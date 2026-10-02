/**
 * Public contract of the vessel module (consumed by the simulation, renderer and UI).
 *
 * Body frame: x forward, y to port, z up. ALL body-frame geometry is expressed relative to the
 * vessel's centre of gravity (CoG), so world = position + rotate(attitude, body).
 */
import type { Quat, Vec3 } from '../core/vec';
import type { VesselType } from '../schema/experiment';
import type { DamageCause } from './damage';

export interface TriangleMesh {
  /** xyz triples [m], body frame relative to CoG. */
  positions: Float32Array;
  /** Triangle vertex indices, counter-clockwise seen from outside (outward normals). */
  indices: Uint32Array;
}

/** Visual-only box (superstructure, wheelhouse, containers …) in body frame relative to CoG. */
export interface VisualBox {
  center: Vec3;
  size: Vec3;
  /** Material hint for the renderer. */
  material: VisualMaterial;
  /** Rotation about the vertical axis [deg] (e.g. a carrier's angled flight deck). */
  yawDeg?: number;
}

export type VisualMaterial =
  | 'hull'
  | 'deck'
  | 'superstructure'
  | 'glass'
  | 'cargo'
  | 'accent'
  | 'wood'
  | 'gold'
  | 'flightdeck'
  | 'sail'
  | 'flag';

/** Hull paint: below the boot top, the boot-top band and the topsides (sRGB hex). */
export interface HullPaint {
  bottom: number;
  boot: number;
  topside: number;
}

/**
 * Projected areas above the design waterline that catch the wind, and their centroids (body
 * frame relative to the CoG). Computed by rasterising the hull profile and the superstructure
 * onto the centre plane (lateral) and the midship section (frontal), so overlapping parts are
 * counted once.
 */
export interface WindageSpec {
  lateralArea: number;
  frontalArea: number;
  lateralCentre: Vec3;
  frontalCentreZ: number;
}

/** One mast of a square rig (body frame relative to CoG). */
export interface MastSpec {
  x: number;
  /** Foot (deck) and truck (top) heights. */
  zFoot: number;
  zTop: number;
  /** Square sails from the lowest course upward: yard height, half span, depth of the sail. */
  sails: { zYard: number; halfSpan: number; drop: number }[];
}

/**
 * Sail plan of a square-rigged ship. The sails are one aerodynamic surface of `area` acting at
 * `centre`; the crew braces the yards between `minBraceDeg` from the centre line and square.
 */
export interface SailPlan {
  area: number;
  centre: Vec3;
  minBraceDeg: number;
  masts: MastSpec[];
  /** Bowsprit tip (jib stay) for drawing. */
  bowsprit: Vec3;
}

export interface VesselDefinition {
  type: VesselType;
  displayName: string;
  description: string;
  /** Main dimensions [m] (after scaling). */
  length: number;
  beam: number;
  depth: number;
  /** Still-water equilibrium draft in the chosen loading condition [m]. */
  draft: number;
  /** Draft at the design load [m]; the boot-top paint line sits here. */
  designDraft: number;
  /** Mass [kg]. */
  mass: number;
  /** Principal moments of inertia about the CoG [kg·m²]. */
  inertia: Vec3;
  /** Vertical position of the CoG above the keel [m] (KG). */
  kg: number;
  /** Transverse metacentric height GM at design draft [m]. */
  gm: number;
  /** Watertight hull used for hydrostatics/hydrodynamics. */
  physicsHull: TriangleMesh;
  /** Smoother hull for display (may equal physicsHull). */
  renderHull: TriangleMesh;
  superstructure: VisualBox[];
  /** Maximum service speed [m/s]. */
  maxSpeed: number;

  // ---- Additional particulars (plain data, so definitions can cross a worker boundary) ----

  /** Reference points on the hull (body frame relative to CoG). */
  points: VesselPoints;
  propulsion: PropulsionSpec;
  /** Hydrostatic particulars at the design draft in the design water density. */
  hydrostatics: DesignHydrostatics;
  /** Indices of `physicsHull` vertices on the deck edge (green-water detection). */
  deckEdgeVertices: Uint32Array;
  windage: WindageSpec;
  /** Sail plan (sailing ships; they have no engine). */
  sails: SailPlan | null;
  paint: HullPaint;
  /**
   * Keel/deadwood fin aft of a traditional sailing hull (lateral area [m²] and its centre x,
   * body frame). It moves the centre of lateral resistance aft and makes the hull course-stable.
   */
  keelFin: { area: number; x: number } | null;
  /** Per-material colour overrides for the superstructure (sRGB hex). */
  palette: Partial<Record<VisualMaterial, number>>;
}

export interface VesselPoints {
  /** Bow accelerometer (on deck near the stem). */
  bow: Vec3;
  /** Bridge accelerometer (wheelhouse). */
  bridge: Vec3;
  /** Propeller hub centre. */
  propeller: Vec3;
  /** Rudder centre of effort. */
  rudder: Vec3;
}

export interface PropulsionSpec {
  /** Maximum effective ahead thrust (net of thrust deduction) [N]. */
  maxThrust: number;
  /** Astern thrust as a fraction of `maxThrust`. */
  asternFraction: number;
  /** Propeller diameter [m]. */
  propellerDiameter: number;
  /** Wake fraction w (inflow speed = (1 − w)·U). */
  wakeFraction: number;
  /** Engine/propeller thrust time constant [s]. */
  thrustTimeConstant: number;
  /** Rudder (movable) area [m²] and geometric aspect ratio (span / chord). */
  rudderArea: number;
  rudderAspectRatio: number;
  /** Maximum rudder angle [deg] and steering-gear rate [deg/s]. */
  maxRudderDeg: number;
  rudderRateDeg: number;
}

export interface DesignHydrostatics {
  /** Water density the design draft refers to [kg/m³]. */
  waterDensity: number;
  /** Displaced volume ∇ [m³]. */
  volume: number;
  /** Centre of buoyancy (body frame relative to CoG). */
  centreOfBuoyancy: Vec3;
  /** Waterline length and beam [m]; waterplane area [m²]; wetted surface [m²]. */
  waterlineLength: number;
  waterlineBeam: number;
  waterplaneArea: number;
  wettedArea: number;
  /** Block coefficient ∇ / (L_wl B_wl T). */
  blockCoefficient: number;
  /** KB, transverse BM, longitudinal BM [m]. */
  kb: number;
  bm: number;
  bmL: number;
  /** Righting-arm curve (free trim, constant displacement). */
  gzHeelDeg: number[];
  gz: number[];
  /** Angle of vanishing stability [deg]; 0 when GZ is never positive. */
  avsDeg: number;
}

export interface VesselCommand {
  /** Desired compass heading [deg] (autopilot). */
  headingDeg?: number;
  /** Desired speed through water [kn] (autopilot / speed governor). */
  speedKn?: number;
  autopilot?: boolean;
  /** Manual rudder angle [deg], positive = turn to port (used when autopilot is off). */
  rudderDeg?: number;
  /** Manual throttle −1…1 (used when autopilot is off). */
  throttle?: number;
  /** Restore health to 1 and bring a disabled vessel back into service. */
  repair?: boolean;
}

export type { DamageCause };

/** Horizontal hull footprint for collision tests (world frame, x east, y north). */
export interface HullFootprint {
  /** CoG position [m]. */
  x: number;
  y: number;
  /** Unit vector of the bow direction in the horizontal plane. */
  fx: number;
  fy: number;
  /** Half length and half beam of the hull rectangle [m]. */
  halfLength: number;
  halfBeam: number;
  /** Displacement mass [kg]. */
  mass: number;
  /** Horizontal CoG velocity [m/s]. */
  vx: number;
  vy: number;
}

/** Instantaneous kinematic state (CoG). */
export interface VesselKinematics {
  position: Vec3;
  attitude: Quat;
  /** World-frame linear velocity of the CoG [m/s]. */
  velocity: Vec3;
  /** Body-frame angular velocity [rad/s]. */
  angularVelocity: Vec3;
}

export interface VesselTelemetry extends VesselKinematics {
  id: string;
  /** Euler angles [deg] (roll + = starboard down, pitch + = bow down) and compass heading. */
  rollDeg: number;
  pitchDeg: number;
  headingDeg: number;
  /** CoG heave relative to its still-water equilibrium height [m]. */
  heave: number;
  /** Speed over ground [kn]. */
  speedKn: number;
  rudderDeg: number;
  /** Propeller thrust [N]. */
  thrust: number;
  /** Vertical acceleration at the bow/bridge [m/s²] (including gravity removed). */
  bowAccel: number;
  bridgeAccel: number;
  /** Fraction of hull volume currently submerged relative to design (1 = design). */
  submergence: number;
  /** Events during the last step. */
  slamming: boolean;
  greenWater: boolean;
  /** Heel beyond the angle of vanishing stability or inverted. */
  capsized: boolean;
  /** True wind at the vessel (10 m), speed [m/s] and compass bearing it comes FROM [deg]. */
  windSpeed: number;
  windFromDeg: number;
  /** Apparent wind speed [m/s] and angle off the bow [deg] (+ = from port). */
  apparentWind: number;
  apparentWindAngleDeg: number;
  /** Wind force on the vessel (above-water windage + sails), magnitude [N]. */
  windForce: number;
  /** Sails (sailing ships): fraction of canvas set 0–1 and yard brace angle [deg]. */
  sailSet: number;
  braceDeg: number;
  /** Structural health 0–1 (1 = intact, 0 = disabled). Stays 1 when damage is off. */
  health: number;
  /** Health 0: engine and steering dead, the vessel drifts until repaired. */
  disabled: boolean;
  /** Most recent significant cause of damage, cleared ~5 s after it stops; null = none. */
  damageCause: DamageCause | null;
}
