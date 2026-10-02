/**
 * Lost planes: rare old aircraft crossing the sky, as if from another time.
 *
 * About once a minute (wall clock) a flight from the Bermuda Triangle's lore drifts across
 * the sky — five TBM Avenger torpedo bombers in loose formation (Flight 19, December 1945), a
 * lone PBM Mariner flying boat, a Douglas DC-3, or an Avro Tudor four-prop airliner (Star Tiger,
 * Star Ariel). They do not arrive from the horizon: each one condenses out of a faint shimmer
 * mid-sky, crosses slightly translucent and desaturated, and dissolves the same way. On rare
 * passes the formation flickers, or one aircraft falls behind and is gone. At night only their
 * navigation lights are left, drifting overhead.
 *
 * The scheduling and flight-path maths are pure functions (no WebGL) so they can be tested in
 * node; the layer only poses a small pool of meshes from them. Coordinates are Three.js (y-up).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Pcg32 } from '../../core/rng';
import type { SceneryFrame, SceneryLayer } from './types';

// ---------------------------------------------------------------------------------------------
// Aircraft
// ---------------------------------------------------------------------------------------------

export type AircraftKind = 'avenger' | 'mariner' | 'dc3' | 'tudor';

export interface AircraftSpec {
  kind: AircraftKind;
  label: string;
  /** Wingspan [m]. */
  span: number;
  /** Aircraft in the flight. */
  count: number;
  /** Cruise speed [m/s]. */
  speed: number;
  /** Relative chance of being picked in fair weather. */
  weight: number;
}

export const AIRCRAFT: Readonly<Record<AircraftKind, AircraftSpec>> = {
  avenger: {
    kind: 'avenger',
    label: 'Flight 19 (TBM Avenger ×5)',
    span: 16.5,
    count: 5,
    speed: 68,
    weight: 0.34,
  },
  mariner: { kind: 'mariner', label: 'PBM Mariner', span: 36, count: 1, speed: 62, weight: 0.2 },
  dc3: { kind: 'dc3', label: 'Douglas DC-3', span: 29, count: 1, speed: 72, weight: 0.24 },
  tudor: { kind: 'tudor', label: 'Avro Tudor', span: 36, count: 1, speed: 85, weight: 0.22 },
};

const KINDS: readonly AircraftKind[] = ['avenger', 'mariner', 'dc3', 'tudor'];

/**
 * The airframes are drawn larger than life so a flight a kilometre or two off still reads
 * as aircraft from sea level. Wingspans in AIRCRAFT are the real ones.
 */
export const AIRCRAFT_DRAW_SCALE = 2.6;

/** The most aircraft a single crossing can hold (Flight 19). */
export const MAX_FLIGHT_SIZE = 5;

// ---------------------------------------------------------------------------------------------
// Schedule and flight paths (pure)
// ---------------------------------------------------------------------------------------------

export const PLANE_SCHEDULE = {
  /** Mean wall-clock seconds between crossings in fair weather. */
  meanIntervalS: 55,
  /** …and in a storm, when the lost flights are a little more restless. */
  stormMeanIntervalS: 40,
  /** Never two crossings closer together than this. */
  minIntervalS: 15,
  /** Delay before the first crossing after start (or after the layer is switched on). */
  firstDelayS: [6, 14] as const,
  maxConcurrent: 2,
  /** Cruise altitude band [m above the sea]. */
  minAltitude: 250,
  maxAltitude: 1500,
  /** Ceiling for the passes planned to cross the camera's view. */
  inViewMaxAltitude: 400,
  minDurationS: 30,
  maxDurationS: 90,
  /** Horizontal distance of the point of closest approach from the camera [m]. */
  minRange: 700,
  maxRange: 4500,
  /** Largest gentle turn rate [rad/s]. */
  maxTurnRate: 0.004,
} as const;

/** What the scheduler needs to know about the viewer when it plans a crossing. */
export interface PlaneView {
  camX: number;
  camY: number;
  camZ: number;
  /** Horizontal view direction (need not be normalised; zero means "any way"). */
  forwardX: number;
  forwardZ: number;
}

export interface FormationMember {
  /** Distance behind the leader [m]. */
  behind: number;
  /** Distance to starboard of the leader [m] (negative = port). */
  side: number;
  /** Height above the leader [m]. */
  up: number;
  /** Phase for this aircraft's small wander and flicker. */
  phase: number;
}

export interface Crossing {
  id: number;
  kind: AircraftKind;
  /** Wall time the crossing starts fading in [s]. */
  startT: number;
  duration: number;
  /** Leader's start position (Three.js x, z) and altitude (Three.js y) [m]. */
  x0: number;
  z0: number;
  altitude: number;
  /** Initial heading: direction (cos h, 0, sin h) in Three.js axes [rad]. */
  heading0: number;
  turnRate: number;
  speed: number;
  fadeIn: number;
  fadeOut: number;
  members: FormationMember[];
  /** 0 = steady; up to 1 = the whole flight flickers in and out. */
  flicker: number;
  /** Index of the aircraft that falls behind and vanishes, or −1. */
  laggard: number;
  /** Fraction of the duration at which the laggard is gone. */
  laggardGoneAt: number;
  /**
   * Set on a flight the camera rides: it circles this centre (Three.js x, z) instead of
   * crossing the sky, and the centre may move to keep over the fleet.
   */
  orbit?: { cx: number; cz: number };
}

export interface PlanePose {
  x: number;
  y: number;
  z: number;
  heading: number;
  bank: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function smoothstep(a: number, b: number, x: number): number {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function uniform(rng: Pcg32, lo: number, hi: number): number {
  return lo + (hi - lo) * rng.nextFloat();
}

/** Mean wall seconds between crossings for a given calm (0 storm … 1 fair). */
export function meanCrossingInterval(calm: number): number {
  return lerp(PLANE_SCHEDULE.stormMeanIntervalS, PLANE_SCHEDULE.meanIntervalS, clamp(calm, 0, 1));
}

/** Seconds until the next crossing: a minimum gap plus an exponential tail. */
export function crossingInterval(rng: Pcg32, calm: number): number {
  const min = PLANE_SCHEDULE.minIntervalS;
  return min - (meanCrossingInterval(calm) - min) * Math.log(rng.nextFloatOpenZero());
}

/** Which aircraft appears. Storms make Flight 19 a little more likely. */
export function chooseAircraft(rng: Pcg32, calm: number): AircraftKind {
  const storm = 1 - clamp(calm, 0, 1);
  let total = 0;
  for (const k of KINDS) total += AIRCRAFT[k].weight * (k === 'avenger' ? 1 + storm : 1);
  let u = rng.nextFloat() * total;
  for (const k of KINDS) {
    u -= AIRCRAFT[k].weight * (k === 'avenger' ? 1 + storm : 1);
    if (u < 0) return k;
  }
  return 'avenger';
}

function formation(rng: Pcg32, kind: AircraftKind): FormationMember[] {
  if (AIRCRAFT[kind].count === 1)
    return [{ behind: 0, side: 0, up: 0, phase: rng.nextFloat() * 6.28 }];
  // A loose, slightly ragged V of five: leader, two wingmen, two trailing.
  const slots = [
    [0, 0],
    [26, -28],
    [26, 28],
    [54, -54],
    [54, 56],
  ] as const;
  const k = AIRCRAFT_DRAW_SCALE;
  return slots.map(([behind, side]) => ({
    behind: k * (behind + uniform(rng, -5, 5)),
    side: k * (side + uniform(rng, -5, 5)),
    up: uniform(rng, -4, 4),
    phase: rng.nextFloat() * 6.28,
  }));
}

/**
 * Plan one crossing. Usually (85 %) it passes in front of the camera, 6–12° above the horizon,
 * so it is seen without looking up; otherwise it may cross anywhere in the sky.
 */
export function planCrossing(
  rng: Pcg32,
  view: PlaneView,
  startT: number,
  calm: number,
  id = 0,
): Crossing {
  const S = PLANE_SCHEDULE;
  const kind = chooseAircraft(rng, calm);
  const spec = AIRCRAFT[kind];
  const fLen = Math.hypot(view.forwardX, view.forwardZ);
  const inView = fLen > 1e-6 && rng.nextFloat() < 0.85;
  // Passes in view fly lower and nearer, so they cross the band just above the horizon that a
  // sea-level camera actually shows; the rest may be anywhere up to the ceiling.
  const top = inView ? S.inViewMaxAltitude : S.maxAltitude;
  const altitude = S.minAltitude + (top - S.minAltitude) * Math.pow(rng.nextFloat(), 1.4);
  const bearing = inView
    ? Math.atan2(view.forwardZ, view.forwardX) + uniform(rng, -0.4, 0.4)
    : rng.nextFloat() * Math.PI * 2;
  const elevation = (inView ? uniform(rng, 6, 12) : uniform(rng, 15, 60)) * (Math.PI / 180);
  const rise = Math.max(altitude - view.camY, 120);
  const range = clamp(rise / Math.tan(elevation), S.minRange, S.maxRange);
  const cx = view.camX + Math.cos(bearing) * range;
  const cz = view.camZ + Math.sin(bearing) * range;

  const side = rng.nextFloat() < 0.5 ? 1 : -1;
  const receding = rng.nextFloat() < 0.5;
  // Passes in view fly obliquely through the aim point, so one end of the pass — where the
  // flight condenses out of the haze or dissolves into it — lies well inside the view, low
  // in the distance, while the other end goes by overhead. Others cross the line of sight.
  const heading0 = inView
    ? bearing + side * uniform(rng, 0.6, 1.05) + (receding ? 0 : Math.PI)
    : bearing + (Math.PI / 2) * side + uniform(rng, -0.6, 0.6);
  const turnRate = uniform(rng, -1, 1) * S.maxTurnRate;
  const duration = uniform(rng, S.minDurationS, S.maxDurationS);
  const speed = spec.speed * uniform(rng, 0.9, 1.1);
  // The aim point sits mid-pass (a little nearer the far end for oblique passes), so the
  // flight appears and vanishes mid-sky rather than at the horizon.
  const u = inView ? (receding ? 0.4 : 0.6) : 0.5;
  const lead = speed * duration * (u + uniform(rng, -0.06, 0.06));
  const x0 = cx - Math.cos(heading0) * lead;
  const z0 = cz - Math.sin(heading0) * lead;

  const members = formation(rng, kind);
  const strange = rng.nextFloat();
  const flicker = strange < 0.18 ? uniform(rng, 0.45, 0.9) : 0;
  const laggard =
    members.length > 1 && rng.nextFloat() < 0.3
      ? 1 + Math.floor(rng.nextFloat() * (members.length - 1))
      : -1;

  return {
    id,
    kind,
    startT,
    duration,
    x0,
    z0,
    altitude,
    heading0,
    turnRate,
    speed,
    fadeIn: uniform(rng, 5, 9),
    fadeOut: uniform(rng, 6, 12),
    members,
    flicker,
    laggard,
    laggardGoneAt: uniform(rng, 0.55, 0.75),
  };
}

export const RIDE = {
  /** Radius of the circuit flown around the fleet [m]. */
  radius: 800,
  /** Altitude band of a ride [m]. */
  minAltitude: 260,
  maxAltitude: 360,
  /** Seconds a ride takes to condense, and to dissolve after the camera leaves. */
  fadeIn: 3,
  fadeOut: 8,
  /** Time constant with which the circuit's centre follows the fleet [s]. */
  followS: 20,
} as const;

/**
 * Plan a flight for the camera to ride: one of the lost flights, circling `centre` (the fleet)
 * at a few hundred metres. It starts on the circuit due `bearing` [rad, Three.js atan2(z, x)]
 * of the centre, and holds steady (no flicker, nobody lost) so the view is calm. The duration
 * is only a start: the layer extends it for as long as the camera stays aboard.
 */
export function planRide(
  rng: Pcg32,
  centre: { x: number; z: number },
  startT: number,
  calm: number,
  bearing = rng.nextFloat() * Math.PI * 2,
  id = 0,
): Crossing {
  const kind = chooseAircraft(rng, calm);
  const speed = AIRCRAFT[kind].speed;
  const dir = rng.nextFloat() < 0.5 ? 1 : -1;
  const turnRate = (dir * speed) / RIDE.radius;
  // Tangent to the circuit at the start point, turning about the centre.
  const heading0 = bearing + (dir * Math.PI) / 2;
  const x0 = centre.x + Math.cos(bearing) * RIDE.radius;
  const z0 = centre.z + Math.sin(bearing) * RIDE.radius;
  return {
    id,
    kind,
    startT,
    duration: 60,
    x0,
    z0,
    altitude: uniform(rng, RIDE.minAltitude, RIDE.maxAltitude),
    heading0,
    turnRate,
    speed,
    fadeIn: RIDE.fadeIn,
    fadeOut: RIDE.fadeOut,
    members: formation(rng, kind),
    flicker: 0,
    laggard: -1,
    laggardGoneAt: 1,
    orbit: { cx: centre.x, cz: centre.z },
  };
}

/** Distance the laggard has dropped back after `tau` seconds [m]. */
function lagDistance(c: Crossing, member: number, tau: number): number {
  if (member !== c.laggard) return 0;
  const onset = c.duration * 0.25;
  const s = Math.max(0, tau - onset);
  return 0.6 * s * s;
}

/**
 * Pose of aircraft `member` at `tau` seconds into the crossing: the leader flies a gentle
 * circular arc at constant altitude; the others hold loose formation on it.
 */
export function crossingPose(c: Crossing, member: number, tau: number, out: PlanePose): PlanePose {
  const m = c.members[member] ?? c.members[0]!;
  const w = c.turnRate;
  const v = c.speed;
  const h = c.heading0 + w * tau;
  let px: number;
  let pz: number;
  if (c.orbit && Math.abs(w) >= 1e-7) {
    // Same arc as below, written about its (movable) centre.
    px = c.orbit.cx + (v / w) * Math.sin(h);
    pz = c.orbit.cz - (v / w) * Math.cos(h);
  } else if (Math.abs(w) < 1e-7) {
    px = c.x0 + Math.cos(h) * v * tau;
    pz = c.z0 + Math.sin(h) * v * tau;
  } else {
    px = c.x0 + (v / w) * (Math.sin(h) - Math.sin(c.heading0));
    pz = c.z0 - (v / w) * (Math.cos(h) - Math.cos(c.heading0));
  }
  const fx = Math.cos(h);
  const fz = Math.sin(h);
  // Starboard in Three.js axes with y up: forward × up = (−fz, 0, fx).
  const behind = m.behind + lagDistance(c, member, tau) + 2.5 * Math.sin(tau * 0.21 + m.phase);
  const side = m.side + 3 * Math.sin(tau * 0.17 + m.phase * 1.7);
  out.x = px - fx * behind - fz * side;
  out.z = pz - fz * behind + fx * side;
  out.y = c.altitude + m.up + 2 * Math.sin(tau * 0.31 + m.phase);
  out.heading = h;
  out.bank = Math.atan((v * w) / 9.81) + 0.03 * Math.sin(tau * 0.43 + m.phase);
  return out;
}

/** How solid aircraft `member` is at `tau` [0–1]: shimmer fade in/out, flicker, the laggard. */
export function memberOpacity(c: Crossing, member: number, tau: number): number {
  if (tau <= 0 || tau >= c.duration) return 0;
  let o = smoothstep(0, c.fadeIn, tau) * (1 - smoothstep(c.duration - c.fadeOut, c.duration, tau));
  if (c.flicker > 0) {
    const m = c.members[member]?.phase ?? 0;
    // Slow uneasy pulses with a faster stutter on top, slightly out of step between aircraft.
    const slow = 0.5 + 0.5 * Math.sin(tau * 0.9 + m * 0.3);
    const fast = 0.5 + 0.5 * Math.sin(tau * 7.3 + m);
    o *= 1 - c.flicker * Math.pow(slow, 3) * (0.6 + 0.4 * fast);
  }
  if (member === c.laggard) {
    const gone = c.duration * c.laggardGoneAt;
    o *= 1 - smoothstep(gone - 7, gone, tau);
  }
  return clamp(o, 0, 1);
}

/** Strength of the shimmer an aircraft condenses out of / dissolves into [0–1]. */
export function shimmerAmount(c: Crossing, member: number, tau: number): number {
  if (tau <= 0 || tau >= c.duration) return 0;
  const bump = (a: number, b: number) =>
    tau > a && tau < b ? Math.sin((Math.PI * (tau - a)) / (b - a)) : 0;
  let s = Math.max(bump(-1, c.fadeIn + 2), bump(c.duration - c.fadeOut - 2, c.duration + 1));
  if (member === c.laggard) {
    const gone = c.duration * c.laggardGoneAt;
    s = Math.max(s, bump(gone - 9, gone + 1));
  }
  return s;
}

/**
 * Seeded, deterministic scheduler of crossings. Same seed and same inputs give the same skies.
 */
export class CrossingScheduler {
  readonly active: Crossing[] = [];
  /** The flight the camera rides (also in `active`), or null. */
  ride: Crossing | null = null;
  private readonly rng: Pcg32;
  /** Rides draw from their own stream so they never change the sky's schedule. */
  private readonly rideRng: Pcg32;
  private nextAt: number;
  private nextId = 1;

  constructor(seed: number, startT = 0) {
    this.rng = new Pcg32(seed, 19);
    this.rideRng = new Pcg32(seed, 41);
    this.nextAt = startT + this.firstDelay();
  }

  private firstDelay(): number {
    const [a, b] = PLANE_SCHEDULE.firstDelayS;
    return uniform(this.rng, a, b);
  }

  /** Drop every crossing but the ride (the lost flights were switched off). */
  clear(): void {
    this.active.length = 0;
    if (this.ride) this.active.push(this.ride);
  }

  /** Forget every crossing (but a ride) and wait the first-crossing delay again (layer on). */
  reset(t: number): void {
    this.active.length = 0;
    if (this.ride) this.active.push(this.ride);
    this.nextAt = t + this.firstDelay();
  }

  /**
   * Keep (or stop) a flight for the camera to ride at wall time `t`. While `riding`, the ride
   * is started if there is none, revived if it was dissolving, and kept from ending; its
   * circuit's centre eases toward `centre`. When the camera leaves, it dissolves.
   */
  updateRide(
    t: number,
    dt: number,
    riding: boolean,
    centre: { x: number; z: number },
    calm: number,
  ): Crossing | null {
    let c = this.ride;
    if (c && t >= c.startT + c.duration) {
      this.active.splice(this.active.indexOf(c), 1);
      c = this.ride = null;
    }
    if (!riding) {
      if (c) c.duration = Math.min(c.duration, t - c.startT + c.fadeOut);
      return null;
    }
    if (!c) {
      c = this.ride = planRide(this.rideRng, centre, t, calm, undefined, this.nextId++);
      this.active.push(c);
    }
    const tau = t - c.startT;
    c.duration = Math.max(c.duration, tau + c.fadeOut + 30);
    if (c.orbit) {
      const k = 1 - Math.exp(-Math.max(0, dt) / RIDE.followS);
      c.orbit.cx += (centre.x - c.orbit.cx) * k;
      c.orbit.cz += (centre.z - c.orbit.cz) * k;
    }
    return c;
  }

  /** Wall time the next crossing is due [s]. */
  get nextCrossingAt(): number {
    return this.nextAt;
  }

  /**
   * Advance to wall time `t`: retire finished crossings, start a new one when due. With
   * `spawn` false (the lost flights are switched off) nothing new is scheduled.
   */
  update(t: number, view: PlaneView, calm: number, spawn = true): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const c = this.active[i]!;
      if (t >= c.startT + c.duration) {
        this.active.splice(i, 1);
        if (c === this.ride) this.ride = null;
      }
    }
    if (!spawn || t < this.nextAt) return;
    // The ridden flight is extra: it never holds back the sky's own crossings.
    const crossing = this.active.length - (this.ride ? 1 : 0);
    if (crossing >= PLANE_SCHEDULE.maxConcurrent) {
      // The sky is busy enough; look again a little later.
      this.nextAt = t + 10;
      return;
    }
    this.active.push(planCrossing(this.rng, view, t, calm, this.nextId++));
    this.nextAt = t + crossingInterval(this.rng, calm);
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry (stylised low-poly, nose along +x, up +y, starboard +z)
// ---------------------------------------------------------------------------------------------

interface AirframeLayout {
  geometry: THREE.BufferGeometry;
  /** Propeller hubs and radii. */
  props: { x: number; y: number; z: number; r: number }[];
  /** Port wingtip, starboard wingtip, tail light. */
  lights: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
}

function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

/** Cylinder along x: `rNose` at the +x end. */
function tube(
  length: number,
  rNose: number,
  rTail: number,
  x: number,
  y: number,
  z: number,
  segments = 8,
): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rNose, rTail, length, segments)
    .rotateZ(-Math.PI / 2)
    .translate(x, y, z);
}

/** One wing panel from z = zRoot outward to ±span, with dihedral. */
function wingPanel(
  span: number,
  chord: number,
  thick: number,
  side: 1 | -1,
  dihedralDeg: number,
  x: number,
  y: number,
  zRoot: number,
): THREE.BufferGeometry {
  return new THREE.BoxGeometry(chord, thick, span)
    .translate(0, 0, (side * span) / 2)
    .rotateX((side * dihedralDeg * Math.PI) / 180)
    .translate(x, y, side * zRoot);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((g) => {
    const n = g.toNonIndexed();
    n.deleteAttribute('uv');
    g.dispose();
    return n;
  });
  const out = mergeGeometries(flat, false);
  for (const g of flat) g.dispose();
  if (!out) throw new Error('planes: failed to merge airframe geometry');
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

function buildAirframe(kind: AircraftKind): AirframeLayout {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  switch (kind) {
    case 'avenger': {
      const half = 8.25;
      return {
        geometry: merge([
          tube(11.5, 0.9, 0.35, -0.2, 0, 0),
          tube(1.2, 0.85, 1.0, 5.6, 0, 0, 10),
          box(4.4, 0.9, 1.0, 1.1, 0.95, 0), // long greenhouse canopy
          new THREE.SphereGeometry(0.6, 8, 6).translate(-1.6, 1.05, 0), // dorsal turret
          wingPanel(half - 0.6, 2.7, 0.3, 1, 4, 0.9, -0.45, 0.6),
          wingPanel(half - 0.6, 2.7, 0.3, -1, 4, 0.9, -0.45, 0.6),
          box(1.6, 0.18, 5.8, -5.5, 0.25, 0),
          box(1.9, 2.3, 0.16, -5.7, 1.3, 0),
        ]),
        props: [{ x: 6.3, y: 0, z: 0, r: 2 }],
        lights: [v(0.9, 0.1, -half), v(0.9, 0.1, half), v(-6.6, 0.5, 0)],
      };
    }
    case 'mariner': {
      const half = 18;
      const inner = 5.5;
      const gull = 16; // steep inner panel of the gull wing
      return {
        geometry: merge([
          tube(21, 1.3, 0.45, -0.5, 0, 0).scale(1, 1.35, 1),
          box(6, 0.8, 1.6, 6.5, -0.9, 0), // planing bottom forward
          wingPanel(inner, 3.9, 0.45, 1, gull, 1.2, 1.3, 0.8),
          wingPanel(inner, 3.9, 0.45, -1, gull, 1.2, 1.3, 0.8),
          wingPanel(half - inner - 0.8, 3.4, 0.35, 1, 2, 1.2, 2.8, inner + 0.5),
          wingPanel(half - inner - 0.8, 3.4, 0.35, -1, 2, 1.2, 2.8, inner + 0.5),
          tube(5, 0.8, 0.5, 2.2, 2.6, inner),
          tube(5, 0.8, 0.5, 2.2, 2.6, -inner),
          box(2.2, 0.6, 0.6, 1.0, 1.1, 14.8), // wingtip floats
          box(2.2, 0.6, 0.6, 1.0, 1.1, -14.8),
          box(0.3, 1.6, 0.15, 1.0, 1.9, 14.8),
          box(0.3, 1.6, 0.15, 1.0, 1.9, -14.8),
          wingPanel(5.6, 1.9, 0.2, 1, 18, -10, 1.5, 0),
          wingPanel(5.6, 1.9, 0.2, -1, 18, -10, 1.5, 0),
          box(2.1, 3.2, 0.18, -10.2, 3.2, 5.3), // twin fins at the tailplane tips
          box(2.1, 3.2, 0.18, -10.2, 3.2, -5.3),
        ]),
        props: [
          { x: 4.9, y: 2.6, z: inner, r: 2.3 },
          { x: 4.9, y: 2.6, z: -inner, r: 2.3 },
        ],
        lights: [v(1.2, 3.2, -half), v(1.2, 3.2, half), v(-11.3, 1.4, 0)],
      };
    }
    case 'dc3': {
      const half = 14.5;
      return {
        geometry: merge([
          tube(17, 1.25, 0.3, -0.6, 0, 0, 10),
          new THREE.SphereGeometry(1.25, 10, 6).scale(1.5, 1, 1).translate(7.9, 0, 0),
          wingPanel(half - 1, 3.4, 0.38, 1, 6, 0.7, -0.75, 1),
          wingPanel(half - 1, 3.4, 0.38, -1, 6, 0.7, -0.75, 1),
          tube(4.2, 0.75, 0.4, 1.9, -0.45, 2.9),
          tube(4.2, 0.75, 0.4, 1.9, -0.45, -2.9),
          box(2.1, 0.2, 8.6, -8.3, 0.2, 0),
          box(2.4, 2.9, 0.18, -8.5, 1.6, 0),
        ]),
        props: [
          { x: 4.1, y: -0.45, z: 2.9, r: 1.8 },
          { x: 4.1, y: -0.45, z: -2.9, r: 1.8 },
        ],
        lights: [v(0.7, 0.8, -half), v(0.7, 0.8, half), v(-9.4, 0.9, 0)],
      };
    }
    case 'tudor': {
      const half = 18;
      return {
        geometry: merge([
          tube(22, 1.6, 0.35, -0.8, 0, 0, 10),
          new THREE.SphereGeometry(1.6, 10, 6).scale(1.4, 1, 1).translate(10.2, 0, 0),
          wingPanel(half - 1.3, 3.9, 0.42, 1, 5, 1, -0.8, 1.3),
          wingPanel(half - 1.3, 3.9, 0.42, -1, 5, 1, -0.8, 1.3),
          tube(4.4, 0.75, 0.4, 2.1, -0.4, 4.6),
          tube(4.4, 0.75, 0.4, 2.1, -0.4, -4.6),
          tube(4.4, 0.7, 0.4, 2.0, -0.05, 9.4),
          tube(4.4, 0.7, 0.4, 2.0, -0.05, -9.4),
          box(2.6, 0.22, 13, -10.6, 0.4, 0),
          box(3.0, 4.2, 0.2, -10.9, 2.3, 0), // the Tudor's big fin
          new THREE.SphereGeometry(1.5, 8, 4).scale(1, 0.8, 0.07).translate(-10.9, 4.2, 0),
        ]),
        props: [
          { x: 4.4, y: -0.4, z: 4.6, r: 1.9 },
          { x: 4.4, y: -0.4, z: -4.6, r: 1.9 },
          { x: 4.3, y: -0.05, z: 9.4, r: 1.9 },
          { x: 4.3, y: -0.05, z: -9.4, r: 1.9 },
        ],
        lights: [v(1, 0.7, -half), v(1, 0.7, half), v(-12.2, 1.2, 0)],
      };
    }
  }
}

/** Unit-radius propeller: three thin blades in the y-z plane, spinning about x. */
function buildPropGeometry(): THREE.BufferGeometry {
  const blades: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    blades.push(
      new THREE.BoxGeometry(0.05, 1, 0.16).translate(0, 0.5, 0).rotateX((i * 2 * Math.PI) / 3),
    );
  }
  return merge(blades);
}

/** Soft radial glow (white, alpha falling off) for lights and the shimmer. */
function buildGlowTexture(): THREE.DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const dx = (i + 0.5) / n - 0.5;
      const dy = (j + 0.5) / n - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const a = Math.max(0, 1 - r);
      const k = (j * n + i) * 4;
      data[k] = 255;
      data[k + 1] = 255;
      data[k + 2] = 255;
      data[k + 3] = Math.round(255 * (a * a * 0.7 + Math.pow(a, 8) * 0.3));
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------------------------

/** One pooled aircraft: a body, up to four propellers, three nav lights and its shimmer. */
interface Slot {
  group: THREE.Group;
  body: THREE.Mesh;
  bodyMat: THREE.MeshLambertMaterial;
  props: THREE.Mesh[];
  propMat: THREE.MeshBasicMaterial;
  lights: THREE.Sprite[];
  lightMats: THREE.SpriteMaterial[];
  shimmer: THREE.Sprite;
  shimmerMat: THREE.SpriteMaterial;
  crossing: Crossing | null;
  member: number;
}

const GHOST_COLOR = new THREE.Color(0x8f9a9c);
const GHOST_EMISSIVE = new THREE.Color(0x1c2427);
const SHIMMER_COLOR = new THREE.Color(0xcfe0e6);
const LIGHT_COLORS = [0xff3a2a, 0x3aff6a, 0xfff6e8] as const;
const BASE_OPACITY = 0.9;
/** Navigation lights keep about this angular size [rad] whatever the distance. */
const LIGHT_ANGULAR = 0.0045;

export class PlaneLayer implements SceneryLayer {
  readonly object = new THREE.Group();

  private readonly scheduler: CrossingScheduler;
  private readonly airframes: Record<AircraftKind, AirframeLayout>;
  private readonly propGeometry = buildPropGeometry();
  private readonly glow = buildGlowTexture();
  private readonly slots: Slot[] = [];
  private enabled = true;
  private needsReset = false;
  private readonly view: PlaneView = { camX: 0, camY: 0, camZ: 0, forwardX: 1, forwardZ: 0 };
  private readonly pose: PlanePose = { x: 0, y: 0, z: 0, heading: 0, bank: 0 };
  private readonly fwd = new THREE.Vector3();
  private readonly haze = new THREE.Color();

  constructor(seed = 0x19451205) {
    this.object.name = 'planes';
    this.scheduler = new CrossingScheduler(seed);
    this.airframes = {
      avenger: buildAirframe('avenger'),
      mariner: buildAirframe('mariner'),
      dc3: buildAirframe('dc3'),
      tudor: buildAirframe('tudor'),
    };
    // One flight more than the sky schedules, for the one the camera may be riding.
    const poolSize = (PLANE_SCHEDULE.maxConcurrent + 1) * MAX_FLIGHT_SIZE;
    for (let i = 0; i < poolSize; i++) this.slots.push(this.createSlot());
  }

  private createSlot(): Slot {
    const group = new THREE.Group();
    group.rotation.order = 'YXZ';
    group.visible = false;
    const bodyMat = new THREE.MeshLambertMaterial({
      color: GHOST_COLOR,
      emissive: GHOST_EMISSIVE,
      flatShading: true,
      transparent: true,
      opacity: BASE_OPACITY,
      fog: false,
    });
    group.scale.setScalar(AIRCRAFT_DRAW_SCALE);
    const body = new THREE.Mesh(this.airframes.avenger.geometry, bodyMat);
    group.add(body);
    const propMat = new THREE.MeshBasicMaterial({
      color: 0x30383a,
      transparent: true,
      opacity: 0.5,
      fog: false,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const props: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Mesh(this.propGeometry, propMat);
      props.push(p);
      group.add(p);
    }
    const lightMats: THREE.SpriteMaterial[] = [];
    const lights: THREE.Sprite[] = [];
    for (const color of LIGHT_COLORS) {
      const m = new THREE.SpriteMaterial({
        map: this.glow,
        color,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const s = new THREE.Sprite(m);
      lightMats.push(m);
      lights.push(s);
      group.add(s);
    }
    const shimmerMat = new THREE.SpriteMaterial({
      map: this.glow,
      color: SHIMMER_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    const shimmer = new THREE.Sprite(shimmerMat);
    // The shimmer is posed in world space (it should not bank with the aircraft).
    shimmer.visible = false;
    this.object.add(group, shimmer);
    return {
      group,
      body,
      bodyMat,
      props,
      propMat,
      lights,
      lightMats,
      shimmer,
      shimmerMat,
      crossing: null,
      member: 0,
    };
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.enabled) this.needsReset = true;
    if (!enabled && this.enabled) {
      this.scheduler.clear();
      this.bindSlots();
    }
    this.enabled = enabled;
    this.object.visible = enabled || this.scheduler.ride !== null;
  }

  /**
   * Keep a flight circling `centre` (Three.js x, z: the fleet) for the camera to ride, or let
   * it dissolve when `riding` is false. Call once a frame, before `ridePose`, with the same
   * wall time the frame's `update` gets. Works whether or not the lost flights are switched on.
   */
  updateRide(
    t: number,
    dt: number,
    riding: boolean,
    centre: { x: number; z: number },
    calm: number,
  ): void {
    this.scheduler.updateRide(t, dt, riding, centre, calm);
    this.object.visible = this.enabled || this.scheduler.ride !== null;
  }

  /** Pose of the ridden flight's leader at wall time `t`, or null when there is no ride. */
  ridePose(t: number, out: PlanePose): PlanePose | null {
    const c = this.scheduler.ride;
    return c ? crossingPose(c, 0, t - c.startT, out) : null;
  }

  /** Name of the ridden flight, for the view's caption. */
  get rideLabel(): string | null {
    const c = this.scheduler.ride;
    return c ? AIRCRAFT[c.kind].label : null;
  }

  update(frame: SceneryFrame): void {
    if (!this.enabled && !this.scheduler.ride) return;
    const t = frame.wallT;
    if (this.needsReset) {
      this.scheduler.reset(t);
      this.needsReset = false;
    }
    const cam = frame.camera;
    cam.getWorldDirection(this.fwd);
    this.view.camX = cam.position.x;
    this.view.camY = cam.position.y;
    this.view.camZ = cam.position.z;
    this.view.forwardX = this.fwd.x;
    this.view.forwardZ = this.fwd.z;
    this.scheduler.update(t, this.view, frame.calm, this.enabled);
    this.bindSlots();

    const fog = (this.object.parent as THREE.Scene | null)?.fog;
    if (fog) this.haze.copy(fog.color);
    else this.haze.setRGB(0.7, 0.75, 0.8);
    const daylight = clamp(frame.daylight, 0, 1);
    // By day the aircraft are seen; at night barely, and only their lights carry.
    const bodyVis = 0.1 + 0.9 * smoothstep(0.06, 0.45, daylight);
    const lightVis = 0.3 + 0.7 * (1 - smoothstep(0.2, 0.8, daylight));
    const blink = Math.pow(0.5 + 0.5 * Math.cos(t * Math.PI * 2 * 0.8), 6);

    for (const slot of this.slots) {
      const c = slot.crossing;
      if (!c) continue;
      const tau = t - c.startT;
      const o = memberOpacity(c, slot.member, tau);
      const sh = shimmerAmount(c, slot.member, tau);
      if (o <= 0.002 && sh <= 0.002) {
        slot.group.visible = false;
        slot.shimmer.visible = false;
        continue;
      }
      const p = crossingPose(c, slot.member, tau, this.pose);
      const g = slot.group;
      g.visible = o > 0.002;
      g.position.set(p.x, p.y, p.z);
      g.rotation.set(p.bank, -p.heading, 0.02);

      const dx = p.x - cam.position.x;
      const dy = p.y - cam.position.y;
      const dz = p.z - cam.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Own altitude-appropriate haze: always a little ghostly, more so far away.
      const hazeK = 0.18 + 0.4 * (1 - Math.exp(-dist / 6000));
      slot.bodyMat.color.copy(GHOST_COLOR).lerp(this.haze, hazeK);
      slot.bodyMat.emissive.copy(GHOST_EMISSIVE).multiplyScalar(0.4 + 0.6 * daylight);
      slot.bodyMat.opacity = BASE_OPACITY * o * bodyVis;
      // Shimmer: the body wavers slightly as it condenses out of (or into) the haze.
      const waver = 1 + 0.035 * sh * Math.sin(t * 23 + slot.member);
      slot.body.scale.set(1, waver, 2 - waver);
      slot.propMat.opacity = 0.45 * o * bodyVis;
      for (let i = 0; i < slot.props.length; i++) {
        const prop = slot.props[i]!;
        prop.rotation.x = t * 41 + i * 0.9;
      }

      const lightScale =
        (Math.max(1.2, dist * LIGHT_ANGULAR) * (1 + 0.6 * (1 - daylight))) / AIRCRAFT_DRAW_SCALE;
      for (let i = 0; i < 3; i++) {
        const s = slot.lights[i]!;
        s.scale.setScalar(i === 2 ? lightScale * (0.6 + 0.6 * blink) : lightScale);
        slot.lightMats[i]!.opacity = o * lightVis * (i === 2 ? 0.25 + 0.75 * blink : 0.9);
      }

      slot.shimmer.visible = sh > 0.002;
      if (slot.shimmer.visible) {
        slot.shimmer.position.set(p.x, p.y, p.z);
        const span = AIRCRAFT[c.kind].span;
        slot.shimmer.scale.setScalar(
          AIRCRAFT_DRAW_SCALE * span * (2.2 + 0.4 * Math.sin(t * 3.1 + slot.member)),
        );
        // Faded right by the lens, so riding a flight as it condenses is not a white-out.
        slot.shimmerMat.opacity = sh * 0.32 * (0.35 + 0.65 * daylight) * smoothstep(60, 400, dist);
        slot.shimmerMat.color.copy(SHIMMER_COLOR).lerp(this.haze, 0.35);
      }
    }
  }

  /** Give newly scheduled crossings pooled aircraft and free those of finished ones. */
  private bindSlots(): void {
    const active = this.scheduler.active;
    for (const slot of this.slots) {
      if (slot.crossing && !active.includes(slot.crossing)) this.release(slot);
    }
    for (const c of active) {
      let bound = false;
      for (const s of this.slots) if (s.crossing === c) bound = true;
      if (bound) continue;
      let m = 0;
      for (const slot of this.slots) {
        if (m >= c.members.length) break;
        if (!slot.crossing) this.assign(slot, c, m++);
      }
    }
  }

  private assign(slot: Slot, c: Crossing, member: number): void {
    const layout = this.airframes[c.kind];
    slot.crossing = c;
    slot.member = member;
    slot.body.geometry = layout.geometry;
    for (let i = 0; i < slot.props.length; i++) {
      const prop = slot.props[i]!;
      const hub = layout.props[i];
      prop.visible = !!hub;
      if (hub) {
        prop.position.set(hub.x, hub.y, hub.z);
        prop.scale.setScalar(hub.r);
      }
    }
    for (let i = 0; i < 3; i++) slot.lights[i]!.position.copy(layout.lights[i]!);
  }

  private release(slot: Slot): void {
    slot.crossing = null;
    slot.group.visible = false;
    slot.shimmer.visible = false;
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.bodyMat.dispose();
      slot.propMat.dispose();
      for (const m of slot.lightMats) m.dispose();
      slot.shimmerMat.dispose();
    }
    this.slots.length = 0;
    for (const k of KINDS) this.airframes[k].geometry.dispose();
    this.propGeometry.dispose();
    this.glow.dispose();
    this.object.clear();
  }
}
