/**
 * Sky (three.js Preetham `Sky` addon), its cube capture for water reflections, the PMREM
 * environment for vessel materials, and the matching sun light.
 *
 * The sun irradiance is derived from the same Preetham terms the Sky shader uses (sun intensity
 * E(θ_z) and extinction F_ex along the sun direction), scaled like the Sky's own cloud lighting,
 * so sky, water and vessels share one radiometric scale.
 */
import {
  Color,
  CubeCamera,
  DirectionalLight,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { Environment } from '../../schema/experiment';
import { bearingElevationToThree } from '../coords';

const CUBE_SIZE = 256;

export class SkyEnvironment {
  readonly sky = new Sky();
  readonly sunLight = new DirectionalLight(0xffffff, 1);
  /** Unit vector towards the sun (three.js frame). */
  readonly sunDirection = new Vector3(0, 1, 0);
  /** Sun irradiance on a surface facing the sun (linear RGB, Sky units). */
  readonly sunIrradiance = new Color(1, 1, 1);
  readonly cubeTarget: WebGLCubeRenderTarget;
  private readonly cubeCamera: CubeCamera;
  private readonly captureScene = new Scene();
  private readonly captureSky = new Sky();
  private pmrem: PMREMGenerator;
  private readonly renderer: WebGLRenderer;
  private envTarget: WebGLRenderTarget | null = null;
  private dirty = true;

  constructor(renderer: WebGLRenderer) {
    this.sky.scale.setScalar(1e4);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.sky.name = 'Sky';
    this.captureSky.scale.setScalar(1e4);
    this.captureSky.frustumCulled = false;
    this.captureScene.add(this.captureSky);
    this.cubeTarget = new WebGLCubeRenderTarget(CUBE_SIZE, {
      type: HalfFloatType,
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
    });
    this.cubeCamera = new CubeCamera(1, 1e5, this.cubeTarget);
    this.renderer = renderer;
    this.pmrem = new PMREMGenerator(renderer);
    this.sunLight.name = 'Sun';
    for (const s of [this.sky, this.captureSky]) {
      const u = s.material.uniforms;
      u.turbidity!.value = 2.2;
      u.rayleigh!.value = 1.2;
      u.mieCoefficient!.value = 0.004;
      u.mieDirectionalG!.value = 0.8;
      u.cloudCoverage!.value = 0.28;
      u.cloudDensity!.value = 0.35;
    }
    // The reflection capture omits the sun disc; the water adds the sun analytically (BRDF).
    this.captureSky.material.uniforms.showSunDisc!.value = 0;
  }

  /** Mip levels of the reflection cube (for roughness → LOD). */
  get maxMip(): number {
    return Math.log2(CUBE_SIZE);
  }

  /** PMREM environment for physically based vessel materials. */
  get environment(): WebGLRenderTarget['texture'] | null {
    return this.envTarget?.texture ?? null;
  }

  setEnvironment(env: Environment): void {
    bearingElevationToThree(env.sunAzimuthDeg, env.sunElevationDeg, this.sunDirection);
    for (const s of [this.sky, this.captureSky]) {
      (s.material.uniforms.sunPosition!.value as Vector3).copy(this.sunDirection);
      // More wind → somewhat more cloud.
      s.material.uniforms.cloudCoverage!.value = Math.min(0.6, 0.2 + env.windSpeed * 0.012);
    }
    this.computeSun();
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(1000);
    this.dirty = true;
  }

  /** Cloud drift. */
  setTime(t: number): void {
    this.sky.material.uniforms.time!.value = t;
  }

  /** Re-capture the sky when it changed (call before rendering the main scene). */
  update(renderer: WebGLRenderer): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    this.cubeCamera.update(renderer, this.captureScene);
    this.envTarget?.dispose();
    this.envTarget = this.pmrem.fromCubemap(this.cubeTarget.texture);
    return true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Free GPU resources after a context loss; the next update() recreates them. */
  releaseGpu(): void {
    this.cubeTarget.dispose();
    this.envTarget?.dispose();
    this.envTarget = null;
    this.pmrem.dispose();
    this.pmrem = new PMREMGenerator(this.renderer);
    this.dirty = true;
  }

  dispose(): void {
    this.cubeTarget.dispose();
    this.envTarget?.dispose();
    this.envTarget = null;
    this.pmrem.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.captureSky.geometry.dispose();
    this.captureSky.material.dispose();
    this.sky.removeFromParent();
    this.sunLight.removeFromParent();
  }

  /** Port of the Preetham terms of Sky.js evaluated along the sun direction. */
  private computeSun(): void {
    const u = this.sky.material.uniforms;
    const turbidity = u.turbidity!.value as number;
    const rayleigh = u.rayleigh!.value as number;
    const mieCoefficient = u.mieCoefficient!.value as number;
    const cosZ = Math.max(-1, Math.min(1, this.sunDirection.y));
    // Sun intensity with the "earth shadow" cutoff (Sky.js: sunIntensity).
    const cutoff = 1.6110731556870734;
    const ee = 1000 * Math.max(0, 1 - Math.exp(-(cutoff - Math.acos(cosZ)) / 1.5));
    const totalRayleigh = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
    const mieConst = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
    const c = 0.2 * turbidity * 10e-18;
    const zenith = Math.acos(Math.max(0, cosZ));
    const inv = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));
    const sR = 8.4e3 * inv;
    const sM = 1.25e3 * inv;
    const rgb = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const betaR = totalRayleigh[i]! * rayleigh;
      const betaM = 0.434 * c * mieConst[i]! * mieCoefficient;
      const fex = Math.exp(-(betaR * sR + betaM * sM));
      // Same scale the Sky shader uses to light its clouds (E·F_ex·0.04), halved for a
      // physically plausible sun : sky irradiance ratio (~8:1 at noon).
      rgb[i] = ee * fex * 0.04 * 0.5;
    }
    this.sunIrradiance.setRGB(rgb[0]!, rgb[1]!, rgb[2]!);
    const peak = Math.max(rgb[0]!, rgb[1]!, rgb[2]!, 1e-6);
    this.sunLight.color.setRGB(rgb[0]! / peak, rgb[1]! / peak, rgb[2]! / peak);
    // three.js direct lighting: irradiance = intensity · colour · (n·l).
    this.sunLight.intensity = peak;
  }
}
