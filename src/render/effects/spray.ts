/**
 * Visual spray: one pool of point sprites shared by every vessel. Particles are thrown from the bow
 * while a ship makes way and in bursts when it slams or ships green water, then fall under gravity
 * and fade. Like the wake foam, this is decoration only and never feeds back into the physics.
 *
 * Three.js space (y up). Time comes from the drawn simulation time, so spray freezes when the
 * simulation is paused.
 */
import * as THREE from 'three';

const SPRAY_VERT = /* glsl */ `
attribute float aAlpha;
attribute float aSize;
uniform float uScale;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 0.0, 96.0);
  gl_Position = projectionMatrix * mv;
}
`;

const SPRAY_FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = dot(c, c) * 4.0;
  if (r > 1.0) discard;
  float a = vAlpha * (1.0 - r) * (1.0 - r);
  gl_FragColor = vec4(vec3(0.93, 0.96, 0.98), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const GRAVITY = 9.81;
/** Air drag on droplets [1/s]: spray slows quickly and does not fly ballistically far. */
const DRAG = 1.4;

export interface SprayEmit {
  /** Emission point (Three.js space). */
  x: number;
  y: number;
  z: number;
  /** Mean launch velocity [m/s]. */
  vx: number;
  vy: number;
  vz: number;
  /** Random velocity added on each axis, ± this much [m/s]. */
  jitter: number;
  /** Random offset of the emission point on each horizontal axis, ± this much [m]. */
  spread: number;
  /** Droplet sprite size [m]. */
  size: number;
}

export class SprayParticles {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly floor: Float32Array;
  private readonly alpha: Float32Array;
  private readonly size: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly material: THREE.ShaderMaterial;
  private next = 0;
  private live = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.floor = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 } },
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
  }

  /** Pixels per metre at unit distance: half the drawing-buffer height over tan(fov / 2). */
  setViewport(heightPx: number, fovDeg: number): void {
    const half = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
    this.material.uniforms.uScale!.value = (heightPx * 0.5) / Math.max(half, 1e-3);
  }

  get liveCount(): number {
    return this.live;
  }

  emit(e: SprayEmit, count: number): void {
    const n = Math.min(Math.floor(count), this.capacity);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      if (this.life[i]! <= 0) this.live++;
      const j = i * 3;
      this.pos[j] = e.x + (Math.random() * 2 - 1) * e.spread;
      this.pos[j + 1] = e.y;
      this.pos[j + 2] = e.z + (Math.random() * 2 - 1) * e.spread;
      this.vel[j] = e.vx + (Math.random() * 2 - 1) * e.jitter;
      this.vel[j + 1] = e.vy * (0.55 + Math.random() * 0.45);
      this.vel[j + 2] = e.vz + (Math.random() * 2 - 1) * e.jitter;
      const lifetime = 0.7 + Math.random() * 0.9;
      this.life[i] = lifetime;
      this.maxLife[i] = lifetime;
      this.floor[i] = e.y - 1.5 - e.size * 2;
      this.baseSize[i] = e.size * (0.6 + Math.random() * 0.8);
    }
    this.points.visible = this.live > 0;
  }

  update(dt: number): void {
    if (dt <= 0 || this.live === 0) return;
    const damp = Math.exp(-DRAG * dt);
    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) continue;
      const j = i * 3;
      this.vel[j] = this.vel[j]! * damp;
      this.vel[j + 1] = this.vel[j + 1]! * damp - GRAVITY * dt;
      this.vel[j + 2] = this.vel[j + 2]! * damp;
      this.pos[j] = this.pos[j]! + this.vel[j]! * dt;
      this.pos[j + 1] = this.pos[j + 1]! + this.vel[j + 1]! * dt;
      this.pos[j + 2] = this.pos[j + 2]! + this.vel[j + 2]! * dt;
      const left = this.life[i]! - dt;
      if (left <= 0 || this.pos[j + 1]! < this.floor[i]!) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      this.life[i] = left;
      const age = 1 - left / this.maxLife[i]!;
      // Fade in fast, thin out as the droplet cloud spreads.
      this.alpha[i] = Math.min(1, age * 8) * (1 - age) * 0.75;
      this.size[i] = this.baseSize[i]! * (1 + age * 1.6);
      live++;
    }
    this.live = live;
    this.points.visible = live > 0;
    const geo = this.points.geometry;
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('aAlpha').needsUpdate = true;
    geo.getAttribute('aSize').needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    this.live = 0;
    this.points.visible = false;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
