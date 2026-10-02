/** Little sailors walking the decks. */
import * as THREE from 'three';
import type { VesselDefinition } from '../../vessel/api';
import type { SceneryFrame, SceneryLayer, SceneryVessel } from './types';
import { disposeObject3D, GeometryPool, hash01, makeMat } from './util';

interface Sailor {
  mesh: THREE.Group;
  vesselId: string;
  /** Phase along the deck walk [0–1). */
  phase: number;
  speed: number;
  lane: number;
  /** Body-frame walk endpoints (x along length, y across beam, z deck). */
  aft: THREE.Vector3;
  fwd: THREE.Vector3;
}

/** High-vis gear so the figures read against dark decks. */
const BODY_COLORS = [0xf59e0b, 0xea580c, 0xdc2626, 0x2563eb, 0x0f766e];

/** Walkable deck height in body frame (above any flat `deck` plates). */
function deckHeight(def: VesselDefinition): number {
  let z = def.points.bow.z;
  for (const b of def.superstructure) {
    if (b.material === 'deck') z = Math.max(z, b.center.z + b.size.z * 0.5);
  }
  return z + 0.08;
}

export class SailorLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private readonly pool = new GeometryPool();
  private readonly sailors: Sailor[] = [];
  private readonly bodyGeo = this.pool.share(new THREE.CapsuleGeometry(0.22, 0.7, 3, 6));
  private readonly headGeo = this.pool.share(new THREE.SphereGeometry(0.2, 8, 6));

  constructor() {
    this.object.name = 'sailors';
    // Sailors live as children of vessel groups, so this root stays empty.
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
    for (const s of this.sailors) s.mesh.visible = enabled;
  }

  setVessels(vessels: readonly SceneryVessel[]): void {
    this.clearSailors();
    if (vessels.length === 0) return;
    for (const v of vessels) this.spawnForVessel(v);
  }

  update(frame: SceneryFrame): void {
    if (!this.object.visible) return;
    for (const s of this.sailors) {
      const motion = frame.vessels.find((v) => v.id === s.vesselId);
      if (motion?.capsized) {
        s.mesh.visible = false;
        continue;
      }
      s.mesh.visible = true;
      // Pace slows in heavy seas; they still brace-walk.
      const seaFactor = 0.35 + 0.65 * frame.calm;
      s.phase = (s.phase + frame.dt * s.speed * seaFactor) % 2;
      // Ping-pong along the deck.
      const u = s.phase < 1 ? s.phase : 2 - s.phase;
      const x = THREE.MathUtils.lerp(s.aft.x, s.fwd.x, u);
      const y = THREE.MathUtils.lerp(s.aft.y, s.fwd.y, u) + s.lane;
      const z = THREE.MathUtils.lerp(s.aft.z, s.fwd.z, u);
      s.mesh.position.set(x, z, -y);
      const goingFwd = s.phase < 1;
      s.mesh.rotation.y = goingFwd ? 0 : Math.PI;
      const bob = Math.sin(s.phase * Math.PI * 2) * 0.05;
      s.mesh.position.y += bob;
    }
  }

  private spawnForVessel(v: SceneryVessel): void {
    const def = v.definition;
    const count = Math.min(10, Math.max(2, Math.round(def.length / 22)));
    const bow = def.points.bow;
    const zDeck = deckHeight(def);
    // Keep clear of the stern propeller and the stem.
    const aftX = -def.length * 0.18;
    const fwdX = Math.min(bow.x - def.length * 0.06, def.length * 0.38);
    // Wide freighters: walk the outer catwalk outside the cargo footprint (≈ ±0.43–0.47 B).
    const sideBias = def.beam > 12 ? 0.455 : 0.2;
    for (let i = 0; i < count; i++) {
      const seed = Math.imul(Math.round(def.length * 1000) + i, 2654435761) >>> 0;
      const mesh = this.makeSailor(seed);
      const lane = (i % 2 === 0 ? 1 : -1) * def.beam * (sideBias + hash01(seed + 3) * 0.015);
      const sailor: Sailor = {
        mesh,
        vesselId: v.id,
        phase: hash01(seed + 1),
        speed: 0.1 + hash01(seed + 2) * 0.08,
        lane,
        aft: new THREE.Vector3(aftX, 0, zDeck),
        fwd: new THREE.Vector3(fwdX, 0, zDeck),
      };
      mesh.position.set(aftX, zDeck, -lane);
      // Slightly larger than life so they read at typical orbit distances.
      const scale = Math.min(4.5, Math.max(1.4, def.beam * 0.2));
      mesh.scale.setScalar(scale);
      // Draw above nearby deck plates so figures are not buried in cargo.
      mesh.traverse((c) => {
        if (c instanceof THREE.Mesh) {
          c.renderOrder = 2;
          c.material.depthTest = true;
        }
      });
      v.group.add(mesh);
      this.sailors.push(sailor);
    }
  }

  private makeSailor(seed: number): THREE.Group {
    const g = new THREE.Group();
    g.name = 'sailor';
    const bodyColor = BODY_COLORS[Math.floor(hash01(seed) * BODY_COLORS.length)]!;
    const body = new THREE.Mesh(
      this.bodyGeo,
      makeMat(bodyColor, { roughness: 0.55, emissive: bodyColor, emissiveIntensity: 0.12 }),
    );
    body.position.y = 0.55;
    const head = new THREE.Mesh(this.headGeo, makeMat(0xe8c4a2, { roughness: 0.65 }));
    head.position.y = 1.15;
    g.add(body, head);
    g.userData.mats = [body.material, head.material];
    return g;
  }

  private clearSailors(): void {
    for (const s of this.sailors) {
      s.mesh.parent?.remove(s.mesh);
      const mats = s.mesh.userData.mats as THREE.Material[] | undefined;
      if (mats) for (const m of mats) m.dispose();
    }
    this.sailors.length = 0;
  }

  dispose(): void {
    this.clearSailors();
    this.pool.dispose();
    disposeObject3D(this.object, { shared: true });
  }
}
