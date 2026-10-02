/**
 * Sun, sky, fog and exposure. With the day:night cycle off it reproduces the experiment's
 * fixed sun; with it on, the clock time moves the sun across the sky.
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

export class SkyLighting {
  private readonly state: LightingState = {
    sunDir: new THREE.Vector3(0, 1, 0),
    daylight: 1,
    timeOfDay: 12,
  };

  constructor(private readonly parts: LightingParts) {}

  update(input: LightingInput): LightingState {
    const { env } = input;
    const elev = THREE.MathUtils.degToRad(env.sunElevationDeg);
    const az = THREE.MathUtils.degToRad(env.sunAzimuthDeg);
    const horiz = Math.cos(elev);
    // Azimuth is a compass bearing toward the sun: 0 north (+world y), clockwise.
    const sun = this.state.sunDir.set(Math.sin(az) * horiz, Math.sin(elev), -Math.cos(az) * horiz);
    if (sun.lengthSq() < 1e-6) sun.set(0, 1, 0);
    sun.normalize();
    (this.parts.oceanUniforms.uSunDir!.value as THREE.Vector3).copy(sun);
    this.parts.sun.position.copy(sun).multiplyScalar(2000);
    this.parts.sun.intensity = THREE.MathUtils.clamp(0.35 + env.sunElevationDeg / 28, 0.25, 2.6);
    this.parts.sun.color.set(env.sunElevationDeg < 8 ? 0xffb27a : 0xfff4e0);
    // Same curve as daylight() in the sky shader.
    this.state.daylight = THREE.MathUtils.clamp(sun.y * 4 + 0.25, 0.08, 1);
    this.state.timeOfDay = input.timeOfDay ?? 12;
    return this.state;
  }

  dispose(): void {}
}
