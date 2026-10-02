/** Vessel dynamics module: hull library, hydrostatics and 6-DOF seakeeping/manoeuvring. */
export type * from './api';
export { createVesselDefinition, PITCH_YAW_GYRADIUS, ROLL_GYRADIUS } from './definition';
export { Vessel, type VesselOffset, type VesselOptions } from './vessel';
export * as damage from './damage';
export { hullDesign, type HullDesign } from './hulls';
export {
  checkWatertight,
  loftHull,
  meshArea,
  meshBounds,
  meshVolume,
  type HullShape,
  type LoftOptions,
  type WatertightReport,
} from './mesh';
export {
  gzCurve,
  quatToMat3,
  sectionAt,
  solveFloating,
  submergedProperties,
  vanishingStabilityAngle,
  type SubmergedProperties,
} from './hydrostatics';
export { buildHydroModel, type HydroModel } from './hydroModel';
export { LocalWater, type Footprint } from './waterPatch';
export { HullForces, type RigidState } from './hullForces';
export { Autopilot } from './control';
export * as coefficients from './coefficients';
