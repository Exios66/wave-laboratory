/**
 * Visual particle effects: rain streaks around the camera, and a pool of spray sprites for bow
 * spray, slamming and green water and for spindrift blown off the crests in a gale. They are
 * purely visual and never feed back into the physics.
 */
import * as THREE from 'three';
import { RAIN_FRAG, RAIN_VERT, SPRAY_FRAG, SPRAY_VERT } from '../ocean/shaders';

export class RainField {
  readonly object: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
    const seeds = new Float32Array(max * 2 * 3);
    const ends = new Float32Array(max * 2);
    let s = 1234567;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < max; i++) {
      const x = rand();
      const y = rand();
      const z = rand();
      for (let e = 0; e < 2; e++) {
        const v = 2 * i + e;
        seeds[3 * v] = x;
        seeds[3 * v + 1] = y;
        seeds[3 * v + 2] = z;
        ends[v] = e;
      }
    }
    const geo = new THREE.BufferGeometry();
    // Positions are computed in the shader; three.js still needs a position attribute.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 2 * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uVel: { value: new THREE.Vector3(0, -7, 0) },
        uBox: { value: new THREE.Vector3(70, 46, 70) },
        uStreak: { value: 0.05 },
        uOpacity: { value: 0.3 },
        uColor: { value: new THREE.Color(0.75, 0.78, 0.82) },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.object = new THREE.LineSegments(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
  }

  /**
   * @param rain rain rate [mm/h]
   * @param windThree wind velocity in three.js coordinates [m/s]
   */
  update(t: number, rain: number, windThree: THREE.Vector3, light: number, fraction = 1): void {
    const active = rain > 0.2 ? Math.round(this.max * fraction * Math.min(1, 0.15 + rain / 35)) : 0;
    this.object.geometry.setDrawRange(0, active * 2);
    this.object.visible = active > 0;
    const u = this.material.uniforms;
    u.uTime!.value = t;
    // Terminal velocity of drops grows with drop size, i.e. with the rain rate (6–9 m/s).
    const fall = 6 + Math.min(3, rain / 20);
    (u.uVel!.value as THREE.Vector3).set(windThree.x * 0.9, -fall, windThree.z * 0.9);
    u.uOpacity!.value = (0.18 + Math.min(0.3, rain / 150)) * (0.4 + 0.6 * light);
    (u.uColor!.value as THREE.Color).setScalar(0.55 + 0.25 * light);
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

export interface SprayEmitter {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Random velocity spread [m/s]. */
  spread: number;
  size: number;
  life: number;
}

/** A pool of spray sprites integrated on the CPU (ballistic with air drag toward the wind). */
export class SprayPool {
  readonly object: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly sizeAttr: Float32Array;
  private next = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity).fill(1e9);
    this.life = new Float32Array(capacity).fill(1);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.sizeAttr = new Float32Array(capacity);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      'aAlpha',
      new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      'aSize',
      new THREE.BufferAttribute(this.sizeAttr, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelScale: { value: 400 },
        uColor: { value: new THREE.Color(0.92, 0.95, 0.97) },
      },
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.object = new THREE.Points(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
  }

  /** Emit `n` particles from an emitter (three.js coordinates). */
  emit(e: SprayEmitter, n: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      const r = () => (Math.random() * 2 - 1) * e.spread;
      this.pos[3 * i] = e.x + r() * 0.15;
      this.pos[3 * i + 1] = e.y;
      this.pos[3 * i + 2] = e.z + r() * 0.15;
      this.vel[3 * i] = e.vx + r();
      this.vel[3 * i + 1] = e.vy + Math.abs(r()) * 0.6;
      this.vel[3 * i + 2] = e.vz + r();
      this.age[i] = 0;
      this.life[i] = e.life * (0.6 + 0.8 * Math.random());
      this.size[i] = e.size * (0.6 + 0.8 * Math.random());
    }
  }

  /** Advance by dt with air drag relaxing toward the wind (three.js coordinates). */
  update(dt: number, wind: THREE.Vector3, light: number, pixelScale: number): void {
    const drag = 1 - Math.exp(-dt * 1.4);
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      const a = (this.age[i]! += dt);
      const life = this.life[i]!;
      if (a >= life) {
        this.alpha[i] = 0;
        this.sizeAttr[i] = 0;
        continue;
      }
      alive++;
      const j = 3 * i;
      this.vel[j]! += (wind.x - this.vel[j]!) * drag;
      this.vel[j + 2]! += (wind.z - this.vel[j + 2]!) * drag;
      this.vel[j + 1]! -= 9.81 * dt * 0.8;
      this.pos[j]! += this.vel[j]! * dt;
      this.pos[j + 1]! += this.vel[j + 1]! * dt;
      this.pos[j + 2]! += this.vel[j + 2]! * dt;
      const u = a / life;
      this.alpha[i] = 0.4 * Math.min(1, u * 8) * (1 - u) * (1 - u);
      this.sizeAttr[i] = this.size[i]! * (1 + 1.5 * u);
    }
    this.object.visible = alive > 0;
    const geo = this.object.geometry;
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('aAlpha').needsUpdate = true;
    geo.getAttribute('aSize').needsUpdate = true;
    this.material.uniforms.uPixelScale!.value = pixelScale;
    (this.material.uniforms.uColor!.value as THREE.Color).setScalar(0.4 + 0.55 * light);
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
