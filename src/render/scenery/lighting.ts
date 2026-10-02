/**
 * Sun and moon. With the day:night cycle off it reproduces the experiment's fixed sun; with it
 * on, the clock time moves the sun (and a roughly opposite moon) across the sky.
 *
 * LabRenderer.updateWeather() owns fog, clear colour, hemisphere intensity and exposure; it
 * multiplies in `exposureScale`, takes `hemiSky`/`hemiGround` and passes `night`/`dusk` to its
 * horizon colour. The sun intensity set here is the clear-sky value that the weather dims.
 *
 * Shader uniforms added here (shared by the sky dome and the ocean, all 0 = plain daytime):
 *   uNight   0 day … 1 night (night sky gradient, moonlight floor, moon, moon glint)
 *   uDusk    0 … 1 golden-hour tint around sunrise and sunset
 *   uStars   0 … 1 star visibility (sky dome only)
 *   uMoonDir unit vector toward the moon, Three.js axes
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
  /** 0 = deep night, 1 = full daylight (for the scenery layers). */
  daylight: number;
  /** Sky brightness as `daylight()` in the sky shader computes it (for the weather's lights). */
  skyLight: number;
  /** Clock time [h]; derived from the fixed sun when the cycle is off. */
  timeOfDay: number;
  /** 0 day … 1 night; same as the uNight uniform. */
  night: number;
  /** 0 … 1 golden-hour strength; same as the uDusk uniform. */
  dusk: number;
  /** Multiplies the weather's tone-mapping exposure (lifts the night so it stays readable). */
  exposureScale: number;
  /** Hemisphere light colours for the time of day (the weather sets the intensity). */
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
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

/** Look of the sky for a sun elevation. All outputs are 0–1. */
export interface SkyMood {
  /** 0 = deep night, 1 = full daylight (reported to the other layers). */
  daylight: number;
  /** Darkness of the sky gradient: stays near 0 through sunset glow, 1 in full night. */
  night: number;
  /** Golden-hour strength. */
  dusk: number;
  /** Star visibility (before cloud, which the shader applies). */
  stars: number;
}

export function skyMood(sunElevationDeg: number): SkyMood {
  const e = sunElevationDeg;
  return {
    daylight: smoothstep(-9, 6, e),
    night: 1 - smoothstep(-16, 1, e),
    dusk: smoothstep(-10, -1, e) * (1 - smoothstep(4, 22, e)),
    stars: smoothstep(-6, -16, e),
  };
}

/**
 * Mirror of `daylight()` in the sky shader: the weather's clear-sky curve, brightened a little
 * through the golden hour and with a moonlight floor at night.
 */
export function skyLightLevel(sunY: number, night: number, dusk: number): number {
  const base = THREE.MathUtils.clamp(sunY * 4 + 0.25, 0.08 + 0.14 * night, 1);
  return Math.min(1, base + dusk * 0.25);
}

const lin = (hex: number) => new THREE.Color(hex);
const SUN_WHITE = lin(0xfff4e0);
const SUN_LOW = lin(0xffb27a);
const MOON_LIGHT = lin(0x9db4e0);
const HEMI_SKY_DAY = lin(0xc5ddf2);
const HEMI_SKY_DUSK = lin(0xf2c9a8);
const HEMI_SKY_NIGHT = lin(0x5a78a8);
const HEMI_GROUND_DAY = lin(0x1c3344);
const HEMI_GROUND_NIGHT = lin(0x0a1420);
const NIGHT_EXPOSURE_SCALE = 1.7;

export class SkyLighting {
  private readonly state: LightingState = {
    sunDir: new THREE.Vector3(0, 1, 0),
    daylight: 1,
    skyLight: 1,
    timeOfDay: 12,
    night: 0,
    dusk: 0,
    exposureScale: 1,
    hemiSky: HEMI_SKY_DAY.clone(),
    hemiGround: HEMI_GROUND_DAY.clone(),
  };
  private readonly moonDir = new THREE.Vector3(0, -1, 0);
  private readonly u: Record<'uNight' | 'uDusk' | 'uStars', THREE.IUniform<number>>;

  constructor(private readonly parts: LightingParts) {
    this.u = { uNight: { value: 0 }, uDusk: { value: 0 }, uStars: { value: 0 } };
    const shared: Record<string, THREE.IUniform> = { ...this.u, uMoonDir: { value: this.moonDir } };
    // The ocean ShaderMaterial uses `oceanUniforms` directly, so adding keys here reaches it.
    Object.assign(parts.oceanUniforms, shared);
    Object.assign(parts.skyMaterial.uniforms, shared);
  }

  update(input: LightingInput): LightingState {
    const { env } = input;
    const sunLight = this.parts.sun;
    const st = this.state;
    const sun = st.sunDir;

    if (input.timeOfDay === null) {
      // Fixed sun from the experiment: the original behaviour.
      directionFromAngles(env.sunElevationDeg, env.sunAzimuthDeg, sun);
      sunLight.position.copy(sun).multiplyScalar(2000);
      sunLight.intensity = THREE.MathUtils.clamp(0.35 + env.sunElevationDeg / 28, 0.25, 2.6);
      sunLight.color.copy(env.sunElevationDeg < 8 ? SUN_LOW : SUN_WHITE);
      this.moonDir.set(0, -1, 0);
      st.night = 0;
      st.dusk = 0;
      this.u.uStars.value = 0;
      st.skyLight = skyLightLevel(sun.y, 0, 0);
      st.daylight = st.skyLight;
      st.timeOfDay = 12;
      st.exposureScale = 1;
      st.hemiSky.copy(HEMI_SKY_DAY);
      st.hemiGround.copy(HEMI_GROUND_DAY);
    } else {
      const hours = ((input.timeOfDay % 24) + 24) % 24;
      const sp = sunPositionAt(hours);
      const mp = moonPositionAt(hours);
      directionFromAngles(sp.elevationDeg, sp.azimuthDeg, sun);
      directionFromAngles(mp.elevationDeg, mp.azimuthDeg, this.moonDir);
      const mood = skyMood(sp.elevationDeg);
      st.night = mood.night;
      st.dusk = mood.dusk;
      this.u.uStars.value = mood.stars;
      st.skyLight = skyLightLevel(sun.y, mood.night, mood.dusk);
      st.daylight = mood.daylight;
      st.timeOfDay = hours;

      // Direct light: the sun by day, swapped to the moon once the sun is well down.
      const sunUp = smoothstep(-4, 3, sp.elevationDeg);
      if (sunUp > 0.02 || mp.elevationDeg < 2) {
        sunLight.position.copy(sun).multiplyScalar(2000);
        sunLight.intensity =
          THREE.MathUtils.clamp(0.35 + sp.elevationDeg / 28, 0.25, 2.6) * sunUp +
          (1 - sunUp) * 0.25;
        sunLight.color.copy(SUN_WHITE).lerp(SUN_LOW, 1 - smoothstep(2, 24, sp.elevationDeg));
      } else {
        sunLight.position.copy(this.moonDir).multiplyScalar(2000);
        sunLight.intensity = 0.7 * smoothstep(2, 20, mp.elevationDeg) + 0.25;
        sunLight.color.copy(MOON_LIGHT);
      }
      st.exposureScale = THREE.MathUtils.lerp(1, NIGHT_EXPOSURE_SCALE, mood.night);
      st.hemiSky
        .copy(HEMI_SKY_DAY)
        .lerp(HEMI_SKY_DUSK, mood.dusk * 0.6)
        .lerp(HEMI_SKY_NIGHT, mood.night);
      st.hemiGround.copy(HEMI_GROUND_DAY).lerp(HEMI_GROUND_NIGHT, mood.night);
    }

    this.u.uNight.value = st.night;
    this.u.uDusk.value = st.dusk;
    (this.parts.oceanUniforms.uSunDir!.value as THREE.Vector3).copy(sun);
    return st;
  }

  dispose(): void {}
}
