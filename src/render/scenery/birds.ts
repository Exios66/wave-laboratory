/**
 * Gulls, terns and albatrosses, seen in fair weather.
 *
 * - Gull flocks wheel in loose circles near the point the camera is looking at.
 * - A few gulls trail the stern of each moving vessel (or circle it when it is stopped).
 * - Terns circle and now and then plunge-dive into the sea with a small splash.
 * - One or two albatrosses glide long, low figure-of-eight arcs over the swell and rarely flap.
 *
 * Numbers scale with how calm and how light it is. When the weather turns or night falls the
 * birds climb away downwind and fade, and they come back when it clears.
 *
 * The flight paths and wing poses are pure functions of time and a per-bird slot, so they can be
 * unit-tested without WebGL. The layer itself only keeps per-bird presence (arriving/leaving).
 */
import * as THREE from 'three';
import type { SceneryFrame, SceneryLayer, SceneryVessel } from './types';

// ---------------------------------------------------------------------------------------------
// Pure maths
// ---------------------------------------------------------------------------------------------

export type BirdRole = 'gull' | 'tern' | 'albatross';
/** flock: wheeling gulls. ship: gulls trailing a vessel. soar: albatross. dive: tern. */
export type BirdMode = 'flock' | 'ship' | 'soar' | 'dive';

export interface BirdSlot {
  index: number;
  role: BirdRole;
  mode: BirdMode;
  /** Flock number (flock/dive/soar) or vessel number (ship). */
  group: number;
  /** 0–1. The bird is wanted when its rank is below the fair-weather fraction. */
  rank: number;
  /** The one bird that may stay out in the twilight when everyone else has gone. */
  lone: boolean;
  /** Circle radius or arc size [m]. */
  radius: number;
  /** Cruise altitude above mean sea level [m]. */
  altitude: number;
  /** Air speed along the path [m/s]. */
  speed: number;
  /** +1 anticlockwise, −1 clockwise (seen from above). */
  dir: number;
  /** Phase offset [rad]. */
  phase: number;
  /** Offset of the flock centre from the anchor [m], Three.js x/z. */
  offsetX: number;
  offsetZ: number;
  /** Tern dive cycle length [s]. */
  divePeriod: number;
  /** Uniform random numbers for small per-bird variations. */
  r1: number;
  r2: number;
  r3: number;
  /** Size multiplier on the unit bird. */
  scale: number;
}

/** What the paths need to know about the scene, all Three.js axes. */
export interface FlightContext {
  /** The point the birds gather around (near what the camera looks at). */
  anchorX: number;
  anchorZ: number;
  /** Unit vector the wind blows TOWARD (downwind), horizontal. */
  downwindX: number;
  downwindZ: number;
  windSpeed: number;
  /** Significant wave height [m]. */
  hs: number;
}

/** A vessel as the trailing gulls see it. Position is extrapolated from `t0` at the given velocity. */
export interface ShipTrack {
  x: number;
  z: number;
  /** Velocity [m/s] (Three.js x/z). */
  vx: number;
  vz: number;
  /** Unit forward (bow) direction, horizontal. */
  fx: number;
  fz: number;
  length: number;
  /** Height of the deck/superstructure the gulls hover above [m]. */
  height: number;
  /** Time at which (x, z) was sampled. */
  t0: number;
}

export interface WingPose {
  /** Inner wing angle at the shoulder [rad], positive = raised. */
  inner: number;
  /** Outer wing angle relative to the inner wing at the wrist [rad]. */
  outer: number;
  /** 0–1: how much of the time-envelope is flapping (0 = gliding). */
  flap: number;
}

const TAU = Math.PI * 2;
const G = 9.81;

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

function smoothstep(a: number, b: number, x: number): number {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
}

function fract(x: number): number {
  return x - Math.floor(x);
}

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lowest height a cruising bird keeps over the sea [m] (clears the crests). */
export function seaClearance(hs: number): number {
  return 1.2 + 0.9 * Math.max(0, hs);
}

/**
 * Fraction of the bird population that is out, 0–1. Birds leave as the weather turns
 * (calm below about 0.4 there are none) and roost at night.
 */
export function seabirdFraction(calm: number, daylight: number): number {
  return smoothstep(0.38, 0.78, calm) * smoothstep(0.12, 0.6, daylight);
}

/** Whether a slot's bird should be out now. */
export function slotWanted(
  slot: BirdSlot,
  calm: number,
  daylight: number,
  vesselAvailable = true,
): boolean {
  if (slot.mode === 'ship' && !vesselAvailable) return false;
  if (slot.rank < seabirdFraction(calm, daylight)) return true;
  // A lone gull lingers in the dusk while it is calm.
  return slot.lone && calm > 0.55 && daylight > 0.02;
}

export const FLOCKS = 3;
export const FLOCK_SIZE = 6;
export const TERNS = 7;
export const ALBATROSSES = 2;
export const SHIP_VESSELS = 3;
export const SHIP_GULLS = 5;

/** The fixed roster of bird slots. Deterministic for a given seed. */
export function createBirdSlots(seed = 1): BirdSlot[] {
  const rnd = mulberry32(seed);
  const slots: BirdSlot[] = [];
  const base = (role: BirdRole, mode: BirdMode, group: number, rank: number): BirdSlot => ({
    index: slots.length,
    role,
    mode,
    group,
    rank,
    lone: false,
    radius: 30,
    altitude: 15,
    speed: 10,
    dir: 1,
    phase: rnd() * TAU,
    offsetX: 0,
    offsetZ: 0,
    divePeriod: 20,
    r1: rnd(),
    r2: rnd(),
    r3: rnd(),
    scale: 1,
  });

  for (let f = 0; f < FLOCKS; f++) {
    // Flock centres around the anchor, one close, two further out.
    const ang = f * 2.2 + rnd() * 0.8;
    const dist = f === 0 ? 25 + rnd() * 25 : 90 + rnd() * 90;
    const dir = rnd() < 0.5 ? -1 : 1;
    const alt = 14 + rnd() * 14;
    for (let k = 0; k < FLOCK_SIZE; k++) {
      const s = base('gull', 'flock', f, (k + 0.3 + 0.4 * rnd()) / FLOCK_SIZE);
      s.offsetX = Math.cos(ang) * dist;
      s.offsetZ = Math.sin(ang) * dist;
      s.dir = dir;
      s.radius = 16 + rnd() * 30;
      s.altitude = alt + (rnd() - 0.5) * 10;
      s.speed = 8.5 + rnd() * 3;
      s.scale = 1.1 + rnd() * 0.15;
      s.lone = f === 0 && k === 0;
      slots.push(s);
    }
  }

  {
    const ang = 0.9 + rnd() * 1.5;
    const dist = 40 + rnd() * 40;
    for (let k = 0; k < TERNS; k++) {
      const s = base('tern', 'dive', 0, (k + 0.3 + 0.4 * rnd()) / TERNS);
      s.offsetX = Math.cos(ang) * dist;
      s.offsetZ = Math.sin(ang) * dist;
      s.dir = rnd() < 0.5 ? -1 : 1;
      s.radius = 12 + rnd() * 20;
      s.altitude = 9 + rnd() * 6;
      s.speed = 7 + rnd() * 2;
      s.divePeriod = 16 + rnd() * 14;
      s.scale = 0.85 + rnd() * 0.1;
      slots.push(s);
    }
  }

  for (let k = 0; k < ALBATROSSES; k++) {
    const s = base('albatross', 'soar', k, k === 0 ? 0.25 : 0.7);
    const ang = rnd() * TAU;
    const dist = 60 + rnd() * 120;
    s.offsetX = Math.cos(ang) * dist;
    s.offsetZ = Math.sin(ang) * dist;
    s.radius = 160 + rnd() * 110;
    s.speed = 13 + rnd() * 3;
    s.dir = k === 0 ? 1 : -1;
    s.scale = 1.85;
    slots.push(s);
  }

  for (let v = 0; v < SHIP_VESSELS; v++) {
    for (let k = 0; k < SHIP_GULLS; k++) {
      const s = base('gull', 'ship', v, (k + 0.3 + 0.4 * rnd()) / SHIP_GULLS);
      s.speed = 8 + rnd() * 2;
      s.scale = 1.05 + rnd() * 0.15;
      s.dir = rnd() < 0.5 ? -1 : 1;
      slots.push(s);
    }
  }
  return slots;
}

export interface BirdCounts {
  gull: number;
  tern: number;
  albatross: number;
  ship: number;
  total: number;
}

/** How many birds of each kind are wanted. `vessels` = number of vessels gulls can follow. */
export function birdCounts(
  slots: readonly BirdSlot[],
  calm: number,
  daylight: number,
  vessels: number,
): BirdCounts {
  const out: BirdCounts = { gull: 0, tern: 0, albatross: 0, ship: 0, total: 0 };
  for (const s of slots) {
    if (!slotWanted(s, calm, daylight, s.group < vessels)) continue;
    if (s.mode === 'ship') out.ship++;
    else out[s.role]++;
    out.total++;
  }
  return out;
}

/** Slow back-and-forth drift downwind [m]; birds sag downwind of their circle a little. */
function windDrift(slot: BirdSlot, t: number, ctx: FlightContext): number {
  const w = Math.min(ctx.windSpeed, 12);
  return w * (2.5 + 2 * Math.sin(0.045 * t + slot.r1 * TAU));
}

/** A gull wheeling in a loose, breathing circle. */
export function flockPosition(
  slot: BirdSlot,
  t: number,
  ctx: FlightContext,
  out: THREE.Vector3,
): THREE.Vector3 {
  const drift = windDrift(slot, t, ctx);
  const cx = ctx.anchorX + slot.offsetX + ctx.downwindX * drift;
  const cz = ctx.anchorZ + slot.offsetZ + ctx.downwindZ * drift;
  const R = slot.radius * (1 + 0.22 * Math.sin(0.27 * t + slot.phase * 3));
  const th = slot.dir * (slot.speed / slot.radius) * t + slot.phase;
  const y = slot.altitude + 3.5 * Math.sin(0.19 * t + slot.phase * 2) + 1.2 * Math.sin(0.7 * t);
  return out.set(
    cx + R * Math.cos(th),
    Math.max(y, seaClearance(ctx.hs) + 2),
    cz + R * 0.85 * Math.sin(th),
  );
}

/** An albatross: a long, low figure-of-eight, climbing a little through each end turn. */
export function soarPosition(
  slot: BirdSlot,
  t: number,
  ctx: FlightContext,
  out: THREE.Vector3,
): THREE.Vector3 {
  const R = slot.radius;
  const th = slot.dir * (slot.speed / (1.25 * R)) * t + slot.phase;
  const lx = R * Math.cos(th);
  const lz = 0.55 * R * Math.sin(2 * th);
  const rot = slot.r2 * TAU;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const drift = windDrift(slot, t, ctx) * 0.5;
  const turn = 0.5 + 0.5 * Math.cos(2 * th);
  const y =
    seaClearance(ctx.hs) + 0.5 + 0.6 * Math.sin(0.9 * t + slot.phase) ** 2 + 11 * turn * turn;
  return out.set(
    ctx.anchorX + slot.offsetX + c * lx - s * lz + ctx.downwindX * drift,
    y,
    ctx.anchorZ + slot.offsetZ + s * lx + c * lz + ctx.downwindZ * drift,
  );
}

const DIVE_CRUISE_END = 0.8;
const DIVE_HOVER_END = 0.86;
const DIVE_PLUNGE_END = 0.9;
const DIVE_UNDER_END = 0.92;
const DIVE_SLOW = 0.15;
const DIVE_DEPTH = 0.8;

export type DiveStage = 'cruise' | 'hover' | 'plunge' | 'under' | 'emerge';

export interface DiveState {
  /** Height above mean sea level [m]. */
  y: number;
  stage: DiveStage;
  /** 0–1: wings folded for the plunge. */
  fold: number;
}

/** Altitude through one dive cycle, `u` in [0, 1), cruise altitude `h`. */
export function ternDiveProfile(u: number, h: number, out: DiveState): DiveState {
  const span = h + DIVE_DEPTH;
  if (u < DIVE_CRUISE_END) {
    out.stage = 'cruise';
    out.y = h + 1.5 * Math.sin((TAU * u) / DIVE_CRUISE_END);
    out.fold = 0;
  } else if (u < DIVE_HOVER_END) {
    const s = (u - DIVE_CRUISE_END) / (DIVE_HOVER_END - DIVE_CRUISE_END);
    out.stage = 'hover';
    out.y = h + 1.2 * Math.sin(Math.PI * s);
    out.fold = smoothstep(0.6, 1, s) * 0.6;
  } else if (u < DIVE_PLUNGE_END) {
    const s = (u - DIVE_HOVER_END) / (DIVE_PLUNGE_END - DIVE_HOVER_END);
    out.stage = 'plunge';
    out.y = h - span * s * s;
    out.fold = 0.6 + 0.4 * smoothstep(0, 0.3, s);
  } else if (u < DIVE_UNDER_END) {
    out.stage = 'under';
    out.y = -DIVE_DEPTH;
    out.fold = 1;
  } else {
    const s = (u - DIVE_UNDER_END) / (1 - DIVE_UNDER_END);
    out.stage = 'emerge';
    out.y = -DIVE_DEPTH + span * smoothstep(0, 1, s);
    out.fold = 1 - smoothstep(0, 0.35, s);
  }
  return out;
}

/** Tern dive cycle phase u ∈ [0, 1) and the slowed-down "path time" for the horizontal circle. */
export interface TernCycle {
  u: number;
  pathT: number;
}

export function ternCycle(
  slot: BirdSlot,
  t: number,
  out: TernCycle = { u: 0, pathT: 0 },
): TernCycle {
  const P = slot.divePeriod;
  const x = t / P + slot.r3;
  const k = Math.floor(x);
  const u = x - k;
  const g1 = DIVE_CRUISE_END + (1 - DIVE_CRUISE_END) * DIVE_SLOW;
  const g = u < DIVE_CRUISE_END ? u : DIVE_CRUISE_END + (u - DIVE_CRUISE_END) * DIVE_SLOW;
  out.u = u;
  out.pathT = (k * g1 + g) * P;
  return out;
}

const diveScratch: DiveState = { y: 0, stage: 'cruise', fold: 0 };
const cycleScratch: TernCycle = { u: 0, pathT: 0 };

/** A tern circling and plunge-diving. Also fills `dive` (stage and fold) when given. */
export function divePosition(
  slot: BirdSlot,
  t: number,
  ctx: FlightContext,
  out: THREE.Vector3,
  dive: DiveState = diveScratch,
): THREE.Vector3 {
  const { u, pathT } = ternCycle(slot, t, cycleScratch);
  const drift = windDrift(slot, t, ctx);
  const cx = ctx.anchorX + slot.offsetX + ctx.downwindX * drift;
  const cz = ctx.anchorZ + slot.offsetZ + ctx.downwindZ * drift;
  const th = slot.dir * (slot.speed / slot.radius) * pathT + slot.phase;
  const R = slot.radius * (1 + 0.2 * Math.sin(0.31 * t + slot.phase));
  const h = Math.max(slot.altitude, seaClearance(ctx.hs) + 4);
  ternDiveProfile(u, h, dive);
  return out.set(cx + R * Math.cos(th), dive.y, cz + R * Math.sin(th));
}

/**
 * A gull following a ship: weaving behind the stern when it is under way, circling it when it
 * is stopped.
 */
export function shipPosition(
  slot: BirdSlot,
  t: number,
  ship: ShipTrack,
  out: THREE.Vector3,
): THREE.Vector3 {
  const dt = t - ship.t0;
  const px = ship.x + ship.vx * dt;
  const pz = ship.z + ship.vz * dt;
  const speed = Math.hypot(ship.vx, ship.vz);
  const m = smoothstep(0.4, 2, speed);
  const L = ship.length;
  // Trailing behind the stern, side to side and up and down.
  const back = L * 0.5 + 6 + slot.r1 * (L * 0.35 + 10);
  const side = (slot.r2 - 0.5) * (L * 0.3 + 8) + Math.sin(0.45 * t + slot.phase) * (4 + L * 0.05);
  const altT = ship.height + 3 + slot.r3 * 6 + 1.6 * Math.sin(0.6 * t + slot.phase * 1.7);
  const rx = -ship.fz;
  const rz = ship.fx;
  const tx = px - ship.fx * back + rx * side;
  const tz = pz - ship.fz * back + rz * side;
  // Circling a stopped ship.
  const R = L * 0.6 + 14 + slot.r1 * 12;
  const th = slot.dir * (slot.speed / R) * t + slot.phase;
  const cxp = px + R * Math.cos(th);
  const czp = pz + R * Math.sin(th);
  const altC = ship.height + 6 + slot.r3 * 8 + 2 * Math.sin(0.3 * t + slot.phase);
  return out.set(cxp + (tx - cxp) * m, altC + (altT - altC) * m, czp + (tz - czp) * m);
}

/**
 * Where a leaving bird has got to: up and away downwind. `presence` 1 = here, 0 = gone.
 * Never lowers the bird.
 */
export function departureOffset(
  slot: BirdSlot,
  presence: number,
  ctx: FlightContext,
  out: THREE.Vector3,
): THREE.Vector3 {
  const k = (1 - clamp(presence, 0, 1)) ** 2;
  let dx = ctx.downwindX;
  let dz = ctx.downwindZ;
  if (ctx.windSpeed < 0.5 || dx * dx + dz * dz < 1e-6) {
    const a = slot.r2 * TAU;
    dx = Math.cos(a);
    dz = Math.sin(a);
  }
  const spread = (slot.r1 - 0.5) * 0.7;
  const c = Math.cos(spread);
  const s = Math.sin(spread);
  return out.set((c * dx - s * dz) * 900 * k, 220 * k, (s * dx + c * dz) * 900 * k);
}

/**
 * Bank angle [rad] for flying with velocity `vel` and acceleration `acc`. Positive = rolled
 * to the right (right wing down), which is what a right turn needs.
 */
export function bankAngle(vel: THREE.Vector3, acc: THREE.Vector3, maxBank = 1.05): number {
  const vh = Math.hypot(vel.x, vel.z);
  if (vh < 1e-3) return 0;
  // Right of the heading (y up): forward × up.
  const rx = -vel.z / vh;
  const rz = vel.x / vh;
  const lateral = acc.x * rx + acc.z * rz;
  return clamp(Math.atan2(lateral, G), -maxBank, maxBank);
}

interface FlapStyle {
  period: number;
  duty: number;
  freq: number;
  amp: number;
  glideInner: number;
  glideOuter: number;
}

const FLAP: Record<BirdRole, FlapStyle> = {
  // Gulls flap a few beats then glide with the wrists bent: the classic "M".
  gull: { period: 6, duty: 0.4, freq: 2.4, amp: 0.6, glideInner: 0.2, glideOuter: -0.32 },
  // Terns are buoyant and flap most of the time.
  tern: { period: 3.6, duty: 0.72, freq: 3.1, amp: 0.68, glideInner: 0.22, glideOuter: -0.28 },
  // Albatrosses glide on stiff, flat wings and only rarely flap.
  albatross: {
    period: 26,
    duty: 0.09,
    freq: 1.3,
    amp: 0.38,
    glideInner: 0.04,
    glideOuter: -0.06,
  },
};

/**
 * Wing angles at time `t`. `climb` [m/s] makes a bird flap more; `fold` (0–1) folds the wings
 * up and back for a dive.
 */
export function wingPose(
  role: BirdRole,
  t: number,
  seed: number,
  climb: number,
  fold: number,
  out: WingPose,
): WingPose {
  const st = FLAP[role];
  const period = st.period * (0.8 + 0.4 * seed);
  const duty = clamp(st.duty + Math.max(0, climb) * 0.12, 0.05, 1);
  const p = fract(t / period + seed);
  const edge = 0.07;
  const env = duty >= 1 ? 1 : smoothstep(0, edge, p) * (1 - smoothstep(duty - edge, duty, p));
  const ph = TAU * st.freq * t + seed * 9;
  const flapInner = 0.08 + st.amp * Math.sin(ph);
  const flapOuter = 0.35 * Math.sin(ph - 0.9);
  let inner = st.glideInner + (flapInner - st.glideInner) * env;
  let outer = st.glideOuter + (flapOuter - st.glideOuter) * env;
  const f = clamp(fold, 0, 1);
  inner += (1.25 - inner) * f;
  outer += (0.9 - outer) * f;
  out.inner = inner;
  out.outer = outer;
  out.flap = env * (1 - f);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Geometry (low-poly, vertex-coloured)
// ---------------------------------------------------------------------------------------------

type RGB = readonly [number, number, number];
const WHITE: RGB = [0.97, 0.97, 0.97];
const MANTLE: RGB = [0.66, 0.71, 0.76];
const TIP: RGB = [0.1, 0.1, 0.12];
const BEAK: RGB = [0.98, 0.72, 0.18];
const TAIL: RGB = [0.9, 0.91, 0.93];

function colored(geo: THREE.BufferGeometry, col: RGB): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(col, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const pa = p.getAttribute('position').array as Float32Array;
    const ca = p.getAttribute('color').array as Float32Array;
    pos.set(pa, o);
    col.set(ca, o);
    o += pa.length;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Triangles from vertex positions and colours (non-indexed). */
function polys(
  verts: readonly (readonly [number, number, number])[],
  cols: readonly RGB[],
  tris: readonly number[],
) {
  const pos = new Float32Array(tris.length * 3);
  const col = new Float32Array(tris.length * 3);
  tris.forEach((v, i) => {
    pos.set(verts[v]!, i * 3);
    col.set(cols[v]!, i * 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Unit bird body: forward +x, up +y, right +z. About 1 m long. */
function bodyGeometry(): THREE.BufferGeometry {
  const profile = [
    [0.0, -0.5],
    [0.05, -0.4],
    [0.1, -0.18],
    [0.115, 0.0],
    [0.09, 0.16],
    [0.07, 0.23],
    [0.085, 0.3],
    [0.06, 0.38],
    [0.0, 0.42],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const body = new THREE.LatheGeometry(profile, 6);
  body.rotateZ(-Math.PI / 2);
  body.scale(1, 0.85, 1);
  const beak = new THREE.ConeGeometry(0.028, 0.14, 4);
  beak.rotateZ(-Math.PI / 2);
  beak.translate(0.47, 0.0, 0);
  const tail = polys(
    [
      [-0.36, 0.02, -0.06],
      [-0.36, 0.02, 0.06],
      [-0.6, 0.02, 0.12],
      [-0.6, 0.02, -0.12],
    ],
    [TAIL, TAIL, TAIL, TAIL],
    [0, 1, 2, 0, 2, 3],
  );
  return merge([colored(body, WHITE), colored(beak, BEAK), tail]);
}

function mirrorZ(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.clone();
  g.scale(1, 1, -1);
  // Restore the winding after the mirror.
  const pos = g.getAttribute('position');
  const col = g.getAttribute('color');
  for (let i = 0; i < pos.count; i += 3) {
    for (const a of [pos, col]) {
      const x = a.getX(i + 1);
      const y = a.getY(i + 1);
      const z = a.getZ(i + 1);
      a.setXYZ(i + 1, a.getX(i + 2), a.getY(i + 2), a.getZ(i + 2));
      a.setXYZ(i + 2, x, y, z);
    }
  }
  g.computeVertexNormals();
  return g;
}

/** Right inner wing, hinged at the origin, spanning +z to the wrist at z = 0.5. */
function innerWingGeometry(): THREE.BufferGeometry {
  const g = polys(
    [
      [0.13, 0, 0],
      [0.0, 0.025, 0],
      [-0.17, 0, 0],
      [0.1, 0, 0.5],
      [-0.01, 0.02, 0.5],
      [-0.12, 0, 0.5],
    ],
    [MANTLE, MANTLE, MANTLE, MANTLE, MANTLE, MANTLE],
    [0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5],
  );
  g.computeVertexNormals();
  return g;
}

/** Right outer wing (hand), hinged at the wrist, with dark tips. */
function outerWingGeometry(): THREE.BufferGeometry {
  const mid: RGB = [0.62, 0.66, 0.7];
  const g = polys(
    [
      [0.1, 0, 0], // 0 root leading
      [-0.12, 0, 0], // 1 root trailing
      [0.03, 0, 0.26], // 2
      [-0.15, 0, 0.24], // 3
      [-0.04, 0, 0.42], // 4 dark
      [-0.19, 0, 0.36], // 5 dark
      [-0.25, 0, 0.64], // 6 tip
    ],
    [MANTLE, MANTLE, mid, mid, TIP, TIP, TIP],
    [0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5, 4, 6, 5],
  );
  g.computeVertexNormals();
  return g;
}

/** A splash: a ring of spray spikes flaring outward over a flat foam disc. Unit size. */
function crownGeometry(): THREE.BufferGeometry {
  const N = 11;
  const pos: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU;
    const w = (0.5 / N) * TAU;
    const h = 0.65 + 0.35 * Math.abs(Math.sin(i * 2.7));
    pos.push(
      Math.cos(a - w) * 0.45,
      0,
      Math.sin(a - w) * 0.45,
      Math.cos(a + w) * 0.45,
      0,
      Math.sin(a + w) * 0.45,
      Math.cos(a) * 1.0,
      h,
      Math.sin(a) * 1.0,
    );
  }
  for (let i = 0; i < 14; i++) {
    const a0 = (i / 14) * TAU;
    const a1 = ((i + 1) / 14) * TAU;
    pos.push(0, 0.03, 0, Math.cos(a1) * 0.7, 0.03, Math.sin(a1) * 0.7);
    pos.push(Math.cos(a0) * 0.7, 0.03, Math.sin(a0) * 0.7);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------------------------

interface BirdState {
  presence: number;
  /** Last right vector, kept for steep dives where the heading is undefined. */
  rx: number;
  rz: number;
  prevY: number;
  /** Smoothed bank, so the roll does not jitter. */
  bank: number;
}

interface Splash {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
}

const SPLASHES = 8;
const SPLASH_LIFE = 1.3;
const ARRIVE_RATE = 1 / 14;
const LEAVE_RATE = 1 / 10;
const H = 0.05;

/** Hinge points of the wings on the unit body. */
const SHOULDER_X = 0.03;
const SHOULDER_Y = 0.04;
const SHOULDER_Z = 0.07;
const WRIST_Z = 0.5;

export class SeabirdLayer implements SceneryLayer {
  readonly object = new THREE.Group();

  private readonly slots = createBirdSlots(20260);
  private readonly states: BirdState[];
  private readonly geometries: THREE.BufferGeometry[];
  private readonly material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  private readonly body: THREE.InstancedMesh;
  private readonly innerL: THREE.InstancedMesh;
  private readonly innerR: THREE.InstancedMesh;
  private readonly outerL: THREE.InstancedMesh;
  private readonly outerR: THREE.InstancedMesh;
  private readonly meshes: readonly THREE.InstancedMesh[];
  private readonly crown = crownGeometry();
  private readonly splashes: Splash[] = [];

  private readonly ships: ShipTrack[] = [];
  private shipCount = 0;
  private readonly vesselInfo = new Map<
    string,
    { group: THREE.Group; length: number; height: number }
  >();
  private readonly ctx: FlightContext = {
    anchorX: 0,
    anchorZ: 0,
    downwindX: 1,
    downwindZ: 0,
    windSpeed: 0,
    hs: 0,
  };
  private primed = false;

  // Scratch, reused every frame.
  private readonly p0 = new THREE.Vector3();
  private readonly pa = new THREE.Vector3();
  private readonly pb = new THREE.Vector3();
  private readonly off = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly acc = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly mBody = new THREE.Matrix4();
  private readonly mWing = new THREE.Matrix4();
  private readonly mOuter = new THREE.Matrix4();
  private readonly mTmp = new THREE.Matrix4();
  private readonly mZero = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly pose: WingPose = { inner: 0, outer: 0, flap: 0 };
  private readonly dive: DiveState = { y: 0, stage: 'cruise', fold: 0 };
  private readonly ray = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor() {
    this.object.name = 'birds';
    // Seen from below against a bright sky the birds would read as dark specks. A little
    // self-light (scaled by each vertex's own colour, so wingtips stay dark) keeps them white.
    this.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= diffuseColor.rgb;',
      );
    };
    const n = this.slots.length;
    this.states = this.slots.map(() => ({ presence: 0, rx: 0, rz: 1, prevY: 10, bank: 0 }));
    const bodyGeo = bodyGeometry();
    const innerRGeo = innerWingGeometry();
    const outerRGeo = outerWingGeometry();
    const innerLGeo = mirrorZ(innerRGeo);
    const outerLGeo = mirrorZ(outerRGeo);
    this.geometries = [bodyGeo, innerRGeo, outerRGeo, innerLGeo, outerLGeo];
    const make = (geo: THREE.BufferGeometry, name: string) => {
      const m = new THREE.InstancedMesh(geo, this.material, n);
      m.name = name;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.object.add(m);
      return m;
    };
    this.body = make(bodyGeo, 'bird-body');
    this.innerR = make(innerRGeo, 'bird-wing-inner-r');
    this.outerR = make(outerRGeo, 'bird-wing-outer-r');
    this.innerL = make(innerLGeo, 'bird-wing-inner-l');
    this.outerL = make(outerLGeo, 'bird-wing-outer-l');
    this.meshes = [this.body, this.innerL, this.innerR, this.outerL, this.outerR];
    for (const s of this.slots) {
      // Albatrosses have dark upper wings; terns are paler than gulls.
      const bodyTint = s.role === 'tern' ? 1.02 : 1;
      const wingTint = s.role === 'albatross' ? 0.42 : s.role === 'tern' ? 1.18 : 1;
      this.color.setScalar(bodyTint);
      this.body.setColorAt(s.index, this.color);
      this.color.setScalar(wingTint);
      for (const m of [this.innerL, this.innerR, this.outerL, this.outerR])
        m.setColorAt(s.index, this.color);
      for (const m of this.meshes) m.setMatrixAt(s.index, this.mZero);
    }
    for (let i = 0; i < SPLASHES; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xf4f8fb,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.crown, mat);
      mesh.visible = false;
      mesh.name = 'bird-splash';
      this.object.add(mesh);
      this.splashes.push({ mesh, mat, age: SPLASH_LIFE });
    }
    for (let i = 0; i < SHIP_VESSELS; i++)
      this.ships.push({ x: 0, z: 0, vx: 0, vz: 0, fx: 1, fz: 0, length: 30, height: 4, t0: 0 });
  }

  setVessels(vessels: readonly SceneryVessel[]): void {
    this.vesselInfo.clear();
    for (const v of vessels) {
      const d = v.definition;
      // Highest point above the waterline (superstructure boxes are relative to the CoG).
      let height = d.depth - d.draft;
      for (const b of d.superstructure)
        height = Math.max(height, b.center.z + b.size.z / 2 + d.kg - d.draft);
      this.vesselInfo.set(v.id, {
        group: v.group,
        length: v.definition.length,
        height: clamp(height, 1, 40),
      });
    }
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
    if (!enabled) this.primed = false;
  }

  update(frame: SceneryFrame): void {
    if (!this.object.visible) return;
    const t = frame.wallT;
    const dt = frame.dt;
    this.updateContext(frame);
    this.material.emissive.setScalar(0.42 * frame.daylight);
    this.updateShips(frame, t);

    const ctx = this.ctx;
    for (const slot of this.slots) {
      const st = this.states[slot.index]!;
      const shipOk = slot.mode !== 'ship' || slot.group < this.shipCount;
      const wanted = slotWanted(slot, frame.calm, frame.daylight, shipOk);
      const target = wanted ? 1 : 0;
      let rate = 0;
      if (!this.primed) st.presence = target;
      else if (st.presence < target) rate = ARRIVE_RATE;
      else if (st.presence > target) rate = -LEAVE_RATE;
      st.presence = clamp(st.presence + rate * dt, 0, 1);
      // A ship gull whose ship is gone simply vanishes (it has nothing to be placed by).
      if (st.presence <= 0.002 || (slot.mode === 'ship' && !shipOk)) {
        if (slot.mode === 'ship' && !shipOk) st.presence = 0;
        for (const m of this.meshes) m.setMatrixAt(slot.index, this.mZero);
        continue;
      }

      // Position and its derivatives (finite differences of the pure path).
      this.position(slot, t, st.presence, this.p0);
      this.position(slot, t - H, st.presence - rate * H, this.pa);
      this.position(slot, t + H, st.presence + rate * H, this.pb);
      this.vel.subVectors(this.pb, this.pa).multiplyScalar(1 / (2 * H));
      this.acc
        .copy(this.pa)
        .add(this.pb)
        .addScaledVector(this.p0, -2)
        .multiplyScalar(1 / (H * H));

      let fold = 0;
      if (slot.mode === 'dive') {
        divePosition(slot, t, ctx, this.tmp, this.dive);
        fold = this.dive.fold;
        if (st.prevY > 0 && this.p0.y <= 0 && st.presence > 0.5) this.splash(this.p0.x, this.p0.z);
        st.prevY = this.p0.y;
      }

      // Orientation: nose along the velocity (ship gulls hang in the wind, facing ahead).
      this.fwd.copy(this.vel);
      if (slot.mode === 'ship') {
        const ship = this.ships[slot.group]!;
        const along = this.fwd.x * ship.fx + this.fwd.z * ship.fz;
        const m = smoothstep(0.4, 2, Math.hypot(ship.vx, ship.vz));
        const need = Math.max(0, 7 - along) * m;
        this.fwd.x += ship.fx * need;
        this.fwd.z += ship.fz * need;
      }
      if (this.fwd.lengthSq() < 1e-6) this.fwd.set(-st.rz, 0, st.rx);
      this.fwd.normalize();
      this.right.crossVectors(this.fwd, THREE.Object3D.DEFAULT_UP);
      if (this.right.lengthSq() < 1e-4) this.right.set(st.rx, 0, st.rz);
      this.right.normalize();
      st.rx = this.right.x;
      st.rz = this.right.z;
      this.up.crossVectors(this.right, this.fwd);
      const bankTarget = slot.mode === 'dive' && fold > 0.5 ? 0 : bankAngle(this.vel, this.acc);
      st.bank += (bankTarget - st.bank) * (1 - Math.exp(-dt / 0.4));
      const cb = Math.cos(st.bank);
      const sb = Math.sin(st.bank);
      // Roll about the forward axis: right wing down for a right turn.
      this.tmp.copy(this.up).multiplyScalar(cb).addScaledVector(this.right, sb);
      this.right.multiplyScalar(cb).addScaledVector(this.up, -sb);
      this.up.copy(this.tmp);

      // Size: fade in/out with presence; a little larger far away so they still read as birds.
      const dist = this.p0.distanceTo(frame.camera.position);
      const s =
        slot.scale * smoothstep(0, 0.35, st.presence) * (1 + 1.3 * smoothstep(60, 420, dist));
      this.mBody.makeBasis(this.fwd, this.up, this.right).scale(this.tmp.setScalar(s));
      this.mBody.setPosition(this.p0);
      this.body.setMatrixAt(slot.index, this.mBody);

      wingPose(slot.role, t, slot.r1, this.vel.y, fold, this.pose);
      this.setWing(slot.index, 1, this.innerR, this.outerR);
      this.setWing(slot.index, -1, this.innerL, this.outerL);
    }
    this.primed = true;
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
    this.updateSplashes(dt);
  }

  private setWing(
    index: number,
    side: number,
    inner: THREE.InstancedMesh,
    outer: THREE.InstancedMesh,
  ): void {
    // Raising the right (+z) wing is a negative rotation about +x; the left is mirrored.
    this.mWing
      .copy(this.mBody)
      .multiply(this.mTmp.makeTranslation(SHOULDER_X, SHOULDER_Y, side * SHOULDER_Z))
      .multiply(this.mTmp.makeRotationX(-side * this.pose.inner));
    inner.setMatrixAt(index, this.mWing);
    this.mOuter
      .copy(this.mWing)
      .multiply(this.mTmp.makeTranslation(0, 0, side * WRIST_Z))
      .multiply(this.mTmp.makeRotationX(-side * this.pose.outer));
    outer.setMatrixAt(index, this.mOuter);
  }

  private position(slot: BirdSlot, t: number, presence: number, out: THREE.Vector3): void {
    switch (slot.mode) {
      case 'flock':
        flockPosition(slot, t, this.ctx, out);
        break;
      case 'soar':
        soarPosition(slot, t, this.ctx, out);
        break;
      case 'dive':
        divePosition(slot, t, this.ctx, out, diveScratch);
        break;
      case 'ship':
        shipPosition(slot, t, this.ships[slot.group]!, out);
        break;
    }
    if (presence < 1) out.add(departureOffset(slot, presence, this.ctx, this.off));
  }

  private updateContext(frame: SceneryFrame): void {
    const ctx = this.ctx;
    const cam = frame.camera;
    cam.getWorldDirection(this.ray);
    // Where the camera is looking on the sea, kept within a sensible range.
    let ax: number;
    let az: number;
    const hz = Math.hypot(this.ray.x, this.ray.z) || 1;
    if (this.ray.y < -0.02) {
      const d = clamp(-cam.position.y / this.ray.y, 30, 450);
      ax = cam.position.x + this.ray.x * d;
      az = cam.position.z + this.ray.z * d;
    } else {
      ax = cam.position.x + (this.ray.x / hz) * 300;
      az = cam.position.z + (this.ray.z / hz) * 300;
    }
    if (!this.primed) {
      ctx.anchorX = ax;
      ctx.anchorZ = az;
    } else {
      const k = 1 - Math.exp(-frame.dt / 10);
      ctx.anchorX += (ax - ctx.anchorX) * k;
      ctx.anchorZ += (az - ctx.anchorZ) * k;
    }
    // Downwind (the wind blows FROM windDirectionDeg). Compass → three: east = +x, north = −z.
    const to = THREE.MathUtils.degToRad(frame.windDirectionDeg + 180);
    ctx.downwindX = Math.sin(to);
    ctx.downwindZ = -Math.cos(to);
    ctx.windSpeed = frame.windSpeed;
    ctx.hs = frame.hs;
  }

  private updateShips(frame: SceneryFrame, t: number): void {
    let n = 0;
    for (let i = 0; i < frame.vessels.length && n < SHIP_VESSELS; i++) {
      const v = frame.vessels[i]!;
      const pos = frame.vesselPositions[i];
      if (!pos || v.capsized) continue;
      const info = this.vesselInfo.get(v.id);
      const ship = this.ships[n]!;
      if (info) {
        this.tmp.set(1, 0, 0).applyQuaternion(info.group.quaternion);
        this.tmp.y = 0;
        if (this.tmp.lengthSq() > 1e-6) {
          this.tmp.normalize();
          ship.fx = this.tmp.x;
          ship.fz = this.tmp.z;
        }
        ship.length = info.length;
        ship.height = info.height;
      }
      const speed = Math.max(0, v.speedKn) * 0.5144;
      ship.x = pos.x;
      ship.z = pos.z;
      ship.vx = ship.fx * speed;
      ship.vz = ship.fz * speed;
      ship.t0 = t;
      n++;
    }
    this.shipCount = n;
  }

  private splash(x: number, z: number): void {
    let best = this.splashes[0]!;
    for (const s of this.splashes) if (s.age > best.age) best = s;
    best.age = 0;
    best.mesh.position.set(x, 0, z);
    best.mesh.visible = true;
  }

  private updateSplashes(dt: number): void {
    for (const s of this.splashes) {
      if (s.age >= SPLASH_LIFE) continue;
      s.age += dt;
      const u = s.age / SPLASH_LIFE;
      if (u >= 1) {
        s.mesh.visible = false;
        continue;
      }
      const r = 0.4 + 1.6 * Math.sqrt(u);
      s.mesh.scale.set(r, 1.8 * Math.sin(Math.PI * Math.min(1, u * 1.4)) + 0.05, r);
      s.mat.opacity = 0.85 * (1 - u);
    }
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.crown.dispose();
    this.material.dispose();
    for (const s of this.splashes) s.mat.dispose();
    for (const m of this.meshes) m.dispose();
    this.object.clear();
  }
}
