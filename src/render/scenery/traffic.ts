/**
 * Ambient passerby naval traffic, offshore static architecture and opt-in pirate luggers.
 *
 * Purely visual (scenery never touches wave forces or experiment state):
 *  - Phase 1 working fleets: fishing trawlers in circular/dredge grounds, cargo ships on
 *    merchant lanes, and patrol boats on station rounds;
 *  - Phase 2 big tonnage & static architecture: cruise liners (multi-tier superstructure on a
 *    fine hull), VLCC oil tankers, rare aircraft carriers, and hash-grid offshore rig fields
 *    (oil platforms with night flare + beacon, wind turbines, sea buoys);
 *  - Phase 3 opt-in pirates (`ambience.hostiles`, off by default): a square-rigged lugger
 *    approaches from the horizon, parallels the player vessel, and peels off (always despawning
 *    cleanly beyond 500 m).
 *
 * Placement & routing live in pure functions (`trafficInCell`, `trafficNear`, `structuresInCell`,
 * `structuresNear`, `stepHostileEncounter`) so they are unit-tested in Node without WebGL.
 *
 * Rendering is one vertex-coloured `InstancedMesh` per hull class and per structure kind (7 + 3;
 * the renderer skips empty ones, so a typical frame draws a handful) plus a single shared additive
 * point pass for night navigation lights, deck lamps, rig flares and beacons, respecting the
 * `TRAFFIC_BUDGET` / `STRUCTURE_BUDGET` caps (`full`: 12 hulls / 3 rig cells, `mid`: 8 / 2,
 * `lite`: 4 / 0). The tier comes from the device-capped quality (`LabRenderer`), see AMBIENCE.md.
 *
 * Routing guarantees (all unit-tested): a route is a pure function of the cell and time (calm only
 * gates visibility, never time), stays inside its own grid cell, keeps clear of the origin zone,
 * islands and rigs, and is continuous in position and heading. Fishing fleets share one circle at
 * even phase spacing and lanes are racetracks with rounded ends, so hulls never overlap.
 *
 * Coordinates: world (x east, y north, z up) maps to Three.js as (x, z, −y).
 */
import * as THREE from 'three';
import { smoothstep } from '../../core/mathUtil';
import { mulberry32 } from '../../core/rng';
import type { VesselType } from '../../schema/experiment';
import type { VisualBox, VisualMaterial } from '../../vessel/api';
import { hullDesign, type HullDesign } from '../../vessel/hulls';
import { loftHull } from '../../vessel/mesh';
import type { WakeSource } from '../scene/wakes';
import { ISLAND_CLEAR_RADIUS, islandsNear } from './islands';
import type { SceneryFrame, SceneryLayer, SceneryTier } from './types';
import { KN, type WildVessel } from './wildlife';

// ---------------------------------------------------------------------------------------------
// Budget & constants
// ---------------------------------------------------------------------------------------------

export const TRAFFIC_CELL = 1800;
export const TRAFFIC_VIEW_RANGE = 5200;
export const TRAFFIC_CLEAR_RADIUS = ISLAND_CLEAR_RADIUS + 180;

export const STRUCTURE_CELL = 2400;
export const STRUCTURE_VIEW_RANGE = 5500;
export const STRUCTURE_CLEAR_RADIUS = ISLAND_CLEAR_RADIUS + 260;

/** Hard cap per tier on active background traffic ships. */
export const TRAFFIC_BUDGET: Record<SceneryTier, number> = {
  full: 12,
  mid: 8,
  lite: 4,
};

/** Hard cap per tier on live static offshore structure cells. */
export const STRUCTURE_BUDGET: Record<SceneryTier, number> = {
  full: 3,
  mid: 2,
  lite: 0,
};

export type TrafficKind =
  'trawler' | 'cargo' | 'patrol' | 'liner' | 'tanker' | 'carrier' | 'pirate';

export type TrafficPattern = 'orbit' | 'lane';

export interface TrafficShipSpec {
  id: string;
  kind: TrafficKind;
  pattern: TrafficPattern;
  /** Anchor centre in world coordinates [m]. */
  cx: number;
  cy: number;
  /** Orbit radius [m] or half-lane length [m]. */
  span: number;
  /** Base heading [rad] (lane direction) or orbit angular direction (+1 / −1). */
  heading: number;
  turnDir: 1 | -1;
  /** Nominal speed in fair weather [m/s]. */
  speed: number;
  phase: number;
  length: number;
  beam: number;
  height: number;
  seed: number;
  /** Minimum calm [0–1] below which this vessel hauls nets / heads for shelter. */
  shelterCalm: number;
}

export interface TrafficShipPose {
  id: string;
  kind: TrafficKind;
  /** World coordinates [m]. */
  x: number;
  y: number;
  /** Heading in world coordinates [rad] (0 = +x east, π/2 = +y north). */
  heading: number;
  /** Speed through the water [m/s]. */
  speed: number;
  /** Heave [m], pitch [rad, nose up], roll [rad, starboard down]. */
  heave: number;
  pitch: number;
  roll: number;
  length: number;
  beam: number;
  height: number;
  /** True when trawling nets are deployed (fair daytime/dusk weather). */
  working: boolean;
}

const TRAFFIC_SALT = 0x7a4f1c23;
const STRUCTURE_SALT = 0x91ef04a7;

function hash2(ix: number, iy: number, salt: number): number {
  let h = Math.imul((salt ^ ix) | 0, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h ^ (iy | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function wrapAngle(a: number): number {
  const tau = Math.PI * 2;
  return a - tau * Math.floor((a + Math.PI) / tau);
}

/**
 * Grid cells are pure functions of their indices and never change, but a 5 km view spans a few
 * hundred of them every frame — so keep the answers and hand out the same arrays each time.
 */
const cellCache = new Map<string, unknown>();

function cellSpec<T>(key: string, build: () => T): T {
  if (!cellCache.has(key)) cellCache.set(key, build());
  return cellCache.get(key) as T;
}

const CLASS_DIMS: Record<
  TrafficKind,
  { length: number; beam: number; height: number; kn: number }
> = {
  trawler: { length: 25, beam: 7.2, height: 10, kn: 7.5 },
  cargo: { length: 118, beam: 20, height: 26, kn: 13.5 },
  patrol: { length: 30, beam: 6.4, height: 9, kn: 20 },
  liner: { length: 165, beam: 24, height: 36, kn: 16 },
  tanker: { length: 240, beam: 44, height: 28, kn: 11.5 },
  carrier: { length: 280, beam: 58, height: 34, kn: 22 },
  pirate: { length: 34, beam: 9, height: 28, kn: 9.5 },
};

/** Clear of origin, any island / lagoon and any offshore structure within `margin` metres. */
function clearWater(x: number, y: number, margin: number): boolean {
  if (Math.hypot(x, y) < TRAFFIC_CLEAR_RADIUS + margin) return false;
  if (islandsNear(x, y, margin + 80).length > 0) return false;
  const sx = Math.floor(x / STRUCTURE_CELL);
  const sy = Math.floor(y / STRUCTURE_CELL);
  for (let iy = sy - 1; iy <= sy + 1; iy++) {
    for (let ix = sx - 1; ix <= sx + 1; ix++) {
      const cell = structuresInCell(ix, iy);
      if (!cell) continue;
      for (const it of cell.items) {
        if (Math.hypot(it.x - x, it.y - y) < margin + 40) return false;
      }
    }
  }
  return true;
}

/** Turn radius of the rounded ends of a shipping lane [m] (half the lane separation). */
export const LANE_TURN_RADIUS = 80;
/** Extra clearance kept between a ship's route and its grid cell edge [m]. */
const CELL_EDGE_MARGIN = 20;

/** Distance from `(x, y)` to the nearest edge of its traffic cell [m]. */
function cellEdgeDistance(x: number, y: number): number {
  const fx = x / TRAFFIC_CELL - Math.floor(x / TRAFFIC_CELL);
  const fy = y / TRAFFIC_CELL - Math.floor(y / TRAFFIC_CELL);
  return Math.min(fx, 1 - fx, fy, 1 - fy) * TRAFFIC_CELL;
}

/** True when the whole racetrack lane (end to end, `span` long) around `(cx, cy)` is open water. */
function laneClear(cx: number, cy: number, heading: number, span: number, margin: number): boolean {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const n = 8;
  for (let k = 0; k <= n; k++) {
    const u = (k / n - 0.5) * span;
    if (!clearWater(cx + c * u, cy + s * u, margin)) return false;
  }
  return true;
}

/**
 * Deterministic ships assigned to grid cell (ix, iy). Fishing grounds hold 2–3 trawlers in
 * working circles; shipping lanes carry cargo ships, tankers, liners, patrol boats or a rare
 * carrier escort.
 */
export function trafficInCell(ix: number, iy: number): TrafficShipSpec[] {
  return cellSpec(`t${ix}:${iy}`, () => buildTrafficCell(ix, iy));
}

function buildTrafficCell(ix: number, iy: number): TrafficShipSpec[] {
  const seed = hash2(ix, iy, TRAFFIC_SALT);
  const rnd = mulberry32(seed);
  if (rnd() > 0.52) return [];
  const cx = (ix + 0.25 + 0.5 * rnd()) * TRAFFIC_CELL;
  const cy = (iy + 0.25 + 0.5 * rnd()) * TRAFFIC_CELL;
  if (!clearWater(cx, cy, 260)) return [];

  const roll = rnd();
  const out: TrafficShipSpec[] = [];
  if (roll < 0.42) {
    // Fishing fleet ground: 2-3 trawlers sharing one working circle. Same centre, radius,
    // speed and sense, evenly spaced in phase, so hulls keep a constant separation of at
    // least 2*pi*r/count (> 200 m) and can never overlap each other.
    const count = 2 + (rnd() < 0.45 ? 1 : 0);
    const r = 110 + rnd() * 90;
    const turnDir: 1 | -1 = rnd() < 0.5 ? 1 : -1;
    const d = CLASS_DIMS.trawler;
    const speed = d.kn * KN * (0.85 + 0.3 * rnd());
    const phase0 = rnd() * Math.PI * 2;
    if (!clearWater(cx, cy, r + d.length)) return [];
    for (let k = 0; k < count; k++) {
      out.push({
        id: `trawler:${ix}:${iy}:${k}`,
        kind: 'trawler',
        pattern: 'orbit',
        cx,
        cy,
        span: r,
        heading: phase0,
        turnDir,
        speed,
        phase: phase0 + (k / count) * Math.PI * 2,
        length: d.length,
        beam: d.beam,
        height: d.height,
        seed: hash2(ix * 16 + k, iy, TRAFFIC_SALT ^ 1),
        shelterCalm: 0.28 + 0.14 * rnd(),
      });
    }
    return out;
  }

  if (roll < 0.62) {
    // Patrol boat station round.
    const d = CLASS_DIMS.patrol;
    const patrolSpan = 240 + rnd() * 140;
    if (!clearWater(cx, cy, patrolSpan + d.length)) return [];
    out.push({
      id: `patrol:${ix}:${iy}`,
      kind: 'patrol',
      pattern: 'orbit',
      cx,
      cy,
      span: patrolSpan,
      heading: rnd() * Math.PI * 2,
      turnDir: rnd() < 0.5 ? 1 : -1,
      speed: d.kn * KN * (0.85 + 0.25 * rnd()),
      phase: rnd() * Math.PI * 2,
      length: d.length,
      beam: d.beam,
      height: d.height,
      seed: seed ^ 2,
      shelterCalm: 0.15,
    });
    return out;
  }

  // Deep-water lane: merchant cargo, cruise liner, oil tanker, or rare carrier group.
  const laneHeading = rnd() * Math.PI * 2;
  const rawSpan = 650 + rnd() * 350;
  const laneRoll = rnd();
  const kind: TrafficKind =
    laneRoll < 0.48 ? 'cargo' : laneRoll < 0.72 ? 'liner' : laneRoll < 0.93 ? 'tanker' : 'carrier';
  const d = CLASS_DIMS[kind];
  // The racetrack (and the carrier's escort station beside it) must stay inside this cell,
  // clear of its edge by the hull's half length, so lanes of neighbouring cells never overlap.
  const escortOffset = kind === 'carrier' ? 140 : 0;
  const reach = cellEdgeDistance(cx, cy) - d.length * 0.5 - CELL_EDGE_MARGIN - escortOffset;
  const span = Math.min(rawSpan, 2 * reach);
  if (span * 0.5 - LANE_TURN_RADIUS < 40) return [];
  if (!laneClear(cx, cy, laneHeading, span, 260 + escortOffset)) return [];
  out.push({
    id: `${kind}:${ix}:${iy}:0`,
    kind,
    pattern: 'lane',
    cx,
    cy,
    span,
    heading: laneHeading,
    turnDir: 1,
    speed: d.kn * KN * (0.9 + 0.2 * rnd()),
    phase: rnd() * Math.PI * 2,
    length: d.length,
    beam: d.beam,
    height: d.height,
    seed: seed ^ 3,
    shelterCalm: kind === 'liner' ? 0.32 : 0.18,
  });
  // Carrier flagship travels with a patrol escort.
  if (kind === 'carrier') {
    const ed = CLASS_DIMS.patrol;
    const side = -Math.sin(laneHeading) * escortOffset;
    const sideY = Math.cos(laneHeading) * escortOffset;
    if (laneClear(cx + side, cy + sideY, laneHeading, span, 260)) {
      out.push({
        id: `escort:${ix}:${iy}:1`,
        kind: 'patrol',
        pattern: 'lane',
        cx: cx + side,
        cy: cy + sideY,
        span,
        heading: laneHeading,
        turnDir: 1,
        speed: out[0]!.speed,
        phase: out[0]!.phase,
        length: ed.length,
        beam: ed.beam,
        height: ed.height,
        seed: seed ^ 4,
        shelterCalm: 0.12,
      });
    }
  }
  return out;
}

/**
 * Point on a racetrack lane `path` metres along its loop (period `4H + 2*pi*R` with
 * `H = span/2 - R`): out along +heading on the starboard-lateral leg, a half circle of radius
 * `LANE_TURN_RADIUS` round the far end, back on the other leg and round the near end. Position,
 * heading and turn rate are all continuous, so the ship never snaps round at the lane ends.
 */
function lanePoint(span: number, path: number): { u: number; v: number; dir: number; k: number } {
  const R = LANE_TURN_RADIUS;
  const H = Math.max(span * 0.5 - R, 1);
  const arc = Math.PI * R;
  const total = 4 * H + 2 * arc;
  const s = ((path % total) + total) % total;
  if (s < 2 * H) return { u: -H + s, v: -R, dir: 0, k: 0 };
  if (s < 2 * H + arc) {
    const a = -Math.PI / 2 + (s - 2 * H) / R;
    return { u: H + R * Math.cos(a), v: R * Math.sin(a), dir: a + Math.PI / 2, k: 1 / R };
  }
  if (s < 4 * H + arc) return { u: H - (s - 2 * H - arc), v: R, dir: Math.PI, k: 0 };
  const a = Math.PI / 2 + (s - 4 * H - arc) / R;
  return { u: -H + R * Math.cos(a), v: R * Math.sin(a), dir: a + Math.PI / 2, k: 1 / R };
}

/**
 * Evaluate a background ship's kinematic pose at time `t` [s] and weather `calm` [0–1].
 * As `calm` drops below `spec.shelterCalm` working vessels haul nets, and once it falls further
 * the ship has reached shelter and is gone (`null`); the route itself never depends on weather.
 */
export function evaluateTrafficShip(
  spec: TrafficShipSpec,
  t: number,
  calm: number,
  hs: number,
): TrafficShipPose | null {
  const weatherGate = smoothstep(spec.shelterCalm * 0.45, spec.shelterCalm + 0.2, calm);
  if (weatherGate <= 0.02) return null;
  // Routes advance at the ship's nominal speed so a pose is a pure function of `t` and the
  // route: calm only gates visibility and nets, it never rescales time (which would teleport
  // every ship whenever the weather slider moves).
  const speed = spec.speed;
  let x: number;
  let y: number;
  let heading: number;
  let turnRate = 0;

  if (spec.pattern === 'orbit') {
    const r = Math.max(40, spec.span);
    const omega = (spec.turnDir * speed) / r;
    const th = spec.phase + omega * t;
    x = spec.cx + Math.cos(th) * r;
    y = spec.cy + Math.sin(th) * r;
    heading = wrapAngle(th + spec.turnDir * (Math.PI / 2));
    turnRate = omega;
  } else {
    const total =
      4 * Math.max(spec.span * 0.5 - LANE_TURN_RADIUS, 1) + 2 * Math.PI * LANE_TURN_RADIUS;
    const p = lanePoint(spec.span, (spec.phase / (Math.PI * 2)) * total + speed * t);
    const c = Math.cos(spec.heading);
    const sn = Math.sin(spec.heading);
    x = spec.cx + c * p.u - sn * p.v;
    y = spec.cy + sn * p.u + c * p.v;
    heading = wrapAngle(spec.heading + p.dir);
    turnRate = p.k * speed;
  }

  // Kinematic wave response: scaled to hull length so big ships pitch slowly and small craft bob.
  const sizeScale = Math.sqrt(30 / Math.max(spec.length, 15));
  const freq = 0.65 + 0.35 * sizeScale;
  const ph = t * freq + (spec.seed & 0xff) * 0.17;
  const hEff = Math.min(hs, 6);
  const heave = 0.22 * hEff * sizeScale * Math.sin(ph);
  const pitch = 0.035 * hEff * sizeScale * Math.cos(ph + 0.4);
  const waveRoll = 0.065 * hEff * sizeScale * Math.sin(ph * 0.83 + 1.1);
  const turnHeel = -Math.atan((speed * turnRate) / 9.81) * 1.4;
  const roll = waveRoll + turnHeel;

  return {
    id: spec.id,
    kind: spec.kind,
    x,
    y,
    heading,
    speed,
    heave,
    pitch,
    roll,
    length: spec.length,
    beam: spec.beam,
    height: spec.height,
    working: spec.kind === 'trawler' && calm >= spec.shelterCalm,
  };
}

/**
 * Active background traffic poses within `radius` of world `(x, y)`, nearest first and capped
 * by the tier's `maxHulls` budget.
 */
export function trafficNear(
  x: number,
  y: number,
  t: number,
  calm: number,
  hs: number,
  tier: SceneryTier = 'full',
  radius = TRAFFIC_VIEW_RANGE,
): TrafficShipPose[] {
  const cap = TRAFFIC_BUDGET[tier];
  if (cap <= 0) return [];
  const reach = radius + TRAFFIC_CELL * 0.75;
  const ix0 = Math.floor((x - reach) / TRAFFIC_CELL);
  const ix1 = Math.floor((x + reach) / TRAFFIC_CELL);
  const iy0 = Math.floor((y - reach) / TRAFFIC_CELL);
  const iy1 = Math.floor((y + reach) / TRAFFIC_CELL);
  const found: { pose: TrafficShipPose; d: number }[] = [];
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      for (const spec of trafficInCell(ix, iy)) {
        const pose = evaluateTrafficShip(spec, t, calm, hs);
        if (!pose) continue;
        const d = Math.hypot(pose.x - x, pose.y - y);
        if (d <= radius) found.push({ pose, d });
      }
    }
  }
  found.sort((a, b) => a.d - b.d);
  return found.slice(0, cap).map((f) => f.pose);
}

// ---------------------------------------------------------------------------------------------
// Phase 2: Static offshore architecture (rigs, wind farms, sea buoys)
// ---------------------------------------------------------------------------------------------

export type StructureKind = 'oil-rig' | 'wind-turbine' | 'buoy';

export interface StructureItem {
  id: string;
  kind: StructureKind;
  x: number;
  y: number;
  yaw: number;
  scale: number;
  seed: number;
}

export interface StructureCellSpec {
  key: string;
  cx: number;
  cy: number;
  items: StructureItem[];
}

export function structuresInCell(ix: number, iy: number): StructureCellSpec | null {
  return cellSpec<StructureCellSpec | null>(`s${ix}:${iy}`, () => buildStructureCell(ix, iy));
}

function buildStructureCell(ix: number, iy: number): StructureCellSpec | null {
  const seed = hash2(ix, iy, STRUCTURE_SALT);
  const rnd = mulberry32(seed);
  if (rnd() > 0.34) return null;
  const cx = (ix + 0.3 + 0.4 * rnd()) * STRUCTURE_CELL;
  const cy = (iy + 0.3 + 0.4 * rnd()) * STRUCTURE_CELL;
  if (Math.hypot(cx, cy) < STRUCTURE_CLEAR_RADIUS) return null;
  if (islandsNear(cx, cy, 420).length > 0) return null;

  const items: StructureItem[] = [];
  const kindRoll = rnd();
  if (kindRoll < 0.46) {
    // Offshore oil platform + standby guard buoy.
    items.push({
      id: `rig:${ix}:${iy}`,
      kind: 'oil-rig',
      x: cx,
      y: cy,
      yaw: rnd() * Math.PI * 2,
      scale: 0.95 + 0.2 * rnd(),
      seed,
    });
    const ba = rnd() * Math.PI * 2;
    items.push({
      id: `buoy:${ix}:${iy}:0`,
      kind: 'buoy',
      x: cx + Math.cos(ba) * 140,
      y: cy + Math.sin(ba) * 140,
      yaw: 0,
      scale: 1,
      seed: seed ^ 11,
    });
  } else {
    // Offshore wind farm array (3–4 turbines on a row + cardinal mark buoy).
    const count = 3 + (rnd() < 0.5 ? 1 : 0);
    const rowAng = rnd() * Math.PI * 2;
    const spacing = 150;
    for (let k = 0; k < count; k++) {
      const off = (k - (count - 1) / 2) * spacing;
      items.push({
        id: `turbine:${ix}:${iy}:${k}`,
        kind: 'wind-turbine',
        x: cx + Math.cos(rowAng) * off,
        y: cy + Math.sin(rowAng) * off,
        yaw: rowAng + Math.PI / 2,
        scale: 0.95 + 0.15 * rnd(),
        seed: hash2(ix * 8 + k, iy, STRUCTURE_SALT ^ 7),
      });
    }
    items.push({
      id: `buoy:${ix}:${iy}:mark`,
      kind: 'buoy',
      x: cx - Math.sin(rowAng) * 120,
      y: cy + Math.cos(rowAng) * 120,
      yaw: 0,
      scale: 1,
      seed: seed ^ 19,
    });
  }
  return { key: `${ix}:${iy}`, cx, cy, items };
}

/**
 * Live offshore structure cells within `radius` of world `(x, y)`, nearest first and capped by
 * `STRUCTURE_BUDGET[tier]`.
 */
export function structuresNear(
  x: number,
  y: number,
  tier: SceneryTier = 'full',
  radius = STRUCTURE_VIEW_RANGE,
): StructureCellSpec[] {
  const cap = STRUCTURE_BUDGET[tier];
  if (cap <= 0) return [];
  const reach = radius + STRUCTURE_CELL * 0.6;
  const ix0 = Math.floor((x - reach) / STRUCTURE_CELL);
  const ix1 = Math.floor((x + reach) / STRUCTURE_CELL);
  const iy0 = Math.floor((y - reach) / STRUCTURE_CELL);
  const iy1 = Math.floor((y + reach) / STRUCTURE_CELL);
  const found: { cell: StructureCellSpec; d: number }[] = [];
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const cell = structuresInCell(ix, iy);
      if (!cell) continue;
      const d = Math.hypot(cell.cx - x, cell.cy - y);
      if (d <= radius) found.push({ cell, d });
    }
  }
  found.sort((a, b) => a.d - b.d);
  return found.slice(0, cap).map((f) => f.cell);
}

/** Beacon flash intensity [0–1] at time `t` for a structure with `seed`. */
export function structureBeaconIntensity(t: number, seed: number, calm: number): number {
  const period = 3.2 + (seed & 7) * 0.25;
  const phase = (((t / period + (seed >>> 8) / 65536) % 1) + 1) % 1;
  const pulse = Math.pow(Math.max(0, Math.sin(phase * Math.PI * 2)), 8);
  const stormBoost = 0.65 + 0.35 * (1 - calm);
  return pulse * stormBoost;
}

// ---------------------------------------------------------------------------------------------
// Phase 3: Opt-in Pirate Lugger Encounter State Machine (pure)
// ---------------------------------------------------------------------------------------------

export type HostileStage = 'idle' | 'approaching' | 'paralleling' | 'peeling';

export const HOSTILE_DESPAWN_RANGE = 500;
export const HOSTILE_SPAWN_RANGE = 460;
/** How far abeam the lugger shadows the vessel, [m]. */
export const HOSTILE_STATION_RANGE = 55;

export interface HostileState {
  stage: HostileStage;
  x: number;
  y: number;
  heading: number;
  speed: number;
  /** Seconds spent in the current stage. */
  stageT: number;
  /** Seconds until the next ambush attempt when idle. */
  cooldown: number;
  /** Unit vector across the vessel, pointing to the station the lugger shadows. */
  stationX: number;
  stationY: number;
  seed: number;
}

export function createHostileState(seed = 0x5012a7e): HostileState {
  return {
    stage: 'idle',
    x: 0,
    y: 0,
    heading: 0,
    speed: 0,
    stageT: 0,
    cooldown: 8,
    stationX: 0,
    stationY: 1,
    seed,
  };
}

/**
 * Advance the opt-in pirate lugger encounter by `dt` seconds around `target` (world x, y, heading).
 * Guarantees hard despawn when disabled, on `lite` tier, or whenever distance exceeds
 * `HOSTILE_DESPAWN_RANGE` (500 m).
 */
export function stepHostileEncounter(
  state: HostileState,
  dt: number,
  enabled: boolean,
  tier: SceneryTier,
  target: { x: number; y: number; heading: number; speed: number },
  hs: number,
): TrafficShipPose | null {
  if (!enabled || tier === 'lite') {
    state.stage = 'idle';
    state.stageT = 0;
    return null;
  }
  const step = Math.min(Math.max(dt, 0), 0.25);
  const rnd = mulberry32((state.seed += 1));

  if (state.stage === 'idle') {
    state.cooldown -= step;
    if (state.cooldown > 0) return null;
    const bearing = target.heading + (rnd() < 0.5 ? 1 : -1) * (0.9 + 0.6 * rnd());
    state.x = target.x + Math.cos(bearing) * HOSTILE_SPAWN_RANGE;
    state.y = target.y + Math.sin(bearing) * HOSTILE_SPAWN_RANGE;
    // Shadow whichever beam the lugger arrived on: the station is across that bearing.
    const side = rnd() < 0.5 ? 1 : -1;
    state.stationX = -Math.sin(bearing) * side;
    state.stationY = Math.cos(bearing) * side;
    state.heading = Math.atan2(target.y - state.y, target.x - state.x);
    state.speed = CLASS_DIMS.pirate.kn * KN;
    state.stage = 'approaching';
    state.stageT = 0;
  }

  state.stageT += step;
  const dx = target.x - state.x;
  const dy = target.y - state.y;
  const dist = Math.hypot(dx, dy);

  // Hard rule: always despawn beyond 500 m so no stale encounter lingers.
  if (dist > HOSTILE_DESPAWN_RANGE) {
    state.stage = 'idle';
    state.cooldown = 35 + (state.seed & 15);
    state.stageT = 0;
    return null;
  }

  if (state.stage === 'approaching') {
    const toTarget = Math.atan2(dy, dx);
    state.heading = wrapAngle(
      state.heading + wrapAngle(toTarget - state.heading) * Math.min(1, step * 1.4),
    );
    state.speed = CLASS_DIMS.pirate.kn * KN * 1.1;
    if (dist < 150 || state.stageT > 40) {
      state.stage = 'paralleling';
      state.stageT = 0;
    }
  } else if (state.stage === 'paralleling') {
    // Steer for a station abeam of the vessel so the lugger really shadows it, then peel away.
    const sx = target.x + state.stationX * HOSTILE_STATION_RANGE - state.x;
    const sy = target.y + state.stationY * HOSTILE_STATION_RANGE - state.y;
    const toStation = Math.atan2(sy, sx);
    state.heading = wrapAngle(
      state.heading + wrapAngle(toStation - state.heading) * Math.min(1, step * 1.8),
    );
    state.speed = Math.max(5 * KN, target.speed * 1.05);
    // Shadow it for a while once abeam; give up and leave if it never gets there.
    if ((state.stageT > 20 && dist < 110) || state.stageT > 70) {
      state.stage = 'peeling';
      state.stageT = 0;
    }
  } else if (state.stage === 'peeling') {
    const away = Math.atan2(-dy, -dx);
    state.heading = wrapAngle(
      state.heading + wrapAngle(away - state.heading) * Math.min(1, step * 1.6),
    );
    state.speed = CLASS_DIMS.pirate.kn * KN * 1.25;
  }

  state.x += Math.cos(state.heading) * state.speed * step;
  state.y += Math.sin(state.heading) * state.speed * step;

  if (Math.hypot(target.x - state.x, target.y - state.y) > HOSTILE_DESPAWN_RANGE) {
    state.stage = 'idle';
    state.cooldown = 35;
    state.stageT = 0;
    return null;
  }

  const d = CLASS_DIMS.pirate;
  const hEff = Math.min(hs, 5);
  return {
    id: 'hostile:pirate',
    kind: 'pirate',
    x: state.x,
    y: state.y,
    heading: state.heading,
    speed: state.speed,
    heave: 0.2 * hEff * Math.sin(state.stageT * 1.1),
    pitch: 0.03 * hEff * Math.cos(state.stageT * 1.1),
    roll: 0.06 * hEff * Math.sin(state.stageT * 0.9),
    length: d.length,
    beam: d.beam,
    height: d.height,
    working: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Low-poly procedural geometry builders (reusing hull designs + offshore structures)
// ---------------------------------------------------------------------------------------------

const MAT_HEX: Record<VisualMaterial, number> = {
  hull: 0xd8dee9,
  deck: 0x4b5568,
  superstructure: 0xe8eef6,
  glass: 0x8cc8e8,
  cargo: 0xb45309,
  accent: 0xd97706,
  wood: 0x6b4529,
  gold: 0xd4a72c,
  flightdeck: 0x3b4047,
  sail: 0xe6dcc3,
  flag: 0x111111,
};

function appendBox(
  pos: number[],
  col: number[],
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  color: THREE.Color,
): void {
  const hx = sx * 0.5;
  const hy = sy * 0.5;
  const hz = sz * 0.5;
  const v = [
    [cx - hx, cy - hy, cz - hz],
    [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz],
    [cx - hx, cy + hy, cz - hz],
    [cx - hx, cy - hy, cz + hz],
    [cx + hx, cy - hy, cz + hz],
    [cx + hx, cy + hy, cz + hz],
    [cx - hx, cy + hy, cz + hz],
  ] as const;
  const faces = [
    [0, 1, 2, 0, 2, 3],
    [5, 4, 7, 5, 7, 6],
    [4, 0, 3, 4, 3, 7],
    [1, 5, 6, 1, 6, 2],
    [3, 2, 6, 3, 6, 7],
    [4, 5, 1, 4, 1, 0],
  ] as const;
  for (const f of faces) {
    for (const idx of f) {
      const p = v[idx]!;
      pos.push(p[0], p[1], p[2]);
      col.push(color.r, color.g, color.b);
    }
  }
}

function buildTrafficGeometry(kind: TrafficKind): THREE.BufferGeometry {
  const vesselType: VesselType =
    kind === 'cargo' || kind === 'liner'
      ? 'cargo-ship'
      : kind === 'patrol'
        ? 'patrol-boat'
        : kind === 'tanker'
          ? 'oil-tanker'
          : kind === 'carrier'
            ? 'aircraft-carrier'
            : kind === 'pirate'
              ? 'pirate-ship'
              : 'trawler';
  const design: HullDesign = hullDesign(vesselType);
  const scale = kind === 'liner' ? 1.35 : kind === 'tanker' ? 0.72 : kind === 'carrier' ? 0.84 : 1;
  const loft = loftHull(design.shape, { stations: 18, levelsBelow: 4, levelsAbove: 4 });
  const pos: number[] = [];
  const col: number[] = [];
  const cBottom = new THREE.Color(design.paint?.bottom ?? 0x7f1d1d);
  const cTop = new THREE.Color(kind === 'liner' ? 0xf8fafc : (design.paint?.topside ?? 0x334155));
  const wl = design.draft;
  const mp = loft.mesh.positions;
  const mi = loft.mesh.indices;
  for (let i = 0; i < mi.length; i++) {
    const vi = mi[i]! * 3;
    const kx = mp[vi]! * scale;
    const ky = mp[vi + 1]! * scale;
    const kz = (mp[vi + 2]! - wl) * scale;
    // Three.js local frame: +x bow, +y up, −z port.
    pos.push(kx, kz, -ky);
    const c = mp[vi + 2]! < wl ? cBottom : cTop;
    col.push(c.r, c.g, c.b);
  }
  const boxes: VisualBox[] =
    kind === 'liner'
      ? [
          {
            center: { x: -4, y: 0, z: design.depth + 4.5 },
            size: { x: 84, y: 18, z: 9 },
            material: 'superstructure',
          },
          {
            center: { x: -6, y: 0, z: design.depth + 11.5 },
            size: { x: 70, y: 16, z: 6 },
            material: 'superstructure',
          },
          {
            center: { x: 26, y: 0, z: design.depth + 13 },
            size: { x: 8, y: 17, z: 2.5 },
            material: 'glass',
          },
          {
            center: { x: -22, y: 0, z: design.depth + 18 },
            size: { x: 9, y: 5, z: 8 },
            material: 'accent',
          },
        ]
      : design.superstructure;
  const cTmp = new THREE.Color();
  for (const b of boxes) {
    const hex = design.palette?.[b.material] ?? MAT_HEX[b.material];
    cTmp.setHex(hex);
    appendBox(
      pos,
      col,
      b.center.x * scale,
      (b.center.z - wl) * scale,
      -b.center.y * scale,
      b.size.x * scale,
      b.size.z * scale,
      b.size.y * scale,
      cTmp,
    );
  }
  // Pirate ship sails silhouette.
  if (kind === 'pirate' && design.rig) {
    cTmp.setHex(0xe6dcc3);
    for (const m of design.rig.masts) {
      for (const s of m.sails) {
        appendBox(pos, col, m.x, s.zYard - wl - s.drop * 0.5, 0, 0.6, s.drop, s.halfSpan * 2, cTmp);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function buildStructureGeometry(kind: StructureKind): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  if (kind === 'oil-rig') {
    c.setHex(0x475569);
    for (const [lx, lz] of [
      [-14, -14],
      [14, -14],
      [-14, 14],
      [14, 14],
    ] as const) {
      appendBox(pos, col, lx, 10, lz, 3.2, 28, 3.2, c);
    }
    c.setHex(0x64748b);
    appendBox(pos, col, 0, 24, 0, 38, 4.5, 34, c);
    c.setHex(0xe2e8f0);
    appendBox(pos, col, -8, 29, 6, 14, 6, 14, c);
    c.setHex(0xd97706);
    appendBox(pos, col, 6, 38, -4, 3.5, 24, 3.5, c); // derrick tower
    appendBox(pos, col, 22, 33, -12, 2.2, 18, 2.2, c); // flare boom
    c.setHex(0x0ea5e9);
    appendBox(pos, col, -16, 27, -10, 12, 0.8, 12, c); // helipad
  } else if (kind === 'wind-turbine') {
    // shortcut: rotor blades are baked into the mesh and never turn, so a whole farm costs one
    // draw call; give each turbine its own rotor mesh when they get close enough to read.
    c.setHex(0xf1f5f9);
    appendBox(pos, col, 0, 36, 0, 3.2, 74, 3.2, c);
    appendBox(pos, col, 1.5, 73, 0, 7, 3.6, 3.6, c);
    c.setHex(0xe2e8f0);
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3;
      const by = 73 + Math.cos(a) * 18;
      const bz = Math.sin(a) * 18;
      appendBox(
        pos,
        col,
        3.2,
        by,
        bz,
        0.6,
        Math.max(2, Math.abs(Math.cos(a)) * 34),
        Math.max(2, Math.abs(Math.sin(a)) * 34),
        c,
      );
    }
    c.setHex(0xeab308);
    appendBox(pos, col, 0, 2, 0, 4.4, 5, 4.4, c);
  } else {
    c.setHex(0xef4444);
    appendBox(pos, col, 0, 1.2, 0, 2.8, 2.4, 2.8, c);
    c.setHex(0xf8fafc);
    appendBox(pos, col, 0, 3.8, 0, 0.8, 3.2, 0.8, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------------------------
// Layer implementation (Traffic + Structures + Hostiles)
// ---------------------------------------------------------------------------------------------

const TRAFFIC_KINDS: readonly TrafficKind[] = [
  'trawler',
  'cargo',
  'patrol',
  'liner',
  'tanker',
  'carrier',
  'pirate',
];
const STRUCTURE_KINDS: readonly StructureKind[] = ['oil-rig', 'wind-turbine', 'buoy'];
const MAX_LIGHTS = 64;

/** Soft round light sprite (white, alpha falloff) so night lamps are glows, not hard squares. */
function lightSpriteTexture(): THREE.DataTexture {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const r = Math.min(1, Math.hypot((i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5) * 2);
      const o = (j * n + i) * 4;
      data.fill(255, o, o + 3);
      data[o + 3] = Math.round(((1 - r) ** 2 * 0.8 + Math.max(0, 1 - r * 4) * 0.2) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export class TrafficLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private trafficEnabled = true;
  private structuresEnabled = true;
  private hostilesEnabled = false;

  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.58,
    metalness: 0.08,
  });
  private readonly shipMeshes: Record<TrafficKind, THREE.InstancedMesh>;
  private readonly structMeshes: Record<StructureKind, THREE.InstancedMesh>;
  private readonly lightPoints: THREE.Points;
  private readonly lightPos: THREE.BufferAttribute;
  private readonly lightCol: THREE.BufferAttribute;
  private readonly lightMat: THREE.PointsMaterial;

  private readonly hostileState = createHostileState();
  private activePoses: TrafficShipPose[] = [];
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpE = new THREE.Euler();
  private readonly tmpS = new THREE.Vector3(1, 1, 1);
  private readonly tmpDir = new THREE.Vector3();

  constructor() {
    this.object.name = 'traffic-and-structures';
    this.shipMeshes = {} as Record<TrafficKind, THREE.InstancedMesh>;
    for (const k of TRAFFIC_KINDS) {
      const m = new THREE.InstancedMesh(buildTrafficGeometry(k), this.material, 14);
      m.name = `traffic-${k}`;
      m.frustumCulled = false;
      m.count = 0;
      this.shipMeshes[k] = m;
      this.object.add(m);
    }
    this.structMeshes = {} as Record<StructureKind, THREE.InstancedMesh>;
    for (const k of STRUCTURE_KINDS) {
      const m = new THREE.InstancedMesh(buildStructureGeometry(k), this.material, 16);
      m.name = `structure-${k}`;
      m.frustumCulled = false;
      m.count = 0;
      this.structMeshes[k] = m;
      this.object.add(m);
    }
    const lGeo = new THREE.BufferGeometry();
    this.lightPos = new THREE.BufferAttribute(new Float32Array(MAX_LIGHTS * 3), 3);
    this.lightCol = new THREE.BufferAttribute(new Float32Array(MAX_LIGHTS * 3), 3);
    this.lightPos.setUsage(THREE.DynamicDrawUsage);
    this.lightCol.setUsage(THREE.DynamicDrawUsage);
    lGeo.setAttribute('position', this.lightPos);
    lGeo.setAttribute('color', this.lightCol);
    this.lightMat = new THREE.PointsMaterial({
      size: 6,
      map: lightSpriteTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.lightPoints = new THREE.Points(lGeo, this.lightMat);
    this.lightPoints.frustumCulled = false;
    this.object.add(this.lightPoints);
  }

  setEnabled(enabled: boolean): void {
    this.trafficEnabled = enabled;
    this.syncVisibility();
  }

  setFlags(flags: { traffic: boolean; structures: boolean; hostiles: boolean }): void {
    this.trafficEnabled = flags.traffic;
    this.structuresEnabled = flags.structures;
    this.hostilesEnabled = flags.hostiles;
    this.syncVisibility();
  }

  private syncVisibility(): void {
    this.object.visible = this.trafficEnabled || this.structuresEnabled || this.hostilesEnabled;
  }

  /** Current active traffic poses (for wakes, wildlife bow-riding and trailing gulls). */
  get ships(): readonly TrafficShipPose[] {
    return this.activePoses;
  }

  /** Exported wake sources for the nearest moving traffic hulls. */
  appendWakeSources(out: WakeSource[], limit = 6): void {
    let added = 0;
    for (const s of this.activePoses) {
      if (added >= limit) break;
      if (s.speed < 0.8) continue;
      const fx = Math.cos(s.heading);
      const fy = Math.sin(s.heading);
      const half = s.length * 0.45;
      out.push({
        id: s.id,
        length: s.length,
        beam: s.beam,
        bow: { x: s.x + fx * half, y: s.y + fy * half },
        stern: { x: s.x - fx * half, y: s.y - fy * half },
        speed: s.speed,
      });
      added++;
    }
  }

  /** Exported vessel tracks so dolphins and whales interact with background traffic. */
  appendWildVessels(out: WildVessel[]): void {
    for (const s of this.activePoses) {
      out.push({
        id: s.id,
        x: s.x,
        z: -s.y,
        bowX: Math.cos(s.heading),
        bowZ: -Math.sin(s.heading),
        speed: s.speed,
        length: s.length,
      });
    }
  }

  update(frame: SceneryFrame): void {
    if (!this.object.visible) {
      if (this.activePoses.length > 0) this.activePoses = [];
      return;
    }
    const tier = frame.tier ?? 'full';
    const camX = frame.camera.position.x;
    const camY = -frame.camera.position.z;

    for (const k of TRAFFIC_KINDS) this.shipMeshes[k].count = 0;
    for (const k of STRUCTURE_KINDS) this.structMeshes[k].count = 0;

    const poses = this.trafficEnabled
      ? trafficNear(camX, camY, frame.t, frame.calm, frame.hs, tier)
      : [];

    // Optional hostile pirate lugger encounter around the lead vessel (or camera), ambushing
    // from ahead of whatever the camera is looking at so it shows up on the horizon.
    const p0 = frame.vesselPositions[0];
    const v0 = frame.vessels[0];
    frame.camera.getWorldDirection(this.tmpDir);
    const target = {
      x: p0 ? p0.x : camX,
      y: p0 ? -p0.z : camY,
      heading: Math.atan2(-this.tmpDir.z, this.tmpDir.x),
      speed: v0 ? Math.max(0, v0.speedKn) * KN : 4,
    };
    const pirate = stepHostileEncounter(
      this.hostileState,
      frame.dt,
      this.hostilesEnabled || Boolean(frame.hostiles),
      tier,
      target,
      frame.hs,
    );
    if (pirate) poses.push(pirate);
    this.activePoses = poses;

    let lights = 0;
    const lp = this.lightPos.array as Float32Array;
    const lc = this.lightCol.array as Float32Array;
    const nightVis = smoothstep(0.65, 0.15, frame.daylight);
    const pushLight = (x: number, y: number, z: number, r: number, g: number, b: number) => {
      if (lights >= MAX_LIGHTS) return;
      const o = lights * 3;
      lp[o] = x;
      lp[o + 1] = y;
      lp[o + 2] = z;
      lc[o] = r;
      lc[o + 1] = g;
      lc[o + 2] = b;
      lights++;
    };

    for (const s of poses) {
      const mesh = this.shipMeshes[s.kind];
      const idx = mesh.count;
      if (idx >= 14) continue;
      this.tmpP.set(s.x, s.heave, -s.y);
      this.tmpE.set(s.roll, s.heading, s.pitch, 'YXZ');
      this.tmpQ.setFromEuler(this.tmpE);
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      mesh.setMatrixAt(idx, this.tmpM);
      mesh.count = idx + 1;

      if (nightVis > 0.05) {
        // Masthead / deck lamp + port/starboard nav lights.
        const c = Math.cos(s.heading);
        const sn = Math.sin(s.heading);
        pushLight(
          s.x,
          s.heave + s.height + 1.5,
          -s.y,
          1.0 * nightVis,
          0.92 * nightVis,
          0.7 * nightVis,
        );
        if (s.working) {
          pushLight(
            s.x - c * s.length * 0.3,
            s.heave + 5,
            -(s.y - sn * s.length * 0.3),
            1.0 * nightVis,
            0.85 * nightVis,
            0.45 * nightVis,
          );
        }
      }
    }
    for (const k of TRAFFIC_KINDS) {
      if (this.shipMeshes[k].count > 0) this.shipMeshes[k].instanceMatrix.needsUpdate = true;
    }

    if (this.structuresEnabled) {
      const cells = structuresNear(camX, camY, tier);
      for (const cell of cells) {
        for (const item of cell.items) {
          const mesh = this.structMeshes[item.kind];
          const idx = mesh.count;
          if (idx >= 16) continue;
          const bob = item.kind === 'buoy' ? 0.25 * Math.sin(frame.t * 1.7 + item.seed) : 0;
          this.tmpP.set(item.x, bob, -item.y);
          this.tmpE.set(0, item.yaw, 0);
          this.tmpQ.setFromEuler(this.tmpE);
          this.tmpS.setScalar(item.scale);
          this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
          mesh.setMatrixAt(idx, this.tmpM);
          mesh.count = idx + 1;

          const beacon = structureBeaconIntensity(frame.t, item.seed, frame.calm);
          if (item.kind === 'oil-rig') {
            // Persistent flare stack + flashing red aviation beacon.
            pushLight(item.x + 20, 44 * item.scale, -item.y + 10, 1.0, 0.55, 0.12);
            if (beacon > 0.1)
              pushLight(item.x + 6, 52 * item.scale, -item.y + 4, beacon, 0.1, 0.08);
          } else if (beacon > 0.1) {
            const h = item.kind === 'wind-turbine' ? 76 * item.scale : 5.2;
            pushLight(
              item.x,
              h + bob,
              -item.y,
              beacon,
              item.kind === 'buoy' ? beacon * 0.7 : 0.1,
              0.1,
            );
          }
        }
      }
      this.tmpS.set(1, 1, 1);
      for (const k of STRUCTURE_KINDS) {
        if (this.structMeshes[k].count > 0) this.structMeshes[k].instanceMatrix.needsUpdate = true;
      }
    }

    this.lightPoints.geometry.setDrawRange(0, lights);
    if (lights > 0) {
      this.lightPos.needsUpdate = true;
      this.lightCol.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const k of TRAFFIC_KINDS) {
      this.shipMeshes[k].geometry.dispose();
      this.shipMeshes[k].dispose();
    }
    for (const k of STRUCTURE_KINDS) {
      this.structMeshes[k].geometry.dispose();
      this.structMeshes[k].dispose();
    }
    this.material.dispose();
    this.lightPoints.geometry.dispose();
    this.lightMat.map?.dispose();
    this.lightMat.dispose();
    this.object.clear();
  }
}
