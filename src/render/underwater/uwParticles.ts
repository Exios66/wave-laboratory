/**
 * Drifting marine snow and night bioluminescent plankton: one `Points` draw. Positions are wrapped
 * around the camera in world space in the vertex shader, so the particles hang in the water and
 * stream past as the camera swims, instead of riding along with it. They sink slowly and drift
 * with the current. The specks write depth (alpha-tested discs) so the absorption pass fogs each
 * one by its own distance rather than by whatever lies behind it.
 */
import * as THREE from 'three';
import { mulberry32 } from '../../core/rng';

const VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCam;
uniform float uTime;
uniform float uBox;
uniform float uSize;
uniform vec2 uDrift;
varying float vFade;
void main() {
  float sink = 0.05 + 0.1 * aSeed.w;
  vec3 w = aSeed.xyz * uBox + vec3(uDrift.x * (0.6 + aSeed.w), -sink, uDrift.y * (0.6 + aSeed.w)) * uTime;
  vec3 rel = mod(w - uCam + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 world = uCam + rel;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = length(rel);
  float sz = uSize * (0.5 + aSeed.w);
  gl_PointSize = clamp(sz * 420.0 / max(0.4, -mv.z), 1.5, 16.0);
  // Fade at the edge of the box, and above the surface.
  vFade = (1.0 - smoothstep(uBox * 0.32, uBox * 0.5, dist)) * step(world.y, -0.3);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = (1.0 - smoothstep(0.18, 0.5, d)) * vFade * uOpacity;
  if (a < 0.12) discard;
  gl_FragColor = vec4(uColor * (0.55 + 0.9 * a), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class MarineParticles {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.BufferGeometry();

  constructor(readonly capacity: number) {
    const seed = new Float32Array(capacity * 4);
    const rnd = mulberry32(0x5a0bc1);
    for (let i = 0; i < seed.length; i++) seed[i] = rnd();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(capacity * 3), 3),
    );
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uBox: { value: 70 },
        uSize: { value: 0.3 },
        uDrift: { value: new THREE.Vector2(0.12, 0.05) },
        uColor: { value: new THREE.Color(0.6, 0.75, 0.8) },
        uOpacity: { value: 0.8 },
      },
      transparent: false,
      depthWrite: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'underwater-particles';
    this.points.frustumCulled = false;
  }

  /** `count` of the pool in use (a tier knob), the wrap box edge [m] and the look. */
  update(opts: {
    camera: THREE.Vector3;
    time: number;
    count: number;
    box: number;
    size: number;
    color: readonly [number, number, number];
    opacity: number;
    drift: readonly [number, number];
  }): void {
    const u = this.material.uniforms;
    (u.uCam!.value as THREE.Vector3).copy(opts.camera);
    u.uTime!.value = opts.time;
    u.uBox!.value = opts.box;
    u.uSize!.value = opts.size;
    (u.uDrift!.value as THREE.Vector2).set(opts.drift[0], opts.drift[1]);
    (u.uColor!.value as THREE.Color).setRGB(opts.color[0], opts.color[1], opts.color[2]);
    u.uOpacity!.value = opts.opacity;
    this.geometry.setDrawRange(0, Math.min(this.capacity, Math.max(0, opts.count)));
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
