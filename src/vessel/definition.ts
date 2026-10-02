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
import type {
  DesignHydrostatics,
  HullPaint,
  SailPlan,
  VesselDefinition,
  VisualBox,
  WindageSpec,
} from './api';
import { calmWaterResistance, formFactor } from './coefficients';
import { hullDesign, type HullDesign } from './hulls';
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
  // Sailing ships have no engine: the sails are their propulsion.
  const sailing = d.rig !== undefined;
  const maxThrust = sailing
    ? 0
    : calmWaterResistance(maxSpeed, {
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
    ...(b.yawDeg !== undefined ? { yawDeg: b.yawDeg } : {}),
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
    windage: scaleWindage(designWindage(d), s, toBody),
    sails: d.rig ? sailPlan(d.rig, s, toBody) : null,
    paint: d.paint ?? DEFAULT_PAINT,
    keelFin: d.keelFin
      ? {
          area: d.keelFin.areaFraction * lwl * T,
          x: props.wlMinX + (0.5 + d.keelFin.xFraction) * lwl,
        }
      : null,
    palette: { ...d.palette },
  };
}

const DEFAULT_PAINT: HullPaint = { bottom: 0x7f1d1d, boot: 0x1c1917, topside: 0x1e3a5f };

/**
 * Projected wind areas of a design at scale 1 (keel frame). The hull profile above the design
 * waterline and every superstructure box are rasterised onto the centre plane (lateral) and
 * the midship section (frontal), so overlaps are counted once.
 */
export function designWindage(d: HullDesign): WindageSpec {
  const T = d.draft;
  const shape = d.shape;
  const xAt = (u: number, z: number) => shape.xAft(z) + u * (shape.xFwd(z) - shape.xAft(z));
  // Extents.
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMax = d.beam / 2;
  let zMax = T;
  const boxes = d.superstructure.map((b) => {
    const yaw = ((b.yawDeg ?? 0) * Math.PI) / 180;
    const c = Math.abs(Math.cos(yaw));
    const sn = Math.abs(Math.sin(yaw));
    const hx = (c * b.size.x + sn * b.size.y) / 2;
    const hy = (sn * b.size.x + c * b.size.y) / 2;
    return {
      x0: b.center.x - hx,
      x1: b.center.x + hx,
      y0: b.center.y - hy,
      y1: b.center.y + hy,
      z0: Math.max(T, b.center.z - b.size.z / 2),
      z1: b.center.z + b.size.z / 2,
    };
  });
  for (let i = 0; i <= 200; i++) {
    const u = i / 200;
    const deck = shape.deckHeight(u);
    xMin = Math.min(xMin, xAt(u, T), xAt(u, deck));
    xMax = Math.max(xMax, xAt(u, T), xAt(u, deck));
    zMax = Math.max(zMax, deck);
  }
  for (const b of boxes) {
    if (b.z1 <= T) continue;
    xMin = Math.min(xMin, b.x0);
    xMax = Math.max(xMax, b.x1);
    yMax = Math.max(yMax, Math.abs(b.y0), Math.abs(b.y1));
    zMax = Math.max(zMax, b.z1);
  }
  const cell = Math.max(0.05, (xMax - xMin) / 500);
  const nx = Math.ceil((xMax - xMin) / cell) + 1;
  const ny = Math.ceil((2 * yMax) / cell) + 1;
  const nz = Math.ceil((zMax - T) / cell) + 1;
  const lat = new Uint8Array(nx * nz);
  const fro = new Uint8Array(ny * nz);
  const fill = (mask: Uint8Array, n: number, a0: number, a1: number, z0: number, z1: number) => {
    const i0 = Math.max(0, Math.floor(a0 / cell));
    const i1 = Math.min(n - 1, Math.ceil(a1 / cell) - 1);
    const k0 = Math.max(0, Math.floor((z0 - T) / cell));
    const k1 = Math.min(nz - 1, Math.ceil((z1 - T) / cell) - 1);
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) mask[k * n + i] = 1;
  };
  // Hull profile: vertical strips from the waterline to the deck.
  for (let i = 0; i < 600; i++) {
    const u = (i + 0.5) / 600;
    const deck = shape.deckHeight(u);
    for (let k = 0; k < 8; k++) {
      const z = T + ((k + 0.5) / 8) * (deck - T);
      const x = xAt(u, z) - xMin;
      fill(lat, nx, x - cell, x + cell, z - (deck - T) / 16, z + (deck - T) / 16);
    }
  }
  // Hull section: widest half-breadth at each height.
  for (let k = 0; k < nz; k++) {
    const z = T + (k + 0.5) * cell;
    let hw = 0;
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      if (z <= shape.deckHeight(u)) hw = Math.max(hw, shape.halfBreadth(u, z));
    }
    if (hw > 0) fill(fro, ny, yMax - hw, yMax + hw, z - cell / 2, z + cell / 2);
  }
  for (const b of boxes) {
    if (b.z1 <= T) continue;
    fill(lat, nx, b.x0 - xMin, b.x1 - xMin, b.z0, b.z1);
    fill(fro, ny, b.y0 + yMax, b.y1 + yMax, b.z0, b.z1);
  }
  let aL = 0;
  let sx = 0;
  let sz = 0;
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      if (!lat[k * nx + i]) continue;
      aL += 1;
      sx += xMin + (i + 0.5) * cell;
      sz += T + (k + 0.5) * cell;
    }
  }
  let aF = 0;
  let fz = 0;
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < ny; i++) {
      if (!fro[k * ny + i]) continue;
      aF += 1;
      fz += T + (k + 0.5) * cell;
    }
  }
  return {
    lateralArea: aL * cell * cell,
    frontalArea: aF * cell * cell,
    lateralCentre: { x: aL ? sx / aL : 0, y: 0, z: aL ? sz / aL : T },
    frontalCentreZ: aF ? fz / aF : T,
  };
}

function scaleWindage(w: WindageSpec, s: number, toBody: (p: Vec3) => Vec3): WindageSpec {
  const c = toBody(w.lateralCentre);
  return {
    lateralArea: w.lateralArea * s * s,
    frontalArea: w.frontalArea * s * s,
    lateralCentre: c,
    frontalCentreZ: toBody({ x: 0, y: 0, z: w.frontalCentreZ }).z,
  };
}

function sailPlan(
  rig: NonNullable<HullDesign['rig']>,
  s: number,
  toBody: (p: Vec3) => Vec3,
): SailPlan {
  let area = 0;
  let cx = 0;
  let cz = 0;
  for (const m of rig.masts) {
    for (const sail of m.sails) {
      const a = 2 * sail.halfSpan * sail.drop;
      area += a;
      cx += a * m.x;
      cz += a * (sail.zYard - sail.drop / 2);
    }
  }
  const centre = toBody({ x: cx / area, y: 0, z: cz / area });
  return {
    area: area * s * s,
    centre,
    minBraceDeg: rig.minBraceDeg,
    bowsprit: toBody(rig.bowsprit),
    masts: rig.masts.map((m) => ({
      x: toBody({ x: m.x, y: 0, z: 0 }).x,
      zFoot: toBody({ x: 0, y: 0, z: m.zFoot }).z,
      zTop: toBody({ x: 0, y: 0, z: m.zTop }).z,
      sails: m.sails.map((sl) => ({
        zYard: toBody({ x: 0, y: 0, z: sl.zYard }).z,
        halfSpan: sl.halfSpan * s,
        drop: sl.drop * s,
      })),
    })),
  };
}
