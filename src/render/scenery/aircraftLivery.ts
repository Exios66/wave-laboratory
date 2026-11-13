/**
 * Period paint schemes for the lost flights, painted procedurally into one texture atlas per
 * aircraft kind (no downloads, no licences). Every airframe maps its parts into the same five
 * atlas regions; each kind paints those regions in its own livery.
 *
 * Region-local coordinates (s, t) ∈ [0, 1]²:
 *  - fuselage: s runs around the hull (0 keel, 0.25 port, 0.5 crown, 0.75 starboard),
 *    t along it (0 tail, 1 nose);
 *  - wingTop / wingBottom: s across the chord (0 trailing edge, 1 leading edge), t out along
 *    the span (0 centreline, 1 tip);
 *  - tail: s along the fin (0 rear, 1 front, as seen from either side), t up it;
 *  - engine: s around the nacelle, t along it (0 rear, 1 the cowling lip).
 *
 * Texel (i, j) covers uv ((i + ½)/size, (j + ½)/size): row j is v, matching an unflipped
 * `DataTexture`.
 */
import * as THREE from 'three';
import type { AircraftKind } from './planes';

export type AtlasRegion = 'fuselage' | 'wingTop' | 'wingBottom' | 'tail' | 'engine';

export interface AtlasRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Fixed atlas layout shared by every kind; the five rects tile the unit square. */
export const ATLAS_RECTS: Readonly<Record<AtlasRegion, AtlasRect>> = {
  fuselage: { u0: 0, v0: 0.4, u1: 1, v1: 1 },
  wingTop: { u0: 0, v0: 0, u1: 0.3, v1: 0.4 },
  wingBottom: { u0: 0.3, v0: 0, u1: 0.6, v1: 0.4 },
  tail: { u0: 0.6, v0: 0.2, u1: 1, v1: 0.4 },
  engine: { u0: 0.6, v0: 0, u1: 1, v1: 0.2 },
};

const REGIONS = Object.keys(ATLAS_RECTS) as AtlasRegion[];

/** UVs stay this far inside their rect so mipmaps do not bleed one region into the next. */
const PAD = 2 / 512;

export interface Livery {
  kind: AircraftKind;
  /** Main colour (sRGB hex): fuselage sides, fin, nacelles. */
  base: number;
  /** Upper surfaces. */
  upper: number;
  /** Undersides. */
  lower: number;
  /** Window-line stripe, or null. */
  cheatline: number | null;
  insignia: 'usn-star' | null;
  /** Tail code or registration, or null. */
  code: string | null;
  /** Bare or silver-doped metal (metallic shading) rather than matt paint. */
  metal: boolean;
}

const LIVERIES: Readonly<Record<AircraftKind, Livery>> = {
  // 1945 US Navy tri-colour: sea blue above, intermediate blue sides, insignia white below.
  avenger: {
    kind: 'avenger',
    base: 0x4a5d7a,
    upper: 0x1f2f4a,
    lower: 0xe8eaec,
    cheatline: null,
    insignia: 'usn-star',
    code: 'FT-28',
    metal: false,
  },
  // Glossy sea blue overall.
  mariner: {
    kind: 'mariner',
    base: 0x1c2a44,
    upper: 0x1c2a44,
    lower: 0x1c2a44,
    cheatline: null,
    insignia: 'usn-star',
    code: null,
    metal: false,
  },
  dc3: {
    kind: 'dc3',
    base: 0xc9ced3,
    upper: 0xc9ced3,
    lower: 0xc9ced3,
    cheatline: 0x1e3a5f,
    insignia: null,
    code: null,
    metal: true,
  },
  tudor: {
    kind: 'tudor',
    base: 0xbfc5cb,
    upper: 0xbfc5cb,
    lower: 0xbfc5cb,
    cheatline: 0x1e3a5f,
    insignia: null,
    code: 'G-AHNP',
    metal: true,
  },
};

export function liveryFor(kind: AircraftKind): Livery {
  return LIVERIES[kind];
}

/** Real-world sizes [m] the regions stand for, so markings come out round and to scale. */
interface Dims {
  length: number;
  radius: number;
  half: number;
  chord: number;
  finLen: number;
  finH: number;
}

const DIMS: Readonly<Record<AircraftKind, Dims>> = {
  avenger: { length: 11.5, radius: 0.9, half: 8.25, chord: 2.7, finLen: 1.9, finH: 2.3 },
  mariner: { length: 21, radius: 1.5, half: 18, chord: 3.4, finLen: 2.1, finH: 3.2 },
  dc3: { length: 17, radius: 1.25, half: 14.5, chord: 3.4, finLen: 2.4, finH: 2.9 },
  tudor: { length: 22, radius: 1.6, half: 18, chord: 3.9, finLen: 3.0, finH: 4.2 },
};

/** Index of the texel containing (u, v) in a `size`² atlas. */
export function texelIndex(size: number, u: number, v: number): number {
  const i = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
  const j = Math.min(size - 1, Math.max(0, Math.floor(v * size)));
  return j * size + i;
}

// ---------------------------------------------------------------------------------------------
// Markings
// ---------------------------------------------------------------------------------------------

interface Marking {
  region: AtlasRegion;
  /** Centre in region-local coordinates. */
  s: number;
  t: number;
  /** Disc radius [m]. */
  r: number;
  /** +1 when the star's top point faces +s, −1 when it faces −s. */
  up: 1 | -1;
}

function markings(livery: Livery): Marking[] {
  if (livery.insignia !== 'usn-star') return [];
  const fuseT = livery.kind === 'avenger' ? 0.26 : 0.24;
  const fuseR = livery.kind === 'avenger' ? 0.55 : 0.85;
  const wingR = livery.kind === 'avenger' ? 0.85 : 1.25;
  return [
    { region: 'fuselage', s: 0.25, t: fuseT, r: fuseR, up: 1 },
    { region: 'fuselage', s: 0.75, t: fuseT, r: fuseR, up: -1 },
    { region: 'wingTop', s: 0.5, t: 0.78, r: wingR, up: 1 },
    { region: 'wingBottom', s: 0.5, t: 0.78, r: wingR, up: 1 },
  ];
}

/** Metres per unit of region-local s and t. */
function regionScale(region: AtlasRegion, d: Dims): [number, number] {
  switch (region) {
    case 'fuselage':
      return [2 * Math.PI * d.radius, d.length];
    case 'wingTop':
    case 'wingBottom':
      return [d.chord, d.half];
    case 'tail':
      return [d.finLen, d.finH];
    case 'engine':
      return [2 * Math.PI * 0.8, 4.4];
  }
}

export interface InsigniaSpot {
  region: AtlasRegion;
  /** Centre texel (x = column, y = row). */
  x: number;
  y: number;
  /** Disc radius in texels along x (u) and y (v). */
  rx: number;
  ry: number;
}

/** Where the national insignia sit in a `size`² atlas of `livery` (empty when it has none). */
export function insigniaSpots(livery: Livery, size: number): InsigniaSpot[] {
  const d = DIMS[livery.kind];
  return markings(livery).map((m) => {
    const rect = ATLAS_RECTS[m.region];
    const [ms, mt] = regionScale(m.region, d);
    const w = (rect.u1 - rect.u0) * size;
    const h = (rect.v1 - rect.v0) * size;
    return {
      region: m.region,
      x: (rect.u0 + m.s * (rect.u1 - rect.u0)) * size - 0.5,
      y: (rect.v0 + m.t * (rect.v1 - rect.v0)) * size - 0.5,
      rx: (m.r / ms) * w,
      ry: (m.r / mt) * h,
    };
  });
}

/** Five-pointed star, outer radius 0.8, top point along +a; vertices as (a, b) pairs. */
const STAR: readonly (readonly [number, number])[] = Array.from({ length: 10 }, (_, k) => {
  const r = k % 2 === 0 ? 0.8 : 0.8 * 0.381966;
  const th = (k * Math.PI) / 5;
  return [r * Math.cos(th), r * Math.sin(th)] as const;
});

function inStar(a: number, b: number): boolean {
  let inside = false;
  for (let i = 0, j = STAR.length - 1; i < STAR.length; j = i++) {
    const [ai, bi] = STAR[i]!;
    const [aj, bj] = STAR[j]!;
    if (bi > b !== bj > b && a < ((aj - ai) * (b - bi)) / (bj - bi) + ai) inside = !inside;
  }
  return inside;
}

const WHITE = 0xf2f3f1;
const INSIGNIA_BLUE = 0x1f2f4a;

/**
 * The 1943–47 star-and-bar at disc-normalised (a "up", b along the bars): white star on a blue
 * disc, white bars outlined in blue. Returns a colour, or null outside the marking.
 */
function starAndBar(a: number, b: number): number | null {
  const rr = a * a + b * b;
  if (rr <= 1) return inStar(a, b) ? WHITE : INSIGNIA_BLUE;
  const ab = Math.abs(b);
  const aa = Math.abs(a);
  if (ab <= 1.95 && aa <= 0.35) return ab <= 1.87 && aa <= 0.27 ? WHITE : INSIGNIA_BLUE;
  return null;
}

/** 5 × 7 glyphs for the codes in use, rows top to bottom. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
};

/**
 * Whether text `code`, centred at the origin with glyph height `h` [m], covers the point
 * (x right, y up) [m].
 */
function inText(code: string, h: number, x: number, y: number): boolean {
  const cell = h / 7;
  const advance = 6 * cell;
  const width = code.length * advance - cell;
  const cx = x + width / 2;
  const cy = h / 2 - y;
  if (cx < 0 || cy < 0 || cx >= width || cy >= h) return false;
  const k = Math.floor(cx / advance);
  const col = Math.floor((cx - k * advance) / cell);
  if (col > 4) return false;
  const glyph = GLYPHS[code[k]!];
  return !!glyph && glyph[Math.floor(cy / cell)]![col] === '1';
}

// ---------------------------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------------------------

interface Texel {
  /** sRGB colour, 0–255 per channel. */
  r: number;
  g: number;
  b: number;
  rough: number;
  /** Relative surface height (panel grooves negative, rivets positive). */
  h: number;
}

function setHex(out: Texel, hex: number): void {
  out.r = (hex >> 16) & 255;
  out.g = (hex >> 8) & 255;
  out.b = hex & 255;
}

function mixHex(out: Texel, hex: number, k: number): void {
  out.r += (((hex >> 16) & 255) - out.r) * k;
  out.g += (((hex >> 8) & 255) - out.g) * k;
  out.b += ((hex & 255) - out.b) * k;
}

function shade(out: Texel, k: number): void {
  out.r *= k;
  out.g *= k;
  out.b *= k;
}

/** Deterministic hash of two integers to [0, 1). */
function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const PANEL_PITCH = 1.2;
const RIVET_PITCH = 0.12;

/**
 * Panel seam and rivet rows across `along` [m]: a groove every PANEL_PITCH, a rivet row either
 * side of it. `across` [m] spaces the rivets; `px` is the texel size [m] so lines stay ≥ 1 texel.
 */
function seams(along: number, across: number, px: number): number {
  const w = Math.max(px * 0.75, 0.02);
  const m = ((along % PANEL_PITCH) + PANEL_PITCH) % PANEL_PITCH;
  const dl = Math.min(m, PANEL_PITCH - m);
  if (dl < w) return -1;
  const off = Math.abs(dl - 0.07);
  if (off < Math.max(px * 0.6, 0.012)) {
    const q = ((across % RIVET_PITCH) + RIVET_PITCH) % RIVET_PITCH;
    if (Math.min(q, RIVET_PITCH - q) < Math.max(px * 0.6, 0.012)) return 0.45;
  }
  return 0;
}

function paintFuselage(l: Livery, d: Dims, s: number, t: number, px: number, out: Texel): void {
  const [ms, mt] = regionScale('fuselage', d);
  // Elevation around the hull: +1 crown, 0 the sides, −1 the keel.
  const e = Math.cos(2 * Math.PI * (s - 0.5));
  setHex(out, l.base);
  mixHex(out, l.upper, smoothstepK(0.45, 0.65, e));
  mixHex(out, l.lower, smoothstepK(-0.25, -0.45, e));
  const along = t * mt;
  if (l.cheatline !== null && t > 0.08 && t < 0.97) {
    if (e > -0.02 && e < 0.13) setHex(out, l.cheatline);
  }
  // Cabin windows on the airliners, above the cheatline.
  if (l.metal && t > 0.32 && t < 0.8 && e > 0.18 && e < 0.3) {
    const pitch = 0.85;
    const m = ((along % pitch) + pitch) % pitch;
    if (m < 0.38) {
      setHex(out, 0x1a2128);
      out.rough = 0.22;
    }
  }
  // The nose cap (t > 0.96) is one pressed panel: small single-colour parts sample it.
  if (t <= 0.96) {
    out.h += seams(along, s * ms, px);
    // Around-the-hull stringer seams at the crown and the keel line.
    if (Math.abs(e) > 0.995) out.h -= 0.5;
  }
  // Exhaust staining along the sides behind a nose-mounted engine.
  if (l.kind === 'avenger' && t > 0.6 && t < 0.86 && Math.abs(e) < 0.5) {
    shade(out, 1 - 0.18 * smoothstepK(0.6, 0.84, t) * (1 - Math.abs(e) * 2));
  }
  // Registration on the rear fuselage sides, readable from both sides.
  if (l.code && l.kind !== 'avenger') {
    const sides: [number, 1 | -1][] = [
      [0.324, 1],
      [0.676, -1],
    ];
    for (const [sc, up] of sides) {
      const x = up === 1 ? (0.3 - t) * mt : (t - 0.3) * mt;
      const y = up * (s - sc) * ms;
      if (inText(l.code, 0.5, x, y)) {
        setHex(out, l.cheatline ?? 0x111111);
        out.rough = 0.45;
      }
    }
  }
}

function paintWing(l: Livery, d: Dims, top: boolean, s: number, t: number, px: number, out: Texel) {
  const [ms, mt] = regionScale('wingTop', d);
  setHex(out, top ? l.upper : l.lower);
  out.h += seams(t * mt, s * ms, px);
  // Front and rear spar lines, and the aileron hinge outboard.
  const chordM = s * ms;
  for (const at of [0.28 * ms, 0.72 * ms])
    if (Math.abs(chordM - at) < Math.max(px, 0.02)) out.h -= 1;
  if (t > 0.55 && t < 0.97 && Math.abs(s - 0.22) * ms < Math.max(px, 0.02)) out.h -= 1;
}

function paintTail(l: Livery, d: Dims, s: number, t: number, px: number, out: Texel): void {
  const [ms, mt] = regionScale('tail', d);
  setHex(out, l.base);
  // Seams run level only: the fin's port side is mapped mirrored so markings read correctly,
  // so anything fore-and-aft must be symmetric about s = 0.5. The fin tip (t > 0.94) is plain.
  if (t <= 0.94) out.h += seams(t * mt, s * ms, px);
  if (l.kind === 'avenger' && l.code) {
    if (inText(l.code, 0.42, (s - 0.5) * ms, (t - 0.45) * mt)) {
      setHex(out, WHITE);
      out.rough = 0.5;
    }
  }
}

function paintEngine(l: Livery, d: Dims, s: number, t: number, px: number, out: Texel): void {
  const [ms, mt] = regionScale('engine', d);
  setHex(out, l.kind === 'avenger' ? l.upper : l.base);
  out.h += seams(t * mt, s * ms, px) * 0.5;
  // Dark cowling lip at the front.
  if (t > 0.93) {
    shade(out, 0.5);
    out.rough = 0.4;
  }
  // Cowl flaps, then soot and oil streaking back from the exhaust stacks.
  const flap = (s * 24) % 1;
  if (t > 0.4 && t < 0.46 && flap < 0.12) out.h -= 1;
  if (t < 0.46) {
    const k = smoothstepK(0.46, 0.05, t) * (0.75 + 0.25 * Math.sin(s * Math.PI * 18));
    mixHex(out, 0x2a2622, 0.45 * k);
    out.rough += (0.65 - out.rough) * k;
  }
}

function smoothstepK(a: number, b: number, x: number): number {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
}

export interface AtlasPixels {
  /** RGBA, sRGB. */
  albedo: Uint8Array;
  /** One byte per texel. */
  roughness: Uint8Array;
  /** Tangent-space normal, RGB (n · 0.5 + 0.5). */
  normal: Uint8Array;
}

const ROUGH_MIN = 0.22;
const ROUGH_MAX = 0.68;
/** Steepest normal-map slope: keeps every normal within ~45° of the surface normal. */
const MAX_SLOPE = 0.98;
const BUMP = 0.9;

/** Paint the albedo, roughness and normal atlas for `livery`. Pure and deterministic. */
export function paintAtlas(livery: Livery, size: 256 | 512): AtlasPixels {
  const d = DIMS[livery.kind];
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const roughness = new Uint8Array(n);
  const height = new Float32Array(n);
  const marks = markings(livery);
  const baseRough = livery.metal ? 0.26 : livery.kind === 'mariner' ? 0.36 : 0.5;
  const out: Texel = { r: 0, g: 0, b: 0, rough: 0, h: 0 };

  for (const region of REGIONS) {
    const rect = ATLAS_RECTS[region];
    const [ms, mt] = regionScale(region, d);
    const i0 = Math.round(rect.u0 * size);
    const i1 = Math.round(rect.u1 * size);
    const j0 = Math.round(rect.v0 * size);
    const j1 = Math.round(rect.v1 * size);
    const pxM = Math.max(ms / (i1 - i0), mt / (j1 - j0));
    const regionMarks = marks.filter((m) => m.region === region);
    for (let j = j0; j < j1; j++) {
      const t = (j + 0.5 - j0) / (j1 - j0);
      for (let i = i0; i < i1; i++) {
        const s = (i + 0.5 - i0) / (i1 - i0);
        out.rough = baseRough;
        out.h = 0;
        switch (region) {
          case 'fuselage':
            paintFuselage(livery, d, s, t, pxM, out);
            break;
          case 'wingTop':
          case 'wingBottom':
            paintWing(livery, d, region === 'wingTop', s, t, pxM, out);
            break;
          case 'tail':
            paintTail(livery, d, s, t, pxM, out);
            break;
          case 'engine':
            paintEngine(livery, d, s, t, pxM, out);
            break;
        }
        for (const m of regionMarks) {
          const a = (m.up * (s - m.s) * ms) / m.r;
          const b = ((t - m.t) * mt) / m.r;
          const c = starAndBar(a, b);
          if (c !== null) {
            setHex(out, c);
            out.rough = 0.5;
          }
        }
        // Seams read a touch darker; a whisper of mottling keeps flat paint from looking CG.
        const grain = 1 + (hash2(i, j) - 0.5) * 0.016;
        const seamShade = out.h < 0 ? 0.97 : 1;
        const k = (j * size + i) * 4;
        albedo[k] = clampByte(out.r * grain * seamShade);
        albedo[k + 1] = clampByte(out.g * grain * seamShade);
        albedo[k + 2] = clampByte(out.b * grain * seamShade);
        albedo[k + 3] = 255;
        const rough = out.rough + (hash2(j + 7919, i) - 0.5) * 0.03;
        roughness[j * size + i] = clampByte(Math.min(ROUGH_MAX, Math.max(ROUGH_MIN, rough)) * 255);
        height[j * size + i] = out.h;
      }
    }
  }

  return { albedo, roughness, normal: normalsFromHeight(height, size) };
}

function clampByte(x: number): number {
  return Math.min(255, Math.max(0, Math.round(x)));
}

/** Sobel-filtered tangent-space normals (+x along u, +y along v), slopes capped at MAX_SLOPE. */
function normalsFromHeight(h: Float32Array, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 3);
  const at = (i: number, j: number) =>
    h[Math.min(size - 1, Math.max(0, j)) * size + Math.min(size - 1, Math.max(0, i))]!;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const gx =
        at(i + 1, j - 1) +
        2 * at(i + 1, j) +
        at(i + 1, j + 1) -
        (at(i - 1, j - 1) + 2 * at(i - 1, j) + at(i - 1, j + 1));
      const gy =
        at(i - 1, j + 1) +
        2 * at(i, j + 1) +
        at(i + 1, j + 1) -
        (at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1));
      let sx = (-gx * BUMP) / 8;
      let sy = (-gy * BUMP) / 8;
      const g = Math.hypot(sx, sy);
      if (g > MAX_SLOPE) {
        sx *= MAX_SLOPE / g;
        sy *= MAX_SLOPE / g;
      }
      const inv = 1 / Math.sqrt(sx * sx + sy * sy + 1);
      const k = (j * size + i) * 3;
      out[k] = clampByte((sx * inv * 0.5 + 0.5) * 255);
      out[k + 1] = clampByte((sy * inv * 0.5 + 0.5) * 255);
      out[k + 2] = clampByte((inv * 0.5 + 0.5) * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// UV mapping
// ---------------------------------------------------------------------------------------------

/** Region and region-local (s, t) for one vertex; s and t are clamped to [0, 1]. */
export interface UvPick {
  region: AtlasRegion;
  u: number;
  v: number;
}

/**
 * Write atlas UVs for every vertex of `geo` from `pick(position, normal, nativeUv)`, padded
 * inside the chosen region's rect. Mutates and returns `geo`.
 */
export function projectUv(
  geo: THREE.BufferGeometry,
  pick: (p: THREE.Vector3, n: THREE.Vector3, uv: THREE.Vector2) => UvPick,
): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const src = geo.getAttribute('uv');
  const count = pos.count;
  const out = new Float32Array(count * 2);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const uv = new THREE.Vector2();
  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(pos, i);
    if (nor) n.fromBufferAttribute(nor, i);
    else n.set(0, 1, 0);
    if (src) uv.fromBufferAttribute(src as THREE.BufferAttribute, i);
    else uv.set(0, 0);
    const q = pick(p, n, uv);
    const r = ATLAS_RECTS[q.region];
    const s = Math.min(1, Math.max(0, q.u));
    const t = Math.min(1, Math.max(0, q.v));
    out[i * 2] = r.u0 + PAD + s * (r.u1 - r.u0 - 2 * PAD);
    out[i * 2 + 1] = r.v0 + PAD + t * (r.v1 - r.v0 - 2 * PAD);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(out, 2));
  return geo;
}

/** Squeeze the geometry's own [0, 1]² UVs into `region`. Mutates and returns `geo`. */
export function remapUv(geo: THREE.BufferGeometry, region: AtlasRegion): THREE.BufferGeometry {
  return projectUv(geo, (_p, _n, uv) => ({ region, u: uv.x, v: uv.y }));
}
