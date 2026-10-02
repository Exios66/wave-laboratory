/**
 * Sun, moon, sky, fog and exposure. With the day:night cycle off it reproduces the experiment's
 * fixed sun; with it on, the clock time moves the sun (and an opposing moon) across the sky.
 * The weather mood (`calm`) turns a clear sky overcast and hazy as a storm approaches.
 *
 * Shader uniforms added here (shared by the sky dome and the ocean, all 0 = old daytime look):
 *   uNight     0 day … 1 night (sky gradient, moon, reflections)
 *   uDusk      0 … 1 golden-hour tint around sunrise and sunset
 *   uOvercast  0 clear … 1 storm grey
 *   uStars     0 … 1 star visibility (sky dome only)
 *   uWaterDim  0 … 1 how much the water body, crest scatter and foam darken
 *   uGlintDim  0 … 1 how much the sun glint fades (below the horizon, overcast)
 *   uMoonDir   unit vector toward the moon, Three.js axes
 */
import * as THREE from 'three';
import type { Environment } from '../../schema/experiment';

export interface LightingParts {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  skyMaterial: THREE.ShaderMaterial;
  /** The GPU ocean's uniforms (uSunDir, uFogColor, uFogDensity, …), shared with the sky. */
  oceanUniforms: Record<string, THREE.IUniform>;
}

export interface LightingInput {
  env: Environment;
  /** Clock time [h], or null to use the experiment's fixed sun elevation and azimuth. */
  timeOfDay: number | null;
  /** 0 = storm, 1 = fair and calm. */
  calm: number;
  dt: number;
}

export interface LightingState {
  /** Unit vector toward the sun, Three.js axes. */
  sunDir: THREE.Vector3;
  /** 0 = deep night, 1 = full daylight. */
  daylight: number;
  /** Clock time [h]; derived from the fixed sun when the cycle is off. */
  timeOfDay: number;
}

/** Peak solar elevation at noon [deg] (a mid-latitude summer-ish day). */
export const NOON_ELEVATION_DEG = 60;

export interface SunPosition {
  /** Degrees above the horizon (negative below). */
  elevationDeg: number;
  /** Compass bearing toward the body: 0 north, 90 east, clockwise [0, 360). */
  azimuthDeg: number;
}

/**
 * Sun position for a clock time [h]. The sun runs on a great circle tilted so that it rises due
 * east at 06:00, culminates at {@link NOON_ELEVATION_DEG} due south at 12:00, sets due west at
 * 18:00 and is lowest (due north) at midnight.
 */
export function sunPositionAt(hours: number): SunPosition {
  const h = ((((hours % 24) + 24) % 24) - 12) * (Math.PI / 12); // hour angle, 0 at noon
  const tilt = THREE.MathUtils.degToRad(NOON_ELEVATION_DEG);
  const east = -Math.sin(h);
  const up = Math.sin(tilt) * Math.cos(h);
  const north = -Math.cos(tilt) * Math.cos(h);
  const elevationDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(up, -1, 1)));
  let azimuthDeg = THREE.MathUtils.radToDeg(Math.atan2(east, north));
  if (azimuthDeg < 0) azimuthDeg += 360;
  if (azimuthDeg >= 360) azimuthDeg -= 360;
  return { elevationDeg, azimuthDeg };
}

/** The moon sits roughly opposite the sun (a little behind it, so dawn and dusk differ). */
export function moonPositionAt(hours: number): SunPosition {
  return sunPositionAt(hours + 11.4);
}

/** Unit vector toward a body at (elevation, compass azimuth), written in Three.js axes. */
export function directionFromAngles(
  elevationDeg: number,
  azimuthDeg: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const elev = THREE.MathUtils.degToRad(elevationDeg);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const horiz = Math.cos(elev);
  // Azimuth is a compass bearing toward the body: 0 north (+world y = three −z), clockwise.
  out.set(Math.sin(az) * horiz, Math.sin(elev), -Math.cos(az) * horiz);
  if (out.lengthSq() < 1e-6) out.set(0, 1, 0);
  return out.normalize();
}

function smoothstep(a: number, b: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/** Look of the sky for a sun elevation and weather. All outputs are 0–1. */
export interface SkyMood {
  /** 0 = deep night, 1 = full daylight (reported to the other layers). */
  daylight: number;
  /** Darkness of the sky gradient: stays near 0 through sunset glow, 1 in full night. */
  night: number;
  /** Golden-hour strength. */
  dusk: number;
  /** Storm grey. */
  overcast: number;
  /** Star visibility. */
  stars: number;
}

export function skyMood(sunElevationDeg: number, calm: number): SkyMood {
  const e = sunElevationDeg;
  const overcast = 1 - smoothstep(0.1, 0.9, THREE.MathUtils.clamp(calm, 0, 1));
  const night = 1 - smoothstep(-16, 1, e);
  const dusk = smoothstep(-10, -1, e) * (1 - smoothstep(4, 22, e)) * (1 - overcast * 0.85);
  return {
    daylight: smoothstep(-9, 6, e),
    night,
    dusk,
    overcast,
    stars: smoothstep(-6, -16, e) * (1 - overcast),
  };
}

// Colours in linear RGB (the shaders work in linear and the renderer tone-maps).
const lin = (hex: number) => new THREE.Color(hex);
const DAY_HORIZON = new THREE.Color().setRGB(0.78, 0.84, 0.9, THREE.SRGBColorSpace);
const DUSK_HORIZON = new THREE.Color().setRGB(0.95, 0.66, 0.46, THREE.SRGBColorSpace);
const NIGHT_HORIZON = new THREE.Color().setRGB(0.15, 0.2, 0.3, THREE.SRGBColorSpace);
const STORM_HORIZON = new THREE.Color().setRGB(0.55, 0.58, 0.61, THREE.SRGBColorSpace);
const SUN_WHITE = lin(0xfff4e0);
const SUN_LOW = lin(0xffb27a);
const SUN_STORM = lin(0xd8dde2);
const MOON_LIGHT = lin(0x9db4e0);
const HEMI_SKY_DAY = lin(0xc5ddf2);
const HEMI_SKY_DUSK = lin(0xf2c9a8);
const HEMI_SKY_NIGHT = lin(0x5a78a8);
const HEMI_SKY_STORM = lin(0xa4adb6);
const HEMI_GROUND_DAY = lin(0x1c3344);
const HEMI_GROUND_NIGHT = lin(0x0a1420);

const BASE_EXPOSURE = 1.05;
const NIGHT_EXPOSURE = 1.9;
const BASE_FOG_DENSITY = 1.4e-6;

/**
 * Average horizon colour of the sky shader (what distant sea and scenery fade into). Mirrors the
 * mixing order in `skyColor`; the dusk tint is averaged around the horizon.
 */
export function horizonColor(mood: SkyMood, out = new THREE.Color()): THREE.Color {
  out.copy(DAY_HORIZON).lerp(DUSK_HORIZON, mood.dusk * 0.45);
  out.lerp(NIGHT_HORIZON, mood.night);
  const stormLevel = 1 - 0.82 * mood.night;
  const r = STORM_HORIZON.r * stormLevel;
  const g = STORM_HORIZON.g * stormLevel;
  const b = STORM_HORIZON.b * stormLevel;
  const k = mood.overcast * 0.85;
  return out.setRGB(out.r + (r - out.r) * k, out.g + (g - out.g) * k, out.b + (b - out.b) * k);
}

export class SkyLighting {
  private readonly state: LightingState = {
    sunDir: new THREE.Vector3(0, 1, 0),
    daylight: 1,
    timeOfDay: 12,
  };
  private readonly moonDir = new THREE.Vector3(0, -1, 0);
  private readonly u: Record<
    'uNight' | 'uDusk' | 'uOvercast' | 'uStars' | 'uWaterDim' | 'uGlintDim',
    THREE.IUniform<number>
  >;
  private readonly fogColor = new THREE.Color();
  private readonly tmp = new THREE.Color();

  constructor(private readonly parts: LightingParts) {
    this.u = {
      uNight: { value: 0 },
      uDusk: { value: 0 },
      uOvercast: { value: 0 },
      uStars: { value: 0 },
      uWaterDim: { value: 0 },
      uGlintDim: { value: 0 },
    };
    const shared: Record<string, THREE.IUniform> = {
      ...this.u,
      uMoonDir: { value: this.moonDir },
    };
    // The ocean ShaderMaterial uses `oceanUniforms` directly, so adding keys here reaches it.
    Object.assign(parts.oceanUniforms, shared);
    Object.assign(parts.skyMaterial.uniforms, shared);
  }

  update(input: LightingInput): LightingState {
    const { env } = input;
    const { sun: sunLight, hemi, oceanUniforms } = this.parts;
    const calm = THREE.MathUtils.clamp(input.calm, 0, 1);
    const sun = this.state.sunDir;
    let mood: SkyMood;

    if (input.timeOfDay === null) {
      // Fixed sun from the experiment: the original behaviour, plus the weather mood.
      directionFromAngles(env.sunElevationDeg, env.sunAzimuthDeg, sun);
      mood = { ...skyMood(90, calm), daylight: 1, night: 0, dusk: 0, stars: 0 };
      this.state.daylight = THREE.MathUtils.clamp((env.sunElevationDeg + 6) / 16, 0, 1);
      this.state.timeOfDay = 12;
      sunLight.position.copy(sun).multiplyScalar(2000);
      sunLight.intensity = THREE.MathUtils.clamp(0.35 + env.sunElevationDeg / 28, 0.25, 2.6);
      sunLight.color.copy(env.sunElevationDeg < 8 ? SUN_LOW : SUN_WHITE);
      this.moonDir.set(0, -1, 0);
      hemi.color.copy(HEMI_SKY_DAY);
      hemi.groundColor.copy(HEMI_GROUND_DAY);
      hemi.intensity = 0.9;
      this.u.uWaterDim.value = 0;
      this.u.uGlintDim.value = 0;
      this.parts.renderer.toneMappingExposure = BASE_EXPOSURE;
    } else {
      const hours = ((input.timeOfDay % 24) + 24) % 24;
      const sp = sunPositionAt(hours);
      const mp = moonPositionAt(hours);
      directionFromAngles(sp.elevationDeg, sp.azimuthDeg, sun);
      directionFromAngles(mp.elevationDeg, mp.azimuthDeg, this.moonDir);
      mood = skyMood(sp.elevationDeg, calm);
      this.state.daylight = mood.daylight;
      this.state.timeOfDay = hours;

      // Direct light: the sun by day, swapped to the moon once the sun is well down.
      const sunUp = smoothstep(-4, 3, sp.elevationDeg);
      if (sunUp > 0.02 || mp.elevationDeg < 2) {
        sunLight.position.copy(sun).multiplyScalar(2000);
        sunLight.intensity =
          THREE.MathUtils.clamp(0.35 + sp.elevationDeg / 28, 0.25, 2.6) * sunUp +
          (1 - sunUp) * 0.25;
        const low = 1 - smoothstep(2, 24, sp.elevationDeg);
        sunLight.color.copy(SUN_WHITE).lerp(SUN_LOW, low);
      } else {
        sunLight.position.copy(this.moonDir).multiplyScalar(2000);
        sunLight.intensity = 0.7 * smoothstep(2, 20, mp.elevationDeg) + 0.25;
        sunLight.color.copy(MOON_LIGHT);
      }
      hemi.color
        .copy(HEMI_SKY_DAY)
        .lerp(HEMI_SKY_DUSK, mood.dusk * 0.6)
        .lerp(HEMI_SKY_NIGHT, mood.night);
      hemi.groundColor.copy(HEMI_GROUND_DAY).lerp(HEMI_GROUND_NIGHT, mood.night);
      hemi.intensity = THREE.MathUtils.lerp(0.9, 0.75, mood.night);
      this.u.uWaterDim.value = mood.night * 0.65;
      this.u.uGlintDim.value = 1 - sunUp;
      this.parts.renderer.toneMappingExposure = THREE.MathUtils.lerp(
        BASE_EXPOSURE,
        NIGHT_EXPOSURE,
        mood.night,
      );
    }

    // Weather: the storm greys the sky, dims and whitens the sun, thickens the haze.
    const oc = mood.overcast;
    sunLight.intensity *= 1 - 0.6 * oc;
    sunLight.color.lerp(SUN_STORM, oc * 0.7);
    hemi.color.lerp(this.tmp.copy(HEMI_SKY_STORM).multiplyScalar(1 - 0.75 * mood.night), oc * 0.7);
    this.u.uGlintDim.value = 1 - (1 - this.u.uGlintDim.value) * (1 - 0.75 * oc);
    this.u.uWaterDim.value = 1 - (1 - this.u.uWaterDim.value) * (1 - 0.35 * oc);

    this.u.uNight.value = mood.night;
    this.u.uDusk.value = mood.dusk;
    this.u.uOvercast.value = oc;
    this.u.uStars.value = mood.stars;

    (oceanUniforms.uSunDir!.value as THREE.Vector3).copy(sun);
    horizonColor(mood, this.fogColor);
    (oceanUniforms.uFogColor!.value as THREE.Color).copy(this.fogColor);
    const density = BASE_FOG_DENSITY * (1 + 2.2 * oc) * (1 + 0.6 * mood.night);
    oceanUniforms.uFogDensity!.value = density;
    const fog = this.parts.scene.fog;
    if (fog instanceof THREE.FogExp2) {
      fog.color.copy(this.fogColor);
      fog.density = Math.sqrt(density);
    }
    return this.state;
  }

  dispose(): void {}
}
