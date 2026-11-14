/**
 * Distant rain curtains: grey veils of rain hanging from the cloud base to the sea 2–8 km out,
 * upwind where the showers come from. One instanced mesh of upright quads that turn to face the
 * camera about the vertical, follow it (they are far enough that parallax would not show) and
 * fade into the fog like everything else at that range.
 */
import * as THREE from 'three';
import type { SceneryTier } from '../scenery/types';
import { CURTAIN_CAP, curtainCount, curtainPlacement } from './rainCurtains';

/** How tall the curtains are: the sea up to a storm's cloud base [m]. */
const CURTAIN_HEIGHT = 1400;
const MAX_CURTAINS = Math.max(...Object.values(CURTAIN_CAP));

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec2 vUv;
varying float vSeed;
void main() {
  vUv = uv;
  vSeed = float(gl_InstanceID);
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vSeed;
void main() {
  // Soft at both sides, densest just above the sea, thinning up into the cloud.
  float side = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
  float height = smoothstep(1.0, 0.45, vUv.y) * smoothstep(0.0, 0.04, vUv.y);
  // Uneven shafts of heavier rain across the curtain.
  float x = vUv.x * 9.0 + vSeed * 3.7;
  float shafts = 0.65 + 0.2 * sin(x * 2.3) + 0.15 * sin(x * 5.1 + 1.7);
  float a = side * height * shafts * uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface RainCurtainInput {
  /** Rain rate where the camera is [mm/h]. */
  rainMmH: number;
  tier: SceneryTier;
  /** Compass bearing the wind blows FROM [rad]. */
  windFromRad: number;
  camera: THREE.Camera;
  /** Scene light level, 0 (night) to 1 (bright day). */
  light: number;
}

export class RainCurtainLayer {
  readonly object = new THREE.Group();
  /** Fixed, so the same storm always hangs the same curtains. */
  readonly seed = 0x5eed;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.InstancedMesh;
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.object.name = 'rain-curtains';
    // Bottom edge on the sea, centred across.
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.geometry.translate(0, 0.5, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uColor: { value: new THREE.Color(0.55, 0.58, 0.62) }, uOpacity: { value: 0.5 } },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_CURTAINS);
    this.mesh.name = 'rain-curtains';
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.object.add(this.mesh);
  }

  update(input: RainCurtainInput): void {
    const n = curtainCount(input.rainMmH, input.tier);
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    const cam = input.camera.position;
    for (let i = 0; i < n; i++) {
      const p = curtainPlacement(this.seed, i, input.windFromRad);
      const dx = Math.sin(p.bearing) * p.distanceM;
      const dz = -Math.cos(p.bearing) * p.distanceM;
      // Face (local +z) back toward the camera.
      this.tmpQ.setFromAxisAngle(this.up, Math.atan2(-dx, -dz));
      this.tmpP.set(cam.x + dx, 0, cam.z + dz);
      this.tmpS.set(p.widthM, CURTAIN_HEIGHT, 1);
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      this.mesh.setMatrixAt(i, this.tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    const k = 0.25 + 0.75 * Math.min(1, Math.max(0, input.light));
    (this.material.uniforms.uColor!.value as THREE.Color).setRGB(0.55 * k, 0.58 * k, 0.62 * k);
    this.material.uniforms.uOpacity!.value = Math.min(0.6, 0.3 + input.rainMmH / 100);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
