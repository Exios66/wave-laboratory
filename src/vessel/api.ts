/**
 * Public contract of the vessel module (consumed by the simulation, renderer and UI).
 *
 * Body frame: x forward, y to port, z up. ALL body-frame geometry is expressed relative to the
 * vessel's centre of gravity (CoG), so world = position + rotate(attitude, body).
 */
import type { Quat, Vec3 } from '../core/vec';
import type { VesselType } from '../schema/experiment';

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
  material: 'hull' | 'deck' | 'superstructure' | 'glass' | 'cargo' | 'accent';
}

export interface VesselDefinition {
  type: VesselType;
  displayName: string;
  description: string;
  /** Main dimensions [m] (after scaling). */
  length: number;
  beam: number;
  depth: number;
  /** Design (still-water equilibrium) draft [m]. */
  draft: number;
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
}
