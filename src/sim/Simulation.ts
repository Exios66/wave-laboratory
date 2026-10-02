/**
 * The simulation kernel: owns the CPU ocean field, the vessels and the instruments, and
 * advances them with a fixed timestep. It has no DOM/worker dependencies, so it runs equally in
 * the Web Worker, in Node tests and in headless batch runs.
 */
import { FixedStepClock } from '../core/clock';
import { buildGpuOceanData, type GpuOceanData } from '../ocean/gpuData';
import { OceanField } from '../ocean/oceanField';
import type { Experiment, OceanQuality, VesselConfig } from '../schema/experiment';
import type {
  DamageCause,
  HullFootprint,
  VesselCommand,
  VesselDefinition,
  VesselTelemetry,
} from '../vessel/api';
import { collisionDamage } from '../vessel/damage';
import { footprintContact, resolveContact } from './collisions';
import { seaDiagnostics } from './diagnostics';
import { Recorder } from './recorder';
import { WeatherField } from '../weather/weather';
import type {
  CollisionEvent,
  ProbeReading,
  SeaDiagnostics,
  SimFrame,
  WeatherReading,
} from './types';

/** What the simulation needs from a vessel implementation. */
export interface SimVessel {
  readonly id: string;
  readonly definition: VesselDefinition;
  step(dt: number, t: number): void;
  command(cmd: VesselCommand): void;
  telemetry(): VesselTelemetry;
  /** Collision support (vessels without it pass through each other). */
  hullFootprint?(): HullFootprint;
  applyCollision?(impulse: { x: number; y: number }, push: { x: number; y: number }): void;
  applyDamage?(amount: number, cause: DamageCause): void;
}

export type VesselFactory = (
  config: VesselConfig,
  field: OceanField,
  weather: WeatherField,
  options: { damage: boolean },
) => SimVessel;

/** Collision events kept for the next frame at most (older ones are dropped first). */
const MAX_PENDING_COLLISIONS = 64;
/** Minimum time between reported events of one pair in continuous contact [s]. */
const COLLISION_EVENT_INTERVAL = 1;
/** Closing speed below which a contact is resting, not an impact [m/s]. */
const IMPACT_SPEED = 0.05;

export interface SimulationOptions {
  createVessel: VesselFactory;
  /** Recorder sample rate [Hz]. */
  recordRate?: number;
}

export class Simulation {
  readonly experiment: Experiment;
  readonly field: OceanField;
  readonly weather: WeatherField;
  readonly vessels: SimVessel[] = [];
  readonly clock: FixedStepClock;
  readonly recorder: Recorder;
  private lastStepMs = 0;
  private pendingCollisions: CollisionEvent[] = [];
  private readonly lastPairEvent = new Map<string, number>();

  constructor(experiment: Experiment, options: SimulationOptions) {
    this.experiment = experiment;
    this.field = new OceanField(experiment.waves, experiment.environment);
    this.weather = new WeatherField(experiment.weather, experiment.environment);
    this.clock = new FixedStepClock(experiment.timestep, 64);
    this.recorder = new Recorder(options.recordRate ?? 10);
    for (const v of experiment.vessels)
      this.vessels.push(
        options.createVessel(v, this.field, this.weather, { damage: experiment.damage }),
      );
    this.field.prepare(0);
    this.recordIfDue();
  }

  get time(): number {
    return this.clock.time;
  }

  /** Data for the GPU renderer at a given visual quality (default: the experiment's). */
  gpuData(quality: OceanQuality = this.experiment.quality): GpuOceanData {
    return buildGpuOceanData(this.experiment.waves, this.experiment.environment, quality);
  }

  diagnostics(): SeaDiagnostics {
    return seaDiagnostics(this.field.sea, 4 * Math.sqrt(this.field.representedVariance), {
      x: this.field.currentX,
      y: this.field.currentY,
    });
  }

  /** Run exactly one fixed step. */
  stepOnce(): void {
    const dt = this.clock.dt;
    const t = this.clock.time;
    this.field.prepare(t + dt);
    for (const v of this.vessels) v.step(dt, t);
    this.collide(t + dt);
    this.clock.commit();
    this.recordIfDue();
  }

  /**
   * Advance by elapsed (already time-scaled) seconds using the fixed-step accumulator.
   * Returns the number of steps taken.
   */
  advance(elapsed: number): number {
    const start = performance.now();
    const n = this.clock.advance(elapsed);
    for (let i = 0; i < n; i++) this.stepOnce();
    this.lastStepMs = performance.now() - start;
    return n;
  }

  step(count: number): void {
    const start = performance.now();
    for (let i = 0; i < count; i++) this.stepOnce();
    this.lastStepMs = performance.now() - start;
  }

  command(vesselId: string, cmd: VesselCommand): boolean {
    const v = this.vessels.find((x) => x.id === vesselId);
    if (!v) return false;
    v.command(cmd);
    return true;
  }

  probeReadings(t = this.clock.time): ProbeReading[] {
    return this.experiment.probes.map((p) => ({
      id: p.id,
      eta: this.field.surface(p.x, p.y, t).eta,
    }));
  }

  frame(): SimFrame {
    return {
      t: this.clock.time,
      vessels: this.vessels.map((v) => v.telemetry()),
      probes: this.probeReadings(),
      stepMs: this.lastStepMs,
      lagging: this.clock.lagging,
      samples: this.recorder.flush(),
      weather: this.weatherAt(0, 0, this.clock.time),
      collisions: this.flushCollisions(),
    };
  }

  /** Collision events since the last call. */
  flushCollisions(): CollisionEvent[] {
    const out = this.pendingCollisions;
    this.pendingCollisions = [];
    return out;
  }

  /** Separate overlapping hulls, exchange momentum and deal impact damage. */
  private collide(t: number): void {
    const bodies: { v: SimVessel; f: HullFootprint }[] = [];
    for (const v of this.vessels) {
      if (v.hullFootprint && v.applyCollision) bodies.push({ v, f: v.hullFootprint() });
    }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const A = bodies[i]!;
        const B = bodies[j]!;
        const c = footprintContact(A.f, B.f);
        if (!c) continue;
        const r = resolveContact(A.f, B.f, c);
        A.v.applyCollision!({ x: -r.jx, y: -r.jy }, r.pushA);
        B.v.applyCollision!({ x: r.jx, y: r.jy }, r.pushB);
        // Later pairs this step see the updated state.
        A.f = A.v.hullFootprint!();
        B.f = B.v.hullFootprint!();
        if (r.closingSpeed < IMPACT_SPEED) continue;
        // Both structures crumple in the contact zone: each absorbs half the energy.
        const da = collisionDamage(0.5 * r.energy, A.f.mass);
        const db = collisionDamage(0.5 * r.energy, B.f.mass);
        if (this.experiment.damage) {
          A.v.applyDamage?.(da, 'collision');
          B.v.applyDamage?.(db, 'collision');
        }
        const severity = Math.min(1, Math.max(da, db));
        const key = `${A.v.id}|${B.v.id}`;
        const last = this.lastPairEvent.get(key) ?? -Infinity;
        if (t - last < COLLISION_EVENT_INTERVAL && severity < 0.02) continue;
        this.lastPairEvent.set(key, t);
        this.pendingCollisions.push({ a: A.v.id, b: B.v.id, x: c.x, y: c.y, t, severity });
        if (this.pendingCollisions.length > MAX_PENDING_COLLISIONS) this.pendingCollisions.shift();
      }
    }
  }

  /** Weather readout at a point (for the HUD). */
  weatherAt(x: number, y: number, t: number): WeatherReading {
    const w = this.weather.windAt(x, y, t, { u: 0, v: 0, speed: 0, squall: 0 });
    const toward = Math.atan2(w.u, w.v) * (180 / Math.PI);
    return {
      windSpeed: w.speed,
      windFromDeg: w.speed > 0 ? (((toward + 180) % 360) + 360) % 360 : 0,
      squall: w.squall,
      rainMmH: this.weather.rainAt(x, y, t),
    };
  }

  private recordIfDue(): void {
    // Sampling happens on step boundaries; the recorder rate must divide the step rate for
    // exactly uniform samples (default 120 Hz physics / 10 Hz recording).
    const t = this.clock.time;
    while (this.recorder.due(t)) {
      const values: Record<string, number> = {};
      values['weather:wind'] = this.weather.windAt(0, 0, t, {
        u: 0,
        v: 0,
        speed: 0,
        squall: 0,
      }).speed;
      for (const p of this.experiment.probes) {
        values[`${p.id}:eta`] = this.field.surface(p.x, p.y, t).eta;
      }
      for (const v of this.vessels) {
        const tel = v.telemetry();
        values[`${v.id}:heave`] = tel.heave;
        values[`${v.id}:roll`] = tel.rollDeg;
        values[`${v.id}:pitch`] = tel.pitchDeg;
        values[`${v.id}:speed`] = tel.speedKn;
        values[`${v.id}:heading`] = tel.headingDeg;
        values[`${v.id}:bridgeAccel`] = tel.bridgeAccel;
        values[`${v.id}:bowAccel`] = tel.bowAccel;
        values[`${v.id}:wind`] = tel.windSpeed;
        values[`${v.id}:health`] = tel.health;
      }
      this.recorder.record(values);
    }
  }
}
