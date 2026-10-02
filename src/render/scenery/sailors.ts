/**
 * Little sailors walking the decks.
 *
 * Purely decorative: crew members are pixel-art billboards drawn into one procedurally painted
 * sprite sheet and rendered as a single instanced mesh (one draw call, one material, one
 * texture). They stand on the hull's deck (found from the render hull's up-facing triangles),
 * keep clear of the superstructure, stroll short patrols, look out and wave. In heavy weather
 * they brace and hold on; at night one of each crew carries a lantern.
 *
 * The placement maths (deck surface, crew size, spots and patrols) is pure and exported so it
 * can be unit-tested in node without WebGL; the sprite sheet canvas is created lazily.
 */
import * as THREE from 'three';
import type { VesselDefinition, VisualBox } from '../../vessel/api';
import type { SceneryFrame, SceneryLayer, SceneryVessel } from './types';

// ============================================================================ placement maths

/** Height of a person [m] and the readability upscale applied to the sprites. */
/** Sailors closer than this to the camera are not drawn [m]. */
const NEAR_CULL = 6;

export const SAILOR_HEIGHT = 1.8;
export const SAILOR_UPSCALE = 1.3;
/** Clearance kept from the deck edge and from superstructure [m]. */
export const SAILOR_MARGIN = 0.35;
/** Free height a box must leave above the deck to be walked under [m]. */
const HEAD_ROOM = 2.1;
/** Boxes no taller than this above the deck are stepped onto (deck plates, hatch covers) [m]. */
const STEP_UP = 0.6;
/** Largest height change allowed along a patrol between two samples [m]. */
const MAX_STEP = 0.3;

/**
 * The walkable deck of a hull: the up-facing triangles of the render hull (the deck between
 * the sheer lines; sides, bottom and transom face sideways or down), binned along x.
 */
export interface DeckSurface {
  /** 9 floats per triangle: (x, y, z) of the three corners, body frame [m]. */
  tris: Float32Array;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Triangle indices per x bin. */
  bins: number[][];
  binWidth: number;
  boxes: readonly VisualBox[];
}

export interface DeckSpot {
  x: number;
  y: number;
  /** Height of the surface the sailor stands on, body frame [m]. */
  z: number;
  /** True when the spot is on the roof of a low deckhouse rather than on the deck itself. */
  roof?: boolean;
}

export type CrewRole = 'captain' | 'sailor';

export interface CrewMember {
  role: CrewRole;
  /** Row of the sprite sheet (look: skin, hair, uniform). */
  variant: number;
  /** One end of the patrol; the member starts here. */
  home: DeckSpot;
  /** The other end of the patrol (equal to `home` when there is no room to walk). */
  patrol: DeckSpot;
  /** Size variation around 1. */
  scale: number;
}

/** Number of sailor looks and captain looks on the sprite sheet. */
export const SAILOR_VARIANTS = 6;
export const CAPTAIN_VARIANTS = 2;

/** Extract the walkable deck from a vessel definition. */
export function deckSurface(def: VesselDefinition): DeckSurface {
  const p = def.renderHull.positions;
  const ix = def.renderHull.indices;
  const tris: number[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let t = 0; t < ix.length; t += 3) {
    const a = 3 * ix[t]!;
    const b = 3 * ix[t + 1]!;
    const c = 3 * ix[t + 2]!;
    const ux = p[b]! - p[a]!;
    const uy = p[b + 1]! - p[a + 1]!;
    const uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!;
    const vy = p[c + 1]! - p[a + 1]!;
    const vz = p[c + 2]! - p[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || nz / len < 0.85) continue;
    for (const v of [a, b, c]) {
      tris.push(p[v]!, p[v + 1]!, p[v + 2]!);
      minX = Math.min(minX, p[v]!);
      maxX = Math.max(maxX, p[v]!);
      minY = Math.min(minY, p[v + 1]!);
      maxY = Math.max(maxY, p[v + 1]!);
    }
  }
  const count = tris.length / 9;
  const binCount = Math.max(1, Math.min(96, Math.ceil(count / 6)));
  const binWidth = count > 0 ? Math.max(1e-6, (maxX - minX) / binCount) : 1;
  const bins: number[][] = Array.from({ length: binCount }, () => []);
  for (let i = 0; i < count; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = tris[9 * i + 3 * k]!;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    const b0 = Math.max(0, Math.floor((lo - minX) / binWidth));
    const b1 = Math.min(binCount - 1, Math.floor((hi - minX) / binWidth));
    for (let b = b0; b <= b1; b++) bins[b]!.push(i);
  }
  return {
    tris: new Float32Array(tris),
    minX,
    maxX,
    minY,
    maxY,
    bins,
    binWidth,
    boxes: def.superstructure,
  };
}

/** Deck height at body (x, y), or NaN when the point is not over the deck. */
export function deckHeightAt(deck: DeckSurface, x: number, y: number): number {
  if (!(x >= deck.minX && x <= deck.maxX && y >= deck.minY && y <= deck.maxY)) return NaN;
  const b = Math.min(deck.bins.length - 1, Math.floor((x - deck.minX) / deck.binWidth));
  const T = deck.tris;
  for (const i of deck.bins[b]!) {
    const o = 9 * i;
    const ax = T[o]!;
    const ay = T[o + 1]!;
    const bx = T[o + 3]!;
    const by = T[o + 4]!;
    const cx = T[o + 6]!;
    const cy = T[o + 7]!;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
    const l3 = 1 - l1 - l2;
    const eps = -1e-6;
    if (l1 >= eps && l2 >= eps && l3 >= eps) {
      return l1 * T[o + 2]! + l2 * T[o + 5]! + l3 * T[o + 8]!;
    }
  }
  return NaN;
}

const boxBottom = (b: VisualBox): number => b.center.z - b.size.z / 2;
const boxTop = (b: VisualBox): number => b.center.z + b.size.z / 2;
const inFootprint = (b: VisualBox, x: number, y: number, grow: number): boolean =>
  Math.abs(x - b.center.x) <= b.size.x / 2 + grow &&
  Math.abs(y - b.center.y) <= b.size.y / 2 + grow;

/** The deck is under the point and all around it within the margin. */
function deckWithMargin(deck: DeckSurface, x: number, y: number, m: number): number {
  const z = deckHeightAt(deck, x, y);
  if (Number.isNaN(z)) return NaN;
  for (const [dx, dy] of OFFSETS) {
    if (Number.isNaN(deckHeightAt(deck, x + dx * m, y + dy * m))) return NaN;
  }
  return z;
}
const OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7, 0.7],
  [-0.7, 0.7],
  [0.7, -0.7],
  [-0.7, -0.7],
];

/** No box intrudes into a person-sized column standing at height z (ignoring `skip`). */
function clearOfBoxes(
  boxes: readonly VisualBox[],
  x: number,
  y: number,
  z: number,
  margin: number,
  skip?: VisualBox,
): boolean {
  for (const b of boxes) {
    if (b === skip) continue;
    if (!inFootprint(b, x, y, margin)) continue;
    if (boxBottom(b) < z + HEAD_ROOM && boxTop(b) > z + 0.05) return false;
  }
  return true;
}

/**
 * Height a sailor stands at on the deck at body (x, y): the deck, or the top of a low deck
 * plate or hatch cover. NaN when the point is off the deck, too close to its edge, or inside
 * (or under the low overhang of) a superstructure box.
 */
export function standHeightAt(
  deck: DeckSurface,
  x: number,
  y: number,
  margin = SAILOR_MARGIN,
): number {
  let z = deckWithMargin(deck, x, y, margin);
  if (Number.isNaN(z)) return NaN;
  let platform: VisualBox | undefined;
  for (const b of deck.boxes) {
    if (b.material === 'glass') continue;
    const top = boxTop(b);
    if (boxBottom(b) <= z + 0.3 && top > z && top <= z + STEP_UP && inFootprint(b, x, y, 0)) {
      if (!platform || top > boxTop(platform)) platform = b;
    }
  }
  if (platform) {
    // Stand on the plate only well inside it, not straddling its edge.
    if (!inFootprint(platform, x, y, -margin)) return NaN;
    z = boxTop(platform);
  }
  return clearOfBoxes(deck.boxes, x, y, z, margin, platform) ? z : NaN;
}

/**
 * Height a sailor stands at on the roof of a low deckhouse or canopy at (x, y) (used when the
 * deck itself is too crowded, e.g. an enclosed lifeboat), or NaN.
 */
export function roofHeightAt(
  deck: DeckSurface,
  x: number,
  y: number,
  margin = SAILOR_MARGIN,
): number {
  const floor = deckHeightAt(deck, x, y);
  if (Number.isNaN(floor)) return NaN;
  let best = NaN;
  let roof: VisualBox | undefined;
  for (const b of deck.boxes) {
    if (b.material === 'glass' || b.material === 'cargo') continue;
    if (b.size.x < 1.2 || b.size.y < 1.2) continue;
    const top = boxTop(b);
    if (boxBottom(b) > floor + 0.6 || top > floor + 3.5) continue;
    if (!inFootprint(b, x, y, -margin)) continue;
    if (Number.isNaN(best) || top > best) {
      best = top;
      roof = b;
    }
  }
  if (Number.isNaN(best)) return NaN;
  return clearOfBoxes(deck.boxes, x, y, best, margin, roof) ? best : NaN;
}

/** Crew size for a vessel, scaled by its deck area (2 on a lifeboat, ~7 on a cargo ship). */
export function crewCount(def: VesselDefinition): number {
  const area = Math.max(1, def.length * def.beam);
  return Math.max(1, Math.min(8, Math.round(1 + 1.15 * Math.log(Math.max(1, area / 12)))));
}

/** Grid spacing for candidate spots [m]. */
function spotSpacing(def: VesselDefinition): number {
  return Math.min(1.6, Math.max(0.3, Math.sqrt(def.length * def.beam) / 14));
}

/** Candidate standing spots on a regular grid over the deck. */
export function deckSpots(
  def: VesselDefinition,
  deck: DeckSurface = deckSurface(def),
  opts: { roof?: boolean; spacing?: number } = {},
): DeckSpot[] {
  const out: DeckSpot[] = [];
  if (deck.tris.length === 0) return out;
  const h = opts.spacing ?? spotSpacing(def);
  const nx = Math.floor((deck.maxX - deck.minX) / h);
  const ny = Math.floor((deck.maxY - deck.minY) / h);
  const x0 = (deck.minX + deck.maxX - nx * h) / 2;
  const y0 = (deck.minY + deck.maxY - ny * h) / 2;
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const x = x0 + i * h;
      const y = y0 + j * h;
      const z = opts.roof ? roofHeightAt(deck, x, y) : standHeightAt(deck, x, y);
      if (!Number.isNaN(z)) out.push(opts.roof ? { x, y, z, roof: true } : { x, y, z });
    }
  }
  return out;
}

/** A straight walk from a to b stays on walkable ground without climbing. */
export function walkable(deck: DeckSurface, a: DeckSpot, b: DeckSpot): boolean {
  const height = a.roof ? roofHeightAt : standHeightAt;
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / 0.25));
  let prev = a.z;
  for (let k = 1; k <= n; k++) {
    const u = k / n;
    const z = height(deck, a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u);
    if (Number.isNaN(z) || Math.abs(z - prev) > MAX_STEP) return false;
    prev = z;
  }
  return true;
}

/** Small deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const dist2 = (a: DeckSpot, b: DeckSpot): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/**
 * Plan a vessel's crew: how many, where each one stands and the short patrol they walk. The
 * captain (on crews of two or more) keeps near the bridge; the others spread over the deck.
 */
export function planCrew(def: VesselDefinition, seed = 1): CrewMember[] {
  const rand = seededRandom(seed);
  const deck = deckSurface(def);
  const wanted = crewCount(def);
  let spots = deckSpots(def, deck);
  // Crowded decks (an enclosed lifeboat is all canopy): use the roof of a low deckhouse too.
  if (spots.length < wanted * 4) spots = spots.concat(deckSpots(def, deck, { roof: true }));
  if (spots.length === 0) return [];
  const spacing = spotSpacing(def);
  const minGap = Math.max(1.8, spacing * 1.5);

  const chosen: { spot: DeckSpot; role: CrewRole }[] = [];
  if (wanted >= 2) {
    const bridge = def.points.bridge;
    let best = spots[0]!;
    let bestD = Infinity;
    for (const s of spots) {
      const d = Math.hypot(s.x - bridge.x, s.y - bridge.y) + 0.3 * Math.abs(s.z - bridge.z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    chosen.push({ spot: best, role: 'captain' });
  }
  // Farthest-point sampling (with a little jitter) spreads the crew over the deck.
  const minD2 = new Float64Array(spots.length).fill(Infinity);
  const update = (p: DeckSpot): void => {
    for (let i = 0; i < spots.length; i++) minD2[i] = Math.min(minD2[i]!, dist2(spots[i]!, p));
  };
  for (const c of chosen) update(c.spot);
  while (chosen.length < wanted) {
    let pick = -1;
    let score = -Infinity;
    for (let i = 0; i < spots.length; i++) {
      const d = minD2[i]!;
      if (d < minGap * minGap) continue;
      const s = (Number.isFinite(d) ? Math.sqrt(d) : 1e6) * (0.75 + 0.5 * rand());
      if (s > score) {
        score = s;
        pick = i;
      }
    }
    if (pick < 0) break;
    const spot = spots[pick]!;
    chosen.push({ spot, role: 'sailor' });
    update(spot);
  }

  const members: CrewMember[] = [];
  const reach = Math.min(10, Math.max(2, def.length * 0.12));
  for (const { spot, role } of chosen) {
    const maxLen = role === 'captain' ? Math.min(3.5, reach) : reach;
    const minLen = Math.min(1.2, maxLen * 0.5);
    const candidates: DeckSpot[] = [];
    for (const s of spots) {
      if (Boolean(s.roof) !== Boolean(spot.roof)) continue;
      const d = Math.sqrt(dist2(s, spot));
      if (d < minLen || d > maxLen) continue;
      // Do not walk into a shipmate's spot.
      if (chosen.some((o) => o.spot !== spot && dist2(o.spot, s) < (minGap * 0.8) ** 2)) continue;
      candidates.push(s);
    }
    let patrol = spot;
    // Try a few random candidates, longest first among them.
    for (let tries = 0; tries < 12 && candidates.length > 0; tries++) {
      const k = Math.floor(rand() * candidates.length);
      const c = candidates[k]!;
      candidates.splice(k, 1);
      if (walkable(deck, spot, c)) {
        patrol = c;
        break;
      }
    }
    const variant =
      role === 'captain'
        ? SAILOR_VARIANTS + Math.floor(rand() * CAPTAIN_VARIANTS)
        : Math.floor(rand() * SAILOR_VARIANTS);
    members.push({ role, variant, home: spot, patrol, scale: 0.94 + 0.1 * rand() });
  }
  return members;
}

// ============================================================================ sprite sheet

const CELL_W = 16;
const CELL_H = 24;
/** Frames (columns) of the sheet. */
export const FRAME = {
  idle: 0,
  blink: 1,
  walk: 2, // 2..5
  wave: 6, // 6..7
  brace: 8, // 8..9
  look: 10,
  lantern: 11,
} as const;
const COLS = 12;
const ROWS = SAILOR_VARIANTS + CAPTAIN_VARIANTS;
/** Pixel rows from the top of the cap to the soles (the sprite's drawn height). */
const FIGURE_PX = 22;

interface Look {
  skin: string;
  skinShade: string;
  hair: string;
  captain: boolean;
  beard?: string;
}

const SKINS = [
  ['#ffdcbd', '#ebb894'],
  ['#f0bf98', '#d39a72'],
  ['#c88c60', '#a56f48'],
  ['#8a5838', '#6a3f26'],
] as const;

const LOOKS: readonly Look[] = [
  { skin: SKINS[0][0], skinShade: SKINS[0][1], hair: '#6b3e1f', captain: false },
  { skin: SKINS[1][0], skinShade: SKINS[1][1], hair: '#2a211c', captain: false },
  { skin: SKINS[2][0], skinShade: SKINS[2][1], hair: '#1d1a18', captain: false },
  { skin: SKINS[3][0], skinShade: SKINS[3][1], hair: '#141210', captain: false },
  { skin: SKINS[0][0], skinShade: SKINS[0][1], hair: '#e3b65a', captain: false },
  { skin: SKINS[1][0], skinShade: SKINS[1][1], hair: '#b5482a', captain: false },
  { skin: SKINS[1][0], skinShade: SKINS[1][1], hair: '#a3a3a3', captain: true, beard: '#e4e4e4' },
  { skin: SKINS[2][0], skinShade: SKINS[2][1], hair: '#1d1a18', captain: true },
];

const C = {
  white: '#f7f9fc',
  whiteShade: '#c6d0e2',
  navy: '#22305c',
  navyShade: '#18223f',
  blue: '#2e64cc',
  gold: '#f2c23c',
  shoe: '#262a33',
  outline: '#151a29',
  cheek: '#f39a9a',
  eye: '#1a1c28',
  red: '#d94848',
  visor: '#0f1220',
  lanternFrame: '#5b4526',
  lanternGlass: '#ffe08a',
} as const;

type Arm = 'down' | 'fwd' | 'up' | 'upOut' | 'brow' | 'out' | 'lantern';
type Legs = 'stand' | 'stride' | 'passL' | 'passR' | 'wide';
type Eyes = 'open' | 'blink' | 'happy' | 'squint';

interface Pose {
  dy: number;
  legs: Legs;
  armL: Arm;
  armR: Arm;
  eyes: Eyes;
  /** Shift the face toward +x (walking to the right). */
  face: number;
  sway?: number;
}

const POSES: readonly Pose[] = [
  { dy: 0, legs: 'stand', armL: 'down', armR: 'down', eyes: 'open', face: 0 },
  { dy: 0, legs: 'stand', armL: 'down', armR: 'down', eyes: 'blink', face: 0 },
  { dy: 0, legs: 'stride', armL: 'fwd', armR: 'down', eyes: 'open', face: 1 },
  { dy: -1, legs: 'passL', armL: 'down', armR: 'down', eyes: 'open', face: 1 },
  { dy: 0, legs: 'stride', armL: 'down', armR: 'fwd', eyes: 'open', face: 1 },
  { dy: -1, legs: 'passR', armL: 'down', armR: 'down', eyes: 'open', face: 1 },
  { dy: 0, legs: 'stand', armL: 'down', armR: 'up', eyes: 'happy', face: 0 },
  { dy: 0, legs: 'stand', armL: 'down', armR: 'upOut', eyes: 'happy', face: 0 },
  { dy: 2, legs: 'wide', armL: 'out', armR: 'out', eyes: 'squint', face: 0, sway: 0 },
  { dy: 2, legs: 'wide', armL: 'out', armR: 'out', eyes: 'squint', face: 0, sway: 1 },
  { dy: 0, legs: 'stand', armL: 'down', armR: 'brow', eyes: 'open', face: 1 },
  { dy: 0, legs: 'stand', armL: 'lantern', armR: 'down', eyes: 'open', face: 0 },
];

type Paint = (x: number, y: number, w: number, h: number, color: string) => void;

function drawFigure(paint: Paint, look: Look, pose: Pose): void {
  const cloth = look.captain ? C.navy : C.white;
  const clothShade = look.captain ? C.navyShade : C.whiteShade;
  const trousers = look.captain ? C.navy : C.white;
  const trouserShade = look.captain ? C.navyShade : C.whiteShade;
  const cuff = look.captain ? C.gold : C.blue;
  const sx = pose.sway ?? 0;
  const dy = pose.dy;

  // ---- legs
  const leg = (x: number, lift: number, toe: number): void => {
    paint(x, 19, 2, 3 - lift, trousers);
    paint(x + 1, 19, 1, 3 - lift, trouserShade);
    paint(x - 1 + toe, 22 - lift, 3, 2, C.shoe);
  };
  switch (pose.legs) {
    case 'stand':
      leg(5, 0, 0);
      leg(9, 0, 1);
      break;
    case 'stride':
      leg(4, 0, 1);
      leg(10, 0, 1);
      break;
    case 'passL':
      leg(6, 1, 1);
      leg(8, 0, 1);
      break;
    case 'passR':
      leg(6, 0, 1);
      leg(8, 1, 1);
      break;
    case 'wide':
      paint(4 + sx, 19, 2, 1, trousers);
      paint(3 + sx, 20, 2, 2, trousers);
      paint(10 + sx, 19, 2, 1, trousers);
      paint(11 + sx, 20, 2, 2, trousers);
      paint(2 + sx, 22, 3, 2, C.shoe);
      paint(11 + sx, 22, 3, 2, C.shoe);
      break;
  }

  const X = sx;
  const Y = dy;
  // ---- torso
  paint(4 + X, 13 + Y, 8, 6, cloth);
  paint(11 + X, 14 + Y, 1, 5, clothShade);
  if (look.captain) {
    paint(7 + X, 13 + Y, 2, 2, C.white);
    paint(7 + X, 14 + Y, 2, 1, C.red);
    paint(4 + X, 13 + Y, 1, 1, C.gold);
    paint(11 + X, 13 + Y, 1, 1, C.gold);
    paint(6 + X, 15 + Y, 1, 1, C.gold);
    paint(9 + X, 15 + Y, 1, 1, C.gold);
    paint(6 + X, 17 + Y, 1, 1, C.gold);
    paint(9 + X, 17 + Y, 1, 1, C.gold);
  } else {
    paint(4 + X, 13 + Y, 8, 2, C.blue);
    paint(4 + X, 14 + Y, 8, 1, C.white);
    paint(4 + X, 14 + Y, 1, 1, C.blue);
    paint(11 + X, 14 + Y, 1, 1, C.blue);
    paint(7 + X, 13 + Y, 2, 1, look.skin);
    paint(7 + X, 15 + Y, 2, 1, C.red);
    paint(7 + X, 16 + Y, 1, 1, C.red);
  }

  // ---- arms (sleeve + cuff + hand); `side` −1 = left (low x), +1 = right
  const arm = (kind: Arm, side: number): void => {
    const sh = side < 0 ? 2 : 12; // shoulder column
    const out = side < 0 ? -1 : 1;
    switch (kind) {
      case 'down':
        paint(sh + X, 13 + Y, 2, 4, cloth);
        paint(sh + X, 17 + Y, 2, 1, cuff);
        paint(sh + X, 18 + Y, 2, 1, look.skin);
        break;
      case 'fwd':
        paint(sh + X, 13 + Y, 2, 3, cloth);
        paint(sh + out + X, 15 + Y, 2, 1, cloth);
        paint(sh + out + X, 16 + Y, 2, 1, cuff);
        paint(sh + out + X, 17 + Y, 2, 1, look.skin);
        break;
      case 'up':
        paint(sh + X, 13 + Y, 2, 1, cloth);
        paint(sh + X, 9 + Y, 2, 4, cloth);
        paint(sh + X, 8 + Y, 2, 1, cuff);
        paint(sh + X, 6 + Y, 2, 2, look.skin);
        break;
      case 'upOut':
        paint(sh + X, 12 + Y, 2, 2, cloth);
        paint(sh + out + X, 9 + Y, 2, 3, cloth);
        paint(sh + out + X, 8 + Y, 2, 1, cuff);
        paint(sh + out + X, 6 + Y, 2, 2, look.skin);
        break;
      case 'brow':
        paint(sh + X, 10 + Y, 2, 4, cloth);
        paint(sh + X, 9 + Y, 2, 1, cuff);
        paint(sh - 3 + X, 8 + Y, 4, 1, look.skin);
        break;
      case 'out':
        paint(sh + X, 13 + Y, 2, 2, cloth);
        paint(sh + out + X, 15 + Y, 2, 1, cloth);
        paint(sh + out + X, 16 + Y, 2, 1, cuff);
        paint(sh + out + X, 17 + Y, 2, 1, look.skin);
        break;
      case 'lantern':
        paint(sh + X, 13 + Y, 2, 4, cloth);
        paint(sh + X, 17 + Y, 2, 1, cuff);
        paint(sh + X, 18 + Y, 2, 1, look.skin);
        paint(sh - 1 + X, 19 + Y, 3, 1, C.lanternFrame);
        paint(sh - 1 + X, 20 + Y, 3, 2, C.lanternGlass);
        paint(sh - 1 + X, 22 + Y, 3, 1, C.lanternFrame);
        break;
    }
  };
  if (pose.armL !== 'brow' && pose.armL !== 'up' && pose.armL !== 'upOut') arm(pose.armL, -1);
  if (pose.armR !== 'brow' && pose.armR !== 'up' && pose.armR !== 'upOut') arm(pose.armR, 1);

  // ---- head (rounded block)
  paint(4 + X, 5 + Y, 8, 8, look.skin);
  paint(3 + X, 6 + Y, 10, 6, look.skin);
  paint(12 + X, 7 + Y, 1, 4, look.skinShade);
  // hair under the cap
  paint(4 + X, 6 + Y, 8, 1, look.hair);
  paint(3 + X, 6 + Y, 1, 3, look.hair);
  paint(12 + X, 6 + Y, 1, 3, look.hair);
  const f = pose.face + X;
  // eyes
  switch (pose.eyes) {
    case 'open':
      paint(5 + f, 9 + Y, 1, 2, C.eye);
      paint(10 + f, 9 + Y, 1, 2, C.eye);
      break;
    case 'blink':
      paint(5 + f, 10 + Y, 1, 1, C.eye);
      paint(10 + f, 10 + Y, 1, 1, C.eye);
      break;
    case 'happy':
      paint(4 + f, 10 + Y, 1, 1, C.eye);
      paint(5 + f, 9 + Y, 1, 1, C.eye);
      paint(6 + f, 10 + Y, 1, 1, C.eye);
      paint(9 + f, 10 + Y, 1, 1, C.eye);
      paint(10 + f, 9 + Y, 1, 1, C.eye);
      paint(11 + f, 10 + Y, 1, 1, C.eye);
      break;
    case 'squint':
      paint(4 + f, 10 + Y, 2, 1, C.eye);
      paint(10 + f, 10 + Y, 2, 1, C.eye);
      break;
  }
  if (look.beard) {
    paint(4 + X, 11 + Y, 8, 2, look.beard);
    paint(3 + X, 10 + Y, 1, 2, look.beard);
    paint(12 + X, 10 + Y, 1, 2, look.beard);
    paint(7 + f, 11 + Y, 2, 1, '#b86a5e');
  } else {
    paint(4 + f, 11 + Y, 1, 1, C.cheek);
    paint(11 + f, 11 + Y, 1, 1, C.cheek);
    paint(7 + f, 12 + Y, 2, 1, pose.eyes === 'happy' ? '#b8434a' : '#c27a6a');
  }

  // ---- cap
  if (look.captain) {
    paint(3 + X, 1 + Y, 10, 2, C.white);
    paint(4 + X, 1 + Y, 8, 1, C.white);
    paint(3 + X, 2 + Y, 10, 1, C.whiteShade);
    paint(4 + X, 3 + Y, 8, 2, C.navy);
    paint(7 + X, 3 + Y, 2, 1, C.gold);
    paint(3 + X, 5 + Y, 10, 1, C.visor);
  } else {
    paint(5 + X, 2 + Y, 6, 1, C.white);
    paint(4 + X, 3 + Y, 8, 2, C.white);
    paint(3 + X, 5 + Y, 10, 1, C.whiteShade);
    paint(4 + X, 4 + Y, 8, 1, C.blue);
  }

  // raised arms go in front of the head
  if (pose.armL === 'brow' || pose.armL === 'up' || pose.armL === 'upOut') arm(pose.armL, -1);
  if (pose.armR === 'brow' || pose.armR === 'up' || pose.armR === 'upOut') arm(pose.armR, 1);
}

/** Paint the whole sheet (COLS × ROWS cells) and outline every figure. */
function paintSheet(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = COLS * CELL_W;
  canvas.height = ROWS * CELL_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const ox = c * CELL_W;
      const oy = r * CELL_H;
      const paint: Paint = (x, y, w, h, color) => {
        // Clip to the cell so a figure never bleeds into its neighbour.
        const x0 = Math.max(0, x);
        const y0 = Math.max(0, y);
        const x1 = Math.min(CELL_W, x + w);
        const y1 = Math.min(CELL_H, y + h);
        if (x1 <= x0 || y1 <= y0) return;
        ctx.fillStyle = color;
        ctx.fillRect(ox + x0, oy + y0, x1 - x0, y1 - y0);
      };
      drawFigure(paint, LOOKS[r]!, POSES[c]!);
    }
  }
  // Outline: transparent pixels next to the figure (within its cell) become dark.
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const W = canvas.width;
  const solid = new Uint8Array(W * canvas.height);
  for (let i = 0; i < solid.length; i++) solid[i] = d[4 * i + 3]! > 0 ? 1 : 0;
  const oc = new THREE.Color(C.outline);
  const or = Math.round(oc.r * 255);
  const og = Math.round(oc.g * 255);
  const ob = Math.round(oc.b * 255);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (solid[i]) continue;
      const cx = x % CELL_W;
      const cy = y % CELL_H;
      const near =
        (cx > 0 && solid[i - 1]) ||
        (cx < CELL_W - 1 && solid[i + 1]) ||
        (cy > 0 && solid[i - W]) ||
        (cy < CELL_H - 1 && solid[i + W]);
      if (!near) continue;
      d[4 * i] = or;
      d[4 * i + 1] = og;
      d[4 * i + 2] = ob;
      d[4 * i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function paintGlow(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,244,214,1)');
  g.addColorStop(0.12, 'rgba(255,214,140,0.85)');
  g.addColorStop(0.4, 'rgba(255,160,70,0.25)');
  g.addColorStop(1, 'rgba(255,140,50,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return canvas;
}

// ============================================================================ rendering

const VERTEX = /* glsl */ `
attribute vec4 aSprite; // column, row, flip, lantern light
uniform vec2 uGrid;
uniform vec2 uSize;
varying vec2 vUv;
varying float vLit;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 upW = (instanceMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
  float s = length(upW);
  // Screen-facing, but leaning with the hull as it rolls (biased toward screen-up so the
  // sprite stays steady when the camera looks straight down).
  vec2 upV = (modelViewMatrix * vec4(upW / max(s, 1e-5), 0.0)).xy;
  upV = normalize(upV + vec2(0.0, 0.35));
  vec2 rightV = vec2(upV.y, -upV.x);
  mvPosition.xy += (rightV * position.x * uSize.x + upV * position.y * uSize.y) * s;
  mvPosition.z += 0.3 * s; // keep the feet in front of the deck they stand on
  gl_Position = projectionMatrix * mvPosition;
  float u = aSprite.z > 0.5 ? 1.0 - uv.x : uv.x;
  u = mix(0.004, 0.996, u);
  vUv = vec2((aSprite.x + u) / uGrid.x, 1.0 - (aSprite.y + 1.0 - uv.y) / uGrid.y);
  vLit = aSprite.w;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uTint;
uniform vec3 uLamp;
varying vec2 vUv;
varying float vLit;
#include <fog_pars_fragment>
void main() {
  vec4 c = texture2D(uMap, vUv);
  if (c.a < 0.5) discard;
  gl_FragColor = vec4(c.rgb * mix(uTint, uLamp, vLit), 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const Mode = { Idle: 0, Walk: 1, Wave: 2, Look: 3, Brace: 4 } as const;
type Mode = (typeof Mode)[keyof typeof Mode];

interface Sailor {
  vessel: number;
  member: CrewMember;
  /** Patrol end points in Three.js body axes. */
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  len: number;
  /** Position along the patrol 0 (home) … 1 (patrol end) and walking direction. */
  s: number;
  dir: number;
  mode: Mode;
  timer: number;
  anim: number;
  flip: boolean;
  lantern: boolean;
}

interface CrewVessel {
  id: string;
  group: THREE.Group;
}

const WALK_SPEED = 1.1; // [m/s]
const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export class SailorLayer implements SceneryLayer {
  readonly object = new THREE.Group();

  private enabled = true;
  private sheet: THREE.CanvasTexture | null = null;
  private glowTexture: THREE.CanvasTexture | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private glowMaterial: THREE.SpriteMaterial | null = null;
  private mesh: THREE.InstancedMesh | null = null;
  private spriteAttr: THREE.InstancedBufferAttribute | null = null;
  private readonly glows: THREE.Sprite[] = [];
  private vessels: CrewVessel[] = [];
  private sailors: Sailor[] = [];
  /** Per vessel, per frame: hidden (capsized / far away). */
  private hidden: boolean[] = [];

  private readonly local = new THREE.Matrix4();
  private readonly world = new THREE.Matrix4();
  private readonly dirW = new THREE.Vector3();
  private readonly camRight = new THREE.Vector3();
  private readonly upW = new THREE.Vector3();
  private readonly feet = new THREE.Vector3();
  private readonly toCam = new THREE.Vector3();
  private readonly tint = new THREE.Color();

  constructor() {
    this.object.name = 'sailors';
  }

  setVessels(vessels: readonly SceneryVessel[]): void {
    this.vessels = vessels.map((v) => ({ id: v.id, group: v.group }));
    this.sailors = [];
    vessels.forEach((v, vi) => {
      const crew = planCrew(v.definition, hashString(v.id));
      const lanternIndex = crew.findIndex((m) => m.role === 'sailor');
      crew.forEach((member, k) => {
        const len = Math.hypot(member.patrol.x - member.home.x, member.patrol.y - member.home.y);
        this.sailors.push({
          vessel: vi,
          member,
          ax: member.home.x,
          ay: member.home.z,
          az: -member.home.y,
          bx: member.patrol.x,
          by: member.patrol.z,
          bz: -member.patrol.y,
          len,
          s: 0,
          dir: 1,
          mode: Mode.Idle,
          timer: 0.5 + 3 * Math.random(),
          anim: Math.random() * 10,
          flip: Math.random() < 0.5,
          lantern: k === (lanternIndex >= 0 ? lanternIndex : 0),
        });
      });
    });
    this.hidden = this.vessels.map(() => false);
    if (this.sailors.length > 0) this.ensureGpu(this.sailors.length, this.vessels.length);
    if (this.mesh) this.mesh.count = 0;
    for (const g of this.glows) g.visible = false;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.object.visible = enabled;
  }

  update(frame: SceneryFrame): void {
    const mesh = this.mesh;
    const attr = this.spriteAttr;
    if (!this.enabled || !mesh || !attr || !this.material) return;
    const dt = frame.dt;
    const calm = frame.calm;
    const storm = 1 - calm;
    const night = 1 - smooth(0.12, 0.45, frame.daylight);

    // Night tint: sprites are unlit, so darken and cool them with the daylight.
    const day = smooth(0.0, 0.6, frame.daylight);
    const tint = this.tint.setRGB(0.16 + 0.8 * day, 0.19 + 0.77 * day, 0.32 + 0.64 * day);
    (this.material.uniforms.uTint!.value as THREE.Color).copy(tint);

    const cam = frame.camera;
    this.camRight.setFromMatrixColumn(cam.matrixWorld, 0);
    // Hide crews that would be only a few pixels tall (they would just flicker).
    const pxPerM = 1000 / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const farLimit = (SAILOR_HEIGHT * SAILOR_UPSCALE * pxPerM) / 3;

    for (let i = 0; i < this.vessels.length; i++) {
      const v = this.vessels[i]!;
      let capsized = false;
      for (const m of frame.vessels) {
        if (m.id === v.id) {
          capsized = m.capsized;
          break;
        }
      }
      v.group.updateWorldMatrix(true, false);
      const e = v.group.matrixWorld.elements;
      const upY = e[5]!; // body up (three y) → world y component
      const dx = e[12]! - cam.position.x;
      const dy = e[13]! - cam.position.y;
      const dz = e[14]! - cam.position.z;
      const far = dx * dx + dy * dy + dz * dz > farLimit * farLimit;
      this.hidden[i] = capsized || upY < 0.35 || far || !v.group.visible;
    }

    const arr = attr.array as Float32Array;
    let n = 0;
    let glows = 0;
    for (const sailor of this.sailors) {
      this.step(sailor, dt, calm, storm, night);
      if (this.hidden[sailor.vessel]) continue;
      const group = this.vessels[sailor.vessel]!.group;
      const u = sailor.s;
      const px = sailor.ax + (sailor.bx - sailor.ax) * u;
      const py = sailor.ay + (sailor.by - sailor.ay) * u;
      const pz = sailor.az + (sailor.bz - sailor.az) * u;
      if (sailor.mode === Mode.Walk && sailor.len > 0) {
        this.dirW
          .set(sailor.bx - sailor.ax, 0, sailor.bz - sailor.az)
          .multiplyScalar(sailor.dir)
          .applyQuaternion(group.quaternion);
        sailor.flip = this.dirW.dot(this.camRight) < 0;
      }
      const sc = sailor.member.scale;
      this.local.makeScale(sc, sc, sc).setPosition(px, py, pz);
      this.world.multiplyMatrices(group.matrixWorld, this.local);
      // Skip anyone standing right in front of the lens (e.g. next to the bridge camera).
      const w = this.world.elements;
      const cx = w[12]! - cam.position.x;
      const cy = w[13]! - cam.position.y;
      const cz = w[14]! - cam.position.z;
      if (cx * cx + cy * cy + cz * cz < NEAR_CULL * NEAR_CULL) continue;
      mesh.setMatrixAt(n, this.world);
      const lit = sailor.lantern ? night * 0.75 : 0;
      arr[4 * n] = this.frameOf(sailor, night);
      arr[4 * n + 1] = sailor.member.variant;
      arr[4 * n + 2] = sailor.flip ? 1 : 0;
      arr[4 * n + 3] = lit;
      n++;

      if (sailor.lantern && night > 0.02 && glows < this.glows.length) {
        const glow = this.glows[glows++]!;
        // The lantern hangs at the sprite's left hand (right when flipped), knee high.
        const h = SAILOR_HEIGHT * SAILOR_UPSCALE * sc;
        const side = (sailor.flip ? 1 : -1) * 0.36 * h * (CELL_W / CELL_H);
        this.feet.setFromMatrixPosition(this.world);
        this.upW.setFromMatrixColumn(this.world, 1).normalize();
        // Pulled toward the camera so the halo is not cut by the deck it hangs over.
        this.toCam.copy(cam.position).sub(this.feet).normalize();
        glow.position
          .copy(this.feet)
          .addScaledVector(this.upW, 0.2 * h)
          .addScaledVector(this.camRight, side)
          .addScaledVector(this.toCam, 1.2 * sc);
        glow.scale.setScalar(2.4 * sc);
        glow.visible = true;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    attr.needsUpdate = true;
    for (let g = glows; g < this.glows.length; g++) this.glows[g]!.visible = false;
    if (this.glowMaterial) this.glowMaterial.opacity = 0.75 * night;
  }

  dispose(): void {
    if (this.mesh) {
      this.object.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.dispose();
      this.mesh = null;
    }
    for (const g of this.glows) this.object.remove(g);
    this.glows.length = 0;
    this.material?.dispose();
    this.glowMaterial?.dispose();
    this.sheet?.dispose();
    this.glowTexture?.dispose();
    this.material = null;
    this.glowMaterial = null;
    this.sheet = null;
    this.glowTexture = null;
    this.spriteAttr = null;
    this.sailors = [];
    this.vessels = [];
  }

  // ---------------------------------------------------------------------- behaviour

  private step(s: Sailor, dt: number, calm: number, storm: number, night: number): void {
    s.anim += dt;
    // A big sea sends everyone to hold on at once.
    if (calm < 0.2 && s.mode !== Mode.Brace) {
      s.mode = Mode.Brace;
      s.timer = 2 + 3 * Math.random();
    }
    if (s.mode === Mode.Walk) {
      const speed = WALK_SPEED * (0.55 + 0.45 * calm);
      s.s += (s.dir * speed * dt) / Math.max(0.1, s.len);
      if (s.s >= 1 || s.s <= 0) {
        s.s = Math.min(1, Math.max(0, s.s));
        s.dir = s.s >= 1 ? -1 : 1;
        this.choose(s, calm, storm, night, false);
      }
      return;
    }
    s.timer -= dt;
    if (s.timer <= 0) this.choose(s, calm, storm, night, true);
  }

  private choose(s: Sailor, calm: number, storm: number, night: number, mayWalk: boolean): void {
    const captain = s.member.role === 'captain';
    const canWalk = mayWalk && s.len > 0.3;
    const wWalk = canWalk ? (captain ? 0.5 : 1.3) * (0.15 + 0.85 * calm) : 0;
    const wWave = s.lantern && night > 0.5 ? 0 : 0.45 * calm * calm;
    const wLook = captain ? 1 : 0.35;
    const wIdle = 0.7;
    const wBrace = 3 * storm * storm;
    let r = Math.random() * (wWalk + wWave + wLook + wIdle + wBrace);
    s.anim = 0;
    if ((r -= wWalk) < 0) {
      s.mode = Mode.Walk;
      s.dir = s.s >= 0.5 ? -1 : 1;
      return;
    }
    if ((r -= wWave) < 0) {
      s.mode = Mode.Wave;
      s.timer = 1.4 + 1.2 * Math.random();
    } else if ((r -= wLook) < 0) {
      s.mode = Mode.Look;
      s.timer = 1.8 + 2.5 * Math.random();
    } else if ((r -= wIdle) < 0) {
      s.mode = Mode.Idle;
      s.timer = 1.2 + 3 * Math.random();
    } else {
      s.mode = Mode.Brace;
      s.timer = 2 + 3 * Math.random();
    }
  }

  private frameOf(s: Sailor, night: number): number {
    switch (s.mode) {
      case Mode.Walk:
        return FRAME.walk + (Math.floor(s.anim * 7) % 4);
      case Mode.Wave:
        return FRAME.wave + (Math.floor(s.anim * 4) % 2);
      case Mode.Look:
        return FRAME.look;
      case Mode.Brace:
        return FRAME.brace + (Math.floor(s.anim * 1.6) % 2);
      default:
        if (s.lantern && night > 0.3) return FRAME.lantern;
        return s.anim % 3.4 > 3.25 ? FRAME.blink : FRAME.idle;
    }
  }

  // ---------------------------------------------------------------------- GPU resources

  /** Create the sheet, material and an instanced mesh with room for `capacity` sailors. */
  private ensureGpu(capacity: number, lanterns: number): void {
    if (typeof document === 'undefined') return;
    if (!this.sheet) {
      const tex = new THREE.CanvasTexture(paintSheet());
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.sheet = tex;
      const glow = new THREE.CanvasTexture(paintGlow());
      glow.colorSpace = THREE.SRGBColorSpace;
      this.glowTexture = glow;
    }
    if (!this.material) {
      const figureH = SAILOR_HEIGHT * SAILOR_UPSCALE;
      const quadH = (figureH * CELL_H) / FIGURE_PX;
      this.material = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uGrid: { value: new THREE.Vector2(COLS, ROWS) },
            uSize: { value: new THREE.Vector2((quadH * CELL_W) / CELL_H, quadH) },
            uTint: { value: new THREE.Color(1, 1, 1) },
            uLamp: { value: new THREE.Color(1.0, 0.8, 0.52) },
          },
        ]),
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        fog: true,
        toneMapped: false,
      });
      // Assigned after the merge: UniformsUtils clones values, and the texture must be shared.
      this.material.uniforms.uMap = { value: this.sheet };
    }
    if (!this.glowMaterial) {
      this.glowMaterial = new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: 0xffc070,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
    }
    while (this.glows.length < lanterns) {
      const glow = new THREE.Sprite(this.glowMaterial);
      glow.name = 'sailor-lantern';
      glow.visible = false;
      glow.frustumCulled = false;
      // Decoration only: never intercept a pick ray.
      glow.raycast = () => {};
      this.glows.push(glow);
      this.object.add(glow);
    }
    if (this.mesh && this.mesh.instanceMatrix.count >= capacity) return;
    if (this.mesh) {
      this.object.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.dispose();
    }
    const size = Math.max(8, Math.ceil(capacity * 1.5));
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.translate(0, 0.5, 0);
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(size * 4), 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aSprite', attr);
    const mesh = new THREE.InstancedMesh(geometry, this.material, size);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = 'sailor-sprites';
    mesh.count = 0;
    // Instances span every vessel; their bounds change each frame.
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    this.mesh = mesh;
    this.spriteAttr = attr;
    this.object.add(mesh);
  }
}
