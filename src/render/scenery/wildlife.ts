/**
 * Dolphins, whales, turtles and leaping fish, seen in fair weather.
 *
 * The behaviour lives in `WildlifeSim`, plain numbers with no Three.js, so spawning, arcs and
 * departures can be unit-tested. `WildlifeLayer` turns the simulation into a handful of
 * instanced draw calls: one per species, one for spray particles and one for splash rings.
 *
 * Axes are Three.js (y up). A creature's local frame has its nose on +x, back on +y and left
 * side on +z; `yaw` turns it about +y, so it swims along (cos yaw, 0, −sin yaw).
 */
import * as THREE from 'three';
import { deriveSeed, Pcg32 } from '../../core/rng';
import type { SceneryFrame, SceneryLayer, SceneryVessel } from './types';

const G = 9.81;
const KN = 1852 / 3600;
const TAU = Math.PI * 2;

export type Species = 'dolphin' | 'whale' | 'turtle' | 'fish';
export const ALL_SPECIES: readonly Species[] = ['dolphin', 'whale', 'turtle', 'fish'];

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

function smoothstep(a: number, b: number, x: number): number {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function wrapAngle(a: number): number {
  return a - TAU * Math.floor((a + Math.PI) / TAU);
}

// ---------------------------------------------------------------------------------------------
// Weather and spawn rules
// ---------------------------------------------------------------------------------------------

/** Below this calm (0 = storm, 1 = flat calm) no wildlife appears and what is there leaves. */
export const CALM_THRESHOLD = 0.35;

/** 0 below `CALM_THRESHOLD`, rising smoothly to 1 in properly fair weather. */
export function fairWeather(calm: number): number {
  return smoothstep(CALM_THRESHOLD, 0.75, calm);
}

/**
 * How much of a species to show [0–1] for the weather and light. Dolphins stay around at
 * night; whales, fish and turtles become rare.
 */
export function speciesWeight(species: Species, calm: number, daylight: number): number {
  const fw = fairWeather(calm);
  const d = clamp(daylight, 0, 1);
  switch (species) {
    case 'dolphin':
      return fw * (0.55 + 0.45 * d);
    case 'whale':
      return fw * (0.08 + 0.92 * d * d);
    case 'turtle':
      return fw * (0.3 + 0.7 * d);
    case 'fish':
      return fw * (0.12 + 0.88 * d * d);
  }
}

/** Spawns per second at full weight. */
const SPAWN_RATE: Record<Species, number> = {
  dolphin: 1 / 18,
  whale: 1 / 40,
  turtle: 1 / 12,
  fish: 1 / 7,
};

/** Most groups (pods, schools) or solitary animals of a species alive at once for a weight. */
export function maxActive(species: Species, weight: number): number {
  if (weight <= 0) return 0;
  switch (species) {
    case 'dolphin':
      return 1 + Math.round(2 * weight);
    case 'whale':
      return 1;
    case 'turtle':
      return 1 + Math.round(3 * weight);
    case 'fish':
      return 1 + Math.round(2 * weight);
  }
}

/**
 * Where the camera is looking on the sea: the view ray's hit on y = 0, kept 5–600 m from the
 * camera horizontally. A ray at or above the horizon looks 300 m ahead.
 */
export function focusOnSea(
  camX: number,
  camY: number,
  camZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  out: { x: number; z: number },
): { x: number; z: number } {
  let hx = dirX;
  let hz = dirZ;
  const hl = Math.hypot(hx, hz);
  if (hl < 1e-6) {
    hx = 1;
    hz = 0;
  } else {
    hx /= hl;
    hz /= hl;
  }
  let d = 300;
  if (dirY < -0.01 && camY > 0) d = (camY / -dirY) * hl;
  d = clamp(d, 5, 600);
  out.x = camX + hx * d;
  out.z = camZ + hz * d;
  return out;
}

/** A uniform random source in [0, 1). */
export type Rand = () => number;

/**
 * Pick a point `rMin`–`rMax` from (fx, fz) that is also `camMin`–`camMax` from the camera.
 * Returns false (and leaves `out` alone) when no try fits.
 */
export function spawnPoint(
  rand: Rand,
  fx: number,
  fz: number,
  camX: number,
  camZ: number,
  rMin: number,
  rMax: number,
  camMin: number,
  camMax: number,
  out: { x: number; z: number },
): boolean {
  for (let i = 0; i < 10; i++) {
    const a = rand() * TAU;
    // Area-uniform in the annulus.
    const r = Math.sqrt(lerp(rMin * rMin, rMax * rMax, rand()));
    const x = fx + Math.cos(a) * r;
    const z = fz + Math.sin(a) * r;
    const dc = Math.hypot(x - camX, z - camZ);
    if (dc >= camMin && dc <= camMax) {
      out.x = x;
      out.z = z;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Motion profiles
// ---------------------------------------------------------------------------------------------

export interface ArcSample {
  /** Height of the body centre above still water [m]. */
  y: number;
  /** dy/du [m per cycle]. */
  dydu: number;
}

/**
 * Vertical path of one porpoising cycle, u ∈ [0, 1) (wrapped). The animal leaves the water at
 * u = 0, flies an arc of apex `height` and re-enters at u = `airFrac`, then dips to −`depth` and
 * comes back up for the next cycle. `shape` 0 is a ballistic parabola; 1 is the flat-topped glide
 * of a flying fish. The body centre is above water only for 0 < u < airFrac.
 */
export function leapProfile(
  u: number,
  airFrac: number,
  height: number,
  depth: number,
  shape: number,
  out: ArcSample,
): ArcSample {
  const f = clamp(airFrac, 0.02, 0.95);
  const w = u - Math.floor(u);
  if (w < f) {
    const s = w / f;
    const q = 4 * s * (1 - s);
    const p = 1 - 0.75 * clamp(shape, 0, 1);
    out.y = height * Math.pow(q, p);
    out.dydu = (height * p * Math.pow(Math.max(q, 0.03), p - 1) * 4 * (1 - 2 * s)) / f;
  } else {
    const s = (w - f) / (1 - f);
    out.y = -depth * Math.sin(Math.PI * s);
    out.dydu = (-depth * Math.PI * Math.cos(Math.PI * s)) / (1 - f);
  }
  return out;
}

/** Air time of a ballistic leap of apex height h [s]. */
export function airTime(h: number): number {
  return Math.sqrt((8 * Math.max(h, 0)) / G);
}

export interface WhaleSample {
  /** Body centre height [m]. */
  y: number;
  /** Nose-up pitch [rad]. */
  pitch: number;
  /** Body curvature [1/m]: y += bend·x² in the body frame; negative arches the back. */
  bend: number;
}

/** Whale body half-length to the fluke tips [m], and the blowhole in the body frame. */
export const WHALE_TAIL_X = -7.4;
export const WHALE_BLOWHOLE = { x: 4.4, y: 1.45 } as const;
/** Seconds one surfacing (rise, blow, roll, arch, fluke-up dive) takes. */
export const WHALE_SURFACING_S = 17;
/** Fraction of the surfacing at which the blowhole clears the water and the whale blows. */
export const WHALE_BLOW_U = 0.17;

// u, y, pitch, bend
const WHALE_KEYS: readonly (readonly [number, number, number, number])[] = [
  [0, -8, 0.3, 0],
  [0.18, -0.95, 0.06, 0],
  [0.3, -0.85, 0, 0],
  [0.5, -0.9, -0.02, 0],
  [0.62, -1.2, -0.25, -0.012],
  [0.74, -2.4, -0.7, -0.008],
  [0.84, -4.6, -1.15, 0],
  [0.92, -6.2, -1.3, 0.004],
  [1, -12.5, -1.35, 0],
];

/**
 * One whale surfacing, u ∈ [0, 1]: it rises, blows at `WHALE_BLOW_U`, rolls along the surface,
 * arches its back and dives with the fluke raised clear of the water (u ≈ 0.7–0.93).
 */
export function whaleProfile(u: number, out: WhaleSample): WhaleSample {
  const w = clamp(u, 0, 1);
  const n = WHALE_KEYS.length;
  let i = 0;
  while (i < n - 2 && w > WHALE_KEYS[i + 1]![0]) i++;
  const k0 = WHALE_KEYS[Math.max(0, i - 1)]!;
  const k1 = WHALE_KEYS[i]!;
  const k2 = WHALE_KEYS[i + 1]!;
  const k3 = WHALE_KEYS[Math.min(n - 1, i + 2)]!;
  const h = k2[0] - k1[0];
  const t = (w - k1[0]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const herm = (j: 1 | 2 | 3): number => {
    const m1 = ((k2[j] - k0[j]) / Math.max(1e-6, k2[0] - k0[0])) * h;
    const m2 = ((k3[j] - k1[j]) / Math.max(1e-6, k3[0] - k1[0])) * h;
    return h00 * k1[j] + h10 * m1 + h01 * k2[j] + h11 * m2;
  };
  out.y = herm(1);
  out.pitch = herm(2);
  out.bend = herm(3);
  return out;
}

/** Height of a body-frame point (x, y) for a body at height cy, pitch and bend. */
export function bodyPointY(cy: number, pitch: number, bend: number, x: number, y: number): number {
  const yb = y + bend * x * x;
  return cy + x * Math.sin(pitch) + yb * Math.cos(pitch);
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------

/** Body half-length and half-height [m] at size 1, for the visibility test. */
export const BODY: Record<Species, { halfLen: number; halfH: number }> = {
  dolphin: { halfLen: 1.3, halfH: 0.5 },
  whale: { halfLen: 7.6, halfH: 1.9 },
  turtle: { halfLen: 0.75, halfH: 0.25 },
  fish: { halfLen: 0.25, halfH: 0.1 },
};

export interface Animal {
  alive: boolean;
  species: Species;
  /** Index of the pod or school it belongs to, or −1. */
  group: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  /** Body curvature [1/m]. */
  bend: number;
  /** Vertical tail stroke [m] (cetaceans). */
  stroke: number;
  /** Lateral tail beat [m] (fish). */
  lateral: number;
  /** Flipper phase [rad] (turtles). */
  flip: number;
  size: number;
  /** Colour shade, about 1. */
  shade: number;
  // Motion state.
  heading: number;
  speed: number;
  turn: number;
  offAlong: number;
  offSide: number;
  phase: number;
  cycle: number;
  airFrac: number;
  height: number;
  depth: number;
  shape: number;
  /** Leaps (fish) or surfacings (whales) still to come. */
  remaining: number;
  /** Seconds a whale spends below before its next surfacing. */
  under: number;
  age: number;
  life: number;
  leaving: boolean;
  /** Leaves once fair weather falls below this. */
  hardiness: number;
  /** Seconds since it started its final dive (turtles). */
  diveT: number;
  spoutT: number;
  prevY: number;
  prevTail: number;
  seed: number;
}

export interface Group {
  alive: boolean;
  kind: 'pod' | 'school';
  x: number;
  z: number;
  heading: number;
  speed: number;
  turn: number;
  /** Vessel id being bow-ridden, or null. */
  vesselId: string | null;
  age: number;
  life: number;
  leaving: boolean;
  flying: boolean;
}

export interface Particle {
  alive: boolean;
  /** 0 droplet (ballistic), 1 mist (spout: rises, slows, swells). */
  kind: 0 | 1;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  age: number;
  life: number;
}

export interface Ring {
  alive: boolean;
  x: number;
  z: number;
  maxR: number;
  strength: number;
  age: number;
  life: number;
}

export interface WildVessel {
  id: string;
  x: number;
  z: number;
  /** Horizontal unit vector toward the bow. */
  bowX: number;
  bowZ: number;
  /** Speed through the water [m/s]. */
  speed: number;
  length: number;
}

export interface WildlifeInput {
  dt: number;
  calm: number;
  daylight: number;
  /** Significant wave height [m]; lifts surface swimmers a little so the waves do not bury them. */
  hs: number;
  windSpeed: number;
  windDirectionDeg: number;
  camX: number;
  camY: number;
  camZ: number;
  focusX: number;
  focusZ: number;
  vessels: readonly WildVessel[];
}

const CAPACITY: Record<Species, number> = { dolphin: 26, whale: 2, turtle: 6, fish: 36 };
const MAX_GROUPS = 12;
export const MAX_PARTICLES = 640;
export const MAX_RINGS = 64;
/** Animals beyond this horizontal distance from the camera are dropped at once (lost in haze). */
export const DESPAWN_RANGE = 1000;
/** Seconds of continuous fair weather before the first spawn. */
export const SPAWN_SETTLE_S = 4;

function newAnimal(): Animal {
  return {
    alive: false,
    species: 'dolphin',
    group: -1,
    x: 0,
    y: -10,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    bend: 0,
    stroke: 0,
    lateral: 0,
    flip: 0,
    size: 1,
    shade: 1,
    heading: 0,
    speed: 0,
    turn: 0,
    offAlong: 0,
    offSide: 0,
    phase: 0,
    cycle: 1,
    airFrac: 0.3,
    height: 0,
    depth: 1,
    shape: 0,
    remaining: 0,
    under: 0,
    age: 0,
    life: 0,
    leaving: false,
    hardiness: 0,
    diveT: 0,
    spoutT: 0,
    prevY: -10,
    prevTail: -10,
    seed: 0,
  };
}

/** Highest point of an animal's body [m], to tell whether any of it shows above the water. */
export function animalTop(a: Animal): number {
  const b = BODY[a.species];
  const L = b.halfLen * a.size;
  return a.y + L * Math.abs(Math.sin(a.pitch)) + b.halfH * a.size + Math.abs(a.bend) * L * L;
}

/** Below this the whole animal is hidden by a calm sea, so it may vanish without a pop. */
export const HIDDEN_TOP = -0.25;

const arc: ArcSample = { y: 0, dydu: 0 };
const whaleS: WhaleSample = { y: 0, pitch: 0, bend: 0 };
const pt = { x: 0, z: 0 };

export class WildlifeSim {
  readonly animals: Animal[] = [];
  readonly groups: Group[] = [];
  readonly particles: Particle[] = [];
  readonly rings: Ring[] = [];
  /** Time simulated so far [s]. */
  time = 0;

  private readonly rng: Pcg32;
  private noise: number;
  private readonly clock: Record<Species, number> = { dolphin: 0, whale: 0, turtle: 0, fish: 0 };
  private readonly next: Record<Species, number> = { dolphin: 0, whale: 0, turtle: 0, fish: 0 };
  private readonly active: Record<Species, number> = { dolphin: 0, whale: 0, turtle: 0, fish: 0 };
  private readonly rand: Rand = () => this.rng.nextFloat();
  private particleCursor = 0;
  private ringCursor = 0;
  private surfaceY = 0.05;
  private windX = 0;
  private windZ = 0;
  private fairFor = 0;

  constructor(seed: number) {
    this.rng = new Pcg32(seed >>> 0, 0x5eaf00d);
    this.noise = deriveSeed(seed, 77) || 1;
    for (const s of ALL_SPECIES) {
      for (let i = 0; i < CAPACITY[s]; i++) {
        const a = newAnimal();
        a.species = s;
        this.animals.push(a);
      }
      this.next[s] = this.expo() * 0.35;
    }
    for (let i = 0; i < MAX_GROUPS; i++) {
      this.groups.push({
        alive: false,
        kind: 'pod',
        x: 0,
        z: 0,
        heading: 0,
        speed: 0,
        turn: 0,
        vesselId: null,
        age: 0,
        life: 0,
        leaving: false,
        flying: false,
      });
    }
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        alive: false,
        kind: 0,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        size: 0,
        age: 0,
        life: 1,
      });
    }
    for (let i = 0; i < MAX_RINGS; i++) {
      this.rings.push({ alive: false, x: 0, z: 0, maxR: 1, strength: 0, age: 0, life: 1 });
    }
  }

  /** Animals currently alive (any state). */
  count(species?: Species): number {
    let n = 0;
    for (const a of this.animals) if (a.alive && (!species || a.species === species)) n++;
    return n;
  }

  step(inp: WildlifeInput): void {
    const dt = Math.min(Math.max(inp.dt, 0), 0.1);
    if (dt <= 0) return;
    this.time += dt;
    this.surfaceY = 0.05 + 0.22 * clamp(inp.hs, 0, 1.5);
    const wb = THREE.MathUtils.degToRad(inp.windDirectionDeg);
    // Wind blows FROM the bearing; downwind in Three.js axes is (−sin b, cos b) on (x, z).
    this.windX = -Math.sin(wb) * inp.windSpeed;
    this.windZ = Math.cos(wb) * inp.windSpeed;

    const fw = fairWeather(inp.calm);
    this.countActive();
    // Fair weather must hold for a few seconds before anything shows up (the sea state is not
    // known on the very first frames, and a passing lull should not bring out a crowd).
    this.fairFor = fw > 0 ? this.fairFor + dt : 0;
    for (const s of ALL_SPECIES) {
      const w = speciesWeight(s, inp.calm, inp.daylight);
      if (w <= 0 || this.fairFor < SPAWN_SETTLE_S || this.active[s] >= maxActive(s, w)) continue;
      this.clock[s] += dt * SPAWN_RATE[s] * w * (this.active[s] === 0 ? 3 : 1);
      if (this.clock[s] >= this.next[s]) {
        this.clock[s] = 0;
        this.next[s] = this.expo();
        this.spawn(s, inp);
      }
    }

    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi]!;
      if (!g.alive) continue;
      this.updateGroup(g, inp, dt, fw);
    }
    for (const a of this.animals) {
      if (!a.alive) continue;
      if (!a.leaving && fw < a.hardiness) a.leaving = true;
      a.age += dt;
      if (a.age > a.life) a.leaving = true;
      switch (a.species) {
        case 'dolphin':
          this.updateDolphin(a, dt);
          break;
        case 'whale':
          this.updateWhale(a, dt);
          break;
        case 'turtle':
          this.updateTurtle(a, dt);
          break;
        case 'fish':
          this.updateFish(a, dt);
          break;
      }
      if (a.alive && Math.hypot(a.x - inp.camX, a.z - inp.camZ) > DESPAWN_RANGE) a.alive = false;
    }
    // Groups end when their last member has gone.
    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi]!;
      if (!g.alive) continue;
      let any = false;
      for (const a of this.animals) if (a.alive && a.group === gi) any = true;
      if (!any) g.alive = false;
    }
    this.updateParticles(dt);
  }

  // ---- spawning ------------------------------------------------------------------------------

  private countActive(): void {
    this.active.dolphin = 0;
    this.active.fish = 0;
    this.active.whale = 0;
    this.active.turtle = 0;
    for (const g of this.groups) {
      if (!g.alive || g.leaving) continue;
      if (g.kind === 'pod') this.active.dolphin++;
      else this.active.fish++;
    }
    for (const a of this.animals) {
      if (!a.alive || a.leaving) continue;
      if (a.species === 'whale' || a.species === 'turtle') this.active[a.species]++;
    }
  }

  private expo(): number {
    return -Math.log(this.rng.nextFloatOpenZero());
  }

  private range(a: number, b: number): number {
    return a + (b - a) * this.rng.nextFloat();
  }

  /** Cheap deterministic noise for spray (xorshift32). */
  private n01(): number {
    let x = this.noise;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.noise = x >>> 0;
    return this.noise / 4294967296;
  }

  private freeAnimal(s: Species): Animal | null {
    for (const a of this.animals) if (!a.alive && a.species === s) return a;
    return null;
  }

  private freeCount(s: Species): number {
    let n = 0;
    for (const a of this.animals) if (!a.alive && a.species === s) n++;
    return n;
  }

  private freeGroup(): number {
    for (let i = 0; i < this.groups.length; i++) if (!this.groups[i]!.alive) return i;
    return -1;
  }

  private initAnimal(a: Animal, group: number): void {
    a.alive = true;
    a.group = group;
    a.y = -5;
    a.pitch = 0;
    a.roll = 0;
    a.bend = 0;
    a.stroke = 0;
    a.lateral = 0;
    a.flip = 0;
    a.size = 1;
    a.shade = this.range(0.88, 1.1);
    a.turn = 0;
    a.offAlong = 0;
    a.offSide = 0;
    a.phase = 0;
    a.remaining = 0;
    a.under = 0;
    a.age = 0;
    a.leaving = false;
    a.hardiness = this.range(0.05, 0.5);
    a.diveT = 0;
    a.spoutT = 0;
    a.prevY = -5;
    a.prevTail = -5;
    a.seed = this.rng.nextFloat() * 1000;
    a.life = 1e9;
  }

  private spawn(s: Species, inp: WildlifeInput): void {
    switch (s) {
      case 'dolphin':
        this.spawnPod(inp);
        break;
      case 'whale':
        this.spawnWhale(inp);
        break;
      case 'turtle':
        this.spawnTurtle(inp);
        break;
      case 'fish':
        this.spawnSchool(inp);
        break;
    }
  }

  private spawnPod(inp: WildlifeInput): void {
    const gi = this.freeGroup();
    if (gi < 0) return;
    const n = 3 + Math.floor(this.rng.nextFloat() * 4);
    if (this.freeCount('dolphin') < n) return;
    const g = this.groups[gi]!;
    // Bow-ride a moving vessel near the focus that nobody is riding yet.
    let ride: WildVessel | null = null;
    if (this.rng.nextFloat() < 0.6) {
      let best = 700;
      for (const v of inp.vessels) {
        if (v.speed < 3 * KN || v.speed > 22 * KN) continue;
        let taken = false;
        for (const o of this.groups) if (o.alive && o.vesselId === v.id) taken = true;
        if (taken) continue;
        const d = Math.hypot(v.x - inp.camX, v.z - inp.camZ);
        if (d < best) {
          best = d;
          ride = v;
        }
      }
    }
    if (ride) {
      // Join from off the beam, a little astern, and catch up.
      const side = this.rng.nextFloat() < 0.5 ? 1 : -1;
      const off = this.range(35, 70);
      g.x = ride.x - ride.bowZ * side * off - ride.bowX * 20;
      g.z = ride.z + ride.bowX * side * off - ride.bowZ * 20;
      g.heading = Math.atan2(-ride.bowZ, ride.bowX);
      g.speed = ride.speed;
      g.vesselId = ride.id;
      g.life = this.range(45, 110);
    } else {
      if (!spawnPoint(this.rand, inp.focusX, inp.focusZ, inp.camX, inp.camZ, 25, 260, 45, 600, pt))
        return;
      g.x = pt.x;
      g.z = pt.z;
      g.heading = this.rng.nextFloat() * TAU;
      g.speed = this.range(5, 7);
      g.vesselId = null;
      g.life = this.range(70, 160);
    }
    g.alive = true;
    g.kind = 'pod';
    g.turn = 0;
    g.age = 0;
    g.leaving = false;
    g.flying = false;
    const calf = n >= 4 && this.rng.nextFloat() < 0.5;
    for (let i = 0; i < n; i++) {
      const a = this.freeAnimal('dolphin')!;
      this.initAnimal(a, gi);
      const isCalf = calf && i === n - 1;
      a.size = isCalf ? 0.6 : this.range(0.9, 1.1);
      if (isCalf) {
        // Tucked in beside its mother (member 0), leaping with her.
        a.offAlong = -0.6;
        a.offSide = 1.6;
      } else {
        const rank = i >> 1;
        a.offAlong = -rank * this.range(2.5, 4) + this.range(-0.6, 0.6);
        a.offSide = (i & 1 ? 1 : -1) * (i === 0 ? 0 : this.range(1.4, 2.6) + rank * 0.8);
      }
      if (ride) a.offSide += a.offSide >= 0 ? 2.5 : -2.5;
      a.x = g.x;
      a.z = g.z;
      a.heading = g.heading;
      a.speed = g.speed;
      this.newDolphinCycle(a);
      // Start deep in the dip (out of sight). Pairs leap together; pairs are staggered.
      const dip = 1 - a.airFrac;
      const lag = Math.min(0.45, (i >> 1) * 0.15 + this.range(0, 0.08));
      a.phase = a.cycle * (a.airFrac + dip * (0.5 + lag));
      a.prevY = -1;
    }
    if (calf) {
      const mother = this.animals.find((x) => x.alive && x.group === gi && x.size > 0.7);
      const baby = this.animals.find((x) => x.alive && x.group === gi && x.size < 0.7);
      if (mother && baby) {
        baby.phase = mother.phase;
        baby.cycle = mother.cycle;
        baby.airFrac = mother.airFrac;
        baby.height = mother.height * 0.8;
        baby.depth = mother.depth;
        baby.offAlong = mother.offAlong - 0.6;
        baby.offSide = mother.offSide + (mother.offSide >= 0 ? 1.5 : -1.5);
      }
    }
  }

  private newDolphinCycle(a: Animal): void {
    const r = this.rng.nextFloat();
    let air: number;
    if (r < 0.32) {
      // A breath: back and dorsal fin roll through the surface.
      a.height = this.range(0.05, 0.18);
      air = this.range(0.8, 1.1);
    } else if (r < 0.88) {
      a.height = this.range(0.7, 1.5);
      air = airTime(a.height);
    } else {
      a.height = this.range(1.8, 2.6);
      air = airTime(a.height);
    }
    a.height *= Math.sqrt(a.size);
    const under = this.range(1.4, 3.2);
    a.cycle = air + under;
    a.airFrac = air / a.cycle;
    a.depth = this.range(1.5, 2);
  }

  private spawnWhale(inp: WildlifeInput): void {
    const a = this.freeAnimal('whale');
    if (!a) return;
    if (!spawnPoint(this.rand, inp.focusX, inp.focusZ, inp.camX, inp.camZ, 150, 450, 220, 600, pt))
      return;
    this.initAnimal(a, -1);
    a.x = pt.x;
    a.z = pt.z;
    a.y = -10;
    a.heading = this.rng.nextFloat() * TAU;
    a.yaw = a.heading;
    a.speed = this.range(1.2, 2);
    a.size = this.range(0.9, 1.08);
    a.remaining = 2 + Math.floor(this.rng.nextFloat() * 2);
    a.under = this.range(2, 6);
    a.cycle = a.under + WHALE_SURFACING_S;
    a.phase = 0;
    a.hardiness = this.range(0.15, 0.6);
  }

  private spawnTurtle(inp: WildlifeInput): void {
    const a = this.freeAnimal('turtle');
    if (!a) return;
    if (!spawnPoint(this.rand, inp.focusX, inp.focusZ, inp.camX, inp.camZ, 8, 70, 15, 250, pt))
      return;
    this.initAnimal(a, -1);
    a.x = pt.x;
    a.z = pt.z;
    a.y = -2;
    a.heading = this.rng.nextFloat() * TAU;
    a.yaw = a.heading;
    a.speed = this.range(0.25, 0.45);
    a.size = this.range(0.8, 1.15);
    a.life = this.range(45, 120);
    a.phase = this.rng.nextFloat() * 10;
  }

  private spawnSchool(inp: WildlifeInput): void {
    const gi = this.freeGroup();
    if (gi < 0) return;
    const flying = this.rng.nextFloat() < 0.6;
    const n = flying
      ? 3 + Math.floor(this.rng.nextFloat() * 5)
      : 2 + Math.floor(this.rng.nextFloat() * 4);
    if (this.freeCount('fish') < n) return;
    if (!spawnPoint(this.rand, inp.focusX, inp.focusZ, inp.camX, inp.camZ, 10, 200, 25, 450, pt))
      return;
    const g = this.groups[gi]!;
    g.alive = true;
    g.kind = 'school';
    g.flying = flying;
    g.x = pt.x;
    g.z = pt.z;
    g.heading = this.rng.nextFloat() * TAU;
    g.speed = flying ? this.range(10, 15) : this.range(2.5, 4);
    g.turn = 0;
    g.vesselId = null;
    g.age = 0;
    g.life = 1e9;
    g.leaving = false;
    for (let i = 0; i < n; i++) {
      const a = this.freeAnimal('fish')!;
      this.initAnimal(a, gi);
      a.size = flying ? this.range(0.85, 1.1) : this.range(0.9, 1.4);
      a.offAlong = this.range(-4, 4);
      a.offSide = this.range(-3, 3);
      a.remaining = flying
        ? 1 + Math.floor(this.rng.nextFloat() * 2)
        : 2 + Math.floor(this.rng.nextFloat() * 3);
      a.x = g.x;
      a.z = g.z;
      a.heading = g.heading;
      a.speed = g.speed;
      a.y = -1;
      a.prevY = -1;
      this.newFishCycle(a, flying);
      // Wait out of sight for a moment, then the first exit.
      a.phase = -this.range(0.2, 3.5);
    }
  }

  private newFishCycle(a: Animal, flying: boolean): void {
    let air: number;
    if (flying) {
      a.height = this.range(0.6, 1.3);
      air = this.range(1.4, 3);
      a.shape = 1;
    } else {
      a.height = this.range(0.25, 0.7) * a.size;
      air = airTime(a.height);
      a.shape = 0;
    }
    const under = this.range(0.7, 2);
    a.cycle = air + under;
    a.airFrac = air / a.cycle;
    a.depth = 0.9;
  }

  // ---- behaviour -----------------------------------------------------------------------------

  private updateGroup(g: Group, inp: WildlifeInput, dt: number, fw: number): void {
    g.age += dt;
    if (!g.leaving && (g.age > g.life || fw <= 0)) g.leaving = true;
    let ride: WildVessel | null = null;
    if (g.vesselId) {
      for (const v of inp.vessels) if (v.id === g.vesselId) ride = v;
      if (!ride || ride.speed < 1.5 * KN) g.vesselId = null;
    }
    if (ride && g.vesselId) {
      // Station on the bow wave, matching the ship.
      const ahead = ride.length * 0.5 + 3;
      const tx = ride.x + ride.bowX * ahead;
      const tz = ride.z + ride.bowZ * ahead;
      const dx = tx - g.x;
      const dz = tz - g.z;
      const d = Math.hypot(dx, dz);
      const vh = Math.atan2(-ride.bowZ, ride.bowX);
      if (d > 1.5) {
        const v = Math.min(ride.speed + 3.5, d / dt);
        g.x += (dx / d) * v * dt;
        g.z += (dz / d) * v * dt;
        const chase = Math.atan2(-dz, dx);
        g.heading += wrapAngle((d > 12 ? chase : vh) - g.heading) * Math.min(1, dt * 2);
        g.speed = v;
      } else {
        g.x = tx;
        g.z = tz;
        g.heading += wrapAngle(vh - g.heading) * Math.min(1, dt * 3);
        g.speed = ride.speed;
      }
      if (g.leaving) g.vesselId = null;
      return;
    }
    // Free swimming: a slow wander that keeps drifting back toward where the camera looks.
    if (Math.floor(g.age / 7) !== Math.floor((g.age - dt) / 7)) {
      g.turn = (this.rng.nextFloat() - 0.5) * (g.kind === 'pod' ? 0.12 : 0.05);
    }
    const dfx = inp.focusX - g.x;
    const dfz = inp.focusZ - g.z;
    let steer = g.turn;
    if (g.kind === 'pod' && !g.leaving && Math.hypot(dfx, dfz) > 320) {
      steer += clamp(wrapAngle(Math.atan2(-dfz, dfx) - g.heading), -0.15, 0.15);
    }
    g.heading = wrapAngle(g.heading + steer * dt);
    g.x += Math.cos(g.heading) * g.speed * dt;
    g.z -= Math.sin(g.heading) * g.speed * dt;
  }

  private followGroup(a: Animal, dt: number): void {
    const g = this.groups[a.group];
    if (!g) return;
    const c = Math.cos(g.heading);
    const s = Math.sin(g.heading);
    const wob = Math.sin(this.time * 0.37 + a.seed) * 0.6;
    const along = a.offAlong;
    const side = a.offSide + wob;
    // Forward (c, −s); left (−s, −c) in (x, z).
    const tx = g.x + c * along - s * side;
    const tz = g.z - s * along - c * side;
    const k = Math.min(1, dt * 2.5);
    a.x += (tx - a.x) * k;
    a.z += (tz - a.z) * k;
    a.heading = g.heading;
    a.speed = g.speed;
    if (g.leaving) a.leaving = true;
  }

  private setPitchFromArc(a: Animal, dydt: number, dt: number, tau: number): void {
    const target = Math.atan2(dydt, Math.max(a.speed, 0.5));
    const prev = a.pitch;
    a.pitch += (target - a.pitch) * (1 - Math.exp(-dt / tau));
    const rate = (a.pitch - prev) / Math.max(dt, 1e-3);
    // The body curls along the arc: tail and nose droop over the top.
    const bendTarget = clamp(rate * 0.05, -0.1, 0.1) / Math.max(a.size, 0.3);
    a.bend += (bendTarget - a.bend) * Math.min(1, dt * 8);
  }

  private updateDolphin(a: Animal, dt: number): void {
    this.followGroup(a, dt);
    a.phase += dt;
    while (a.phase >= a.cycle) {
      a.phase -= a.cycle;
      this.newDolphinCycle(a);
    }
    const u = a.phase / a.cycle;
    leapProfile(u, a.airFrac, a.height, a.depth, 0, arc);
    a.y = arc.y;
    this.setPitchFromArc(a, arc.dydu / a.cycle, dt, 0.08);
    a.yaw = a.heading;
    a.roll = Math.sin(this.time * 0.6 + a.seed) * 0.12;
    const inAir = u < a.airFrac;
    a.stroke = (inAir ? 0.015 : 0.07) * a.size * Math.sin(this.time * 2.4 * TAU + a.seed);
    this.splashCrossing(a, Math.min(1, 0.35 + a.height * 0.45) * a.size);
    a.prevY = a.y;
    // Leave mid-dip, out of sight.
    const dipS = (u - a.airFrac) / (1 - a.airFrac);
    if (a.leaving && !inAir && dipS > 0.4 && dipS < 0.65) a.alive = false;
  }

  private updateFish(a: Animal, dt: number): void {
    this.followGroup(a, dt);
    const g = this.groups[a.group];
    const flying = g?.flying ?? false;
    a.phase += dt;
    a.yaw = a.heading;
    if (a.phase < 0) {
      a.y = -1;
      a.pitch = 0;
      a.prevY = a.y;
      return;
    }
    while (a.phase >= a.cycle) {
      a.phase -= a.cycle;
      a.remaining--;
      this.newFishCycle(a, flying);
    }
    const u = a.phase / a.cycle;
    const inAir = u < a.airFrac;
    leapProfile(u, a.airFrac, a.height, a.depth, a.shape, arc);
    a.y = arc.y;
    // Flying fish glide a touch faster than they swim.
    this.setPitchFromArc(a, arc.dydu / a.cycle, dt, flying ? 0.12 : 0.06);
    a.pitch = clamp(a.pitch, -0.9, 0.9);
    a.lateral = (inAir && flying ? 0.004 : 0.03) * a.size * Math.sin(this.time * 9 * TAU + a.seed);
    a.roll = flying && inAir ? Math.sin(this.time * 1.7 + a.seed) * 0.1 : 0;
    this.splashCrossing(a, flying ? 0.35 : 0.22);
    // Taxiing flying fish beat their tail along the surface just before take-off: a spray trail.
    if (flying && !inAir && u > 0.92 && this.n01() < 0.5) {
      this.emitDroplet(a.x, 0.05, a.z, 0, 0.6, 0, 0.05, 0.4);
    }
    a.prevY = a.y;
    const dipS = (u - a.airFrac) / (1 - a.airFrac);
    if ((a.remaining <= 0 || a.leaving) && !inAir && dipS > 0.4 && dipS < 0.65) a.alive = false;
  }

  private updateWhale(a: Animal, dt: number): void {
    a.heading = wrapAngle(a.heading + Math.sin(this.time * 0.05 + a.seed) * 0.01 * dt);
    a.x += Math.cos(a.heading) * a.speed * dt;
    a.z -= Math.sin(a.heading) * a.speed * dt;
    a.yaw = a.heading;
    a.phase += dt;
    if (a.phase < a.under) {
      a.y = -10;
      a.pitch = 0.3;
      a.bend = 0;
      a.prevY = a.y;
      a.prevTail = -10;
      if (a.leaving) a.alive = false;
      return;
    }
    const u = (a.phase - a.under) / WHALE_SURFACING_S;
    if (u >= 1) {
      a.remaining--;
      if (a.remaining <= 0 || a.leaving) {
        a.alive = false;
        return;
      }
      a.under = this.range(18, 40);
      a.phase = 0;
      a.y = -10;
      return;
    }
    whaleProfile(u, whaleS);
    a.y = whaleS.y;
    a.pitch = whaleS.pitch;
    a.bend = whaleS.bend / a.size;
    a.stroke = 0.15 * Math.sin(this.time * 0.6 * TAU + a.seed) * (u < 0.6 ? 1 : 0.3);
    a.roll = Math.sin(this.time * 0.3 + a.seed) * 0.05;

    const S = a.size;
    // Blow as the blowhole clears the water.
    const blowY = bodyPointY(a.y, a.pitch, a.bend, WHALE_BLOWHOLE.x * S, WHALE_BLOWHOLE.y * S);
    if (a.spoutT <= 0 && u >= WHALE_BLOW_U && u < WHALE_BLOW_U + 0.05 && blowY > 0) {
      a.spoutT = 1.3;
      this.splashAt(a, WHALE_BLOWHOLE.x * S, 0.9);
    }
    if (a.spoutT > 0) {
      a.spoutT -= dt;
      const n = Math.round(dt * 70);
      for (let i = 0; i < n; i++) this.emitSpout(a, S, Math.max(0, a.spoutT / 1.3));
    }
    // Fluke out of the water: water streams off it; a splash as it slides back in.
    const tailY = bodyPointY(a.y, a.pitch, a.bend, WHALE_TAIL_X * S, 0);
    if (tailY > 0.2 && this.n01() < dt * 30) this.emitFlukeDrip(a, S);
    if (a.prevTail > 0 && tailY <= 0) this.splashAt(a, WHALE_TAIL_X * S, 1);
    a.prevTail = tailY;
    const topY = a.y + 1.7 * S;
    if (a.prevY + 1.7 * S <= 0 && topY > 0) this.splashAt(a, 2 * S, 0.8);
    a.prevY = a.y;
  }

  private updateTurtle(a: Animal, dt: number): void {
    a.phase += dt;
    if (Math.floor(a.age / 9) !== Math.floor((a.age - dt) / 9)) {
      a.turn = (this.rng.nextFloat() - 0.5) * 0.3;
    }
    a.heading = wrapAngle(a.heading + a.turn * dt);
    a.yaw = a.heading;
    const stroke = a.phase * 1.6;
    // Paddle, glide, paddle: a little surge with each stroke.
    const surge = 0.6 + 0.4 * Math.max(0, Math.sin(stroke));
    a.x += Math.cos(a.heading) * a.speed * surge * dt;
    a.z -= Math.sin(a.heading) * a.speed * surge * dt;
    a.flip = stroke;
    const top = this.surfaceY;
    const bob = Math.sin(a.phase * 1.3 + a.seed) * 0.03;
    // Lift the head to breathe now and then.
    const breath =
      smoothstep(0.75, 0.9, (a.phase / 9 + a.seed) % 1) *
      (1 - smoothstep(0.92, 1, (a.phase / 9 + a.seed) % 1));
    if (a.leaving) {
      a.diveT += dt;
      const k = smoothstep(0, 5, a.diveT);
      a.y = top - 2.6 * k;
      a.pitch = -0.4 * Math.sin(Math.PI * Math.min(1, a.diveT / 5));
      if (a.diveT > 5) a.alive = false;
    } else {
      const k = smoothstep(0, 4, a.age);
      a.y = lerp(-2, top + bob, k);
      a.pitch = 0.25 * (1 - k) + 0.12 * breath;
      if (a.prevY < -0.15 && a.y >= -0.15) this.ring(a.x, a.z, 1.4, 0.4);
    }
    a.roll = Math.sin(a.phase * 0.8) * 0.05;
    a.prevY = a.y;
  }

  // ---- spray ---------------------------------------------------------------------------------

  private splashCrossing(a: Animal, strength: number): void {
    const leaving = a.prevY <= 0 && a.y > 0;
    const entering = a.prevY > 0 && a.y <= 0;
    if (!leaving && !entering) return;
    const s = a.height < 0.25 && a.species === 'dolphin' ? strength * 0.3 : strength;
    // Splash at the nose on exit and at the tail on entry, roughly.
    const off = (leaving ? 0.6 : -0.3) * BODY[a.species].halfLen * a.size;
    this.ring(a.x + Math.cos(a.yaw) * off, a.z - Math.sin(a.yaw) * off, 0.6 + 2.2 * s, s);
    const n = Math.round(3 + 12 * s);
    for (let i = 0; i < n; i++) {
      const ang = this.n01() * TAU;
      const sp = (0.5 + this.n01() * 1.6) * (0.5 + s);
      this.emitDroplet(
        a.x + Math.cos(a.yaw) * off,
        0.05,
        a.z - Math.sin(a.yaw) * off,
        Math.cos(ang) * sp + Math.cos(a.yaw) * a.speed * 0.15,
        (1.5 + this.n01() * 2.5) * Math.sqrt(s + 0.1),
        Math.sin(ang) * sp - Math.sin(a.yaw) * a.speed * 0.15,
        (0.04 + 0.06 * this.n01()) * (0.6 + s),
        0.6 + this.n01() * 0.7,
      );
    }
  }

  /** Splash where a body-frame point x along the whale meets the water. */
  private splashAt(a: Animal, bx: number, s: number): void {
    const x = a.x + Math.cos(a.yaw) * bx * Math.cos(a.pitch);
    const z = a.z - Math.sin(a.yaw) * bx * Math.cos(a.pitch);
    this.ring(x, z, 4 + 5 * s, s);
    const n = Math.round(10 + 20 * s);
    for (let i = 0; i < n; i++) {
      const ang = this.n01() * TAU;
      const sp = 1 + this.n01() * 3;
      this.emitDroplet(
        x + Math.cos(ang) * 1.2,
        0.1,
        z + Math.sin(ang) * 1.2,
        Math.cos(ang) * sp,
        2 + this.n01() * 4 * s,
        Math.sin(ang) * sp,
        0.1 + 0.12 * this.n01(),
        0.8 + this.n01() * 0.8,
      );
    }
  }

  private bodyToWorld(a: Animal, bx: number, by: number, bz: number, out: Particle): void {
    const yb = by + a.bend * bx * bx;
    const cp = Math.cos(a.pitch);
    const sp = Math.sin(a.pitch);
    const x1 = bx * cp - yb * sp;
    const y1 = bx * sp + yb * cp;
    const cy = Math.cos(a.yaw);
    const sy = Math.sin(a.yaw);
    out.x = a.x + x1 * cy + bz * sy;
    out.y = a.y + y1;
    out.z = a.z - x1 * sy + bz * cy;
  }

  private emitSpout(a: Animal, S: number, strength: number): void {
    const p = this.alloc();
    this.bodyToWorld(a, WHALE_BLOWHOLE.x * S, WHALE_BLOWHOLE.y * S, 0, p);
    p.y = Math.max(p.y, 0.2);
    p.kind = 1;
    const ang = this.n01() * TAU;
    const sp = this.n01() * 0.8;
    p.vx = Math.cos(ang) * sp;
    p.vz = Math.sin(ang) * sp;
    p.vy = (6 + this.n01() * 5) * (0.5 + 0.5 * strength);
    p.size = 0.25 + this.n01() * 0.3;
    p.age = 0;
    p.life = 1.8 + this.n01() * 1.4;
  }

  private emitFlukeDrip(a: Animal, S: number): void {
    const p = this.alloc();
    const side = (this.n01() * 2 - 1) * 2.2 * S;
    this.bodyToWorld(a, (WHALE_TAIL_X + 0.4) * S, 0, side, p);
    p.kind = 0;
    p.vx = (this.n01() - 0.5) * 0.4;
    p.vz = (this.n01() - 0.5) * 0.4;
    p.vy = -0.5 - this.n01();
    p.size = 0.05 + this.n01() * 0.06;
    p.age = 0;
    p.life = 2;
  }

  private emitDroplet(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    life: number,
  ): void {
    const p = this.alloc();
    p.kind = 0;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.size = size;
    p.age = 0;
    p.life = life;
  }

  /** Next particle slot; the oldest is overwritten when the pool is full. */
  private alloc(): Particle {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const j = (this.particleCursor + i) % MAX_PARTICLES;
      if (!this.particles[j]!.alive) {
        this.particleCursor = (j + 1) % MAX_PARTICLES;
        this.particles[j]!.alive = true;
        return this.particles[j]!;
      }
    }
    const p = this.particles[this.particleCursor]!;
    this.particleCursor = (this.particleCursor + 1) % MAX_PARTICLES;
    p.alive = true;
    return p;
  }

  private ring(x: number, z: number, maxR: number, strength: number): void {
    const r = this.rings[this.ringCursor]!;
    this.ringCursor = (this.ringCursor + 1) % MAX_RINGS;
    r.alive = true;
    r.x = x;
    r.z = z;
    r.maxR = maxR;
    r.strength = clamp(strength, 0.1, 1);
    r.age = 0;
    r.life = 1.2 + 1.3 * r.strength;
  }

  private updateParticles(dt: number): void {
    for (const p of this.particles) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.kind === 0) {
        p.vy -= G * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        if (p.y < -0.1 || p.age > p.life) p.alive = false;
      } else {
        // Mist: quick drag, drifts downwind, swells and fades.
        const drag = Math.exp(-dt * 1.6);
        p.vx = this.windX * 0.5 + (p.vx - this.windX * 0.5) * drag;
        p.vz = this.windZ * 0.5 + (p.vz - this.windZ * 0.5) * drag;
        p.vy = p.vy * drag - 0.6 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.size += dt * 0.9;
        if (p.age > p.life) p.alive = false;
      }
    }
    for (const r of this.rings) {
      if (!r.alive) continue;
      r.age += dt;
      if (r.age > r.life) r.alive = false;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Low-poly meshes
// ---------------------------------------------------------------------------------------------

interface Section {
  x: number;
  /** Half height and half width [m]. */
  ry: number;
  rz: number;
  /** Centre height [m]. */
  cy: number;
}

class MeshBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly flip: number[] = [];
  private readonly c = new THREE.Color();

  vert(x: number, y: number, z: number, color: number, flip = 0): void {
    this.c.setHex(color, THREE.SRGBColorSpace);
    this.pos.push(x, y, z);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.flip.push(flip);
  }

  tri(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    color: number,
    flips: readonly number[] = [0, 0, 0],
  ): void {
    this.vert(a[0]!, a[1]!, a[2]!, color, flips[0]);
    this.vert(b[0]!, b[1]!, b[2]!, color, flips[1]);
    this.vert(c[0]!, c[1]!, c[2]!, color, flips[2]);
  }

  /** Elliptic loft along x; upper facets take `top`, lower ones `belly`. */
  loft(sections: readonly Section[], segs: number, top: number, belly: number, alt?: number): void {
    for (let i = 0; i < sections.length - 1; i++) {
      const s0 = sections[i]!;
      const s1 = sections[i + 1]!;
      for (let k = 0; k < segs; k++) {
        const a0 = (k / segs) * TAU;
        const a1 = ((k + 1) / segs) * TAU;
        const mid = Math.cos((a0 + a1) / 2);
        let color = mid > -0.25 ? top : belly;
        if (alt !== undefined && mid > -0.25 && (i + k) % 2 === 1) color = alt;
        const p = (s: Section, a: number): number[] => [
          s.x,
          s.cy + s.ry * Math.cos(a),
          s.rz * Math.sin(a),
        ];
        this.tri(p(s0, a0), p(s1, a0), p(s1, a1), color);
        this.tri(p(s0, a0), p(s1, a1), p(s0, a1), color);
      }
    }
  }

  /** A flat fin/flipper (double-sided via the material), mirrored across z when `mirror`. */
  fin(
    points: readonly (readonly number[])[],
    color: number,
    mirror: boolean,
    flips?: number[],
  ): void {
    const doIt = (sgn: number): void => {
      const P = points.map((p) => [p[0]!, p[1]!, p[2]! * sgn]);
      const F = flips ? flips.map((f) => f * sgn) : points.map(() => 0);
      for (let i = 1; i < P.length - 1; i++) {
        this.tri(P[0]!, P[i]!, P[i + 1]!, color, [F[0]!, F[i]!, F[i + 1]!]);
      }
    };
    doIt(1);
    if (mirror) doIt(-1);
  }

  /** A tiny pyramid (eyes). */
  bead(x: number, y: number, z: number, r: number, color: number): void {
    const t = [x, y + r, z];
    const b = [x, y - r, z];
    const q = [
      [x + r, y, z],
      [x, y, z + r],
      [x - r, y, z],
      [x, y, z - r],
    ];
    for (let i = 0; i < 4; i++) {
      this.tri(t, q[i]!, q[(i + 1) % 4]!, color);
      this.tri(b, q[(i + 1) % 4]!, q[i]!, color);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aFlip', new THREE.Float32BufferAttribute(this.flip, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Bottlenose dolphin, 2.5 m. */
function dolphinGeometry(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  const top = 0x5d7184;
  const belly = 0xdde5ea;
  m.loft(
    [
      { x: 1.27, ry: 0.015, rz: 0.015, cy: -0.03 },
      { x: 1.12, ry: 0.055, rz: 0.06, cy: -0.035 },
      { x: 0.98, ry: 0.09, rz: 0.09, cy: -0.03 },
      { x: 0.86, ry: 0.19, rz: 0.16, cy: 0.03 },
      { x: 0.55, ry: 0.27, rz: 0.22, cy: 0.01 },
      { x: 0.1, ry: 0.29, rz: 0.23, cy: 0 },
      { x: -0.3, ry: 0.23, rz: 0.17, cy: 0 },
      { x: -0.65, ry: 0.13, rz: 0.08, cy: 0.01 },
      { x: -0.95, ry: 0.07, rz: 0.035, cy: 0.01 },
      { x: -1.06, ry: 0.03, rz: 0.02, cy: 0.01 },
    ],
    8,
    top,
    belly,
  );
  // Fluke (horizontal), dorsal fin, flippers.
  m.fin(
    [
      [-0.98, 0.01, 0.0],
      [-1.15, 0.01, 0.36],
      [-1.3, 0.01, 0.31],
      [-1.2, 0.01, 0.0],
    ],
    top,
    true,
  );
  m.fin(
    [
      [0.08, 0.24, 0],
      [-0.36, 0.52, 0],
      [-0.3, 0.18, 0],
    ],
    top,
    false,
  );
  m.fin(
    [
      [0.5, -0.12, 0.17],
      [0.18, -0.26, 0.48],
      [0.3, -0.12, 0.18],
    ],
    top,
    true,
  );
  m.bead(0.86, 0.06, 0.15, 0.028, 0x14181c);
  m.bead(0.86, 0.06, -0.15, 0.028, 0x14181c);
  return m.build();
}

/** Humpback whale, about 14 m with long white flippers. */
function whaleGeometry(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  const top = 0x38434e;
  const belly = 0xb9c3ca;
  m.loft(
    [
      { x: 7.0, ry: 0.3, rz: 0.5, cy: -0.25 },
      { x: 6.2, ry: 0.85, rz: 1.1, cy: -0.2 },
      { x: 4.2, ry: 1.55, rz: 1.65, cy: -0.15 },
      { x: 1.5, ry: 1.75, rz: 1.75, cy: -0.1 },
      { x: -1.0, ry: 1.5, rz: 1.4, cy: 0 },
      { x: -3.5, ry: 0.95, rz: 0.75, cy: 0.05 },
      { x: -5.5, ry: 0.45, rz: 0.28, cy: 0.05 },
      { x: -6.4, ry: 0.22, rz: 0.14, cy: 0.05 },
    ],
    10,
    top,
    belly,
  );
  m.fin(
    [
      [-6.2, 0.05, 0.0],
      [-6.9, 0.05, 2.3],
      [-7.4, 0.05, 2.2],
      [-7.05, 0.05, 0.0],
    ],
    0x4a5560,
    true,
  );
  m.fin(
    [
      [-2.2, 1.35, 0],
      [-3.1, 1.85, 0],
      [-3.3, 1.0, 0],
    ],
    top,
    false,
  );
  m.fin(
    [
      [3.3, -0.85, 1.35],
      [0.9, -1.75, 4.6],
      [0.4, -1.65, 4.4],
      [2.3, -0.9, 1.45],
    ],
    0xd8dee2,
    true,
  );
  m.bead(5.2, 0.15, 1.12, 0.12, 0x101418);
  m.bead(5.2, 0.15, -1.12, 0.12, 0x101418);
  return m.build();
}

/** Green sea turtle, about 1 m. */
function turtleGeometry(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  const shell = 0x6e7a3c;
  const shell2 = 0x8a6a3a;
  const skin = 0x8f9c6c;
  const plastron = 0xd8c99a;
  m.loft(
    [
      { x: 0.46, ry: 0.03, rz: 0.12, cy: 0.0 },
      { x: 0.32, ry: 0.13, rz: 0.33, cy: 0.02 },
      { x: 0.05, ry: 0.18, rz: 0.4, cy: 0.03 },
      { x: -0.25, ry: 0.13, rz: 0.32, cy: 0.02 },
      { x: -0.44, ry: 0.03, rz: 0.1, cy: 0.0 },
    ],
    10,
    shell,
    plastron,
    shell2,
  );
  m.loft(
    [
      { x: 0.4, ry: 0.07, rz: 0.075, cy: 0.0 },
      { x: 0.58, ry: 0.085, rz: 0.085, cy: 0.03 },
      { x: 0.7, ry: 0.065, rz: 0.07, cy: 0.035 },
      { x: 0.76, ry: 0.01, rz: 0.01, cy: 0.025 },
    ],
    6,
    skin,
    skin,
  );
  m.bead(0.66, 0.07, 0.06, 0.015, 0x101010);
  m.bead(0.66, 0.07, -0.06, 0.015, 0x101010);
  // Front flippers paddle (aFlip 1 at the tips), rear ones steer.
  m.fin(
    [
      [0.27, 0.0, 0.3],
      [0.08, -0.02, 0.86],
      [-0.02, -0.02, 0.8],
      [0.12, 0.0, 0.33],
    ],
    skin,
    true,
    [0, 1, 1, 0],
  );
  m.fin(
    [
      [-0.28, 0.0, 0.22],
      [-0.5, -0.01, 0.38],
      [-0.52, -0.01, 0.28],
      [-0.36, 0.0, 0.15],
    ],
    skin,
    true,
    [0, 0.4, 0.4, 0],
  );
  m.loft(
    [
      { x: -0.4, ry: 0.03, rz: 0.04, cy: 0 },
      { x: -0.55, ry: 0.005, rz: 0.005, cy: 0 },
    ],
    4,
    skin,
    skin,
  );
  return m.build();
}

/** Flying fish, about 0.4 m with wing-like fins. */
function fishGeometry(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  const top = 0x24557f;
  const belly = 0xe6edf2;
  const wing = 0x8db6d8;
  m.loft(
    [
      { x: 0.2, ry: 0.005, rz: 0.005, cy: 0 },
      { x: 0.15, ry: 0.035, rz: 0.028, cy: 0 },
      { x: 0.02, ry: 0.045, rz: 0.035, cy: 0 },
      { x: -0.11, ry: 0.025, rz: 0.018, cy: 0 },
      { x: -0.15, ry: 0.01, rz: 0.008, cy: 0 },
    ],
    6,
    top,
    belly,
  );
  m.fin(
    [
      [-0.14, 0, 0],
      [-0.25, 0.08, 0],
      [-0.2, 0, 0],
      [-0.26, -0.09, 0],
    ],
    top,
    false,
  );
  m.fin(
    [
      [0.1, 0.02, 0.03],
      [-0.06, 0.035, 0.26],
      [-0.12, 0.025, 0.21],
      [0.0, 0.02, 0.03],
    ],
    wing,
    true,
  );
  m.bead(0.15, 0.015, 0.027, 0.008, 0x0a0a0a);
  m.bead(0.15, 0.015, -0.027, 0.008, 0x0a0a0a);
  return m.build();
}

/** Lit, flat-shaded creature material that bends its mesh per instance (aBend). */
function creatureMaterial(tailStart: number, tailLen: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.5,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const uTail = { value: new THREE.Vector2(tailStart, tailLen) };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTail = uTail;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aBend;
attribute float aFlip;
uniform vec2 uTail;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  // x: curvature, y: vertical tail stroke, z: flipper phase, w: lateral tail beat.
  float tail = clamp((-position.x - uTail.x) / uTail.y, 0.0, 1.0);
  tail *= tail;
  transformed.y += aBend.x * position.x * position.x + aBend.y * tail;
  transformed.z += aBend.w * tail;
  float reach = max(abs(position.z) - 0.25, 0.0);
  transformed.y += aFlip * sign(position.z) * sign(aFlip) * reach * 0.8 * sin(aBend.z);
  transformed.x += abs(aFlip) * reach * 0.35 * cos(aBend.z);
}`,
      );
  };
  return mat;
}

/** Unlit spray material with a per-instance alpha (aAlpha). */
function sprayMaterial(): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;');
  };
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------------------------

interface CreatureMesh {
  species: Species;
  mesh: THREE.InstancedMesh;
  bend: THREE.InstancedBufferAttribute;
  base: THREE.Color;
}

/** Seed used when none is given: the same sea life every session, unless the caller varies it. */
export const DEFAULT_WILDLIFE_SEED = 0x51ea11fe;

export class WildlifeLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  readonly sim: WildlifeSim;

  private readonly creatures: CreatureMesh[] = [];
  private readonly spray: THREE.InstancedMesh;
  private readonly sprayAlpha: THREE.InstancedBufferAttribute;
  private readonly rings: THREE.InstancedMesh;
  private readonly ringAlpha: THREE.InstancedBufferAttribute;
  private readonly sprayMat: THREE.MeshBasicMaterial;
  private readonly ringMat: THREE.MeshBasicMaterial;

  private vesselGroups = new Map<string, { group: THREE.Group; length: number }>();
  private readonly wildVessels: WildVessel[] = [];
  private readonly input: WildlifeInput;
  private readonly focus = { x: 0, z: 0 };
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YZX');
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(seed = DEFAULT_WILDLIFE_SEED) {
    this.object.name = 'wildlife';
    this.sim = new WildlifeSim(seed);
    this.input = {
      dt: 0,
      calm: 1,
      daylight: 1,
      hs: 0,
      windSpeed: 0,
      windDirectionDeg: 0,
      camX: 0,
      camY: 0,
      camZ: 0,
      focusX: 0,
      focusZ: 0,
      vessels: this.wildVessels,
    };
    const make = (
      species: Species,
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      base: number,
    ): void => {
      const cap = CAPACITY[species];
      const bend = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      bend.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aBend', bend);
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.name = `wildlife-${species}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      const c = new THREE.Color(1, 1, 1);
      for (let i = 0; i < cap; i++) mesh.setColorAt(i, c);
      this.object.add(mesh);
      this.creatures.push({ species, mesh, bend, base: new THREE.Color(base) });
    };
    make('dolphin', dolphinGeometry(), creatureMaterial(0.3, 1.0), 0xffffff);
    make('whale', whaleGeometry(), creatureMaterial(2.0, 5.4), 0xffffff);
    make('turtle', turtleGeometry(), creatureMaterial(9, 1), 0xffffff);
    make('fish', fishGeometry(), creatureMaterial(0.0, 0.25), 0xffffff);

    this.sprayMat = sprayMaterial();
    const sprayGeo = new THREE.IcosahedronGeometry(1, 0);
    this.sprayAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1);
    this.sprayAlpha.setUsage(THREE.DynamicDrawUsage);
    sprayGeo.setAttribute('aAlpha', this.sprayAlpha);
    this.spray = new THREE.InstancedMesh(sprayGeo, this.sprayMat, MAX_PARTICLES);
    this.spray.name = 'wildlife-spray';
    this.spray.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.spray.frustumCulled = false;
    this.spray.count = 0;
    this.spray.renderOrder = 2;
    this.object.add(this.spray);

    this.ringMat = sprayMaterial();
    const ringGeo = new THREE.RingGeometry(0.8, 1, 28, 1);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS), 1);
    this.ringAlpha.setUsage(THREE.DynamicDrawUsage);
    ringGeo.setAttribute('aAlpha', this.ringAlpha);
    this.rings = new THREE.InstancedMesh(ringGeo, this.ringMat, MAX_RINGS);
    this.rings.name = 'wildlife-rings';
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.count = 0;
    this.rings.renderOrder = 1;
    this.object.add(this.rings);
  }

  setVessels(vessels: readonly SceneryVessel[]): void {
    this.vesselGroups = new Map(
      vessels.map((v) => [v.id, { group: v.group, length: v.definition.length }]),
    );
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
  }

  update(frame: SceneryFrame): void {
    if (!this.object.visible) return;
    const inp = this.input;
    const cam = frame.camera;
    cam.getWorldDirection(this.dir);
    focusOnSea(
      cam.position.x,
      cam.position.y,
      cam.position.z,
      this.dir.x,
      this.dir.y,
      this.dir.z,
      this.focus,
    );
    inp.dt = frame.dt;
    inp.calm = frame.calm;
    inp.daylight = frame.daylight;
    inp.hs = frame.hs;
    inp.windSpeed = frame.windSpeed;
    inp.windDirectionDeg = frame.windDirectionDeg;
    inp.camX = cam.position.x;
    inp.camY = cam.position.y;
    inp.camZ = cam.position.z;
    inp.focusX = this.focus.x;
    inp.focusZ = this.focus.z;
    this.syncVessels(frame);
    this.sim.step(inp);
    this.draw(frame);
  }

  private syncVessels(frame: SceneryFrame): void {
    const n = Math.min(frame.vessels.length, frame.vesselPositions.length);
    while (this.wildVessels.length < n) {
      this.wildVessels.push({ id: '', x: 0, z: 0, bowX: 1, bowZ: 0, speed: 0, length: 10 });
    }
    this.wildVessels.length = n;
    for (let i = 0; i < n; i++) {
      const v = frame.vessels[i]!;
      const pos = frame.vesselPositions[i]!;
      const w = this.wildVessels[i]!;
      w.id = v.id;
      w.x = pos.x;
      w.z = pos.z;
      w.speed = v.capsized ? 0 : Math.max(0, v.speedKn) * KN;
      const view = this.vesselGroups.get(v.id);
      if (view) {
        const e = view.group.matrixWorld.elements;
        const bx = e[0]!;
        const bz = e[2]!;
        const l = Math.hypot(bx, bz);
        if (l > 1e-4) {
          w.bowX = bx / l;
          w.bowZ = bz / l;
        }
        w.length = view.length;
      }
    }
  }

  private draw(frame: SceneryFrame): void {
    const light = 0.35 + 0.65 * clamp(frame.daylight, 0, 1);
    for (const cm of this.creatures) {
      let k = 0;
      const arr = cm.bend.array as Float32Array;
      for (const a of this.sim.animals) {
        if (!a.alive || a.species !== cm.species) continue;
        if (animalTop(a) < -0.6) continue;
        this.p.set(a.x, a.y, a.z);
        this.e.set(a.roll, a.yaw, a.pitch, 'YZX');
        this.q.setFromEuler(this.e);
        this.s.setScalar(a.size);
        this.m.compose(this.p, this.q, this.s);
        cm.mesh.setMatrixAt(k, this.m);
        this.color.copy(cm.base).multiplyScalar(a.shade);
        cm.mesh.setColorAt(k, this.color);
        const o = k * 4;
        arr[o] = a.bend;
        arr[o + 1] = a.stroke / a.size;
        arr[o + 2] = a.flip;
        arr[o + 3] = a.lateral / a.size;
        k++;
      }
      cm.mesh.count = k;
      if (k > 0) {
        cm.mesh.instanceMatrix.needsUpdate = true;
        if (cm.mesh.instanceColor) cm.mesh.instanceColor.needsUpdate = true;
        cm.bend.needsUpdate = true;
      }
    }

    const ident = this.q.identity();
    let k = 0;
    const sa = this.sprayAlpha.array as Float32Array;
    for (const pa of this.sim.particles) {
      if (!pa.alive) continue;
      const f = pa.age / pa.life;
      this.p.set(pa.x, pa.y, pa.z);
      this.s.setScalar(pa.kind === 1 ? pa.size : pa.size * (1 - 0.5 * f));
      this.m.compose(this.p, ident, this.s);
      this.spray.setMatrixAt(k, this.m);
      sa[k] = pa.kind === 1 ? 0.42 * (1 - f) * (1 - f) : 0.9 * (1 - f * f);
      k++;
    }
    this.spray.count = k;
    if (k > 0) {
      this.spray.instanceMatrix.needsUpdate = true;
      this.sprayAlpha.needsUpdate = true;
    }

    k = 0;
    const ra = this.ringAlpha.array as Float32Array;
    const ringY = 0.04 + 0.2 * clamp(frame.hs, 0, 1.5);
    for (const r of this.sim.rings) {
      if (!r.alive) continue;
      const f = r.age / r.life;
      const rad = r.maxR * (0.25 + 0.75 * (1 - (1 - f) * (1 - f)));
      this.p.set(r.x, ringY, r.z);
      this.s.set(rad, 1, rad);
      this.m.compose(this.p, ident, this.s);
      this.rings.setMatrixAt(k, this.m);
      ra[k] = 0.75 * r.strength * Math.pow(1 - f, 1.5);
      k++;
    }
    this.rings.count = k;
    if (k > 0) {
      this.rings.instanceMatrix.needsUpdate = true;
      this.ringAlpha.needsUpdate = true;
    }
    this.sprayMat.color.setScalar(light);
    this.ringMat.color.setScalar(light * 0.95);
  }

  dispose(): void {
    for (const cm of this.creatures) {
      cm.mesh.geometry.dispose();
      (cm.mesh.material as THREE.Material).dispose();
      cm.mesh.dispose();
    }
    this.creatures.length = 0;
    this.spray.geometry.dispose();
    this.sprayMat.dispose();
    this.spray.dispose();
    this.rings.geometry.dispose();
    this.ringMat.dispose();
    this.rings.dispose();
    this.object.clear();
    this.vesselGroups.clear();
  }
}
