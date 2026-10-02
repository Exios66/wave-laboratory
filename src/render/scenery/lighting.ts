/**
 * Sun, sky, fog and exposure. With the day:night cycle off it reproduces the experiment's
 * fixed sun; with it on, the clock time moves the sun across the sky.
 */
import * as THREE from 'three';
import type { Environment } from '../../schema/experiment';
import { daylightFromElevation, sunAnglesFromHour, wrapHour } from './sun';

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

const DAY_FOG = new THREE.Color(0x8aa4b8);
const DUSK_FOG = new THREE.Color(0xb07a5c);
const NIGHT_FOG = new THREE.Color(0x0a1220);
const STORM_FOG = new THREE.Color(0x5a6670);
const TMP = new THREE.Color();

export class SkyLighting {
  private readonly state: LightingState = {
    sunDir: new THREE.Vector3(0, 1, 0),
    daylight: 1,
    timeOfDay: 12,
  };
  private readonly fogScratch = new THREE.Color();

  constructor(private readonly parts: LightingParts) {}

  update(input: LightingInput): LightingState {
    const { env, calm, timeOfDay } = input;
    let elev: number;
    let az: number;
    if (timeOfDay !== null) {
      const angles = sunAnglesFromHour(timeOfDay);
      elev = angles.elevationDeg;
      az = angles.azimuthDeg;
      this.state.timeOfDay = wrapHour(timeOfDay);
    } else {
      elev = env.sunElevationDeg;
      az = env.sunAzimuthDeg;
      // Recover a plausible clock from the fixed sun so scenery still knows "afternoon".
      this.state.timeOfDay = elev >= 0 ? 12 - (elev / 72) * 6 : 0;
    }

    const elevRad = THREE.MathUtils.degToRad(elev);
    const azRad = THREE.MathUtils.degToRad(az);
    const horiz = Math.cos(elevRad);
    // Azimuth is a compass bearing toward the sun: 0 north (+world y), clockwise.
    const sun = this.state.sunDir.set(
      Math.sin(azRad) * horiz,
      Math.sin(elevRad),
      -Math.cos(azRad) * horiz,
    );
    if (sun.lengthSq() < 1e-6) sun.set(0, 1, 0);
    sun.normalize();
    (this.parts.oceanUniforms.uSunDir!.value as THREE.Vector3).copy(sun);
    this.parts.sun.position.copy(sun).multiplyScalar(2000);

    const daylight = daylightFromElevation(elev);
    this.state.daylight = daylight;

    // Sun lamp: warm at the horizon, bright white at noon, almost off at night.
    const sunStrength = THREE.MathUtils.clamp(0.15 + daylight * 2.4, 0.05, 2.7);
    this.parts.sun.intensity = sunStrength * (0.55 + 0.45 * calm);
    if (elev < 6) this.parts.sun.color.setRGB(1, 0.55 + daylight * 0.35, 0.35 + daylight * 0.4);
    else if (elev < 18) this.parts.sun.color.setRGB(1, 0.78, 0.55);
    else this.parts.sun.color.setRGB(1, 0.96, 0.88);

    // Hemisphere: cool sky / warm ground by day; deep blue vault at night.
    this.parts.hemi.intensity = 0.18 + daylight * 0.85 * (0.55 + 0.45 * calm);
    this.parts.hemi.color.setRGB(
      0.35 + daylight * 0.42,
      0.42 + daylight * 0.45,
      0.55 + daylight * 0.4,
    );
    this.parts.hemi.groundColor.setRGB(
      0.04 + daylight * 0.12,
      0.08 + daylight * 0.18,
      0.1 + daylight * 0.16,
    );

    // Fog: dusk/dawn warm, night deep, storms greyer and thicker.
    const fogDay = TMP.copy(DAY_FOG).lerp(STORM_FOG, 1 - calm);
    const warmBand = THREE.MathUtils.clamp(1 - Math.abs(elev - 2) / 14, 0, 1);
    this.fogScratch.copy(fogDay).lerp(DUSK_FOG, warmBand * daylight);
    this.fogScratch.lerp(NIGHT_FOG, 1 - daylight);
    const fogColor = this.parts.oceanUniforms.uFogColor!.value as THREE.Color;
    fogColor.copy(this.fogScratch);
    const density =
      THREE.MathUtils.lerp(2.8e-6, 1.1e-6, daylight) * THREE.MathUtils.lerp(1.7, 1, calm);
    this.parts.oceanUniforms.uFogDensity!.value = density;
    const fog = this.parts.scene.fog;
    if (fog instanceof THREE.FogExp2) {
      fog.color.copy(this.fogScratch);
      fog.density = Math.sqrt(density);
    }

    this.parts.renderer.setClearColor(this.fogScratch.getHex(), 1);
    this.parts.renderer.toneMappingExposure = THREE.MathUtils.lerp(0.55, 1.08, daylight);

    return this.state;
  }

  dispose(): void {}
}
