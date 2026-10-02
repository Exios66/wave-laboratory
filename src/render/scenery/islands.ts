/**
 * Scattered paradise islands across the endless sea.
 *
 * Purely visual: islands do not block, refract or reflect waves, and ships sail straight
 * through them. Nothing here feeds back into the wave field, the hull forces or the
 * experiment state.
 *
 * Placement is a deterministic hash grid over the infinite plane (`islandsNear`), so the same
 * island is always in the same spot with the same shape, palms and huts. A clear zone around
 * the world origin keeps the area where experiments start open water.
 *
 * Rendering keeps a small pool of island slots near the camera and recycles them as the camera
 * moves, so roaming never grows memory. Per visible island there is one draw call (terrain and
 * every static prop merged into one vertex-coloured, flat-shaded mesh). All palms share one
 * instanced mesh that sways in the wind on the GPU, all shallow lagoons share one instanced
 * transparent ring, and lighthouses add one small glow sprite each.
 *
 * Coordinates: world (x east, y north, z up) maps to Three.js as (x, z, −y).
 */
import * as THREE from 'three';
import type { SceneryFrame, SceneryLayer } from './types';

// ---------------------------------------------------------------------------------------------
// Placement (pure, no WebGL)
// ---------------------------------------------------------------------------------------------

/** Size of one placement cell [m]. At most one island per cell. */
export const ISLAND_CELL = 1500;
/** No part of an island, lagoon included, comes closer than this to the world origin [m]. */
export const ISLAND_CLEAR_RADIUS = 450;
/** Outer edge of the lagoon, as a multiple of the island's nominal radius. */
export const ISLAND_FOOTPRINT = 1.8;
/** Islands are built and drawn within this horizontal range of the camera [m]. */
export const ISLAND_VIEW_RANGE = 6000;
/** Chance that a cell holds an island (before the clear zone removes a few). */
export const ISLAND_OCCUPANCY = 0.36;
/** Chance that a cell without an island holds a chain of keys (small low islets) instead. */
export const KEY_OCCUPANCY = 0.3;
/** Islets in a chain of keys. */
export const KEY_COUNT = [3, 7] as const;

const WORLD_SALT = 0x5eed1517;

export interface IslandSpec {
  /** Stable id, the grid cell `ix:iy`. */
  key: string;
  /** Centre, world coordinates [m]. */
  x: number;
  y: number;
  /** Nominal shoreline radius [m]. The coast wobbles roughly ±25 % around it. */
  radius: number;
  /** Seed for the island's shape and decoration. */
  seed: number;
  hut: boolean;
  dock: boolean;
  lighthouse: boolean;
  palms: number;
}

function hash2(ix: number, iy: number, salt: number): number {
  let h = Math.imul((salt ^ ix) | 0, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h ^ (iy | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Small, fast seeded PRNG returning [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The island in grid cell (ix, iy), or null when the cell is open sea. */
export function islandInCell(ix: number, iy: number): IslandSpec | null {
  const seed = hash2(ix, iy, WORLD_SALT);
  const rnd = mulberry32(seed);
  if (rnd() >= ISLAND_OCCUPANCY) return null;
  const large = rnd() < 0.07;
  const diameter = large ? 300 + 160 * rnd() : 40 + 210 * rnd() ** 1.7;
  const radius = diameter / 2;
  // Keep the whole footprint inside the cell so neighbouring islands never overlap.
  const margin = radius * ISLAND_FOOTPRINT + 10;
  const span = ISLAND_CELL - 2 * margin;
  const x = ix * ISLAND_CELL + margin + rnd() * span;
  const y = iy * ISLAND_CELL + margin + rnd() * span;
  if (Math.hypot(x, y) - radius * ISLAND_FOOTPRINT < ISLAND_CLEAR_RADIUS) return null;
  const hut = radius > 22 && rnd() < 0.5;
  const dock = radius > 28 && rnd() < (hut ? 0.6 : 0.2);
  const lighthouse = radius > 40 && rnd() < 0.16;
  const palms =
    radius < 30
      ? 1 + Math.floor(rnd() * 3)
      : Math.min(MAX_PALMS, Math.round(2 + radius / 16 + rnd() * 3));
  return { key: `${ix}:${iy}`, x, y, radius, seed, hut, dock, lighthouse, palms };
}

/**
 * A chain of keys in grid cell (ix, iy): small low islets strung along a gently curving reef
 * line, like the Florida Keys or the Exumas. Empty when the cell holds none (or holds an island).
 */
export function keysInCell(ix: number, iy: number): IslandSpec[] {
  if (islandInCell(ix, iy)) return [];
  const rnd = mulberry32(hash2(ix, iy, WORLD_SALT ^ 0x6b657973));
  if (rnd() >= KEY_OCCUPANCY) return [];
  const n = KEY_COUNT[0] + Math.floor(rnd() * (KEY_COUNT[1] - KEY_COUNT[0] + 1));
  const radii = Array.from({ length: n }, () => 10 + 34 * rnd() ** 1.4);
  const gaps = radii.slice(1).map((r, k) => (r + radii[k]!) * ISLAND_FOOTPRINT + 12 + 70 * rnd());
  // Lay the chain out from its first islet, turning a little at each step.
  let heading = rnd() * Math.PI * 2;
  const bend = (rnd() - 0.5) * 0.5;
  const pts = [{ x: 0, y: 0 }];
  for (const g of gaps) {
    heading += bend + (rnd() - 0.5) * 0.3;
    const last = pts[pts.length - 1]!;
    pts.push({ x: last.x + g * Math.cos(heading), y: last.y + g * Math.sin(heading) });
  }
  // Centre it in the cell, then keep only islets whose whole lagoon stays inside the cell
  // and clear of the origin, and that keep clear of every other islet (a tight bend).
  const cx = pts.reduce((a, p) => a + p.x, 0) / n;
  const cy = pts.reduce((a, p) => a + p.y, 0) / n;
  const ox = (ix + 0.5) * ISLAND_CELL + (rnd() - 0.5) * 200 - cx;
  const oy = (iy + 0.5) * ISLAND_CELL + (rnd() - 0.5) * 200 - cy;
  const out: IslandSpec[] = [];
  for (let k = 0; k < n; k++) {
    const radius = radii[k]!;
    const x = pts[k]!.x + ox;
    const y = pts[k]!.y + oy;
    const m = radius * ISLAND_FOOTPRINT + 10;
    if (x - m < ix * ISLAND_CELL || x + m > (ix + 1) * ISLAND_CELL) continue;
    if (y - m < iy * ISLAND_CELL || y + m > (iy + 1) * ISLAND_CELL) continue;
    if (Math.hypot(x, y) - radius * ISLAND_FOOTPRINT < ISLAND_CLEAR_RADIUS) continue;
    const clash = out.some(
      (o) => Math.hypot(o.x - x, o.y - y) - (o.radius + radius) * ISLAND_FOOTPRINT <= 1,
    );
    if (clash) continue;
    const seed = hash2(ix * 8 + k, iy, WORLD_SALT ^ 0x6b6579);
    const r = mulberry32(seed);
    out.push({
      key: `${ix}:${iy}:${k}`,
      x,
      y,
      radius,
      seed,
      hut: radius > 24 && r() < 0.35,
      dock: false,
      lighthouse: k === 0 && radius > 18 && r() < 0.35,
      palms: radius < 16 ? 1 + Math.floor(r() * 2) : 2 + Math.floor(r() * 4),
    });
  }
  return out;
}

/** Everything in grid cell (ix, iy): one island, a chain of keys, or nothing. */
export function islandsInCell(ix: number, iy: number): IslandSpec[] {
  const one = islandInCell(ix, iy);
  return one ? [one] : keysInCell(ix, iy);
}

/**
 * Islands any part of which (lagoon included) lies within `radius` of world point (x, y),
 * nearest first. Deterministic: the same island always comes back identical.
 */
export function islandsNear(x: number, y: number, radius: number): IslandSpec[] {
  const reach = radius + 240 * ISLAND_FOOTPRINT;
  const ix0 = Math.floor((x - reach) / ISLAND_CELL);
  const ix1 = Math.floor((x + reach) / ISLAND_CELL);
  const iy0 = Math.floor((y - reach) / ISLAND_CELL);
  const iy1 = Math.floor((y + reach) / ISLAND_CELL);
  const found: { spec: IslandSpec; d: number }[] = [];
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      for (const spec of islandsInCell(ix, iy)) {
        const d = Math.hypot(spec.x - x, spec.y - y);
        if (d - spec.radius * ISLAND_FOOTPRINT <= radius) found.push({ spec, d });
      }
    }
  }
  found.sort((a, b) => a.d - b.d);
  return found.map((f) => f.spec);
}

// ---------------------------------------------------------------------------------------------
// Island shape (pure)
// ---------------------------------------------------------------------------------------------

const MAX_PALMS = 16;
/** Seabed depth the underwater skirt reaches [m]; waves expose the upper part. */
const BASE_DEPTH = -8.5;
/** The skirt ends at this multiple of the local shoreline radius. */
const SKIRT_S = 1.45;

interface IslandShape {
  r0: number;
  /** Coast harmonics: amplitude and phase of cos(kθ + p) for k = 1, 2, 3. */
  a: [number, number, number];
  p: [number, number, number];
  /** Normalised radius where the sand meets the grass. */
  sb: number;
  /** Height of the beach crest [m]. */
  hb: number;
  /** Hill height above the beach crest [m]. */
  hill: number;
  seed: number;
}

function makeShape(spec: IslandSpec, rnd: () => number): IslandShape {
  const r0 = spec.radius;
  const beachWidth = THREE.MathUtils.clamp(0.24 * r0, 6, 28);
  return {
    r0,
    a: [0.12 * rnd(), 0.1 * rnd(), 0.05 * rnd()],
    p: [rnd() * 6.283, rnd() * 6.283, rnd() * 6.283],
    sb: 1 - beachWidth / r0,
    hb: THREE.MathUtils.clamp(0.012 * r0, 0.7, 2.2),
    hill: THREE.MathUtils.clamp(0.1 * r0 + 4, 5, 34) * (0.75 + 0.5 * rnd()),
    seed: (spec.seed ^ 0x9e3779b9) >>> 0,
  };
}

/** Shoreline radius [m] in direction θ (Three.js local xz angle, atan2(z, x)). */
function coastRadius(sh: IslandShape, theta: number): number {
  return (
    sh.r0 *
    (1 +
      sh.a[0] * Math.cos(theta + sh.p[0]) +
      sh.a[1] * Math.cos(2 * theta + sh.p[1]) +
      sh.a[2] * Math.cos(3 * theta + sh.p[2]))
  );
}

function lattice(ix: number, iy: number, seed: number): number {
  return hash2(ix, iy, seed) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = lattice(ix, iy, seed);
  const b = lattice(ix + 1, iy, seed);
  const c = lattice(ix, iy + 1, seed);
  const d = lattice(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, seed: number): number {
  return (
    0.55 * valueNoise(x, y, seed) +
    0.3 * valueNoise(2.1 * x + 7.3, 2.1 * y - 3.1, seed + 1) +
    0.15 * valueNoise(4.3 * x - 1.7, 4.3 * y + 5.9, seed + 2)
  );
}

/** Terrain height [m above mean sea level] at normalised radius s and local (x, z). */
function heightAtS(sh: IslandShape, s: number, x: number, z: number): number {
  if (s >= 1) return BASE_DEPTH * Math.min(1, (s - 1) / (SKIRT_S - 1 - 0.05)) ** 0.8;
  if (s >= sh.sb) return sh.hb * ((1 - s) / (1 - sh.sb)) ** 0.75;
  const t = 1 - s / sh.sb;
  const scale = Math.max(14, sh.r0 * 0.45);
  const n = fbm(x / scale, z / scale, sh.seed);
  const dome = t * t * (3 - 2 * t);
  return sh.hb + sh.hill * dome * (0.45 + 0.75 * n) + 0.4 * n * Math.min(1, t * 6);
}

/** Terrain height [m] at island-local Three.js (x, z). */
function heightAt(sh: IslandShape, x: number, z: number): number {
  const r = Math.hypot(x, z);
  const s = r / coastRadius(sh, Math.atan2(z, x));
  return heightAtS(sh, s, x, z);
}

/** Local (x, z) at normalised radius s in direction θ. */
function polar(sh: IslandShape, s: number, theta: number): [number, number] {
  const r = s * coastRadius(sh, theta);
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

// ---------------------------------------------------------------------------------------------
// Geometry building
// ---------------------------------------------------------------------------------------------

interface Template {
  pos: Float32Array;
  index: ArrayLike<number>;
}

function template(geo: THREE.BufferGeometry): Template {
  const pos = Float32Array.from(geo.getAttribute('position').array as ArrayLike<number>);
  const index = geo.index
    ? Array.from(geo.index.array as ArrayLike<number>)
    : Array.from({ length: pos.length / 3 }, (_, i) => i);
  geo.dispose();
  return { pos, index };
}

function makeTemplates() {
  return {
    box: template(new THREE.BoxGeometry(1, 1, 1)),
    // Unit-height cylinders with the base at y = 0.
    cyl6: template(new THREE.CylinderGeometry(1, 1, 1, 6, 1).translate(0, 0.5, 0)),
    cyl8: template(new THREE.CylinderGeometry(1, 1, 1, 8, 1).translate(0, 0.5, 0)),
    taper8: template(new THREE.CylinderGeometry(0.65, 1, 1, 8, 1).translate(0, 0.5, 0)),
    cone4: template(new THREE.ConeGeometry(1, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0)),
    cone8: template(new THREE.ConeGeometry(1, 1, 8, 1).translate(0, 0.5, 0)),
    rock: template(new THREE.IcosahedronGeometry(1, 0)),
    blob: template(new THREE.DodecahedronGeometry(1, 0)),
  };
}

let templates: ReturnType<typeof makeTemplates> | null = null;
/** Primitive shapes merged into islands, built once on first use. */
function TEMPLATES(): ReturnType<typeof makeTemplates> {
  templates ??= makeTemplates();
  return templates;
}

const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();

class MeshBuilder {
  pos: number[] = [];
  col: number[] = [];
  glow: number[] = [];
  idx: number[] = [];

  reset(): void {
    this.pos.length = 0;
    this.col.length = 0;
    this.glow.length = 0;
    this.idx.length = 0;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, c: THREE.Color, g = 0): number {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    this.glow.push(g);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  add(t: Template, m: THREE.Matrix4, c: THREE.Color, g = 0): void {
    const base = this.vertexCount;
    for (let i = 0; i < t.pos.length; i += 3) {
      tmpV.set(t.pos[i]!, t.pos[i + 1]!, t.pos[i + 2]!).applyMatrix4(m);
      this.vertex(tmpV.x, tmpV.y, tmpV.z, c, g);
    }
    for (let i = 0; i < t.index.length; i++) this.idx.push(base + t.index[i]!);
  }
}

function trs(
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
  sx: number,
  sy: number,
  sz: number,
): THREE.Matrix4 {
  tmpQ.setFromEuler(tmpE.set(rx, ry, rz));
  return tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
}

const C = {
  grass: new THREE.Color(0x7fd055),
  grassDeep: new THREE.Color(0x48a744),
  grassHigh: new THREE.Color(0x3d9142),
  sand: new THREE.Color(0xf6e3a6),
  sandWet: new THREE.Color(0xdcc188),
  sandDeep: new THREE.Color(0xb9a679),
  rock: new THREE.Color(0x9a948c),
  rockDark: new THREE.Color(0x77736e),
  bush: new THREE.Color(0x3fa34d),
  bushLight: new THREE.Color(0x5cbf52),
  flowerPink: new THREE.Color(0xff7fb4),
  flowerYellow: new THREE.Color(0xffd84a),
  flowerWhite: new THREE.Color(0xfff6ea),
  wood: new THREE.Color(0xc48a57),
  woodDark: new THREE.Color(0x8a5a36),
  plank: new THREE.Color(0xb98a5e),
  thatch: new THREE.Color(0xe6bb5f),
  door: new THREE.Color(0x6b4428),
  window: new THREE.Color(0xffc861),
  white: new THREE.Color(0xf7f4ee),
  red: new THREE.Color(0xe0483f),
  grey: new THREE.Color(0x5d6266),
  lamp: new THREE.Color(0xfff0a8),
  trunk: new THREE.Color(0x9c7048),
  trunkLight: new THREE.Color(0xb88b5c),
  frond: new THREE.Color(0x58c24c),
  frondDark: new THREE.Color(0x2f9846),
  coconut: new THREE.Color(0x6e4a2a),
};

const tmpC = new THREE.Color();
const tmpC2 = new THREE.Color();

/** Terrain rings, as normalised radius s (1 = shoreline). Denser around the beach. */
const RINGS = [
  0.1,
  0.2,
  0.3,
  0.4,
  0.49,
  0.57,
  0.64,
  0.7,
  0.75,
  0.8,
  0.84,
  0.88,
  0.92,
  0.955,
  0.985,
  1.01,
  1.05,
  1.1,
  1.18,
  1.3,
  SKIRT_S,
];
const SEGMENTS = 56;

function buildTerrain(b: MeshBuilder, sh: IslandShape): number {
  let maxH = 0;
  const colorAt = (s: number, h: number, x: number, z: number, out: THREE.Color) => {
    const n = valueNoise(x / 9 + 11, z / 9 - 4, sh.seed + 7);
    const edge = sh.sb - 0.03 + 0.05 * (n - 0.5);
    if (h < -0.2) return out.copy(C.sandWet).lerp(C.sandDeep, Math.min(1, -h / 4));
    if (h < 0.35) return out.copy(C.sandWet);
    if (s > edge) return out.copy(C.sand);
    out.copy(C.grass).lerp(C.grassDeep, n);
    const up = Math.min(1, (h - sh.hb) / Math.max(4, sh.hill));
    return out.lerp(C.grassHigh, up * 0.6);
  };
  const centreH = heightAtS(sh, 0, 0, 0);
  maxH = centreH;
  const centre = b.vertex(0, centreH, 0, colorAt(0, centreH, 0, 0, tmpC));
  const first = b.vertexCount;
  for (const s of RINGS) {
    for (let k = 0; k < SEGMENTS; k++) {
      const theta = (k / SEGMENTS) * Math.PI * 2;
      const [x, z] = polar(sh, s, theta);
      const h = heightAtS(sh, s, x, z);
      maxH = Math.max(maxH, h);
      b.vertex(x, h, z, colorAt(s, h, x, z, tmpC));
    }
  }
  // Triangles wind counter-clockwise seen from above (+y): θ grows from +x toward +z.
  for (let k = 0; k < SEGMENTS; k++) {
    const k1 = (k + 1) % SEGMENTS;
    b.tri(centre, first + k1, first + k);
  }
  for (let j = 0; j < RINGS.length - 1; j++) {
    const r0 = first + j * SEGMENTS;
    const r1 = r0 + SEGMENTS;
    for (let k = 0; k < SEGMENTS; k++) {
      const k1 = (k + 1) % SEGMENTS;
      b.tri(r0 + k, r0 + k1, r1 + k);
      b.tri(r0 + k1, r1 + k1, r1 + k);
    }
  }
  return maxH;
}

interface Spot {
  x: number;
  z: number;
  r: number;
}

function clear(spots: Spot[], x: number, z: number, r: number): boolean {
  return spots.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r);
}

interface IslandBuild {
  maxH: number;
  /** Palm placements, island-local: x, ground y, z, yaw, scale. */
  palms: number[];
  /** Lighthouse lamp, island-local, or null. */
  lamp: THREE.Vector3 | null;
}

function buildIsland(b: MeshBuilder, spec: IslandSpec): IslandBuild & { shape: IslandShape } {
  const T = TEMPLATES();
  const rnd = mulberry32(spec.seed ^ 0x51ab0b5);
  const sh = makeShape(spec, rnd);
  b.reset();
  let maxH = buildTerrain(b, sh);
  const spots: Spot[] = [];
  const shade = (c: THREE.Color, amount: number) =>
    tmpC2.copy(c).multiplyScalar(1 - amount + 2 * amount * rnd());

  const hutTheta = rnd() * Math.PI * 2;
  if (spec.hut) {
    // A storybook hut, a little oversized so it reads from a ship's deck.
    const k = 1.6;
    const s = sh.sb - Math.min(0.12, (4 * k) / sh.r0);
    const [x, z] = polar(sh, s, hutTheta);
    // Door faces the sea: hut-local +x points outward.
    const yaw = -hutTheta;
    const ca = Math.cos(yaw);
    const sa = Math.sin(yaw);
    let lo = Infinity;
    let hi = -Infinity;
    for (const [dx, dz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const g = heightAt(sh, x + 2 * k * dx, z + 2 * k * dz);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    const floor = hi + 0.5 * k;
    /** Add a part given in hut-local metres (before the size factor), y from the floor. */
    const part = (
      t: Template,
      lx: number,
      ly: number,
      lz: number,
      sx: number,
      sy: number,
      sz: number,
      c: THREE.Color,
      g = 0,
    ) => {
      const px = x + k * (lx * ca + lz * sa);
      const pz = z + k * (-lx * sa + lz * ca);
      b.add(t, trs(px, floor + k * ly, pz, 0, yaw, 0, k * sx, k * sy, k * sz), c, g);
    };
    const stiltLen = (floor - lo) / k + 0.4;
    for (const [lx, lz] of [
      [-1.5, -1.5],
      [1.5, -1.5],
      [-1.5, 1.5],
      [1.5, 1.5],
    ] as const) {
      part(T.cyl6, lx, -stiltLen, lz, 0.14, stiltLen, 0.14, C.woodDark);
    }
    part(T.box, 0.3, -0.1, 0, 4.6, 0.2, 4, C.plank);
    part(T.box, 0, 1.2, 0, 3.2, 2.4, 3.2, C.wood);
    part(T.cone4, 0, 2.3, 0, 3.1, 2.2, 3.1, C.thatch);
    part(T.box, 1.62, 0.85, 0, 0.12, 1.7, 0.9, C.door);
    part(T.box, 1.62, 1.45, 1.0, 0.12, 0.55, 0.55, C.window, 1);
    part(T.box, 0, 1.45, 1.62, 0.6, 0.6, 0.12, C.window, 1);
    part(T.box, 0, 1.45, -1.62, 0.6, 0.6, 0.12, C.window, 1);
    maxH = Math.max(maxH, floor + 4.6 * k);
    spots.push({ x, z, r: 3 * k });
  }

  if (spec.dock) {
    const theta = spec.hut ? hutTheta + 0.35 : rnd() * Math.PI * 2;
    const coast = coastRadius(sh, theta);
    const len = THREE.MathUtils.clamp(0.25 * sh.r0, 10, 30);
    const start = coast - 5;
    const mid = start + (len + 5) / 2;
    const cx = Math.cos(theta);
    const cz = Math.sin(theta);
    const deck = Math.max(1.1, sh.hb * 0.7);
    b.add(T.box, trs(mid * cx, deck, mid * cz, 0, -theta, 0, len + 5, 0.22, 2.2), C.plank);
    for (let d = start + 1; d <= start + len + 5; d += 3) {
      for (const side of [-1, 1]) {
        const px = d * cx - side * 1.05 * cz;
        const pz = d * cz + side * 1.05 * cx;
        b.add(T.cyl6, trs(px, -3, pz, 0, 0, 0, 0.13, deck + 3.6, 0.13), C.woodDark);
      }
    }
    spots.push({ x: (coast - 2) * cx, z: (coast - 2) * cz, r: 3 });
  }

  let lamp: THREE.Vector3 | null = null;
  if (spec.lighthouse) {
    const theta = hutTheta + Math.PI * (0.7 + 0.6 * rnd());
    const [x, z] = polar(sh, sh.sb * 0.95, theta);
    const g = Math.min(
      heightAt(sh, x - 2, z),
      heightAt(sh, x + 2, z),
      heightAt(sh, x, z - 2),
      heightAt(sh, x, z + 2),
    );
    const base = g - 0.5;
    const h = 13;
    b.add(T.cyl8, trs(x, base - 1, z, 0, 0, 0, 2.7, 2.2, 2.7), C.rock);
    b.add(T.taper8, trs(x, base + 1, z, 0, 0, 0, 2, h, 2), C.white);
    for (const f of [0.22, 0.6]) {
      const r = 2 - 0.7 * (f + 0.08);
      b.add(T.taper8, trs(x, base + 1 + h * f, z, 0, 0, 0, r + 0.06, h * 0.16, r + 0.06), C.red);
    }
    const top = base + 1 + h;
    b.add(T.cyl8, trs(x, top, z, 0, 0, 0, 1.9, 0.35, 1.9), C.grey);
    b.add(T.cyl8, trs(x, top + 0.35, z, 0, 0, 0, 1.05, 1.5, 1.05), C.lamp, 1);
    b.add(T.cone8, trs(x, top + 1.85, z, 0, 0, 0, 1.45, 1.5, 1.45), C.red);
    lamp = new THREE.Vector3(x, top + 1.1, z);
    maxH = Math.max(maxH, top + 3.4);
    spots.push({ x, z, r: 3.5 });
  }

  // Rocks: mostly around the shoreline, some wading in the shallows.
  const rocks = 2 + Math.floor(rnd() * (3 + sh.r0 / 25));
  for (let i = 0; i < rocks; i++) {
    const theta = rnd() * Math.PI * 2;
    const s = 0.9 + 0.2 * rnd();
    const [x, z] = polar(sh, s, theta);
    const size = 0.7 + rnd() * (1 + Math.min(2.5, sh.r0 / 50));
    const g = heightAt(sh, x, z);
    const c = rnd() < 0.5 ? C.rock : C.rockDark;
    const m = trs(x, g + size * 0.15, z, rnd() * 3, rnd() * 3, rnd() * 3, size, size * 0.7, size);
    b.add(T.rock, m, shade(c, 0.1));
    if (rnd() < 0.4) {
      const s2 = size * 0.5;
      const m2 = trs(x + size, g, z + size * 0.5, rnd() * 3, rnd() * 3, 0, s2, s2 * 0.8, s2);
      b.add(T.rock, m2, shade(c, 0.1));
    }
  }

  // Bushes with tiny flowers on the grass.
  const bushes = Math.floor((sh.r0 / 10) * (0.5 + rnd()));
  for (let i = 0; i < bushes; i++) {
    const theta = rnd() * Math.PI * 2;
    const s = sh.sb * (0.15 + 0.8 * rnd());
    const [x, z] = polar(sh, s, theta);
    const size = 1.2 + 1.6 * rnd();
    if (!clear(spots, x, z, size)) continue;
    const g = heightAt(sh, x, z);
    const c = rnd() < 0.5 ? C.bush : C.bushLight;
    b.add(
      T.blob,
      trs(x, g + size * 0.45, z, rnd(), rnd() * 3, 0, size, size * 0.8, size),
      shade(c, 0.08),
    );
    const fc = [C.flowerPink, C.flowerYellow, C.flowerWhite][Math.floor(rnd() * 3)]!;
    const flowers = 2 + Math.floor(rnd() * 3);
    for (let f = 0; f < flowers; f++) {
      const a = rnd() * Math.PI * 2;
      const fx = x + Math.cos(a) * size * 0.75;
      const fz = z + Math.sin(a) * size * 0.75;
      b.add(T.rock, trs(fx, g + size * (0.55 + 0.35 * rnd()), fz, 0, a, 0, 0.22, 0.22, 0.22), fc);
    }
  }

  // Palms: love the beach, a few wander inland on the bigger islands.
  const palms: number[] = [];
  for (let i = 0, tries = 0; i < spec.palms && tries < spec.palms * 12; tries++) {
    const theta = rnd() * Math.PI * 2;
    const beachy = rnd() < 0.75;
    const s = beachy
      ? sh.sb - 0.04 + (0.97 - sh.sb) * rnd()
      : Math.min(sh.sb, 0.9) * (0.2 + 0.75 * rnd());
    const [x, z] = polar(sh, s, theta);
    if (!clear(spots, x, z, 1.6)) continue;
    const g = heightAt(sh, x, z);
    const scale = 1.05 + 0.45 * rnd();
    // Palms near the beach lean out over the water; inland ones lean any which way.
    const lean = beachy ? theta + (rnd() - 0.5) * 1.4 : rnd() * Math.PI * 2;
    palms.push(x, g - 0.3, z, -lean, scale);
    spots.push({ x, z, r: 2.2 });
    maxH = Math.max(maxH, g + 9 * scale);
    i++;
  }

  return { maxH, palms, lamp, shape: sh };
}

/** One palm, base at the origin, crown leaning toward +x. Vertex coloured. */
function buildPalmGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const H = PALM_HEIGHT;
  const lean = PALM_LEAN;
  const N = 8;
  const sides = 6;
  const centreAt = (t: number) => tmpV.set(lean * t * t * H, t * H, 0);
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const c = centreAt(t);
    const cx = c.x;
    const cy = c.y;
    const r = 0.3 - 0.13 * t;
    const col = i % 2 === 0 ? C.trunk : C.trunkLight;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      b.vertex(cx + r * Math.cos(a), cy, r * Math.sin(a), col);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      const a = i * sides + k;
      const bb = i * sides + k1;
      const c = (i + 1) * sides + k;
      const d = (i + 1) * sides + k1;
      b.tri(a, c, bb);
      b.tri(bb, c, d);
    }
  }
  const crown = centreAt(1).clone();
  const T = TEMPLATES();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    b.add(
      T.rock,
      trs(crown.x + 0.3 * Math.cos(a), crown.y - 0.3, 0.3 * Math.sin(a), 0, a, 0, 0.24, 0.26, 0.24),
      C.coconut,
    );
  }
  // Fronds: arched, drooping, folded leaves.
  const fronds = 8;
  const L = 3.8;
  const segs = 5;
  for (let f = 0; f < fronds; f++) {
    const phi = (f / fronds) * Math.PI * 2 + (f % 2) * 0.25;
    const dx = Math.cos(phi);
    const dz = Math.sin(phi);
    const lift = f % 2 === 0 ? 1.0 : 0.6;
    const len = L * (f % 2 === 0 ? 1 : 0.85);
    const mid: number[] = [];
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const d = u * len;
      const y = crown.y + lift * 1.3 * u - 2.6 * u * u;
      const w = 0.75 * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.7 + 0.05;
      const col = tmpC.copy(C.frond).lerp(C.frondDark, u * 0.8 + (f % 2) * 0.15);
      const px = crown.x + dx * d;
      const pz = dz * d;
      mid.push(b.vertex(px, y + 0.12, pz, col));
      left.push(b.vertex(px - dz * w, y - 0.12, pz + dx * w, col));
      right.push(b.vertex(px + dz * w, y - 0.12, pz - dx * w, col));
    }
    for (let i = 0; i < segs; i++) {
      b.tri(mid[i]!, left[i]!, mid[i + 1]!);
      b.tri(left[i]!, left[i + 1]!, mid[i + 1]!);
      b.tri(mid[i]!, mid[i + 1]!, right[i]!);
      b.tri(right[i]!, mid[i + 1]!, right[i + 1]!);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  geo.setIndex(b.idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

const PALM_HEIGHT = 7.5;
const PALM_LEAN = 0.3;

function buildLagoonGeometry(): THREE.BufferGeometry {
  const radii = [0.85, 0.97, 1.02, 1.08, 1.2, 1.4, 1.65, 1.95, 2.3];
  const seg = 72;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const r of radii) {
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      pos.push(r * Math.cos(a), 0, r * Math.sin(a));
    }
  }
  for (let j = 0; j < radii.length - 1; j++) {
    for (let k = 0; k < seg; k++) {
      const k1 = (k + 1) % seg;
      const a = j * seg + k;
      const b = j * seg + k1;
      idx.push(a, b, a + seg, b, b + seg, a + seg);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

function glowTexture(): THREE.DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const dx = (i + 0.5) / n - 0.5;
      const dy = (j + 0.5) / n - 0.5;
      const r = Math.min(1, Math.hypot(dx, dy) * 2);
      const a = (1 - r) ** 2.2 * 0.85 + Math.max(0, 1 - r * 6) * 0.15;
      const o = (j * n + i) * 4;
      data[o] = 255;
      data[o + 1] = 236;
      data[o + 2] = 170;
      data[o + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const LAGOON_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aShape;
attribute vec4 aShape2;
uniform float uPull;
varying float vS;
varying float vAngle;
varying float vSeed;
void main() {
  vec3 p = position;
  float theta = atan(p.z, p.x);
  float coast = 1.0 + aShape.x * cos(theta + aShape.y) + aShape.z * cos(2.0 * theta + aShape.w)
    + aShape2.x * cos(3.0 * theta + aShape2.y);
  vS = length(p.xz) / coast;
  vAngle = theta;
  vSeed = aShape2.z;
  vec4 local = vec4(p, 1.0);
#ifdef USE_INSTANCING
  local = instanceMatrix * local;
#endif
  vec4 mvPosition = modelViewMatrix * local;
  gl_Position = projectionMatrix * mvPosition;
  // Win the depth test against the ocean surface within uPull metres, so the tint lies on the
  // water through crests and troughs alike, but still sits behind the beach and ships.
  float d = length(mvPosition.xyz);
  vec4 pulled = projectionMatrix * vec4(mvPosition.xyz * max(0.05, 1.0 - uPull / max(d, 1e-3)), 1.0);
  gl_Position.z = pulled.z / pulled.w * gl_Position.w;
  #include <fog_vertex>
}
`;

const LAGOON_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform float uOpacity;
uniform float uLight;
uniform float uTime;
varying float vS;
varying float vAngle;
varying float vSeed;
void main() {
  float s = vS;
  float inner = smoothstep(0.955, 1.0, s);
  float tint = inner * (1.0 - smoothstep(1.02, 1.78, s)) * (0.55 + 0.45 * (1.0 - smoothstep(1.0, 1.3, s)));
  float wob = 0.012 * sin(vAngle * 23.0 + vSeed * 40.0 + uTime * 0.9)
    + 0.008 * sin(vAngle * 41.0 - uTime * 1.3);
  float swash = 0.5 + 0.5 * sin(uTime * 0.8 + vSeed * 17.0);
  float foamS = s - wob - 0.012 * swash;
  float foam = smoothstep(0.985, 1.0, foamS) * (1.0 - smoothstep(1.015, 1.05, foamS));
  vec3 col = mix(uShallow, uFoam, foam * 0.9) * uLight;
  float alpha = clamp(tint * 0.75 + foam * 0.6, 0.0, 1.0) * uOpacity;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// ---------------------------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------------------------

/** Most islands kept built at once. Typical view holds 3–10. */
/** Islands (and keys) drawn at once, nearest first. */
export const POOL_SIZE = 32;
/** Rebuild the visible set once the camera has moved this far [m]. */
const REFRESH_DISTANCE = 40;
/**
 * Beyond this horizontal distance from the camera the ocean mesh may not reach, so the
 * underwater skirt is clipped at the waterline there instead of showing against the sky [m].
 */
const OCEAN_REACH = 1000;

interface Slot {
  spec: IslandSpec | null;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  vCap: number;
  iCap: number;
  palms: number[];
  shape: IslandShape | null;
  lamp: THREE.Vector3 | null;
  halo: THREE.Sprite | null;
}

export class IslandLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private readonly builder = new MeshBuilder();
  private readonly slots: Slot[] = [];
  private readonly active = new Map<string, Slot>();
  private readonly lastQuery = new THREE.Vector2(Number.NaN, Number.NaN);

  private readonly glow = { value: 0.2 };
  private readonly reach = { value: OCEAN_REACH };
  private readonly landMaterial: THREE.MeshStandardMaterial;

  private readonly palmUniforms = {
    uPalmTime: { value: 0 },
    uPalmWind: { value: new THREE.Vector2(1, 0) },
    uPalmLean: { value: 0.2 },
    uPalmSway: { value: 0.2 },
    uPalmFlutter: { value: 0.1 },
  };
  private readonly palmGeometry: THREE.BufferGeometry;
  private readonly palmMaterial: THREE.MeshStandardMaterial;
  private readonly palmMesh: THREE.InstancedMesh;

  private readonly lagoonGeometry: THREE.BufferGeometry;
  private readonly lagoonMaterial: THREE.ShaderMaterial;
  private readonly lagoonMesh: THREE.InstancedMesh;
  private readonly lagoonShape: THREE.InstancedBufferAttribute;
  private readonly lagoonShape2: THREE.InstancedBufferAttribute;

  private readonly haloTexture: THREE.DataTexture;
  private readonly haloMaterial: THREE.SpriteMaterial;

  constructor() {
    this.object.name = 'islands';

    this.landMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.92,
      metalness: 0,
    });
    this.landMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uIslandGlow = this.glow;
      shader.uniforms.uIslandReach = this.reach;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float glow;\nvarying float vIslandGlow;\nvarying vec3 vIslandWorld;',
        )
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\nvIslandGlow = glow;\nvIslandWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uIslandGlow;\nuniform float uIslandReach;\nvarying float vIslandGlow;\nvarying vec3 vIslandWorld;',
        )
        .replace(
          '#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\nif (vIslandWorld.y < -0.4 && length(vIslandWorld.xz - cameraPosition.xz) > uIslandReach) discard;',
        )
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vIslandGlow * uIslandGlow;',
        );
    };
    this.landMaterial.customProgramCacheKey = () => 'wave-lab-island-land';

    this.palmGeometry = buildPalmGeometry();
    this.palmMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    this.palmMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.palmUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uPalmTime;
uniform vec2 uPalmWind;
uniform float uPalmLean;
uniform float uPalmSway;
uniform float uPalmFlutter;`,
        )
        .replace(
          '#include <project_vertex>',
          `vec4 palmLocal = vec4(transformed, 1.0);
vec2 palmBase = vec2(0.0);
#ifdef USE_INSTANCING
palmLocal = instanceMatrix * palmLocal;
palmBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
#endif
vec4 palmWorld = modelMatrix * palmLocal;
float palmT = max(transformed.y, 0.0) / ${PALM_HEIGHT.toFixed(2)};
float palmPh = dot(palmBase, vec2(0.071, 0.113));
float palmSwing = uPalmLean + uPalmSway * (0.65 * sin(uPalmTime * 1.1 + palmPh)
  + 0.35 * sin(uPalmTime * 2.3 + palmPh * 1.7));
palmWorld.xz += uPalmWind * palmSwing * palmT * palmT;
vec2 palmCrown = vec2(${(PALM_LEAN * PALM_HEIGHT).toFixed(3)}, 0.0);
float palmReach = length(transformed.xz - palmCrown);
palmReach *= step(${(PALM_HEIGHT - 3).toFixed(2)}, transformed.y) * step(0.7, palmReach);
palmWorld.y += uPalmFlutter * palmReach * sin(uPalmTime * 3.1 + palmPh * 2.0 + palmReach * 1.4 + transformed.x * 0.9 + transformed.z * 1.3);
vec4 mvPosition = viewMatrix * palmWorld;
gl_Position = projectionMatrix * mvPosition;`,
        );
    };
    this.palmMaterial.customProgramCacheKey = () => 'wave-lab-island-palm';
    this.palmMesh = new THREE.InstancedMesh(
      this.palmGeometry,
      this.palmMaterial,
      POOL_SIZE * MAX_PALMS,
    );
    this.palmMesh.name = 'island-palms';
    this.palmMesh.count = 0;
    this.object.add(this.palmMesh);

    this.lagoonGeometry = buildLagoonGeometry();
    const lagoonCount = POOL_SIZE;
    this.lagoonShape = new THREE.InstancedBufferAttribute(new Float32Array(lagoonCount * 4), 4);
    this.lagoonShape2 = new THREE.InstancedBufferAttribute(new Float32Array(lagoonCount * 4), 4);
    this.lagoonGeometry.setAttribute('aShape', this.lagoonShape);
    this.lagoonGeometry.setAttribute('aShape2', this.lagoonShape2);
    this.lagoonMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uShallow: { value: new THREE.Color(0x6ff0dc) },
          uFoam: { value: new THREE.Color(0xffffff) },
          uOpacity: { value: 1 },
          uLight: { value: 1 },
          uTime: { value: 0 },
          uPull: { value: 1 },
        },
      ]),
      vertexShader: LAGOON_VERT,
      fragmentShader: LAGOON_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.lagoonMesh = new THREE.InstancedMesh(
      this.lagoonGeometry,
      this.lagoonMaterial,
      lagoonCount,
    );
    this.lagoonMesh.name = 'island-lagoons';
    this.lagoonMesh.count = 0;
    this.lagoonMesh.renderOrder = 1;
    this.object.add(this.lagoonMesh);

    this.haloTexture = glowTexture();
    this.haloMaterial = new THREE.SpriteMaterial({
      map: this.haloTexture,
      color: 0xffe9a8,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      fog: true,
    });
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
  }

  /** Islands currently built (for tests and debugging). */
  get visibleIslands(): readonly IslandSpec[] {
    return [...this.active.values()].map((s) => s.spec!);
  }

  update(frame: SceneryFrame): void {
    if (!this.object.visible) return;
    const cam = frame.camera.position;
    const wx = cam.x;
    const wy = -cam.z;
    if (
      !(Math.hypot(wx - this.lastQuery.x, wy - this.lastQuery.y) < REFRESH_DISTANCE) // NaN-safe
    ) {
      this.lastQuery.set(wx, wy);
      this.refresh(wx, wy);
    }

    const night = THREE.MathUtils.smoothstep(1 - frame.daylight, 0.35, 0.85);
    this.glow.value = 0.12 + 2.6 * night;

    // Wind blows toward the bearing opposite the one it comes FROM.
    const from = THREE.MathUtils.degToRad(frame.windDirectionDeg);
    const u = this.palmUniforms;
    u.uPalmWind.value.set(-Math.sin(from), Math.cos(from));
    const w = Math.max(0, frame.windSpeed);
    u.uPalmTime.value = frame.wallT;
    u.uPalmLean.value = Math.min(1.4, 0.05 * w);
    u.uPalmSway.value = Math.min(0.9, 0.12 + 0.035 * w);
    u.uPalmFlutter.value = Math.min(0.12, 0.02 + 0.006 * w);

    const lu = this.lagoonMaterial.uniforms;
    lu.uTime!.value = frame.wallT;
    lu.uPull!.value = THREE.MathUtils.clamp(0.3 + 0.6 * frame.hs, 0.3, 3);
    lu.uOpacity!.value = THREE.MathUtils.clamp(1.15 - frame.hs / 5, 0.35, 1);
    lu.uLight!.value = 0.12 + 0.88 * frame.daylight;

    this.haloMaterial.opacity = 0.9 * night;
    const pulse = 1 + 0.12 * Math.sin(frame.wallT * 1.7);
    for (const slot of this.active.values()) {
      if (!slot.halo) continue;
      slot.halo.visible = night > 0.01;
      slot.halo.scale.setScalar(16 * pulse);
    }
  }

  private refresh(wx: number, wy: number): void {
    const wanted = islandsNear(wx, wy, ISLAND_VIEW_RANGE).slice(0, POOL_SIZE);
    const keys = new Set(wanted.map((s) => s.key));
    let changed = false;
    for (const [key, slot] of this.active) {
      if (keys.has(key)) continue;
      this.active.delete(key);
      slot.spec = null;
      slot.mesh.visible = false;
      if (slot.halo) slot.halo.visible = false;
      changed = true;
    }
    for (const spec of wanted) {
      if (this.active.has(spec.key)) continue;
      const slot = this.slots.find((s) => s.spec === null) ?? this.newSlot();
      this.assign(slot, spec);
      this.active.set(spec.key, slot);
      changed = true;
    }
    if (changed) this.rebuildInstances();
  }

  private newSlot(): Slot {
    const geometry = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(geometry, this.landMaterial);
    mesh.name = 'island';
    mesh.matrixAutoUpdate = false;
    this.object.add(mesh);
    const slot: Slot = {
      spec: null,
      mesh,
      geometry,
      vCap: 0,
      iCap: 0,
      palms: [],
      shape: null,
      lamp: null,
      halo: null,
    };
    this.slots.push(slot);
    return slot;
  }

  private assign(slot: Slot, spec: IslandSpec): void {
    const b = this.builder;
    const built = buildIsland(b, spec);
    const nV = b.vertexCount;
    const nI = b.idx.length;
    if (nV > slot.vCap || nI > slot.iCap) {
      slot.geometry.dispose();
      slot.vCap = Math.ceil(nV * 1.3);
      slot.iCap = Math.ceil(nI * 1.3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(slot.vCap * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(slot.vCap * 3), 3));
      g.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(slot.vCap), 1));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(slot.iCap), 1));
      slot.geometry = g;
      slot.mesh.geometry = g;
    }
    const g = slot.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const col = g.getAttribute('color') as THREE.BufferAttribute;
    const glow = g.getAttribute('glow') as THREE.BufferAttribute;
    (pos.array as Float32Array).set(b.pos);
    (col.array as Float32Array).set(b.col);
    (glow.array as Float32Array).set(b.glow);
    g.index!.array.set(b.idx);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    glow.needsUpdate = true;
    g.index!.needsUpdate = true;
    g.setDrawRange(0, nI);
    const extent = spec.radius * 1.35 * SKIRT_S;
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, (built.maxH + BASE_DEPTH) / 2, 0),
      Math.hypot(extent, (built.maxH - BASE_DEPTH) / 2),
    );
    g.boundingBox = null;

    slot.spec = spec;
    slot.shape = built.shape;
    slot.palms = built.palms;
    slot.lamp = built.lamp;
    slot.mesh.position.set(spec.x, 0, -spec.y);
    slot.mesh.updateMatrix();
    slot.mesh.visible = true;

    if (built.lamp) {
      if (!slot.halo) {
        slot.halo = new THREE.Sprite(this.haloMaterial);
        slot.halo.name = 'island-lighthouse-glow';
        this.object.add(slot.halo);
      }
      slot.halo.position.set(spec.x + built.lamp.x, built.lamp.y, -spec.y + built.lamp.z);
      slot.halo.visible = true;
    } else if (slot.halo) {
      slot.halo.visible = false;
    }
  }

  private rebuildInstances(): void {
    let p = 0;
    let l = 0;
    const shape = this.lagoonShape.array as Float32Array;
    const shape2 = this.lagoonShape2.array as Float32Array;
    for (const slot of this.active.values()) {
      const spec = slot.spec!;
      const sh = slot.shape!;
      const cx = spec.x;
      const cz = -spec.y;
      for (let i = 0; i < slot.palms.length; i += 5) {
        const s = slot.palms[i + 4]!;
        tmpQ.setFromAxisAngle(tmpV.set(0, 1, 0), slot.palms[i + 3]!);
        tmpM.compose(
          tmpP.set(cx + slot.palms[i]!, slot.palms[i + 1]!, cz + slot.palms[i + 2]!),
          tmpQ,
          tmpS.set(s, s, s),
        );
        this.palmMesh.setMatrixAt(p++, tmpM);
      }
      tmpM.compose(tmpP.set(cx, 0, cz), tmpQ.identity(), tmpS.set(sh.r0, 1, sh.r0));
      this.lagoonMesh.setMatrixAt(l, tmpM);
      shape.set([sh.a[0], sh.p[0], sh.a[1], sh.p[1]], l * 4);
      shape2.set([sh.a[2], sh.p[2], (spec.seed % 1000) / 1000, 0], l * 4);
      l++;
    }
    this.palmMesh.count = p;
    this.palmMesh.instanceMatrix.needsUpdate = true;
    this.palmMesh.computeBoundingSphere();
    if (this.palmMesh.boundingSphere) this.palmMesh.boundingSphere.radius += 3;
    this.lagoonMesh.count = l;
    this.lagoonMesh.instanceMatrix.needsUpdate = true;
    this.lagoonShape.needsUpdate = true;
    this.lagoonShape2.needsUpdate = true;
    this.lagoonMesh.computeBoundingSphere();
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.geometry.dispose();
      this.object.remove(slot.mesh);
      if (slot.halo) this.object.remove(slot.halo);
    }
    this.slots.length = 0;
    this.active.clear();
    this.landMaterial.dispose();
    this.palmGeometry.dispose();
    this.palmMaterial.dispose();
    this.palmMesh.dispose();
    this.object.remove(this.palmMesh);
    this.lagoonGeometry.dispose();
    this.lagoonMaterial.dispose();
    this.lagoonMesh.dispose();
    this.object.remove(this.lagoonMesh);
    this.haloTexture.dispose();
    this.haloMaterial.dispose();
    this.lastQuery.set(Number.NaN, Number.NaN);
  }
}
