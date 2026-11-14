/**
 * Storm visuals that need no GPU to reason about: how many distant rain curtains hang on the
 * horizon, where they stand, and how fast drops land on the camera lens. Pure, tested in node.
 */
import { mulberry32 } from '../../core/rng';
import type { CameraMode } from '../api';
import type { SceneryTier } from '../scenery/types';

/** Most curtains drawn at once, per scenery tier. */
export const CURTAIN_CAP: Readonly<Record<SceneryTier, number>> = { full: 8, mid: 5, lite: 0 };

/** Rain rate [mm/h] below which no curtain shows (drizzle is not visible from afar). */
const CURTAIN_MIN_RAIN = 2;

/** Curtains on the horizon for a rain rate [mm/h]: one per 4 mm/h, at least 1, up to the cap. */
export function curtainCount(rainMmH: number, tier: SceneryTier): number {
  if (!(rainMmH >= CURTAIN_MIN_RAIN)) return 0;
  return Math.min(CURTAIN_CAP[tier], Math.max(1, Math.round(rainMmH / 4)));
}

/**
 * Where curtain `i` stands, seen from the camera: `bearing` [rad] within ±60° of the direction
 * the wind comes from (`windDirRad`, so the showers are on their way in), 2–8 km away and
 * 0.4–1.5 km wide. Deterministic in (seed, i).
 */
export function curtainPlacement(
  seed: number,
  i: number,
  windDirRad: number,
): { bearing: number; distanceM: number; widthM: number } {
  const rnd = mulberry32(((seed >>> 0) * 2654435761 + (i + 1) * 40503) >>> 0);
  const spread = (rnd() * 2 - 1) * (Math.PI / 3);
  return {
    bearing: windDirRad + spread,
    distanceM: 2000 + 6000 * rnd(),
    widthM: 400 + 1100 * rnd(),
  };
}

/** Cameras that sit above the water near a ship, where rain and spray reach the lens. */
const WET_CAMERAS: ReadonlySet<CameraMode> = new Set(['bridge', 'follow', 'orbit']);

/** Most drops landing on the lens per second. */
const MAX_DROP_RATE = 12;

/**
 * Drops per second landing on the lens, from the rain rate [mm/h] and the spray reaching the
 * camera (`sprayRate`, drops/s). Zero underwater, from the air and in the top-down view.
 */
export function lensDropletRate(rainMmH: number, sprayRate: number, camera: CameraMode): number {
  if (!WET_CAMERAS.has(camera)) return 0;
  const rain = Number.isFinite(rainMmH) ? Math.max(0, rainMmH) : 0;
  const spray = Number.isFinite(sprayRate) ? Math.max(0, sprayRate) : 0;
  return Math.min(MAX_DROP_RATE, 0.25 * rain + spray);
}

/**
 * Spindrift reaching the lens [drops/s]: blown off the crests above 15 m/s wind, and only for a
 * camera within a few tens of metres of the sea (none at 30 m and above).
 */
export function lensSprayRate(windMs: number, heightAboveSeaM: number): number {
  if (!Number.isFinite(windMs) || !Number.isFinite(heightAboveSeaM)) return 0;
  const t = Math.min(1, Math.max(0, (heightAboveSeaM - 5) / 25));
  const near = 1 - t * t * (3 - 2 * t);
  return Math.max(0, windMs - 15) * 0.4 * near;
}

/**
 * The drops to draw: all of them on a wet camera above water, none on the dry cameras, the lite
 * tier or underwater. The drops themselves are kept, to show again on returning.
 */
export function shownDroplets(
  drops: readonly Droplet[],
  camera: CameraMode,
  tier: SceneryTier,
  underwater: boolean,
): readonly Droplet[] {
  return WET_CAMERAS.has(camera) && tier !== 'lite' && !underwater ? drops : NO_DROPS;
}
const NO_DROPS: readonly Droplet[] = [];

/** A drop on the lens: centre in screen UV [0, 1]², radius [UV of height], age and life [s]. */
export interface Droplet {
  x: number;
  y: number;
  r: number;
  age: number;
  life: number;
}

/** Most drops on the lens at once (the shader's uniform array size). */
export const DROPLET_CAP = 24;
/** The longest a drop stays on the lens [s]. */
export const DROPLET_MAX_LIFE = 4;

/**
 * Advance the drops on the lens by `dt` [s]: age them, remove the expired, and add new ones at
 * `rate` drops/s (the fraction carries over between frames). `rnd` returns values in [0, 1).
 */
export function stepDroplets(
  state: { drops: Droplet[]; carry: number },
  rate: number,
  dt: number,
  rnd: () => number,
): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const drops = state.drops;
  let w = 0;
  for (const d of drops) {
    d.age += dt;
    if (d.age < d.life) drops[w++] = d;
  }
  drops.length = w;
  state.carry += Math.max(0, Number.isFinite(rate) ? rate : 0) * dt;
  while (state.carry >= 1) {
    state.carry -= 1;
    if (drops.length >= DROPLET_CAP) continue;
    drops.push({
      x: rnd(),
      y: rnd(),
      r: 0.012 + 0.03 * rnd(),
      age: 0,
      life: 1.5 + (DROPLET_MAX_LIFE - 1.5) * rnd(),
    });
  }
}

/**
 * A drop's look, painted once on the CPU: RGBA bytes, `size`² texels. R and G hold the
 * refraction direction (128 = straight through; outward toward the rim, as a bulging drop bends
 * the view), B a small highlight, A the drop's coverage with a soft rim.
 */
export function paintDroplet(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // The drop fills 90% of the texture so its rim never touches the edge texels.
      const u = (((x + 0.5) / size) * 2 - 1) / 0.9;
      const v = (((y + 0.5) / size) * 2 - 1) / 0.9;
      const rho = Math.hypot(u, v);
      const i = (y * size + x) * 4;
      out[i] = 128;
      out[i + 1] = 128;
      if (rho >= 1) continue;
      out[i] = Math.round(128 + 120 * u);
      out[i + 1] = Math.round(128 + 120 * v);
      // A glint up and to the left of centre.
      const g = Math.max(0, 1 - Math.hypot(u + 0.35, v - 0.35) / 0.3);
      out[i + 2] = Math.round(255 * g * g);
      const t = Math.min(1, Math.max(0, (1 - rho) / 0.15));
      out[i + 3] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  return out;
}
