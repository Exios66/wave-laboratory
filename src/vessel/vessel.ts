/**
 * Six-degree-of-freedom vessel in the ocean field.
 *
 * Equations of motion (body frame, about the CoG; Fossen 2011):
 *     (M_RB + A) ν̇ = τ_hull + τ_strip + τ_visc + τ_prop + τ_rudder + τ_grav − C(ν) ν
 * with ν = (u, v, w, p, q, r). τ_hull is the pressure integral over the instantaneous wetted
 * hull (hydrostatics + Froude–Krylov, nonlinear) plus cross-flow drag (`HullForces`); τ_strip
 * the relative-motion strip forces (diffraction ≈ A·a_water and radiation damping on the
 * relative velocity); τ_visc ITTC-57 friction, linear manoeuvring derivatives and roll damping.
 * The Coriolis–centripetal term uses the rigid-body plus diagonal added-mass matrices for the
 * translational part, −ω × ((m + A_ii) v), and the gyroscopic term −ω × ((I + A) ω) for the
 * rotational part. The Munk moment −v × (A v) is omitted on purpose: it is cancelled to a large
 * degree by viscous hull lift, which the L0 model only represents through the linear
 * manoeuvring derivatives.
 *
 * Integration: semi-implicit (symplectic) Euler — velocities first, then position and attitude
 * (exact exponential map) with the new velocities — with internal substeps chosen from the
 * vessel's fastest natural frequency and damping rate, so any step up to ~1/30 s is stable.
 */
import { KNOT, wrapAngle } from '../core/units';
import { integrateQuat, quatFromEuler, quatToEuler, type Quat, type Vec3 } from '../core/vec';
import { headingFromYaw, yawFromHeading } from '../ocean/systems';
import type { OceanField } from '../ocean/oceanField';
import type { VesselConfig } from '../schema/experiment';
import type {
  HullFootprint,
  VesselCommand,
  VesselDefinition,
  VesselKinematics,
  VesselTelemetry,
} from './api';
import {
  resistanceCoefficient,
  rudderLift,
  thrustImmersionFactor,
  type ResistanceParams,
} from './coefficients';
import { Autopilot, rateLimit } from './control';
import { DamageModel, steeringFactor, thrustFactor, type DamageCause } from './damage';
import { HullForces, type RigidState } from './hullForces';
import { buildHydroModel, CROSS_FLOW_CD, type HydroModel } from './hydroModel';
import { quatToMat3, solveFloating } from './hydrostatics';
import { meshBounds } from './mesh';
import { LocalWater, type Footprint } from './waterPatch';
import { emptyLoad, reefedSet, sailLoad, windageLoad } from './windLoads';

/** Source of the 10 m wind at a point (world frame, air velocity toward). */
export interface WindProvider {
  windAt(x: number, y: number, t: number, out: { u: number; v: number; speed: number }): unknown;
}

const DEG = Math.PI / 180;
/** Fraction of the propeller race that reaches the rudder (velocity² increase). */
const RACE_FRACTION = 0.7;
/** Hull flow-straightening factor on the drift at the rudder (MMG γ_R ≈ 0.4–0.6). */
const FLOW_STRAIGHTENING = 0.5;
/** Rudder section zero-lift drag and span efficiency. */
const RUDDER_CD0 = 0.013;
const RUDDER_SPAN_EFFICIENCY = 0.9;

export interface VesselOptions {
  /** Max columns of the local water patch. */
  patchColumns?: number;
  /** Weather wind acting on the windage and sails (none = still air). */
  wind?: WindProvider;
  /** Accumulate structural damage (default true). Off: health stays 1. */
  damage?: boolean;
}

export interface VesselDiagnostics {
  substeps: number;
  /** Instantaneous wetted area [m²] and displaced volume [m³]. */
  wettedArea: number;
  displacedVolume: number;
  /** Pressure + cross-flow force/moment on the hull (body frame, about the CoG). */
  hullForce: Vec3;
  hullMoment: Vec3;
  /** Wetted-area-mean water particle velocity (body frame). */
  waterVelocity: Vec3;
  /** Largest relative entry velocity of slam-prone panels [m/s]. */
  slamVelocity: number;
  throttle: number;
  /** Ocean `column` calls made by this vessel's water patch so far. */
  waterColumnCalls: number;
}

export interface VesselOffset {
  /** Extra CoG height [m]. */
  heave?: number;
  rollDeg?: number;
  pitchDeg?: number;
}

export class Vessel {
  readonly id: string;
  readonly definition: VesselDefinition;
  readonly hydro: HydroModel;
  /** Still-water equilibrium CoG height [m] and trim [rad] in this environment. */
  readonly equilibriumZ: number;
  readonly equilibriumTrim: number;
  /** Internal substeps per step at the last `step` call. */
  substeps = 1;

  private readonly water: LocalWater;
  private readonly hull: HullForces;
  private readonly autopilot = new Autopilot();
  /** Structural health (see `damage.ts`). */
  readonly damage: DamageModel;
  private readonly s: RigidState;
  private q: Quat;
  private readonly gen = new Float64Array(6);
  private readonly acc = new Float64Array(6);
  private readonly rateMax: number;
  private readonly bodyBox: { min: Vec3; max: Vec3 };
  private readonly fp: Footprint = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  private readonly footprint: (t: number) => Footprint;

  // ---- commands & actuators
  private autopilotOn: boolean;
  private headingCmdDeg: number;
  private speedCmdKn: number;
  private rudderCmdDeg = 0;
  private throttleCmd = 0;
  private rudder = 0; // rad
  private thrust = 0; // N (effective)
  private throttle = 0;
  /** Thrust actually delivered at the last substep (after emergence loss) [N]. */
  private deliveredThrust = 0;
  private readonly resistance: ResistanceParams;
  private readonly wind: WindProvider | undefined;
  private readonly windSample = { u: 0, v: 0, speed: 0, squall: 0 };
  private readonly windageOut = emptyLoad();
  private readonly sailOut = emptyLoad();
  /** True wind at the vessel for the current step (world) [m/s]. */
  private windU = 0;
  private windV = 0;
  private sailSet = 0;
  private apparentX = 0;
  private apparentY = 0;
  private windForce = 0;
  /**
   * Sail centre of effort after the crew balances the helm with head sails and spanker: just
   * aft of the hull's centre of lateral resistance x = (N_v / Y_v) L (a little weather helm).
   */
  private readonly sailBalanceX: number;

  // ---- per-step outputs
  private slamming = false;
  private greenWater = false;
  private bowVz = 0;
  private bridgeVz = 0;
  private bowAccel = 0;
  private bridgeAccel = 0;
  private time = 0;
  private stepped = false;

  constructor(
    id: string,
    definition: VesselDefinition,
    config: Pick<VesselConfig, 'x' | 'y' | 'headingDeg' | 'speedKn' | 'autopilot'>,
    field: OceanField,
    options: VesselOptions = {},
  ) {
    this.id = id;
    this.definition = definition;
    this.wind = options.wind;
    this.damage = new DamageModel(definition.length, options.damage ?? true);
    const rho = field.env.waterDensity;
    const g = field.env.gravity;
    const hydro = buildHydroModel(definition, rho, g);
    this.hydro = hydro;
    // Calm-water resistance parameters (the wetted area is the design value; the actual
    // instantaneous wetted area scales the force in `evaluate`).
    this.resistance = {
      wettedArea: definition.hydrostatics.wettedArea,
      length: hydro.lwl,
      formFactor: hydro.formFactor,
      rho,
      nu: hydro.nu,
      g,
    };
    const L = hydro.lwl;
    const def = definition;
    this.sailBalanceX =
      Math.abs(hydro.clarke.yv) > 1e-9 ? (hydro.clarke.nv / hydro.clarke.yv) * L - 0.03 * L : 0;

    // Equilibrium in this environment (water density may differ from the design density).
    const eq = solveFloating(def.physicsHull, def.mass / rho, 0, {
      z0: def.kg - def.draft,
      length: L,
    });
    this.equilibriumZ = eq.z;
    this.equilibriumTrim = eq.trim;

    // Depth levels of the water patch: stretched towards the surface, down to the deepest a
    // hull point can reach when heeled or pitched.
    const H = 1.1 * Math.max(def.depth, def.beam / 2, def.draft * 1.5);
    const levels = [0, -0.06, -0.15, -0.3, -0.55, -1].map((f) => f * H);
    this.water = new LocalWater(
      field,
      levels,
      options.patchColumns ?? 280,
      Math.max(0.25, 0.012 * L),
    );

    const slamMask = new Uint8Array(def.physicsHull.indices.length / 3);
    const pos = def.physicsHull.positions;
    const ix = def.physicsHull.indices;
    for (let t = 0; t < slamMask.length; t++) {
      const a = 3 * ix[3 * t]!;
      const b = 3 * ix[3 * t + 1]!;
      const c = 3 * ix[3 * t + 2]!;
      const cx = (pos[a]! + pos[b]! + pos[c]!) / 3;
      const ux = pos[b]! - pos[a]!;
      const uy = pos[b + 1]! - pos[a + 1]!;
      const vx = pos[c]! - pos[a]!;
      const vy = pos[c + 1]! - pos[a + 1]!;
      const ux2 = pos[b + 2]! - pos[a + 2]!;
      const vz = pos[c + 2]! - pos[a + 2]!;
      const sx = uy * vz - ux2 * vy;
      const sy = ux2 * vx - ux * vz;
      const sz = ux * vy - uy * vx;
      const nz = sz / (Math.hypot(sx, sy, sz) || 1);
      // Forward bottom panels (normal pointing downwards) in the fore 30 % of the waterline.
      slamMask[t] = cx > hydro.slamRegionX && nz < -0.3 ? 1 : 0;
    }
    this.hull = new HullForces(def.physicsHull, {
      rho,
      g,
      crossFlowCd: CROSS_FLOW_CD,
      slamMask,
      slamThreshold: hydro.slamThreshold,
      deckEdge: def.deckEdgeVertices,
    });

    const yaw = yawFromHeading(config.headingDeg);
    this.q = quatFromEuler(0, eq.trim, yaw);
    this.s = {
      px: config.x,
      py: config.y,
      pz: eq.z,
      rot: Float64Array.from(quatToMat3(this.q)),
      u: config.speedKn * KNOT,
      v: 0,
      w: 0,
      p: 0,
      q: 0,
      r: 0,
    };
    this.autopilotOn = config.autopilot;
    this.headingCmdDeg = config.headingDeg;
    this.speedCmdKn = config.speedKn;
    if (definition.sails) {
      // Start with the canvas the crew would carry in this wind (the helmsman starts furled).
      let set = config.autopilot ? 1 : 0;
      if (this.wind && config.autopilot) {
        const w = { u: 0, v: 0, speed: 0 };
        this.wind.windAt(config.x, config.y, 0, w);
        set = reefedSet(w.speed);
      }
      this.sailSet = set;
    }
    if (this.autopilotOn) {
      // Start with the steady-state thrust for the initial speed (no start-up transient).
      const r = Math.min(1, Math.max(0, this.s.u / def.maxSpeed));
      this.throttle = r * r;
      this.thrust = this.throttle * def.propulsion.maxThrust;
    }

    // Fastest dynamics → substep size. Explicit damping terms need h·rate ≲ 0.5 for accuracy
    // (2 for stability); oscillators need h·ω ≲ 0.3.
    const A = hydro.addedMass;
    const uMax = def.maxSpeed;
    const rho2 = 0.5 * rho;
    const yawRate = (Math.abs(hydro.clarke.nr) * rho2 * L ** 4 * uMax) / (hydro.izz + A[35]!);
    const swayRate = (Math.abs(hydro.clarke.yv) * rho2 * L * L * uMax) / (hydro.mass + A[7]!);
    const heaveDamp = 2 * hydro.zetaHeave * hydro.omegaHeave;
    const rollDamp = (hydro.rollB0 + hydro.rollBLift * uMax) / (hydro.ixx + A[21]!);
    this.rateMax = Math.max(
      hydro.omegaHeave / 0.3,
      hydro.omegaRoll / 0.3,
      hydro.omegaPitch / 0.3,
      yawRate / 0.5,
      swayRate / 0.5,
      heaveDamp / 0.5,
      rollDamp / 0.5,
    );

    this.bodyBox = meshBounds(def.physicsHull);
    const margin = 0.03 * L + 0.5;
    this.footprint = (tTarget: number): Footprint => {
      const s = this.s;
      const R = s.rot;
      const dt = tTarget - this.time;
      // World velocity of the CoG.
      const vx = R[0]! * s.u + R[1]! * s.v + R[2]! * s.w;
      const vy = R[3]! * s.u + R[4]! * s.v + R[5]! * s.w;
      const cx = s.px + vx * dt;
      const cy = s.py + vy * dt;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      const b = this.bodyBox;
      for (let k = 0; k < 8; k++) {
        const x = k & 1 ? b.max.x : b.min.x;
        const y = k & 2 ? b.max.y : b.min.y;
        const z = k & 4 ? b.max.z : b.min.z;
        const wx = cx + R[0]! * x + R[1]! * y + R[2]! * z;
        const wy = cy + R[3]! * x + R[4]! * y + R[5]! * z;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
      // The patch is used for one more interval as the "previous" patch: pad by the distance
      // the vessel can travel meanwhile.
      const pad = margin + 2 * Math.hypot(vx, vy) * field.snapshotInterval;
      this.fp.minX = minX - pad;
      this.fp.maxX = maxX + pad;
      this.fp.minY = minY - pad;
      this.fp.maxY = maxY + pad;
      return this.fp;
    };
  }

  // ------------------------------------------------------------------ commands

  command(cmd: VesselCommand): void {
    if (cmd.headingDeg !== undefined) this.headingCmdDeg = cmd.headingDeg;
    if (cmd.speedKn !== undefined) this.speedCmdKn = cmd.speedKn;
    if (cmd.rudderDeg !== undefined) this.rudderCmdDeg = cmd.rudderDeg;
    if (cmd.throttle !== undefined) this.throttleCmd = Math.max(-1, Math.min(1, cmd.throttle));
    if (cmd.autopilot !== undefined && cmd.autopilot !== this.autopilotOn) {
      this.autopilotOn = cmd.autopilot;
      this.autopilot.reset();
    }
    if (cmd.repair) this.damage.repair();
  }

  /**
   * Collision response from the simulation: an impulse [N·s] and a separating displacement [m],
   * both horizontal in the world frame, applied to the CoG (no angular part).
   */
  applyCollision(impulse: { x: number; y: number }, push: { x: number; y: number }): void {
    const s = this.s;
    const R = s.rot;
    const dvx = impulse.x / this.definition.mass;
    const dvy = impulse.y / this.definition.mass;
    // World → body: ν += Rᵀ Δv.
    s.u += R[0]! * dvx + R[3]! * dvy;
    s.v += R[1]! * dvx + R[4]! * dvy;
    s.w += R[2]! * dvx + R[5]! * dvy;
    s.px += push.x;
    s.py += push.y;
  }

  /** Remove `amount` of health (no-op when damage is off). */
  applyDamage(amount: number, cause: DamageCause): void {
    this.damage.damage(amount, cause);
  }

  /** Horizontal hull footprint and momentum data for collision tests (world frame). */
  hullFootprint(): HullFootprint {
    const s = this.s;
    const R = s.rot;
    const def = this.definition;
    const fl = Math.hypot(R[0]!, R[3]!) || 1;
    return {
      x: s.px,
      y: s.py,
      fx: R[0]! / fl,
      fy: R[3]! / fl,
      halfLength: def.length / 2,
      halfBeam: def.beam / 2,
      mass: def.mass,
      vx: R[0]! * s.u + R[1]! * s.v + R[2]! * s.w,
      vy: R[3]! * s.u + R[4]! * s.v + R[5]! * s.w,
    };
  }

  /** Displace the vessel from its current state (used for decay tests and scripted starts). */
  applyOffset(offset: VesselOffset): void {
    this.s.pz += offset.heave ?? 0;
    const e = quatToEuler(this.q);
    this.q = quatFromEuler(
      e.roll + (offset.rollDeg ?? 0) * DEG,
      e.pitch + (offset.pitchDeg ?? 0) * DEG,
      e.yaw,
    );
    this.s.rot.set(quatToMat3(this.q));
  }

  // ------------------------------------------------------------------ stepping

  /** Advance the vessel from time t to t + dt. */
  step(dt: number, t: number): void {
    if (!(dt > 0)) return;
    const def = this.definition;
    const prop = def.propulsion;
    const s = this.s;
    this.time = t;

    // ---- control (once per step)
    const uThroughWater = s.u - this.hull.waterU;
    let rudderTarget: number;
    let throttleTarget: number;
    if (this.autopilotOn) {
      const yaw = quatToEuler(this.q).yaw;
      const yawErr = wrapAngle(yawFromHeading(this.headingCmdDeg) - yaw);
      rudderTarget = this.autopilot.rudder(
        yawErr,
        s.r,
        uThroughWater,
        this.hydro.lwl,
        prop.maxRudderDeg * DEG,
        dt,
      );
      throttleTarget = this.autopilot.throttle(
        this.speedCmdKn * KNOT,
        uThroughWater,
        def.maxSpeed,
        dt,
      );
    } else {
      rudderTarget = this.rudderCmdDeg * DEG;
      throttleTarget = this.throttleCmd;
    }
    // ---- weather: true wind at the CoG for this step
    if (this.wind) {
      this.wind.windAt(s.px, s.py, t, this.windSample);
      this.windU = this.windSample.u;
      this.windV = this.windSample.v;
    }
    if (def.sails) {
      // The engine-less ship sets canvas instead of throttle; the autopilot crew reefs as the
      // apparent wind rises, a helmsman (autopilot off) carries whatever is ordered.
      const R0 = s.rot;
      const ax = this.windU - (R0[0]! * s.u + R0[1]! * s.v);
      const ay = this.windV - (R0[3]! * s.u + R0[4]! * s.v);
      const apparent = Math.hypot(ax, ay);
      const target = Math.max(0, Math.min(1, throttleTarget));
      // Damaged rigging carries less canvas (none once disabled).
      const intact = thrustFactor(this.damage.health);
      const wanted = Math.min(
        intact,
        this.autopilotOn ? Math.min(target, reefedSet(apparent)) : target,
      );
      // Setting or taking in sail takes time (~20 s for the full plan).
      this.sailSet = rateLimit(this.sailSet, wanted, 0.05, dt);
    }
    // Damage: weakened steering gear below 25 % health; a disabled ship's rudder trails
    // amidships and its engine stops.
    const health = this.damage.health;
    const steer = steeringFactor(health);
    const maxR = prop.maxRudderDeg * DEG * Math.max(steer, 0.2);
    rudderTarget = health > 0 ? Math.max(-maxR, Math.min(maxR, rudderTarget)) : 0;
    const rudderRate = prop.rudderRateDeg * DEG * Math.max(steer, 0.2);
    this.rudder = rateLimit(this.rudder, rudderTarget, rudderRate, dt);
    this.throttle = throttleTarget;
    const power = thrustFactor(health);
    const thrustCmd =
      power *
      (throttleTarget >= 0
        ? throttleTarget * prop.maxThrust
        : throttleTarget * prop.maxThrust * prop.asternFraction);
    if (power > 0) {
      this.thrust += (thrustCmd - this.thrust) * (1 - Math.exp(-dt / prop.thrustTimeConstant));
    } else {
      this.thrust = 0;
    }

    // ---- dynamics with substeps
    const n = Math.min(32, Math.max(1, Math.ceil(dt * this.rateMax)));
    this.substeps = n;
    const h = dt / n;
    let slam = false;
    let green = false;
    let greenDepth = 0;
    const M = this.hydro.massInverse;
    for (let k = 0; k < n; k++) {
      const tk = t + k * h;
      this.time = tk;
      this.evaluate(tk);
      slam ||= this.hull.slamming;
      green ||= this.hull.greenWater;
      greenDepth = Math.max(greenDepth, this.hull.greenWaterDepth);
      const f = this.gen;
      const a = this.acc;
      for (let i = 0; i < 6; i++) {
        let sum = 0;
        for (let j = 0; j < 6; j++) sum += M[i * 6 + j]! * f[j]!;
        a[i] = sum;
      }
      // Symplectic Euler: velocities first …
      s.u += h * a[0]!;
      s.v += h * a[1]!;
      s.w += h * a[2]!;
      s.p += h * a[3]!;
      s.q += h * a[4]!;
      s.r += h * a[5]!;
      // … then position (world velocity with the new body velocity) and attitude.
      const R = s.rot;
      s.px += h * (R[0]! * s.u + R[1]! * s.v + R[2]! * s.w);
      s.py += h * (R[3]! * s.u + R[4]! * s.v + R[5]! * s.w);
      s.pz += h * (R[6]! * s.u + R[7]! * s.v + R[8]! * s.w);
      this.q = integrateQuat(this.q, { x: s.p, y: s.q, z: s.r }, h);
      writeRot(this.q, s.rot);
    }
    this.time = t + dt;
    this.slamming = slam;
    this.greenWater = green;

    // ---- point accelerations (kinematic, gravity excluded)
    const bowVz = this.pointVerticalVelocity(def.points.bow);
    const bridgeVz = this.pointVerticalVelocity(def.points.bridge);
    if (this.stepped) {
      this.bowAccel = (bowVz - this.bowVz) / dt;
      this.bridgeAccel = (bridgeVz - this.bridgeVz) / dt;
    }
    this.bowVz = bowVz;
    this.bridgeVz = bridgeVz;
    this.stepped = true;

    // ---- structural damage from this step's seaway and weather
    this.damage.step({
      dt,
      slamming: slam,
      bowAccel: this.bowAccel,
      greenWaterDepth: greenDepth,
      windSpeed: Math.hypot(this.windU, this.windV),
      heelDeg: this.heelDeg,
      capsized: this.capsized,
    });
  }

  /** Heel beyond the angle of vanishing stability or inverted. */
  get capsized(): boolean {
    const heel = this.heelDeg;
    return heel > 90 || heel > this.definition.hydrostatics.avsDeg;
  }

  private pointVerticalVelocity(r: Vec3): number {
    const s = this.s;
    const vx = s.u + s.q * r.z - s.r * r.y;
    const vy = s.v + s.r * r.x - s.p * r.z;
    const vz = s.w + s.p * r.y - s.q * r.x;
    const R = s.rot;
    return R[6]! * vx + R[7]! * vy + R[8]! * vz;
  }

  /** Generalised force (body frame, about the CoG) at the current state into `this.gen`. */
  private evaluate(t: number): void {
    const s = this.s;
    const R = s.rot;
    const hy = this.hydro;
    const def = this.definition;
    const prop = def.propulsion;
    const rho = hy.rho;
    const g = hy.g;
    const water = this.water;
    water.update(t, this.footprint);

    // 1. Pressure integration + cross-flow drag over the wetted hull.
    const hull = this.hull;
    hull.compute(s, water);
    let fx = hull.fx;
    let fy = hull.fy;
    let fz = hull.fz;
    let mx = hull.mx;
    let my = hull.my;
    let mz = hull.mz;

    // 2. Relative-motion strip forces: diffraction (A·a_water) and radiation damping.
    const nS = hy.stripX.length;
    const a11PerStrip = hy.addedMass[0]! / nS;
    for (let i = 0; i < nS; i++) {
      const x = hy.stripX[i]!;
      const z = hy.stripZ[i]!;
      const wx = s.px + R[0]! * x + R[2]! * z;
      const wy = s.py + R[3]! * x + R[5]! * z;
      const wz = s.pz + R[6]! * x + R[8]! * z;
      const eta = water.surface(wx, wy);
      // Immersion ratio of the strip: 1 at the design waterline, 0 when the keel emerges.
      const depthBelow = eta - wz; // depth of the sample point
      const draft = hy.stripDraft[i]!;
      const keelDepth = depthBelow + (z - (hy.waterlineZ - draft));
      const imm = Math.max(0, Math.min(1, keelDepth / draft));
      if (imm <= 0) continue;
      water.fluidBelow(wx, wy, Math.min(wz, eta - 0.01 * draft), eta, true);
      // Water velocity/acceleration → body frame.
      const ww = R[2]! * water.u + R[5]! * water.v + R[8]! * water.w;
      const au = R[0]! * water.au + R[3]! * water.av + R[6]! * water.aw;
      const av = R[1]! * water.au + R[4]! * water.av + R[7]! * water.aw;
      const aw = R[2]! * water.au + R[5]! * water.av + R[8]! * water.aw;
      // Vertical (body) velocity of the strip point r = (x, 0, z): w + p·0 − q·x.
      const pw = s.w - s.q * x;
      const sfz = imm * (hy.stripA33[i]! * aw + hy.stripB33[i]! * (ww - pw));
      const sfy = imm * hy.stripA22[i]! * av;
      const sfx = imm * a11PerStrip * au;
      fx += sfx;
      fy += sfy;
      fz += sfz;
      mx += -z * sfy; // r × f with r = (x, 0, z)
      my += z * sfx - x * sfz;
      mz += x * sfy;
    }

    // 3. Viscous surge resistance (ITTC-57 + form factor + C_A + C_R) on the wetted surface.
    const ur = s.u - hull.waterU;
    const vr = s.v - hull.waterV;
    if (hull.wettedArea > 0) {
      const ct = resistanceCoefficient(ur, this.resistance);
      const res = 0.5 * rho * hull.wettedArea * ur * Math.abs(ur) * ct;
      fx -= res;
      my -= hull.wetZ * res;
      mz += hull.wetY * res;
    }

    // 4. Linear manoeuvring derivatives (Clarke et al. 1983), scaled by submergence.
    const speed = Math.hypot(ur, vr);
    const sub = Math.min(1.2, hull.volume / (def.mass / rho));
    if (speed > 1e-3 && sub > 0) {
      const L = hy.lwl;
      const c = hy.clarke;
      const yH = 0.5 * rho * L * L * speed * (c.yv * vr + c.yr * L * s.r) * sub;
      const nH = 0.5 * rho * L * L * L * speed * (c.nv * vr + c.nr * L * s.r) * sub;
      fy += yH;
      mz += nH;
      mx += -hy.lateralZ * yH;
    }

    // 5. Roll damping (Ikeda-type: linear + speed-dependent lift + quadratic).
    const bRoll = hy.rollB0 + hy.rollBLift * Math.abs(ur) + hy.rollBQuad * Math.abs(s.p);
    mx -= bRoll * s.p * Math.min(1, sub);

    // 6. Propeller thrust with emergence loss.
    const pp = def.points.propeller;
    const ppx = s.px + R[0]! * pp.x + R[1]! * pp.y + R[2]! * pp.z;
    const ppy = s.py + R[3]! * pp.x + R[4]! * pp.y + R[5]! * pp.z;
    const ppz = s.pz + R[6]! * pp.x + R[7]! * pp.y + R[8]! * pp.z;
    const immersion = water.surface(ppx, ppy) - ppz;
    const beta = thrustImmersionFactor(immersion / (0.5 * prop.propellerDiameter));
    const thrust = this.thrust * beta;
    this.deliveredThrust = thrust;
    fx += thrust;
    my += pp.z * thrust;
    mz -= pp.y * thrust;

    // 7. Rudder: lift from aspect ratio with stall, inflow = hull wake + propeller race.
    const rp = def.points.rudder;
    const uR = ur + s.q * rp.z - s.r * rp.y;
    const vR = vr + s.r * rp.x - s.p * rp.z;
    const uA = uR * (1 - prop.wakeFraction);
    const dp = prop.propellerDiameter;
    const race = thrust > 0 ? (RACE_FRACTION * 8 * thrust) / (rho * Math.PI * dp * dp) : 0;
    const uEff2 = uA * uA + race;
    const uEff = uA >= 0 || race > 0 ? Math.sqrt(uEff2) : -Math.sqrt(uEff2);
    const vEff = FLOW_STRAIGHTENING * vR;
    const v2 = uEff * uEff + vEff * vEff;
    if (v2 > 1e-8) {
      const ahead = uEff >= 0;
      const alpha = ahead
        ? this.rudder + Math.atan2(vEff, uEff)
        : this.rudder - Math.atan2(vEff, -uEff);
      const cl = rudderLift(alpha, hy.rudderLiftSlope);
      const q = 0.5 * rho * prop.rudderArea * v2;
      const lift = (ahead ? -1 : 1) * q * cl;
      const drag =
        q *
        (RUDDER_CD0 + (cl * cl) / (Math.PI * prop.rudderAspectRatio * RUDDER_SPAN_EFFICIENCY)) *
        Math.sign(uEff);
      const rIm = Math.min(1, Math.max(0, sub));
      const rfx = -drag * rIm;
      const rfy = lift * rIm;
      fx += rfx;
      fy += rfy;
      mx += -rp.z * rfy;
      my += rp.z * rfx;
      mz += rp.x * rfy - rp.y * rfx;
    }

    // 8. Wind on the windage and the sails (relative air velocity in the body frame).
    if (this.wind) {
      const shipX = R[0]! * s.u + R[1]! * s.v + R[2]! * s.w;
      const shipY = R[3]! * s.u + R[4]! * s.v + R[5]! * s.w;
      const ax = this.windU - shipX;
      const ay = this.windV - shipY;
      const vax = R[0]! * ax + R[3]! * ay;
      const vay = R[1]! * ax + R[4]! * ay;
      this.apparentX = vax;
      this.apparentY = vay;
      const wl = windageLoad(def.windage, hy.lwl, vax, vay, this.windageOut);
      fx += wl.fx;
      fy += wl.fy;
      mx += wl.mx;
      my += wl.my;
      mz += wl.mz;
      let tx = wl.fx;
      let ty = wl.fy;
      if (def.sails) {
        const heelCos = Math.max(0, R[8]!);
        const sl = sailLoad(
          def.sails,
          vax,
          vay,
          this.sailSet,
          heelCos * heelCos,
          this.sailOut,
          this.sailBalanceX,
        );
        fx += sl.fx;
        fy += sl.fy;
        mx += sl.mx;
        my += sl.my;
        mz += sl.mz;
        tx += sl.fx;
        ty += sl.fy;
      }
      this.windForce = Math.hypot(tx, ty);
    }

    // 9. Gravity (world −z) in the body frame.
    const mg = hy.mass * g;
    fx -= mg * R[6]!;
    fy -= mg * R[7]!;
    fz -= mg * R[8]!;

    // 10. Coriolis/centripetal (translational, rigid + added mass) and gyroscopic terms.
    const A = hy.addedMass;
    const ax = (hy.mass + A[0]!) * s.u;
    const ay = (hy.mass + A[7]!) * s.v;
    const az = (hy.mass + A[14]!) * s.w;
    fx -= s.q * az - s.r * ay;
    fy -= s.r * ax - s.p * az;
    fz -= s.p * ay - s.q * ax;
    const hx = (hy.ixx + A[21]!) * s.p;
    const hY = (hy.iyy + A[28]!) * s.q;
    const hz = (hy.izz + A[35]!) * s.r;
    mx -= s.q * hz - s.r * hY;
    my -= s.r * hx - s.p * hz;
    mz -= s.p * hY - s.q * hx;

    const f = this.gen;
    f[0] = fx;
    f[1] = fy;
    f[2] = fz;
    f[3] = mx;
    f[4] = my;
    f[5] = mz;
  }

  // ------------------------------------------------------------------ outputs

  get kinematics(): VesselKinematics {
    const s = this.s;
    const R = s.rot;
    return {
      position: { x: s.px, y: s.py, z: s.pz },
      attitude: { ...this.q },
      velocity: {
        x: R[0]! * s.u + R[1]! * s.v + R[2]! * s.w,
        y: R[3]! * s.u + R[4]! * s.v + R[5]! * s.w,
        z: R[6]! * s.u + R[7]! * s.v + R[8]! * s.w,
      },
      angularVelocity: { x: s.p, y: s.q, z: s.r },
    };
  }

  /** Heel angle: angle between the body z axis and the vertical [deg]. */
  get heelDeg(): number {
    return Math.acos(Math.max(-1, Math.min(1, this.s.rot[8]!))) / DEG;
  }

  telemetry(): VesselTelemetry {
    const k = this.kinematics;
    const e = quatToEuler(this.q);
    return {
      ...k,
      id: this.id,
      rollDeg: e.roll / DEG,
      pitchDeg: e.pitch / DEG,
      headingDeg: headingFromYaw(e.yaw),
      heave: this.s.pz - this.equilibriumZ,
      speedKn: Math.hypot(k.velocity.x, k.velocity.y) / KNOT,
      rudderDeg: this.rudder / DEG,
      thrust: this.deliveredThrust,
      bowAccel: this.bowAccel,
      bridgeAccel: this.bridgeAccel,
      submergence: this.hull.volume / (this.definition.mass / this.hydro.rho),
      slamming: this.slamming,
      greenWater: this.greenWater,
      capsized: this.capsized,
      windSpeed: Math.hypot(this.windU, this.windV),
      windFromDeg: compassFrom(this.windU, this.windV),
      apparentWind: Math.hypot(this.apparentX, this.apparentY),
      apparentWindAngleDeg: Math.atan2(-this.apparentY, -this.apparentX) / DEG,
      windForce: this.windForce,
      sailSet: this.definition.sails ? this.sailSet : 0,
      braceDeg: this.sailOut.braceDeg,
      health: this.damage.health,
      disabled: this.damage.disabled,
      damageCause: this.damage.cause,
    };
  }

  /** Internal quantities for inspectors, plots and tests. */
  diagnostics(): VesselDiagnostics {
    const h = this.hull;
    return {
      substeps: this.substeps,
      wettedArea: h.wettedArea,
      displacedVolume: h.volume,
      hullForce: { x: h.fx, y: h.fy, z: h.fz },
      hullMoment: { x: h.mx, y: h.my, z: h.mz },
      waterVelocity: { x: h.waterU, y: h.waterV, z: h.waterW },
      slamVelocity: h.slamVelocity,
      throttle: this.throttle,
      waterColumnCalls: this.water.columnCalls,
    };
  }
}

/** Compass bearing [deg] a wind with world velocity (u, v) comes FROM. */
function compassFrom(u: number, v: number): number {
  if (Math.hypot(u, v) < 1e-9) return 0;
  // Air moving toward bearing b comes from b + 180; bearing of a vector = atan2(east, north).
  const toward = Math.atan2(u, v) / DEG;
  return (((toward + 180) % 360) + 360) % 360;
}

/** Row-major rotation matrix of q written into `out` (allocation-free `quatToMat3`). */
function writeRot(q: Quat, out: Float64Array): void {
  const { w, x, y, z } = q;
  out[0] = 1 - 2 * (y * y + z * z);
  out[1] = 2 * (x * y - w * z);
  out[2] = 2 * (x * z + w * y);
  out[3] = 2 * (x * y + w * z);
  out[4] = 1 - 2 * (x * x + z * z);
  out[5] = 2 * (y * z - w * x);
  out[6] = 2 * (x * z - w * y);
  out[7] = 2 * (y * z + w * x);
  out[8] = 1 - 2 * (x * x + y * y);
}
