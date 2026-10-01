/**
 * Wave-gauge buoys: a float (sphere) riding the probe's measured η with a pole and top light.
 * The probe measures at a fixed Eulerian point (x, y), so the marker only moves vertically.
 */
import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  type Object3D,
} from 'three';
import type { ProbeConfig } from '../../schema/experiment';
import type { ProbeReading } from '../../sim/types';
import { worldToThree } from '../coords';

const FLOAT_RADIUS = 0.6;
const POLE_HEIGHT = 3;

export class Probes {
  readonly group = new Group();
  private readonly floatGeom = new SphereGeometry(FLOAT_RADIUS, 24, 16);
  private readonly poleGeom = new CylinderGeometry(0.06, 0.06, POLE_HEIGHT, 10);
  private readonly lampGeom = new SphereGeometry(0.16, 12, 8);
  private readonly floatMat = new MeshStandardMaterial({ color: '#ff7a1a', roughness: 0.45 });
  private readonly poleMat = new MeshStandardMaterial({
    color: '#d9d9d9',
    roughness: 0.4,
    metalness: 0.3,
  });
  private readonly lampMat = new MeshStandardMaterial({
    color: '#ffd166',
    emissive: '#ffb703',
    emissiveIntensity: 2,
  });
  private readonly markers = new Map<string, { group: Group; x: number; y: number }>();
  readonly pickables: Object3D[] = [];

  constructor() {
    this.group.name = 'Probes';
  }

  setProbes(probes: readonly ProbeConfig[]): void {
    this.clear();
    for (const p of probes) {
      const g = new Group();
      g.name = `Probe:${p.id}`;
      const float = new Mesh(this.floatGeom, this.floatMat);
      const pole = new Mesh(this.poleGeom, this.poleMat);
      pole.position.y = POLE_HEIGHT / 2;
      const lamp = new Mesh(this.lampGeom, this.lampMat);
      lamp.position.y = POLE_HEIGHT;
      for (const m of [float, pole, lamp]) {
        m.userData.pickId = p.id;
        this.pickables.push(m);
        g.add(m);
      }
      worldToThree(p.x, p.y, 0, g.position);
      this.group.add(g);
      this.markers.set(p.id, { group: g, x: p.x, y: p.y });
    }
  }

  /** Ride the measured surface elevation. */
  update(readings: readonly ProbeReading[]): void {
    for (const r of readings) {
      const m = this.markers.get(r.id);
      if (m) worldToThree(m.x, m.y, r.eta, m.group.position);
    }
  }

  /** Probe position (three.js frame) for camera targeting. */
  positionOf(id: string): Object3D | undefined {
    return this.markers.get(id)?.group;
  }

  private clear(): void {
    for (const m of this.markers.values()) m.group.removeFromParent();
    this.markers.clear();
    this.pickables.length = 0;
  }

  dispose(): void {
    this.clear();
    this.floatGeom.dispose();
    this.poleGeom.dispose();
    this.lampGeom.dispose();
    this.floatMat.dispose();
    this.poleMat.dispose();
    this.lampMat.dispose();
    this.group.removeFromParent();
  }
}
