/**
 * GPU spray: a ring buffer of droplets whose flight is evaluated in the vertex shader (closed-form
 * ballistic motion with drag toward the wind, see sprayMath.ts). Emitting only writes the birth
 * state (position, velocity, lifetime, birth time, size, wind) into the next slots and uploads
 * just those ranges; there is no per-particle loop per frame. Purely visual. Smoke stays on the
 * CPU `SprayPool`.
 */
import * as THREE from 'three';
import { GPU_SPRAY_FRAG, GPU_SPRAY_VERT } from '../ocean/shaders';
import { SPRAY_STYLE } from './particles';
import type { ParticleStyle, SprayEmitter } from './particles';
import { GRAVITY, makeRng, planRingWrite } from './sprayMath';
import type { RingRange } from './sprayMath';

/** Birth times are float32; the clock is rebased before it costs visible precision. */
const REBASE_AT = 3600;
const DEAD = -1e9;

export class GpuSprayPool {
  readonly object: THREE.Points;
  readonly capacity: number;
  private readonly style: ParticleStyle;
  private readonly material: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly misc: Float32Array;
  private readonly rng = makeRng(0x5eed);
  private readonly skyTint = new THREE.Color(1, 1, 1);
  private next = 0;
  /** Highest slot ever written + 1; the draw range, so an idle pool draws nothing. */
  private used = 0;
  private clock = 0;
  /** Clock time after which every particle has died. */
  private expiry = 0;
  private dirty: RingRange[] = [];

  constructor(capacity: number, style: ParticleStyle = SPRAY_STYLE) {
    this.capacity = capacity;
    this.style = style;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 4);
    this.misc = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) this.misc[4 * i] = DEAD;
    const geo = new THREE.BufferGeometry();
    const attr = (a: Float32Array, n: number) =>
      new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr(this.pos, 3));
    geo.setAttribute('aVel', attr(this.vel, 4));
    geo.setAttribute('aMisc', attr(this.misc, 4));
    geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelScale: { value: 400 },
        uAspect: { value: 1.6 },
        uDrag: { value: style.drag },
        uGravity: { value: GRAVITY * style.gravity },
        uGrowth: { value: style.growth },
        uAlpha: { value: style.alpha },
        uColor: { value: new THREE.Color(0.92, 0.95, 0.97) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunK: { value: 0 },
      },
      vertexShader: GPU_SPRAY_VERT,
      fragmentShader: GPU_SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.object = new THREE.Points(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
    this.object.visible = false;
  }

  /** Emit `n` particles from an emitter (three.js coordinates), carried by the given wind. */
  emit(e: SprayEmitter, n: number, windX = 0, windZ = 0): void {
    if (n <= 0 || this.capacity === 0) return;
    const rng = this.rng;
    const r = () => (rng() * 2 - 1) * e.spread;
    const count = Math.min(n, this.capacity);
    const ranges = planRingWrite(this.next, count, this.capacity);
    let i = ranges[0]!.start;
    for (let k = 0; k < count; k++) {
      this.pos[3 * i] = e.x + r() * 0.15;
      this.pos[3 * i + 1] = e.y;
      this.pos[3 * i + 2] = e.z + r() * 0.15;
      const life = e.life * (0.6 + 0.8 * rng());
      this.vel[4 * i] = e.vx + r();
      this.vel[4 * i + 1] = e.vy + Math.abs(r()) * 0.6;
      this.vel[4 * i + 2] = e.vz + r();
      this.vel[4 * i + 3] = life;
      this.misc[4 * i] = this.clock;
      this.misc[4 * i + 1] = e.size * (0.6 + 0.8 * rng());
      this.misc[4 * i + 2] = windX;
      this.misc[4 * i + 3] = windZ;
      this.expiry = Math.max(this.expiry, this.clock + life);
      i = (i + 1) % this.capacity;
    }
    this.next = i;
    for (const rg of ranges) {
      this.dirty.push(rg);
      this.used = Math.max(this.used, rg.start + rg.count);
    }
  }

  /**
   * Set the scene lighting: unit vector toward the sun, how strongly it shines (0..1, falls with
   * cloud and at night) and the sky tint the droplets pick up.
   */
  setLighting(sunDir: THREE.Vector3, sunK: number, sky: THREE.Color): void {
    (this.material.uniforms.uSunDir!.value as THREE.Vector3).copy(sunDir);
    this.material.uniforms.uSunK!.value = sunK;
    this.skyTint.copy(sky);
  }

  /** Advance the clock and upload what was emitted (the wind is baked into each particle). */
  update(dt: number, light: number, pixelScale: number, aspect = 1.6): void {
    this.clock += dt;
    if (this.clock > REBASE_AT) this.rebase();
    this.object.visible = this.used > 0 && this.clock < this.expiry;
    if (!this.object.visible && this.dirty.length === 0) return;
    const geo = this.object.geometry;
    geo.setDrawRange(0, this.used);
    if (this.dirty.length > 0) {
      this.upload(geo.getAttribute('position') as THREE.BufferAttribute, 3);
      this.upload(geo.getAttribute('aVel') as THREE.BufferAttribute, 4);
      this.upload(geo.getAttribute('aMisc') as THREE.BufferAttribute, 4);
      this.dirty = [];
    }
    const u = this.material.uniforms;
    u.uTime!.value = this.clock;
    u.uPixelScale!.value = pixelScale;
    u.uAspect!.value = aspect;
    // Daylight colour, darker at night, a hair of sky tint. Kept well under the bloom threshold.
    const k = this.style.night + (1 - this.style.night) * light;
    const t = this.skyTint;
    const c = this.style.color;
    (u.uColor!.value as THREE.Color).setRGB(
      c[0] * k * (0.85 + 0.15 * t.r),
      c[1] * k * (0.85 + 0.15 * t.g),
      c[2] * k * (0.85 + 0.15 * t.b),
    );
  }

  /** Mark the written ranges for a partial upload (many tiny ranges collapse to the used span). */
  private upload(attr: THREE.BufferAttribute, size: number): void {
    attr.clearUpdateRanges();
    if (this.dirty.length > 12) attr.addUpdateRange(0, this.used * size);
    else for (const r of this.dirty) attr.addUpdateRange(r.start * size, r.count * size);
    attr.needsUpdate = true;
  }

  /** Shift every birth time back so the float32 clock stays small. */
  private rebase(): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.misc[4 * i]! > DEAD / 2) this.misc[4 * i]! -= this.clock;
    }
    this.expiry -= this.clock;
    this.clock = 0;
    this.dirty = [{ start: 0, count: this.used }];
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
