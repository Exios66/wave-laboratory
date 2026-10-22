/**
 * Pure helpers for the underwater seafloor and light (no Three.js, so they are unit tested directly).
 *
 * The seafloor follows the experiment's still-water depth. On a shelf (≤ {@link SHELF_MAX_DEPTH})
 * the floor sits at `env.depth` plus gentle relief and the underwater camera is clamped above it
 * ({@link maxCameraDepth}); in deep water there is no floor at all and the view is "blue water":
 * a depth gradient with drifting particulate. Also here: the per-tier draw-call budget, the
 * refracted sun direction for the shafts and the depth colour grade (from the Jerlov K_d).
 */
import type { SceneryTier } from '../scenery/types';

/** Deepest still water [m] at which a floor is still drawn; beyond it the view is blue water. */
export const SHELF_MAX_DEPTH = 60;
/** Reach of the underwater camera in depth [m]: the shallowest and deepest it may sit. */
export const CAMERA_MIN_DEPTH = 1.5;
export const CAMERA_MAX_DEPTH = 30;
/** Clearance kept between the eye and the highest point of the floor [m]. */
export const FLOOR_CLEARANCE = 0.5;

export type SeafloorMode = 'shelf' | 'blue';

export function seafloorMode(envDepth: number): SeafloorMode {
  return envDepth <= SHELF_MAX_DEPTH ? 'shelf' : 'blue';
}

/** Half the vertical relief of the shelf floor [m]: gentle in shallow water, up to 5 m in 25+ m. */
export function shelfRelief(envDepth: number): number {
  return Math.max(0.5, Math.min(5, 0.2 * envDepth));
}

/** Unit relief shape in [-1, 1] (positive = deeper): ripples, long ridges and rocky pinnacles. */
export function reliefNoise(x: number, y: number): number {
  const ripple = 0.6 * Math.sin(x * 0.14 + y * 0.09) + 0.4 * Math.cos(x * 0.07 - y * 0.12);
  const ridge = 3.2 * Math.sin(x * 0.012) * Math.cos(y * 0.014);
  const pinnacle = Math.max(0, Math.sin(x * 0.031 + 1.2) * Math.sin(y * 0.029 - 0.7)) ** 3 * 5.5;
  return Math.max(-1, Math.min(1, (ridge + ripple - 0.8 * pinnacle) / 4.2));
}

/**
 * Floor depth [m below the surface, positive] at world `(x, y)` for a still-water depth, or
 * `null` in blue water (no floor). On a shelf it is `envDepth ± shelfRelief`, so the shallowest
 * point is `envDepth − shelfRelief` and the camera clamp keeps the eye above it.
 */
export function floorDepthAt(x: number, y: number, envDepth: number): number | null {
  if (seafloorMode(envDepth) === 'blue') return null;
  return envDepth + shelfRelief(envDepth) * reliefNoise(x, y);
}

/** Deepest eye depth [m] of the Underwater camera: above the shallowest floor, within the view limits. */
export function maxCameraDepth(envDepth: number): number {
  const shallowestFloor =
    seafloorMode(envDepth) === 'shelf' ? envDepth - shelfRelief(envDepth) : Infinity;
  return Math.max(CAMERA_MIN_DEPTH, Math.min(CAMERA_MAX_DEPTH, shallowestFloor - FLOOR_CLEARANCE));
}

// ---------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------

/** Hard cap on extra draw calls underwater per tier (seabed, plants, rocks/coral, wrecks, particles, shafts). */
export const UNDERWATER_BUDGET: Record<SceneryTier, number> = {
  full: 6,
  mid: 3,
  lite: 1,
};

export interface UnderwaterDraws {
  seabed: boolean;
  plants: boolean;
  hard: boolean;
  wrecks: boolean;
  particles: boolean;
  shafts: boolean;
}

/**
 * Which underwater draws run for a tier and floor mode. Priority order keeps the total within
 * {@link UNDERWATER_BUDGET}: on a shelf lite is just the seabed, mid adds plants and coral/rocks,
 * full adds wrecks, particulate and shafts; in blue water the floor layers vanish and the
 * particulate (every tier) and shafts (full) take over.
 */
export function underwaterDraws(tier: SceneryTier, mode: SeafloorMode): UnderwaterDraws {
  const none: UnderwaterDraws = {
    seabed: false,
    plants: false,
    hard: false,
    wrecks: false,
    particles: false,
    shafts: false,
  };
  if (mode === 'blue') return { ...none, particles: true, shafts: tier === 'full' };
  if (tier === 'lite') return { ...none, seabed: true };
  if (tier === 'mid') return { ...none, seabed: true, plants: true, hard: true };
  return { seabed: true, plants: true, hard: true, wrecks: true, particles: true, shafts: true };
}

export function countDraws(d: UnderwaterDraws): number {
  return Object.values(d).filter(Boolean).length;
}

// ---------------------------------------------------------------------------------------------
// Light
// ---------------------------------------------------------------------------------------------

/**
 * Direction the sunlight travels under the surface (unit, y-up), refracted from the unit vector
 * `sun` that points at the sun. Snell: sin θw = sin θa / n. A sun below the horizon returns
 * straight down.
 */
export function refractedSunDirection(
  sun: readonly [number, number, number],
  n = 1.333,
): [number, number, number] {
  const len = Math.hypot(sun[0], sun[1], sun[2]) || 1;
  const cosA = Math.max(0, sun[1] / len);
  if (cosA < 0.02) return [0, -1, 0];
  const sinA = Math.sqrt(1 - cosA * cosA);
  const sinW = sinA / n;
  const cosW = Math.sqrt(1 - sinW * sinW);
  // Horizontal part of the incoming ray, normalised, pointing away from the sun.
  const hx = sinA > 1e-6 ? -sun[0] / len / sinA : 0;
  const hz = sinA > 1e-6 ? -sun[2] / len / sinA : 0;
  return [hx * sinW, -cosW, hz * sinW];
}

/** Share of light left at `depth` [m] for attenuation `k` [1/m] (Beer–Lambert). */
export function lightAtDepth(k: number, depth: number): number {
  return Math.exp(-k * Math.max(0, depth));
}

export interface UnderwaterRays {
  /** Refracted travel direction of the sunlight (unit, y-up). */
  dir: [number, number, number];
  /** 0–1: zero at night or with the sun on the horizon, fading with the eye's depth. */
  strength: number;
}

/**
 * God ray strength for the pass: daylight, the sun's height (a low sun gives weak shafts) and how
 * much of the surface light survives to the eye (`kdGreen` is the green-channel K_d).
 */
export function underwaterRays(
  sun: readonly [number, number, number],
  daylight: number,
  depth: number,
  kdGreen: number,
): UnderwaterRays {
  const len = Math.hypot(sun[0], sun[1], sun[2]) || 1;
  const elevation = Math.max(0, sun[1] / len);
  const day = Math.max(0, Math.min(1, daylight));
  const strength = day * Math.sqrt(elevation) * (0.35 + 0.65 * lightAtDepth(kdGreen, depth * 0.5));
  return { dir: refractedSunDirection(sun), strength: Math.max(0, Math.min(1, strength)) };
}

export interface DepthGrade {
  /** Saturation multiplier (1 = untouched). The deep loses colour. */
  saturation: number;
  /** Per-channel multiplier, normalised so its largest channel is 1 (luminance is not crushed). */
  tint: [number, number, number];
}

/**
 * Colour grade for the eye at `depth` [m]. `kd` is the Jerlov diffuse attenuation [1/m]: the tint
 * is the water's own absorption spectrum at a fraction of the depth (the veil already carries the
 * hue; this deepens it), and saturation falls off toward 0.6 in the deep.
 */
export function depthGrade(kd: readonly [number, number, number], depth: number): DepthGrade {
  const d = Math.max(0, depth);
  const raw = kd.map((k) => Math.pow(lightAtDepth(k, d), 0.25)) as [number, number, number];
  const peak = Math.max(raw[0], raw[1], raw[2], 1e-6);
  return {
    saturation: 1 - 0.4 * (1 - Math.exp(-d / 25)),
    tint: [raw[0] / peak, raw[1] / peak, raw[2] / peak],
  };
}
