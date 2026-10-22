/**
 * Marine life model: deterministic placement and analytic motion of the underwater fauna. Pure
 * maths, no three.js, so it unit-tests without a GPU. `marineLife.ts` turns it into instanced
 * meshes.
 *
 * Fauna is organised in "schools" (a school may be a single ray). A school has a home point in
 * the world (x east, y north), an elliptical orbit around it and a swim depth band. Every fish
 * in the school follows the school centre plus its own slow Lissajous offset, so the whole
 * motion is a closed-form function of time: no state, no per-frame allocation, and nothing can
 * blow up after a long pause.
 *
 * Open-water schools come from a hash grid (`MARINE_CELL`); reef schools hang on the coral, kelp
 * and wreck sites the scenery layer already placed. `planMarineLife` picks the schools nearest
 * the camera and truncates them to the per-tier budget.
 */
import { mulberry32 } from '../../core/rng';
import type { SceneryTier } from '../scenery/types';

export type MarineSpecies = 'baitfish' | 'reef' | 'tuna' | 'ray' | 'jelly' | 'shark';

export const MARINE_SPECIES: readonly MarineSpecies[] = [
  'baitfish',
  'reef',
  'tuna',
  'ray',
  'jelly',
  'shark',
];

export const MARINE_CELL = 120;
/** Schools whose home is further than this from the camera [m] are not drawn. */
export const MARINE_RANGE = 220;
const MARINE_SALT = 0x7f3a91c5;
/** Shallowest swim depth [m], before the sea-state allowance. */
const MIN_DEPTH = 3;
/** Fish never go deeper than this even where the seabed is further down [m]. */
export const MARINE_MAX_DEPTH = 60;
/** Clearance kept above the seabed [m]. */
const FLOOR_MARGIN = 0.8;

export interface MarineBudget {
  /** Extra draw calls (one per species with instances). */
  drawCalls: number;
  /** Instance cap per species; absent species are not drawn on this tier. */
  caps: Partial<Record<MarineSpecies, number>>;
}

export const MARINE_BUDGET: Record<SceneryTier, MarineBudget> = {
  full: {
    drawCalls: 6,
    caps: { baitfish: 320, reef: 160, tuna: 40, ray: 6, jelly: 24, shark: 2 },
  },
  mid: { drawCalls: 3, caps: { baitfish: 150, reef: 80, jelly: 12 } },
  lite: { drawCalls: 1, caps: { jelly: 8 } },
};

/** Total instances a tier may draw. */
export function marineInstanceCap(tier: SceneryTier): number {
  let n = 0;
  for (const v of Object.values(MARINE_BUDGET[tier].caps)) n += v;
  return n;
}

export interface SchoolSpec {
  id: string;
  species: MarineSpecies;
  count: number;
  /** Home point [m, world x east / y north]. */
  hx: number;
  hy: number;
  /** 0 = just under the waves, 1 = just above the seabed. */
  depthFrac: number;
  /** Orbit semi-axes [m] and angular speed [rad/s]. */
  rx: number;
  ry: number;
  w: number;
  phase: number;
  /** Per-fish wander radius, horizontally and vertically [m]. */
  spread: number;
  vspread: number;
  /** Body scale [m of fish length]. */
  scale: number;
  seed: number;
}

/** A coral, kelp or wreck site a reef school can sit on. */
export interface ReefSite {
  id: string;
  x: number;
  y: number;
  seed: number;
}

function hash2(ix: number, iy: number, salt: number): number {
  let h = Math.imul((salt ^ ix) | 0, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h ^ (iy | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uniform [0, 1) from a school seed and an index/stream number. */
export function unitHash(seed: number, k: number): number {
  return hash2(seed | 0, k | 0, 0x2545f491) / 4294967296;
}

const TAU = Math.PI * 2;

function orbitSpeed(rnd: () => number, rx: number, ry: number, v0: number, v1: number): number {
  const v = v0 + (v1 - v0) * rnd();
  return v / Math.max(1, 0.5 * (rx + ry));
}

/** Deterministic open-water schools whose home lies in cell `(ix, iy)`. */
export function marineSchoolsInCell(ix: number, iy: number): SchoolSpec[] {
  const seed = hash2(ix, iy, MARINE_SALT);
  const rnd = mulberry32(seed);
  const out: SchoolSpec[] = [];
  const place = (): { hx: number; hy: number } => ({
    hx: (ix + 0.1 + 0.8 * rnd()) * MARINE_CELL,
    hy: (iy + 0.1 + 0.8 * rnd()) * MARINE_CELL,
  });
  const add = (species: MarineSpecies, n: number, f: Partial<SchoolSpec>): void => {
    const p = place();
    const rx = f.rx ?? 30;
    const ry = f.ry ?? 30;
    out.push({
      id: `${species}:${ix}:${iy}:${out.length}`,
      species,
      count: n,
      hx: p.hx,
      hy: p.hy,
      depthFrac: rnd(),
      rx,
      ry,
      w: (rnd() < 0.5 ? -1 : 1) * (f.w ?? 0.05),
      phase: rnd() * TAU,
      spread: f.spread ?? 4,
      vspread: f.vspread ?? 1.5,
      scale: f.scale ?? 0.4,
      seed: Math.floor(rnd() * 4294967296) >>> 0,
    });
  };

  if (rnd() < 0.85) {
    const rx = 14 + 22 * rnd();
    const ry = 14 + 22 * rnd();
    add('baitfish', 24 + Math.floor(rnd() * 40), {
      rx,
      ry,
      w: orbitSpeed(rnd, rx, ry, 1.2, 2.2),
      spread: 2.5 + 2 * rnd(),
      vspread: 1.5 + rnd(),
      scale: 0.45 + 0.2 * rnd(),
    });
  }
  if (rnd() < 0.4) {
    const rx = 40 + 50 * rnd();
    const ry = 40 + 50 * rnd();
    add('tuna', 3 + Math.floor(rnd() * 4), {
      rx,
      ry,
      w: orbitSpeed(rnd, rx, ry, 3, 5),
      spread: 4 + 3 * rnd(),
      vspread: 2,
      scale: 1.3 + 0.5 * rnd(),
    });
  }
  if (rnd() < 0.14) {
    const rx = 60 + 60 * rnd();
    const ry = 40 + 60 * rnd();
    add('ray', 1 + Math.floor(rnd() * 2), {
      rx,
      ry,
      w: orbitSpeed(rnd, rx, ry, 1.6, 2.4),
      spread: 7,
      vspread: 1,
      scale: 2 + 0.8 * rnd(),
    });
  }
  if (rnd() < 0.07) {
    const rx = 70 + 60 * rnd();
    const ry = 60 + 60 * rnd();
    add('shark', 1, {
      rx,
      ry,
      w: orbitSpeed(rnd, rx, ry, 2, 3),
      spread: 0,
      vspread: 1.5,
      scale: 2.6 + 1.2 * rnd(),
    });
  }
  if (rnd() < 0.5) {
    add('jelly', 3 + Math.floor(rnd() * 5), {
      rx: 6 + 6 * rnd(),
      ry: 6 + 6 * rnd(),
      w: 0.04 + 0.03 * rnd(),
      spread: 8,
      vspread: 3,
      scale: 0.9 + 0.5 * rnd(),
    });
  }
  return out;
}

/** The reef school living on a coral, kelp or wreck site. */
export function reefSchoolForSite(site: ReefSite): SchoolSpec {
  const rnd = mulberry32(site.seed ^ 0x51ed270b);
  const rx = 6 + 8 * rnd();
  const ry = 6 + 8 * rnd();
  return {
    id: `reef:${site.id}`,
    species: 'reef',
    count: 10 + Math.floor(rnd() * 14),
    hx: site.x,
    hy: site.y,
    depthFrac: 0.78 + 0.18 * rnd(),
    rx,
    ry,
    w: (rnd() < 0.5 ? -1 : 1) * orbitSpeed(rnd, rx, ry, 0.5, 1),
    phase: rnd() * TAU,
    spread: 2.5 + 2 * rnd(),
    vspread: 0.8,
    scale: 0.3 + 0.12 * rnd(),
    seed: Math.floor(rnd() * 4294967296) >>> 0,
  };
}

export interface MarinePlan {
  /** Selected schools, `count` already truncated to the budget. */
  schools: SchoolSpec[];
  /** Instances per species. */
  totals: Record<MarineSpecies, number>;
}

/**
 * Choose the schools to draw: candidates within `MARINE_RANGE` of the camera, nearest first,
 * each species filled up to its cap for the tier. Reef sites are supplied by the caller (the
 * scenery layer owns the site list); open-water schools come from the hash grid.
 */
export function planMarineLife(
  camX: number,
  camY: number,
  tier: SceneryTier,
  reefSites: readonly ReefSite[],
): MarinePlan {
  const caps = MARINE_BUDGET[tier].caps;
  const cand: { s: SchoolSpec; d: number }[] = [];
  const reach = MARINE_RANGE + MARINE_CELL;
  const ix0 = Math.floor((camX - reach) / MARINE_CELL);
  const ix1 = Math.floor((camX + reach) / MARINE_CELL);
  const iy0 = Math.floor((camY - reach) / MARINE_CELL);
  const iy1 = Math.floor((camY + reach) / MARINE_CELL);
  const consider = (s: SchoolSpec): void => {
    if (caps[s.species] === undefined) return;
    const d = Math.hypot(s.hx - camX, s.hy - camY);
    if (d <= MARINE_RANGE) cand.push({ s, d });
  };
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      for (const s of marineSchoolsInCell(ix, iy)) consider(s);
    }
  }
  if (caps.reef !== undefined) for (const site of reefSites) consider(reefSchoolForSite(site));
  cand.sort((a, b) => a.d - b.d || (a.s.id < b.s.id ? -1 : 1));

  const totals: Record<MarineSpecies, number> = {
    baitfish: 0,
    reef: 0,
    tuna: 0,
    ray: 0,
    jelly: 0,
    shark: 0,
  };
  const schools: SchoolSpec[] = [];
  for (const { s } of cand) {
    const room = (caps[s.species] ?? 0) - totals[s.species];
    if (room <= 0) continue;
    const count = Math.min(room, s.count);
    totals[s.species] += count;
    schools.push(count === s.count ? s : { ...s, count });
  }
  return { schools, totals };
}

export interface FishPose {
  /** World position [m]: x east, y north, depth below mean sea level (positive down). */
  x: number;
  y: number;
  depth: number;
  /** Heading [rad] from +x (east) toward +y (north). */
  yaw: number;
  /** Fish length scale [m]. */
  scale: number;
}

export function makeFishPose(): FishPose {
  return { x: 0, y: 0, depth: 0, yaw: 0, scale: 1 };
}

/** Shallowest depth fish use under a sea of significant wave height `hs` [m]. */
export function marineMinDepth(hs: number): number {
  return MIN_DEPTH + 0.6 * Math.min(Math.max(hs, 0), 4);
}

/**
 * Pose of fish `i` of `school` at time `t` [s]. `seabed(x, y)` is the seafloor depth [m below the
 * surface]; `hs` is the significant wave height [m]. Allocation-free; writes into `out`.
 */
export function fishPose(
  school: SchoolSpec,
  i: number,
  t: number,
  seabed: (x: number, y: number) => number,
  hs: number,
  out: FishPose,
): void {
  const s = school;
  const a = s.w * t + s.phase;
  const sa = Math.sin(a);
  const ca = Math.cos(a);
  const cx = s.hx + s.rx * ca;
  const cy = s.hy + s.ry * sa;
  let vx = -s.rx * s.w * sa;
  let vy = s.ry * s.w * ca;

  // Per-fish wander: two slow Lissajous terms.
  const k = i * 7;
  const fx = 0.25 + 0.35 * unitHash(s.seed, k + 1);
  const fy = 0.25 + 0.35 * unitHash(s.seed, k + 2);
  const px = unitHash(s.seed, k + 3) * TAU;
  const py = unitHash(s.seed, k + 4) * TAU;
  const fz = 0.2 + 0.3 * unitHash(s.seed, k + 5);
  const pz = unitHash(s.seed, k + 6) * TAU;
  const rr = 0.4 + 0.6 * unitHash(s.seed, k + 7);
  const ox = s.spread * rr * Math.sin(fx * t + px);
  const oy = s.spread * rr * Math.sin(fy * t + py);
  vx += s.spread * rr * fx * Math.cos(fx * t + px);
  vy += s.spread * rr * fy * Math.cos(fy * t + py);
  const x = cx + ox;
  const y = cy + oy;

  const floor = Math.min(seabed(x, y) - FLOOR_MARGIN, MARINE_MAX_DEPTH);
  const top = marineMinDepth(hs);
  const bottom = Math.max(top, floor);
  const base = top + (bottom - top) * s.depthFrac;
  const depth = base + s.vspread * Math.sin(fz * t + pz);

  out.x = x;
  out.y = y;
  out.depth = depth < top ? top : depth > bottom ? bottom : depth;
  out.yaw = Math.atan2(vy, vx);
  out.scale = s.scale * (0.85 + 0.3 * unitHash(s.seed, k + 8));
}
