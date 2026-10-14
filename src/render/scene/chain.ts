/**
 * The anchor chain: a thin tube drawn along the catenary the physics solved (the telemetry's
 * `profile`, horizontal distance from the anchor and height above it), from the anchor on the
 * bottom up to the hawse pipe, plus the anchor itself or a mooring buoy. Purely visual.
 */
import * as THREE from 'three';
import type { MooringTelemetry } from '../../vessel/api';

const RADIAL = 6;
/** Points along the tube (the profile is resampled to this many). */
const SEGMENTS = 40;

export class ChainView {
  readonly group = new THREE.Group();
  private readonly tube: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly marker: THREE.Mesh;
  private readonly buoy: THREE.Mesh;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly pts: THREE.Vector3[] = [];
  private readonly frameA = new THREE.Vector3();
  private readonly frameB = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly radius: number;

  /** `length` is the ship's length [m], which sets the link thickness and the buoy size. */
  constructor(length: number) {
    this.radius = 0.05 + 0.0012 * length;
    const n = SEGMENTS + 1;
    this.positions = new Float32Array(n * RADIAL * 3);
    const indices: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const a = i * RADIAL + j;
        const b = i * RADIAL + ((j + 1) % RADIAL);
        const c = (i + 1) * RADIAL + j;
        const d = (i + 1) * RADIAL + ((j + 1) % RADIAL);
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setIndex(indices);
    this.geometries.push(geo);
    const iron = new THREE.MeshStandardMaterial({
      color: 0x3b3f45,
      roughness: 0.55,
      metalness: 0.6,
      side: THREE.DoubleSide,
    });
    this.materials.push(iron);
    this.tube = new THREE.Mesh(geo, iron);
    this.tube.frustumCulled = false;
    for (let i = 0; i < n; i++) this.pts.push(new THREE.Vector3());

    const anchorGeo = new THREE.ConeGeometry(6 * this.radius, 14 * this.radius, 4);
    this.geometries.push(anchorGeo);
    this.marker = new THREE.Mesh(anchorGeo, iron);
    const buoyR = 0.5 + 0.008 * length;
    const buoyGeo = new THREE.SphereGeometry(buoyR, 16, 10);
    this.geometries.push(buoyGeo);
    const red = new THREE.MeshStandardMaterial({ color: 0xd9342b, roughness: 0.5 });
    this.materials.push(red);
    this.buoy = new THREE.Mesh(buoyGeo, red);
    this.group.add(this.tube, this.marker, this.buoy);
    this.group.visible = false;
  }

  /**
   * Draw the line for `m` up to `fairlead` (the hawse pipe as drawn, three.js axes), so the chain
   * meets the interpolated hull exactly. Hidden while no anchor is down.
   */
  update(m: MooringTelemetry, fairlead: THREE.Vector3): void {
    const profile = m.profile;
    this.group.visible = m.deployed && profile.length >= 4;
    if (!this.group.visible) return;
    // World (x east, y north, z up) → three.js (x, z, −y).
    const ax = m.anchor.x;
    const ay = m.anchor.y;
    const az = m.anchor.z;
    const dx = m.fairlead.x - ax;
    const dy = m.fairlead.y - ay;
    const dist = Math.hypot(dx, dy);
    const ux = dist > 1e-6 ? dx / dist : 1;
    const uy = dist > 1e-6 ? dy / dist : 0;
    // Resample the profile evenly by arc position.
    const count = profile.length / 2;
    const seg: number[] = [0];
    for (let k = 1; k < count; k++) {
      seg.push(
        seg[k - 1]! +
          Math.hypot(
            profile[2 * k]! - profile[2 * k - 2]!,
            profile[2 * k + 1]! - profile[2 * k - 1]!,
          ),
      );
    }
    const total = seg[count - 1]! || 1;
    let k = 1;
    for (let i = 0; i <= SEGMENTS; i++) {
      const s = (total * i) / SEGMENTS;
      while (k < count - 1 && seg[k]! < s) k++;
      const s0 = seg[k - 1]!;
      const f = seg[k]! > s0 ? (s - s0) / (seg[k]! - s0) : 0;
      const d = profile[2 * k - 2]! + f * (profile[2 * k]! - profile[2 * k - 2]!);
      const z = profile[2 * k - 1]! + f * (profile[2 * k + 1]! - profile[2 * k - 1]!);
      this.pts[i]!.set(ax + ux * d, az + z, -(ay + uy * d));
    }
    // The drawn hull moves between physics frames; spread the difference over the line.
    const end = this.pts[SEGMENTS]!;
    const ex = fairlead.x - end.x;
    const ey = fairlead.y - end.y;
    const ez = fairlead.z - end.z;
    for (let i = 0; i <= SEGMENTS; i++) {
      const w = i / SEGMENTS;
      this.pts[i]!.x += ex * w;
      this.pts[i]!.y += ey * w;
      this.pts[i]!.z += ez * w;
    }
    this.writeTube();
    this.marker.visible = m.kind === 'anchor';
    this.buoy.visible = m.kind === 'buoy';
    this.marker.position.set(ax, az + 7 * this.radius, -ay);
    this.marker.rotation.x = Math.PI; // flukes down
    this.buoy.position.set(ax, 0.3 * this.radius + 0.5, -ay);
  }

  /** Update tube geometry and normals around the current resampled line points. */
  private writeTube(): void {
    const pos = this.positions;
    const up = this.frameA;
    const side = this.frameB;
    const t = this.tangent;
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = this.pts[Math.max(0, i - 1)]!;
      const b = this.pts[Math.min(SEGMENTS, i + 1)]!;
      t.subVectors(b, a);
      if (t.lengthSq() < 1e-12) t.set(1, 0, 0);
      t.normalize();
      // Any frame perpendicular to the tangent will do for a round tube.
      up.set(0, 1, 0);
      if (Math.abs(t.y) > 0.95) up.set(1, 0, 0);
      side.crossVectors(t, up).normalize();
      up.crossVectors(side, t).normalize();
      const p = this.pts[i]!;
      for (let j = 0; j < RADIAL; j++) {
        const phi = (2 * Math.PI * j) / RADIAL;
        const c = Math.cos(phi) * this.radius;
        const s = Math.sin(phi) * this.radius;
        const o = 3 * (i * RADIAL + j);
        pos[o] = p.x + side.x * c + up.x * s;
        pos[o + 1] = p.y + side.y * c + up.y * s;
        pos[o + 2] = p.z + side.z * c + up.z * s;
      }
    }
    const attr = this.tube.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.tube.geometry.computeVertexNormals();
  }

  /** Release owned geometries and materials; the caller removes the group from its scene. */
  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
