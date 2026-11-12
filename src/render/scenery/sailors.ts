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
import { mulberry32 } from '../../core/rng';
import { smoothstep } from '../../core/mathUtil';
import type { VesselType } from '../../schema/experiment';
import type { VesselDefinition, VisualBox } from '../../vessel/api';
import type { SceneryFrame, SceneryLayer, SceneryVessel } from './types';

// ============================================================================ placement maths

/** Height of a person [m] and the readability upscale applied to the sprites. */
/** Sailors closer than this to the camera are not drawn [m]. */
const NEAR_CULL = 6;
/** …and from a bridge camera, where a sailor a few metres ahead filled a third of the view. */
const BRIDGE_CULL = 16;

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
  /** Outfit set (index into OUTFITS), from the vessel type. */
  outfit: number;
  /** Look within the outfit set: crew looks first, then captain looks (see `personFor`). */
  variant: number;
  /** One end of the patrol; the member starts here. */
  home: DeckSpot;
  /** The other end of the patrol (equal to `home` when there is no room to walk). */
  patrol: DeckSpot;
  /** Size variation around 1. */
  scale: number;
}

/** Number of sailor looks and captain looks per outfit set on the sprite sheet. */
export const SAILOR_VARIANTS = 8;
export const CAPTAIN_VARIANTS = 2;

/** Outfit sets: what a vessel type's crew wears (see `garbFor`). */
export const OUTFITS = ['navy', 'merchant', 'fishing', 'rescue', 'yacht', 'pirate'] as const;
export type OutfitKind = (typeof OUTFITS)[number];

const OUTFIT_OF: Record<VesselType, OutfitKind> = {
  'patrol-boat': 'navy',
  'aircraft-carrier': 'navy',
  submarine: 'navy',
  'cargo-ship': 'merchant',
  'oil-tanker': 'merchant',
  trawler: 'fishing',
  lifeboat: 'rescue',
  'sloop-yacht': 'yacht',
  catamaran: 'yacht',
  'pirate-ship': 'pirate',
  'box-barge': 'merchant',
  wigley: 'merchant',
};

/** Index into OUTFITS of the outfit set a vessel type's crew wears. */
export function outfitFor(type: VesselType): number {
  return OUTFITS.indexOf(OUTFIT_OF[type]);
}

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
 * Returns an empty crew for submarines or when no standing spots are available.
 */
export function planCrew(def: VesselDefinition, seed = 1): CrewMember[] {
  // A submarine at periscope depth has no deck above water: the crew is below.
  if (def.submarine) return [];
  const rand = mulberry32(seed);
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
  const outfit = outfitFor(def.type);
  const looks = Array.from({ length: SAILOR_VARIANTS }, (_, i) => i);
  for (let i = looks.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [looks[i], looks[j]] = [looks[j]!, looks[i]!];
  }
  let sailors = 0;
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
    // Crewmates are different people: deal the crew looks out without repeats (until a crew
    // larger than the pool wraps around).
    const variant =
      role === 'captain'
        ? SAILOR_VARIANTS + Math.floor(rand() * CAPTAIN_VARIANTS)
        : looks[sailors++ % SAILOR_VARIANTS]!;
    members.push({ role, outfit, variant, home: spot, patrol, scale: 0.94 + 0.1 * rand() });
  }
  return members;
}

// ============================================================================ sprite sheet

/** Cell size of one figure on the sheet [px]: twice the old 16 × 24, for faces and cloth detail. */
const CELL_W = 32;
const CELL_H = 48;
/** Frames (columns within an outfit block) of the sheet. */
export const FRAME = {
  idle: 0,
  blink: 1,
  walk: 2, // 2..5
  wave: 6, // 6..7
  brace: 8, // 8..9
  look: 10,
  lantern: 11,
} as const;
const FRAMES = 12;
/** Outfit blocks per sheet row of blocks (keeps the sheet under 2048 px on each side). */
const BLOCKS_ACROSS = 3;
/** Rows per outfit block: the crew looks, then the captain looks. */
const LOOKS_PER_OUTFIT = SAILOR_VARIANTS + CAPTAIN_VARIANTS;
const COLS = BLOCKS_ACROSS * FRAMES;
const ROWS = Math.ceil(OUTFITS.length / BLOCKS_ACROSS) * LOOKS_PER_OUTFIT;
/** Sheet size [px]. */
export const SHEET_SIZE = { width: COLS * CELL_W, height: ROWS * CELL_H } as const;
/** Pixel rows from the top of the cap to the soles (the sprite's drawn height). */
const FIGURE_PX = 44;

/** Sheet cell (column, row) of an outfit's look `variant` in animation frame `frame`. */
export function sheetCell(outfit: number, variant: number, frame: number): [number, number] {
  const block = outfit % OUTFITS.length;
  return [
    (block % BLOCKS_ACROSS) * FRAMES + frame,
    Math.floor(block / BLOCKS_ACROSS) * LOOKS_PER_OUTFIT + variant,
  ];
}

// ---------------------------------------------------------------------------- people

type HairStyle = 'short' | 'crop' | 'long' | 'bun' | 'curly' | 'bald';

/** Skin tones (base, shade, light), light to deep. */
export const SKIN_TONES = [
  ['#ffe0c4', '#efbd98', '#fff0e2'],
  ['#f3c6a0', '#d9a07a', '#fbdcc0'],
  ['#d9a274', '#b9804f', '#e9bc92'],
  ['#b67a4f', '#935c36', '#c99369'],
  ['#8c5a37', '#6c4024', '#a2704a'],
  ['#5e3a24', '#452816', '#774d33'],
] as const;

export interface Person {
  skin: number;
  hair: HairStyle;
  hairColor: string;
  beard?: string;
  /** Broader shoulders and torso. */
  broad: boolean;
}

/**
 * The people crews are drawn from: every skin tone, hair style and build, men and women. Skin
 * tones repeat in a period of six, so any eight consecutive entries show all six.
 */
export const PEOPLE: readonly Person[] = [
  { skin: 0, hair: 'short', hairColor: '#6b3e1f', broad: true },
  { skin: 3, hair: 'bun', hairColor: '#1d1a18', broad: false },
  { skin: 5, hair: 'crop', hairColor: '#141210', broad: true },
  { skin: 1, hair: 'long', hairColor: '#e3b65a', broad: false },
  { skin: 4, hair: 'curly', hairColor: '#1d1a18', broad: false },
  { skin: 2, hair: 'short', hairColor: '#2a211c', broad: true, beard: '#2a211c' },
  { skin: 0, hair: 'curly', hairColor: '#b5482a', broad: false },
  { skin: 3, hair: 'crop', hairColor: '#2a1d16', broad: true },
  { skin: 5, hair: 'long', hairColor: '#141210', broad: false },
  { skin: 1, hair: 'short', hairColor: '#8a5a2b', broad: true, beard: '#7a4e25' },
  { skin: 4, hair: 'bun', hairColor: '#2a1d16', broad: false },
  { skin: 2, hair: 'long', hairColor: '#3a2618', broad: false },
  { skin: 0, hair: 'short', hairColor: '#a3a3a3', broad: true, beard: '#e4e4e4' },
  { skin: 3, hair: 'bald', hairColor: '#1d1a18', broad: true, beard: '#1b1715' },
  { skin: 5, hair: 'bun', hairColor: '#141210', broad: false },
  { skin: 1, hair: 'crop', hairColor: '#c08a3e', broad: true },
  { skin: 4, hair: 'short', hairColor: '#141210', broad: true },
  { skin: 2, hair: 'curly', hairColor: '#1d1a18', broad: false },
];

/**
 * Person drawn for an outfit's look `variant`. A crew's eight looks are eight consecutive people
 * (so every skin tone is aboard), starting at a different place for each outfit set.
 */
export function personFor(outfit: number, variant: number): Person {
  const n = PEOPLE.length;
  const i =
    variant < SAILOR_VARIANTS
      ? (variant + outfit * 5) % n
      : ((variant - SAILOR_VARIANTS) * 7 + outfit * 3 + 12) % n;
  return PEOPLE[i]!;
}

// ---------------------------------------------------------------------------- outfits

type Hat =
  'sailor' | 'peaked' | 'hardhat' | 'souwester' | 'beanie' | 'bandana' | 'cap' | 'tricorn' | 'none';

interface Garb {
  shirt: string;
  shirtShade: string;
  trousers: string;
  trousersShade: string;
  shoe: string;
  cuff: string;
  hat: Hat;
  hatColor: string;
  hatShade: string;
  hatTrim?: string;
  /** Short sleeves (forearms show) and shorts (calves show). */
  shortSleeves?: boolean;
  shorts?: boolean;
  /** Tall boots over the trousers. */
  boots?: boolean;
  /** Torso details. */
  sailorCollar?: boolean;
  stripes?: string;
  vest?: { color: string; band: string };
  zip?: boolean;
  buttons?: string;
  epaulettes?: { color: string; stripe: string };
  tie?: string;
  shirtFront?: string;
  sash?: string;
  belt?: string;
  coatTails?: boolean;
  ribbed?: boolean;
  polo?: string;
}

const C = {
  white: '#f7f9fc',
  whiteShade: '#c6d0e2',
  navy: '#22305c',
  navyShade: '#18223f',
  blue: '#2e64cc',
  gold: '#f2c23c',
  shoe: '#262a33',
  outline: '#151a29',
  eye: '#1a1c28',
  eyeWhite: '#f4f1ea',
  red: '#d94848',
  visor: '#0f1220',
  lanternFrame: '#5b4526',
  lanternGlass: '#ffe08a',
} as const;

const pick = <T>(list: readonly T[], k: number): T => list[k % list.length]!;

/** What a crew member of an outfit set wears; `k` varies colours between crewmates. */
function garbFor(kind: OutfitKind, captain: boolean, k: number): Garb {
  switch (kind) {
    case 'navy':
      return captain
        ? {
            shirt: C.navy,
            shirtShade: C.navyShade,
            trousers: C.navy,
            trousersShade: C.navyShade,
            shoe: C.shoe,
            cuff: C.gold,
            hat: 'peaked',
            hatColor: C.white,
            hatShade: C.whiteShade,
            hatTrim: C.gold,
            buttons: C.gold,
            epaulettes: { color: C.navyShade, stripe: C.gold },
            shirtFront: C.white,
            tie: '#101520',
          }
        : {
            shirt: C.white,
            shirtShade: C.whiteShade,
            trousers: C.white,
            trousersShade: C.whiteShade,
            shoe: C.shoe,
            cuff: C.blue,
            hat: 'sailor',
            hatColor: C.white,
            hatShade: C.whiteShade,
            hatTrim: C.blue,
            sailorCollar: true,
          };
    case 'merchant': {
      if (captain)
        return {
          shirt: C.white,
          shirtShade: C.whiteShade,
          trousers: '#1f2a44',
          trousersShade: '#151d31',
          shoe: C.shoe,
          cuff: C.white,
          hat: 'peaked',
          hatColor: C.white,
          hatShade: C.whiteShade,
          hatTrim: '#1f2a44',
          shortSleeves: true,
          epaulettes: { color: '#111522', stripe: C.gold },
          tie: '#1f2a44',
          belt: '#1a1a1a',
        };
      const suit = pick<readonly [string, string]>(
        [
          ['#e8702a', '#bf5719'],
          ['#2f5fa8', '#234a85'],
          ['#d84b2a', '#ad3a1f'],
          ['#3f6f3a', '#2f552c'],
        ],
        k,
      );
      const helmet = pick<readonly [string, string]>(
        [
          ['#f6f6f2', '#c9cbc6'],
          ['#f5c518', '#c99d0e'],
          ['#f08a24', '#c46c15'],
          ['#2f7bd8', '#235fa8'],
        ],
        k + 1,
      );
      return {
        shirt: suit[0],
        shirtShade: suit[1],
        trousers: suit[0],
        trousersShade: suit[1],
        shoe: '#3b2a1c',
        cuff: suit[1],
        hat: 'hardhat',
        hatColor: helmet[0],
        hatShade: helmet[1],
        vest: k % 3 === 2 ? undefined : { color: '#d6f03c', band: '#e8eef2' },
        zip: true,
        boots: true,
      };
    }
    case 'fishing': {
      if (captain)
        return {
          shirt: '#2b3a55',
          shirtShade: '#1e2a40',
          trousers: '#3a3a3a',
          trousersShade: '#2a2a2a',
          shoe: '#2d4a2c',
          cuff: '#1e2a40',
          hat: 'beanie',
          hatColor: '#7a2f2f',
          hatShade: '#5c2222',
          ribbed: true,
          boots: true,
        };
      const coat = pick<readonly [string, string]>(
        [
          ['#f5c518', '#c99d0e'],
          ['#f07f1e', '#c66412'],
          ['#f5c518', '#c99d0e'],
          ['#2f8a5a', '#236a45'],
        ],
        k,
      );
      const souwester = k % 2 === 0;
      return {
        shirt: coat[0],
        shirtShade: coat[1],
        trousers: coat[0],
        trousersShade: coat[1],
        shoe: '#ece9e0',
        cuff: coat[1],
        hat: souwester ? 'souwester' : 'beanie',
        hatColor: souwester ? coat[0] : pick(['#2b3a55', '#5a5a5a', '#7a2f2f'], k),
        hatShade: souwester ? coat[1] : '#1e2430',
        buttons: '#3a2a1a',
        boots: true,
      };
    }
    case 'rescue':
      return {
        shirt: captain ? '#1f2a44' : '#c8352e',
        shirtShade: captain ? '#151d31' : '#9e2722',
        trousers: captain ? '#1f2a44' : '#c8352e',
        trousersShade: captain ? '#151d31' : '#9e2722',
        shoe: '#202020',
        cuff: '#202020',
        hat: 'hardhat',
        hatColor: captain ? '#f5c518' : '#f6f6f2',
        hatShade: captain ? '#c99d0e' : '#c9cbc6',
        vest: { color: '#f5c518', band: '#e8eef2' },
        boots: true,
      };
    case 'yacht': {
      if (captain)
        return {
          shirt: '#1f2a44',
          shirtShade: '#151d31',
          trousers: '#e9e3d2',
          trousersShade: '#c9c1aa',
          shoe: '#7a5532',
          cuff: '#1f2a44',
          hat: 'cap',
          hatColor: C.white,
          hatShade: C.whiteShade,
          hatTrim: '#1f2a44',
          shortSleeves: true,
          shorts: true,
          polo: C.white,
          belt: '#5a3a22',
        };
      const polo = pick<readonly [string, string]>(
        [
          ['#e14b5a', '#b83845'],
          ['#2fa3a0', '#21807d'],
          ['#f2f2ee', '#c9cbc6'],
          ['#f2b33d', '#c88f22'],
          ['#5b7fd6', '#4262b0'],
        ],
        k,
      );
      return {
        shirt: polo[0],
        shirtShade: polo[1],
        trousers: k % 2 === 0 ? '#d9c79c' : '#1f2a44',
        trousersShade: k % 2 === 0 ? '#b8a57a' : '#151d31',
        shoe: k % 2 === 0 ? '#f2f2ee' : '#7a5532',
        cuff: polo[1],
        hat: k % 3 === 1 ? 'none' : 'cap',
        hatColor: pick(['#1f2a44', '#f2f2ee', '#c8352e'], k),
        hatShade: '#141a2c',
        shortSleeves: true,
        shorts: true,
        polo: C.white,
      };
    }
    case 'pirate': {
      if (captain)
        return {
          shirt: '#8e1f24',
          shirtShade: '#6a161a',
          trousers: '#2a2018',
          trousersShade: '#1c150f',
          shoe: '#141414',
          cuff: C.gold,
          hat: 'tricorn',
          hatColor: '#1a1a1a',
          hatShade: '#0d0d0d',
          hatTrim: C.gold,
          buttons: C.gold,
          shirtFront: '#f2ead8',
          coatTails: true,
          belt: '#3a2a1a',
          boots: true,
        };
      return {
        shirt: '#efe8d8',
        shirtShade: '#cfc5ae',
        trousers: pick(['#5a4330', '#3a3a46', '#6b5a3a'], k),
        trousersShade: '#2e2219',
        shoe: '#1a1a1a',
        cuff: '#cfc5ae',
        hat: k % 4 === 3 ? 'none' : 'bandana',
        hatColor: pick(['#c8352e', '#1f2a44', '#2f6b3a', '#d7a12a'], k),
        hatShade: '#4a1414',
        stripes: pick(['#c8352e', '#1f2a44', '#1a1a1a'], k),
        sash: pick(['#c8352e', '#d7a12a', '#2f5fa8'], k + 1),
        boots: k % 2 === 0,
      };
    }
  }
}

// ---------------------------------------------------------------------------- poses

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

/**
 * Draw one figure in a 32 × 48 cell. Coordinates are sheet pixels; the silhouette keeps the
 * old 16 × 24 figure's proportions at twice the resolution, which leaves room for eye whites,
 * brows, a nose, shaded cloth, buttons, belts, collars and proper hats.
 */
function drawFigure(paint: Paint, person: Person, g: Garb, pose: Pose): void {
  const [skin, skinShade, skinLight] = SKIN_TONES[person.skin]!;
  const sx = 2 * (pose.sway ?? 0);
  const X = sx;
  const Y = 2 * pose.dy;
  const wide = person.broad ? 1 : 0;

  // ---- legs: trousers (or shorts over bare calves), then shoes or boots
  const leg = (x: number, lift: number, toe: number): void => {
    const top = 38;
    const len = 6 - 2 * lift;
    if (g.shorts) {
      paint(x, top, 4, 3, g.trousers);
      paint(x + 3, top, 1, 3, g.trousersShade);
      paint(x, top + 3, 4, len - 3, skin);
      paint(x + 3, top + 3, 1, len - 3, skinShade);
    } else {
      paint(x, top, 4, len, g.trousers);
      paint(x + 3, top, 1, len, g.trousersShade);
    }
    const foot = 44 - 2 * lift;
    if (g.boots) {
      paint(x, foot - 3, 4, 3, g.shoe);
      paint(x, foot - 3, 4, 1, g.trousersShade);
    }
    paint(x - 2 + 2 * toe, foot, 6, 4, g.shoe);
    paint(x - 1 + 2 * toe, foot, 3, 1, lighten(g.shoe));
  };
  switch (pose.legs) {
    case 'stand':
      leg(10, 0, 0);
      leg(18, 0, 1);
      break;
    case 'stride':
      leg(8, 0, 1);
      leg(20, 0, 1);
      break;
    case 'passL':
      leg(12, 1, 1);
      leg(16, 0, 1);
      break;
    case 'passR':
      leg(12, 0, 1);
      leg(16, 1, 1);
      break;
    case 'wide': {
      const t = g.shorts ? skin : g.trousers;
      paint(8 + sx, 38, 4, 2, g.trousers);
      paint(6 + sx, 40, 4, 4, t);
      paint(20 + sx, 38, 4, 2, g.trousers);
      paint(22 + sx, 40, 4, 4, t);
      paint(9 + sx, 40, 1, 4, g.shorts ? skinShade : g.trousersShade);
      paint(25 + sx, 40, 1, 4, g.shorts ? skinShade : g.trousersShade);
      paint(4 + sx, 44, 6, 4, g.shoe);
      paint(22 + sx, 44, 6, 4, g.shoe);
      break;
    }
  }

  // ---- torso
  const tx = 8 - wide;
  const tw = 16 + 2 * wide;
  paint(tx + X, 26 + Y, tw, 12, g.shirt);
  paint(tx + tw - 2 + X, 27 + Y, 2, 11, g.shirtShade);
  paint(tx + X, 27 + Y, 1, 10, lighten(g.shirt));
  if (g.coatTails) {
    paint(tx + X, 36 + Y, 4, 6, g.shirt);
    paint(tx + tw - 4 + X, 36 + Y, 4, 6, g.shirtShade);
    paint(tx + 4 + X, 36 + Y, 1, 4, g.cuff);
    paint(tx + tw - 5 + X, 36 + Y, 1, 4, g.cuff);
  }
  if (g.stripes) {
    for (let r = 28; r < 38; r += 3) paint(tx + X, r + Y, tw, 1, g.stripes);
  }
  if (g.ribbed) {
    for (let c = tx + 2; c < tx + tw - 2; c += 3) paint(c + X, 30 + Y, 1, 7, g.shirtShade);
    paint(tx + X, 26 + Y, tw, 2, g.shirtShade);
  }
  if (g.shirtFront) {
    paint(14 + X, 26 + Y, 4, 6, g.shirtFront);
    if (g.tie) paint(15 + X, 27 + Y, 2, 6, g.tie);
    else paint(14 + X, 26 + Y, 4, 2, lighten(g.shirtFront));
  } else if (g.tie) {
    paint(14 + X, 26 + Y, 4, 2, skin);
    paint(15 + X, 27 + Y, 2, 7, g.tie);
  }
  if (g.polo) {
    paint(12 + X, 26 + Y, 8, 2, g.polo);
    paint(15 + X, 26 + Y, 2, 4, skin);
    paint(16 + X, 28 + Y, 1, 3, g.shirtShade);
  }
  if (g.sailorCollar) {
    paint(tx + X, 26 + Y, tw, 4, C.blue);
    paint(tx + 1 + X, 28 + Y, tw - 2, 1, C.white);
    paint(14 + X, 26 + Y, 4, 2, skin);
    paint(15 + X, 28 + Y, 2, 1, skin);
    paint(14 + X, 30 + Y, 4, 2, C.red);
    paint(15 + X, 32 + Y, 2, 2, C.red);
  }
  if (g.vest) {
    paint(tx + 1 + X, 27 + Y, 5, 10, g.vest.color);
    paint(tx + tw - 6 + X, 27 + Y, 5, 10, g.vest.color);
    paint(tx + 1 + X, 32 + Y, 5, 1, g.vest.band);
    paint(tx + tw - 6 + X, 32 + Y, 5, 1, g.vest.band);
    paint(tx + 2 + X, 27 + Y, 1, 10, g.vest.band);
    paint(tx + tw - 3 + X, 27 + Y, 1, 10, g.vest.band);
  }
  if (g.zip) paint(16 + X, 27 + Y, 1, 11, g.shirtShade);
  if (g.buttons) {
    for (const r of [29, 32, 35]) {
      paint(13 + X, r + Y, 1, 1, g.buttons);
      paint(18 + X, r + Y, 1, 1, g.buttons);
    }
  }
  if (g.epaulettes) {
    paint(tx - 1 + X, 26 + Y, 5, 2, g.epaulettes.color);
    paint(tx + tw - 4 + X, 26 + Y, 5, 2, g.epaulettes.color);
    paint(tx - 1 + X, 27 + Y, 5, 1, g.epaulettes.stripe);
    paint(tx + tw - 4 + X, 27 + Y, 5, 1, g.epaulettes.stripe);
  }
  if (g.belt) {
    paint(tx + X, 36 + Y, tw, 2, g.belt);
    paint(15 + X, 36 + Y, 2, 2, C.gold);
  }
  if (g.sash) {
    paint(tx + X, 35 + Y, tw, 3, g.sash);
    paint(tx + 2 + X, 38 + Y, 2, 4, g.sash);
  }

  // ---- arms (sleeve, cuff and hand); `side` −1 = left (low x), +1 = right
  const hand = (x: number, y: number, w = 4, h = 2): void => {
    paint(x, y, w, h, skin);
    paint(x, y + h - 1, w, 1, skinShade);
  };
  const sleeve = (x: number, y: number, w: number, h: number): void => {
    if (g.shortSleeves && h > 3) {
      paint(x, y, w, 3, g.shirt);
      paint(x, y + 3, w, h - 3, skin);
      paint(x + w - 1, y + 3, 1, h - 3, skinShade);
    } else {
      paint(x, y, w, h, g.shirt);
      paint(x + w - 1, y, 1, h, g.shirtShade);
    }
  };
  const cuff = (x: number, y: number, w: number): void => {
    if (!g.shortSleeves) paint(x, y, w, 2, g.cuff);
  };
  const arm = (kind: Arm, side: number): void => {
    const sh = side < 0 ? 4 - wide : 24 + wide; // shoulder column
    const out = side < 0 ? -2 : 2;
    switch (kind) {
      case 'down':
        sleeve(sh + X, 26 + Y, 4, 8);
        cuff(sh + X, 34 + Y, 4);
        hand(sh + X, 36 + Y);
        break;
      case 'fwd':
        sleeve(sh + X, 26 + Y, 4, 6);
        sleeve(sh + out + X, 30 + Y, 4, 2);
        cuff(sh + out + X, 32 + Y, 4);
        hand(sh + out + X, 34 + Y);
        break;
      case 'up':
        paint(sh + X, 26 + Y, 4, 2, g.shirt);
        sleeve(sh + X, 18 + Y, 4, 8);
        cuff(sh + X, 16 + Y, 4);
        hand(sh + X, 12 + Y, 4, 4);
        break;
      case 'upOut':
        paint(sh + X, 24 + Y, 4, 4, g.shirt);
        sleeve(sh + out + X, 18 + Y, 4, 6);
        cuff(sh + out + X, 16 + Y, 4);
        hand(sh + out + X, 12 + Y, 4, 4);
        break;
      case 'brow':
        sleeve(sh + X, 20 + Y, 4, 8);
        cuff(sh + X, 18 + Y, 4);
        hand(sh - 6 + X, 16 + Y, 8, 2);
        break;
      case 'out':
        sleeve(sh + X, 26 + Y, 4, 4);
        sleeve(sh + out + X, 30 + Y, 4, 2);
        cuff(sh + out + X, 32 + Y, 4);
        hand(sh + out + X, 34 + Y);
        break;
      case 'lantern':
        sleeve(sh + X, 26 + Y, 4, 8);
        cuff(sh + X, 34 + Y, 4);
        hand(sh + X, 36 + Y);
        paint(sh - 2 + X, 38 + Y, 6, 2, C.lanternFrame);
        paint(sh - 2 + X, 40 + Y, 6, 4, C.lanternGlass);
        paint(sh - 1 + X, 41 + Y, 1, 2, '#fff6cf');
        paint(sh - 2 + X, 44 + Y, 6, 2, C.lanternFrame);
        break;
    }
  };
  const raised = (a: Arm): boolean => a === 'brow' || a === 'up' || a === 'upOut';
  if (!raised(pose.armL)) arm(pose.armL, -1);
  if (!raised(pose.armR)) arm(pose.armR, 1);

  // ---- hair behind the head (long hair falls to the shoulders)
  const hc = person.hairColor;
  const hcShade = darken(hc);
  if (person.hair === 'long') {
    paint(5 + X, 14 + Y, 4, 14, hc);
    paint(23 + X, 14 + Y, 4, 14, hc);
    paint(25 + X, 16 + Y, 2, 12, hcShade);
  }
  if (person.hair === 'bun') {
    paint(22 + X, 8 + Y, 6, 6, hc);
    paint(25 + X, 9 + Y, 2, 4, hcShade);
  }

  // ---- head (rounded block), ears, neck
  paint(14 + X, 24 + Y, 4, 2, skinShade);
  paint(8 + X, 10 + Y, 16, 16, skin);
  paint(6 + X, 12 + Y, 20, 12, skin);
  paint(7 + X, 11 + Y, 18, 14, skin);
  paint(24 + X, 14 + Y, 2, 9, skinShade);
  paint(22 + X, 23 + Y, 2, 2, skinShade);
  paint(10 + X, 25 + Y, 12, 1, skinShade);
  paint(8 + X, 13 + Y, 2, 6, skinLight);
  paint(5 + X, 17 + Y, 2, 4, skin);
  paint(5 + X, 18 + Y, 1, 2, skinShade);
  paint(25 + X, 17 + Y, 2, 4, skinShade);

  // ---- hair on the head (the hat covers its top)
  switch (person.hair) {
    case 'short':
    case 'long':
    case 'bun':
      paint(8 + X, 11 + Y, 16, 3, hc);
      paint(6 + X, 12 + Y, 2, 6, hc);
      paint(24 + X, 12 + Y, 2, 6, hc);
      paint(10 + X, 14 + Y, 5, 1, hc);
      paint(20 + X, 12 + Y, 3, 2, hcShade);
      break;
    case 'crop':
      paint(8 + X, 11 + Y, 16, 2, hc);
      paint(6 + X, 12 + Y, 2, 4, hc);
      paint(24 + X, 12 + Y, 2, 4, hc);
      break;
    case 'curly':
      paint(6 + X, 9 + Y, 20, 5, hc);
      paint(5 + X, 11 + Y, 2, 9, hc);
      paint(25 + X, 11 + Y, 2, 9, hc);
      for (const [cx, cy] of [
        [8, 10],
        [12, 12],
        [17, 10],
        [21, 12],
        [6, 15],
        [25, 14],
      ] as const)
        paint(cx + X, cy + Y, 2, 1, hcShade);
      break;
    case 'bald':
      paint(10 + X, 11 + Y, 4, 1, skinLight);
      break;
  }

  // ---- face
  const f = 2 * pose.face + X;
  const brow = person.hair === 'bald' ? skinShade : hc;
  for (const ex of [10, 19]) {
    const x = ex + f;
    paint(x, 16 + Y, 4, 1, brow);
    switch (pose.eyes) {
      case 'open':
        paint(x, 18 + Y, 3, 3, C.eyeWhite);
        paint(x + 1, 18 + Y, 2, 3, C.eye);
        paint(x + 1, 18 + Y, 1, 1, C.eyeWhite);
        break;
      case 'blink':
        paint(x, 20 + Y, 3, 1, C.eye);
        break;
      case 'happy':
        paint(x, 20 + Y, 1, 1, C.eye);
        paint(x + 1, 19 + Y, 2, 1, C.eye);
        paint(x + 3, 20 + Y, 1, 1, C.eye);
        break;
      case 'squint':
        paint(x, 20 + Y, 4, 1, C.eye);
        break;
    }
  }
  paint(15 + f, 21 + Y, 2, 2, skinShade);
  if (person.beard) {
    paint(8 + X, 21 + Y, 16, 5, person.beard);
    paint(6 + X, 18 + Y, 2, 5, person.beard);
    paint(24 + X, 18 + Y, 2, 5, person.beard);
    paint(12 + f, 22 + Y, 8, 1, person.beard);
    paint(14 + f, 23 + Y, 4, 1, '#8a4a40');
  } else {
    paint(8 + f, 22 + Y, 2, 1, 'rgba(232,112,112,0.45)');
    paint(22 + f, 22 + Y, 2, 1, 'rgba(232,112,112,0.45)');
    paint(14 + f, 24 + Y, 4, 1, pose.eyes === 'happy' ? '#a8343c' : '#b06a5c');
    if (pose.eyes === 'happy') paint(15 + f, 25 + Y, 2, 1, '#a8343c');
  }

  // ---- hat
  const hat = g.hatColor;
  const hatS = g.hatShade;
  switch (g.hat) {
    case 'sailor':
      paint(10 + X, 4 + Y, 12, 2, hat);
      paint(8 + X, 6 + Y, 16, 4, hat);
      paint(6 + X, 10 + Y, 20, 2, hatS);
      paint(8 + X, 8 + Y, 16, 1, g.hatTrim ?? C.blue);
      paint(11 + X, 5 + Y, 4, 1, C.white);
      break;
    case 'peaked':
      paint(6 + X, 2 + Y, 20, 4, hat);
      paint(6 + X, 5 + Y, 20, 1, hatS);
      paint(8 + X, 6 + Y, 16, 4, C.navy);
      paint(14 + X, 6 + Y, 4, 2, g.hatTrim ?? C.gold);
      paint(6 + X, 10 + Y, 20, 2, C.visor);
      paint(8 + X, 10 + Y, 8, 1, '#2b3150');
      break;
    case 'hardhat':
      paint(10 + X, 3 + Y, 12, 2, hat);
      paint(8 + X, 5 + Y, 16, 5, hat);
      paint(5 + X, 10 + Y, 22, 2, hat);
      paint(5 + X, 11 + Y, 22, 1, hatS);
      paint(20 + X, 5 + Y, 4, 5, hatS);
      paint(15 + X, 3 + Y, 2, 7, hatS);
      paint(11 + X, 4 + Y, 3, 2, lighten(hat));
      break;
    case 'souwester':
      paint(10 + X, 4 + Y, 12, 3, hat);
      paint(8 + X, 7 + Y, 16, 4, hat);
      paint(4 + X, 11 + Y, 24, 2, hat);
      paint(3 + X, 12 + Y, 3, 3, hatS);
      paint(26 + X, 12 + Y, 3, 3, hatS);
      paint(20 + X, 6 + Y, 3, 5, hatS);
      paint(11 + X, 5 + Y, 3, 1, lighten(hat));
      break;
    case 'beanie':
      paint(9 + X, 4 + Y, 14, 3, hat);
      paint(7 + X, 7 + Y, 18, 4, hat);
      paint(7 + X, 10 + Y, 18, 3, hatS);
      for (let c = 8; c < 25; c += 3) paint(c + X, 10 + Y, 1, 3, hat);
      paint(14 + X, 1 + Y, 4, 3, lighten(hat));
      break;
    case 'bandana':
      paint(8 + X, 8 + Y, 16, 5, hat);
      paint(7 + X, 10 + Y, 18, 3, hat);
      paint(24 + X, 11 + Y, 4, 3, hat);
      paint(26 + X, 14 + Y, 2, 4, hatS);
      for (const [cx, cy] of [
        [10, 9],
        [15, 11],
        [20, 9],
      ] as const)
        paint(cx + X, cy + Y, 1, 1, C.white);
      break;
    case 'cap':
      paint(10 + X, 5 + Y, 12, 2, hat);
      paint(8 + X, 7 + Y, 16, 4, hat);
      paint(7 + X, 11 + Y, 18, 2, hatS);
      paint(15 + X, 5 + Y, 2, 1, hatS);
      if (g.hatTrim) paint(14 + X, 8 + Y, 4, 2, g.hatTrim);
      break;
    case 'tricorn':
      paint(4 + X, 7 + Y, 24, 4, hat);
      paint(7 + X, 3 + Y, 18, 4, hat);
      paint(2 + X, 6 + Y, 4, 3, hat);
      paint(26 + X, 6 + Y, 4, 3, hat);
      paint(4 + X, 10 + Y, 24, 1, g.hatTrim ?? C.gold);
      paint(14 + X, 4 + Y, 4, 3, hatS);
      paint(15 + X, 7 + Y, 2, 2, '#f2ead8');
      break;
    case 'none':
      break;
  }

  // raised arms go in front of the head
  if (raised(pose.armL)) arm(pose.armL, -1);
  if (raised(pose.armR)) arm(pose.armR, 1);
}

/** A hex colour moved toward white or black by `t`. */
function mixHex(hex: string, toward: number, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) * (1 - t) + toward * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
const lighten = (hex: string): string => (hex.startsWith('#') ? mixHex(hex, 255, 0.28) : hex);
const darken = (hex: string): string => (hex.startsWith('#') ? mixHex(hex, 0, 0.3) : hex);

/** Paint the whole sheet (every outfit block, look and frame) and outline every figure. */
export function paintSailorSheet(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SHEET_SIZE.width;
  canvas.height = SHEET_SIZE.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  OUTFITS.forEach((kind, o) => {
    for (let v = 0; v < LOOKS_PER_OUTFIT; v++) {
      const captain = v >= SAILOR_VARIANTS;
      const person = personFor(o, v);
      const garb = garbFor(kind, captain, captain ? v - SAILOR_VARIANTS : v);
      for (let fr = 0; fr < FRAMES; fr++) {
        const [col, row] = sheetCell(o, v, fr);
        const ox = col * CELL_W;
        const oy = row * CELL_H;
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
        drawFigure(paint, person, garb, POSES[fr]!);
      }
    }
  });
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
    const night = 1 - smoothstep(0.12, 0.45, frame.daylight);

    // Night tint: sprites are unlit, so darken and cool them with the daylight.
    const day = smoothstep(0.0, 0.6, frame.daylight);
    const tint = this.tint.setRGB(0.16 + 0.8 * day, 0.19 + 0.77 * day, 0.32 + 0.64 * day);
    (this.material.uniforms.uTint!.value as THREE.Color).copy(tint);

    const cam = frame.camera;
    this.camRight.setFromMatrixColumn(cam.matrixWorld, 0);
    // Hide crews that would be only a few pixels tall (they would just flicker).
    // shortcut: cull assumes a 1000 px viewport height, correctness margin scales with window; upgrade to real canvas height if crews pop visibly at small or 4K windows.
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

    const cull = frame.bridgeView ? BRIDGE_CULL : NEAR_CULL;
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
      if (cx * cx + cy * cy + cz * cz < cull * cull) continue;
      mesh.setMatrixAt(n, this.world);
      const lit = sailor.lantern ? night * 0.75 : 0;
      const [col, row] = sheetCell(
        sailor.member.outfit,
        sailor.member.variant,
        this.frameOf(sailor, night),
      );
      arr[4 * n] = col;
      arr[4 * n + 1] = row;
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
      const tex = new THREE.CanvasTexture(paintSailorSheet());
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
