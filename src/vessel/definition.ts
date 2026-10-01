/**
 * Vessel definitions: hull geometry, loading condition and design particulars.
 *
 * Loading condition (fidelity L0):
 *  - the vessel floats at its design draft T on an even keel in sea water (ρ = 1025 kg/m³),
 *    so mass m = ρ ∇(T) and the CoG lies vertically above the centre of buoyancy (LCG = LCB);
 *  - KG = kgFactor · D (depth amidships);
 *  - radii of gyration k_xx = 0.38 B and k_yy = k_zz = 0.25 L_wl, the usual design values for
 *    merchant ships (ITTC 7.5-02-07-04.1 suggests 0.35–0.40 B and 0.24–0.26 L).
 * All body-frame geometry is translated so that the CoG is the origin.
 */
import { KNOT } from '../core/units';
import {
  SEAWATER_DENSITY,
  SEAWATER_KINEMATIC_VISCOSITY,
  STANDARD_GRAVITY,
} from '../core/constants';
import { quatIdentity, type Vec3 } from '../core/vec';
import type { VesselType } from '../schema/experiment';
import type { DesignHydrostatics, VesselDefinition, VisualBox } from './api';
import { calmWaterResistance, formFactor } from './coefficients';
import { hullDesign } from './hulls';
import { gzCurve, quatToMat3, submergedProperties, vanishingStabilityAngle } from './hydrostatics';
import { loftHull, meshBounds, transformMesh } from './mesh';

/** Radii of gyration as fractions of beam (roll) and waterline length (pitch, yaw). */
export const ROLL_GYRADIUS = 0.38;
export const PITCH_YAW_GYRADIUS = 0.25;

/** Heel angles of the stored GZ curve [deg]. */
const GZ_HEELS = Array.from({ length: 37 }, (_, i) => i * 5);

export function createVesselDefinition(
  type: VesselType,
  scale = 1,
  kgFactor = 0.6,
): VesselDefinition {
  const d = hullDesign(type);
  const s = scale;
  const rho = SEAWATER_DENSITY;
  const g = STANDARD_GRAVITY;
  const T = d.draft * s;
  const B = d.beam * s;
  const D = d.depth * s;

  const physicsKeel = loftHull(d.shape, d.physicsLoft);
  const renderKeel = loftHull(d.shape, d.renderLoft);
  const zero = { x: 0, y: 0, z: 0 };
  const scaledKeel = transformMesh(physicsKeel.mesh, s, zero);

  // Hydrostatics at the design draft in the keel frame (water plane at z = T).
  const ident = quatToMat3(quatIdentity());
  const keelProps = submergedProperties(scaledKeel, ident, { x: 0, y: 0, z: -T });
  const kg = kgFactor * D;
  const cog: Vec3 = { x: keelProps.centroid.x, y: 0, z: kg };

  const physicsHull = transformMesh(physicsKeel.mesh, s, cog);
  const renderHull = transformMesh(renderKeel.mesh, s, cog);
  // Recompute on the final (CoG-frame, float32) mesh so every number refers to it exactly.
  const props = submergedProperties(physicsHull, ident, { x: 0, y: 0, z: kg - T });
  const volume = props.volume;
  const mass = rho * volume;
  const lwl = props.wlMaxX - props.wlMinX;
  const bwl = props.wlMaxY - props.wlMinY;
  const kb = props.centroid.z + T; // centroid z is measured from the water plane; keel at −T
  const bm = props.wpIyy / volume;
  const bmL = props.wpIxx / volume;
  const gm = kb + bm - kg;
  const cb = volume / (lwl * bwl * T);

  const gz = gzCurve(physicsHull, volume, GZ_HEELS, lwl);
  const avsDeg = vanishingStabilityAngle(GZ_HEELS, gz);

  const bounds = meshBounds(physicsHull);
  const length = bounds.max.x - bounds.min.x;

  const inertia: Vec3 = {
    x: mass * (ROLL_GYRADIUS * B) ** 2,
    y: mass * (PITCH_YAW_GYRADIUS * lwl) ** 2,
    z: mass * (PITCH_YAW_GYRADIUS * lwl) ** 2,
  };

  // Propulsion sized so that full effective thrust balances calm-water resistance at the
  // service speed (thrust deduction is folded into the "effective" thrust).
  const maxSpeed = d.maxSpeedKn * KNOT * Math.sqrt(s); // Froude scaling of speed
  const k1 = formFactor(cb, lwl, bwl, T);
  const maxThrust = calmWaterResistance(maxSpeed, {
    wettedArea: props.wettedArea,
    length: lwl,
    formFactor: k1,
    rho,
    nu: SEAWATER_KINEMATIC_VISCOSITY,
    g,
  });

  const toBody = (p: Vec3): Vec3 => ({ x: p.x * s - cog.x, y: p.y * s, z: p.z * s - cog.z });
  const u = 0.93;
  const zBow = d.shape.deckHeight(u);
  const xBow = d.shape.xAft(zBow) + u * (d.shape.xFwd(zBow) - d.shape.xAft(zBow));
  const superstructure: VisualBox[] = d.superstructure.map((b) => ({
    center: toBody(b.center),
    size: { x: b.size.x * s, y: b.size.y * s, z: b.size.z * s },
    material: b.material,
  }));

  const hydrostatics: DesignHydrostatics = {
    waterDensity: rho,
    volume,
    centreOfBuoyancy: { x: props.centroid.x, y: props.centroid.y, z: props.centroid.z + T - kg },
    waterlineLength: lwl,
    waterlineBeam: bwl,
    waterplaneArea: props.waterplaneArea,
    wettedArea: props.wettedArea,
    blockCoefficient: cb,
    kb,
    bm,
    bmL,
    gzHeelDeg: GZ_HEELS.slice(),
    gz,
    avsDeg,
  };

  return {
    type,
    displayName: d.displayName,
    description: d.description,
    length,
    beam: B,
    depth: D,
    draft: T,
    mass,
    inertia,
    kg,
    gm,
    physicsHull,
    renderHull,
    superstructure,
    maxSpeed,
    points: {
      bow: toBody({ x: xBow, y: 0, z: zBow }),
      bridge: toBody(d.bridge),
      propeller: toBody({ x: d.propeller.x, y: 0, z: d.propeller.z }),
      rudder: toBody({ x: d.rudder.x, y: 0, z: d.rudder.z }),
    },
    propulsion: {
      maxThrust,
      asternFraction: 0.6,
      propellerDiameter: d.propeller.diameter * s,
      wakeFraction: d.propeller.wake,
      thrustTimeConstant: d.propeller.timeConstant * Math.sqrt(s),
      rudderArea: d.rudder.area * s * s,
      rudderAspectRatio: d.rudder.aspect,
      maxRudderDeg: 35,
      rudderRateDeg: d.rudder.rateDeg,
    },
    hydrostatics,
    deckEdgeVertices: physicsKeel.deckEdge,
  };
}
