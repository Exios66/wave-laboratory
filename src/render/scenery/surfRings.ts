/**
 * Foam rings where waves break around rocks standing in the sea and around navigation buoys.
 * Every ring comes from one instanced mesh (one draw call), sized by the sea state through
 * `surfBand` and pulsing with the swash at the sea's wave period.
 */
import * as THREE from 'three';
import { surfBand, swashSpeed, SURF_MAX_WIDTH_M } from './surf';
import type { SceneryFrame, SceneryLayer } from './types';

/** A body the surf breaks around: centre in Three.js axes on the water, radius [m]. */
export interface SurfAnchor {
  x: number;
  z: number;
  r: number;
}

/** Anything that has rocks or buoys in the water. Appends its anchors to `out`. */
export interface SurfSource {
  surfAnchors(out: SurfAnchor[]): void;
}

/** Most rings drawn at once. */
export const SURF_RING_CAP = 64;
/** Rings farther than this from the camera [m] are too small to see and are not drawn. */
export const SURF_RING_RANGE = 1500;

/** How far outside the band's width the quad reaches, for the wobble and swash [×width]. */
const MARGIN = 1.6;

const RING_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute float aCore;
attribute float aSeed;
uniform float uPull;
varying vec2 vLocal;
varying float vCore;
varying float vSeed;
void main() {
  float outer = length(instanceMatrix[0].xyz);
  vLocal = position.xz * outer;
  vCore = aCore;
  vSeed = aSeed;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // Win the depth test against the wave surface within uPull metres, as the lagoon tint does.
  float d = length(mvPosition.xyz);
  vec4 pulled = projectionMatrix * vec4(mvPosition.xyz * max(0.05, 1.0 - uPull / max(d, 1e-3)), 1.0);
  gl_Position.z = pulled.z / pulled.w * gl_Position.w;
  #include <fog_vertex>
}
`;

const RING_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uFoam;
uniform float uLight;
uniform float uTime;
uniform float uSwash;
uniform float uSurfWidth;
uniform float uSurfStrength;
varying vec2 vLocal;
varying float vCore;
varying float vSeed;
void main() {
  float w = uSurfWidth;
  float angle = atan(vLocal.y, vLocal.x);
  float swash = 0.5 + 0.5 * sin(uTime * uSwash + vSeed * 17.0);
  float wob = 0.15 * w * sin(angle * 7.0 + vSeed * 31.0 + uTime * 1.1)
    + 0.08 * w * sin(angle * 13.0 - uTime * 1.7);
  float e = length(vLocal) - vCore - wob - 0.3 * w * swash;
  float foam = smoothstep(-0.3 * w, 0.0, e) * (1.0 - smoothstep(0.15 * w, w, e));
  float alpha = foam * (0.15 + 0.7 * uSurfStrength);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uFoam * uLight, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class SurfRingLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.InstancedMesh;
  private readonly core: THREE.InstancedBufferAttribute;
  private readonly seed: THREE.InstancedBufferAttribute;
  private readonly anchors: SurfAnchor[] = [];
  private readonly near: { a: SurfAnchor; d: number }[] = [];
  private readonly tmpM = new THREE.Matrix4();

  constructor(private readonly sources: readonly SurfSource[]) {
    this.object.name = 'surf';
    const g = new THREE.PlaneGeometry(2, 2, 1, 1);
    g.rotateX(-Math.PI / 2);
    this.core = new THREE.InstancedBufferAttribute(new Float32Array(SURF_RING_CAP), 1);
    this.seed = new THREE.InstancedBufferAttribute(new Float32Array(SURF_RING_CAP), 1);
    g.setAttribute('aCore', this.core);
    g.setAttribute('aSeed', this.seed);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uFoam: { value: new THREE.Color(0xffffff) },
          uLight: { value: 1 },
          uTime: { value: 0 },
          uSwash: { value: swashSpeed(Number.NaN) },
          uSurfWidth: { value: 0.5 },
          uSurfStrength: { value: 0 },
          uPull: { value: 1 },
        },
      ]),
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.mesh = new THREE.InstancedMesh(g, this.material, SURF_RING_CAP);
    this.mesh.name = 'surf-rings';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.object.add(this.mesh);
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
  }

  update(frame: SceneryFrame): void {
    if (!this.object.visible) return;
    const band = surfBand(frame.hs, frame.wavePeriod ?? Number.NaN);
    const u = this.material.uniforms;
    u.uTime!.value = frame.wallT;
    u.uSwash!.value = swashSpeed(frame.wavePeriod ?? Number.NaN);
    u.uSurfWidth!.value = band.width;
    u.uSurfStrength!.value = band.strength;
    u.uLight!.value = 0.12 + 0.88 * frame.daylight;
    u.uPull!.value = THREE.MathUtils.clamp(0.3 + 0.6 * frame.hs, 0.3, 3);

    const anchors = this.anchors;
    anchors.length = 0;
    for (const s of this.sources) s.surfAnchors(anchors);
    const cam = frame.camera.position;
    const near = this.near;
    near.length = 0;
    for (const a of anchors) {
      const d = Math.hypot(a.x - cam.x, a.z - cam.z);
      if (d <= SURF_RING_RANGE && a.r > 0) near.push({ a, d });
    }
    near.sort((p, q) => p.d - q.d);
    const n = Math.min(SURF_RING_CAP, near.length);
    const pad = MARGIN * Math.min(band.width, SURF_MAX_WIDTH_M);
    for (let i = 0; i < n; i++) {
      const a = near[i]!.a;
      const outer = a.r + pad;
      this.tmpM.makeScale(outer, 1, outer).setPosition(a.x, 0, a.z);
      this.mesh.setMatrixAt(i, this.tmpM);
      this.core.setX(i, a.r);
      // A stable phase per anchor, from where it sits.
      this.seed.setX(
        i,
        (((Math.floor(a.x) * 73856093) ^ (Math.floor(a.z) * 19349663)) >>> 0) / 4294967296,
      );
    }
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.core.needsUpdate = true;
      this.seed.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
