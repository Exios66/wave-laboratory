/** Little sailors walking the decks. */
import * as THREE from 'three';
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

const BODY_COLORS = [0x1e3a5f, 0x334155, 0x0f766e, 0x7c2d12, 0x1d4ed8];

export class SailorLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private readonly pool = new GeometryPool();
  private readonly sailors: Sailor[] = [];
  private readonly bodyGeo = this.pool.share(new THREE.CapsuleGeometry(0.18, 0.55, 3, 6));
  private readonly headGeo = this.pool.share(new THREE.SphereGeometry(0.16, 8, 6));

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
      // Face the walk direction (body x → three x; body y → −three z).
      const goingFwd = s.phase < 1;
      s.mesh.rotation.y = goingFwd ? 0 : Math.PI;
      // Soft bob with the gait.
      const bob = Math.sin(s.phase * Math.PI * 2) * 0.04;
      s.mesh.position.y += bob;
    }
  }

  private spawnForVessel(v: SceneryVessel): void {
    const def = v.definition;
    // Tiny craft get one hand; freighters get a watch section.
    const count = Math.min(8, Math.max(1, Math.round(def.length / 28)));
    const bow = def.points.bow;
    const bridge = def.points.bridge;
    const deckZ = Math.max(bow.z, bridge.z) * 0.15 + Math.min(bow.z, bridge.z) * 0.85;
    // Stay clear of the stern propeller and the stem.
    const aftX = -def.length * 0.28;
    const fwdX = Math.min(bow.x - def.length * 0.08, def.length * 0.32);
    for (let i = 0; i < count; i++) {
      const seed = Math.imul(def.length * 1000 + i, 2654435761) >>> 0;
      const mesh = this.makeSailor(seed);
      const lane = (i % 2 === 0 ? 1 : -1) * def.beam * (0.12 + hash01(seed + 3) * 0.18);
      const sailor: Sailor = {
        mesh,
        vesselId: v.id,
        phase: hash01(seed + 1),
        speed: 0.08 + hash01(seed + 2) * 0.07,
        lane,
        aft: new THREE.Vector3(aftX, 0, deckZ),
        fwd: new THREE.Vector3(fwdX, 0, deckZ + (bridge.z - deckZ) * 0.15),
      };
      // Body-frame: three.js group axes already match LabRenderer vessel groups.
      mesh.position.set(aftX, deckZ, 0);
      const scale = Math.min(1.35, Math.max(0.55, def.beam * 0.08));
      mesh.scale.setScalar(scale);
      v.group.add(mesh);
      this.sailors.push(sailor);
    }
  }

  private makeSailor(seed: number): THREE.Group {
    const g = new THREE.Group();
    g.name = 'sailor';
    const bodyColor = BODY_COLORS[Math.floor(hash01(seed) * BODY_COLORS.length)]!;
    const body = new THREE.Mesh(this.bodyGeo, makeMat(bodyColor, { roughness: 0.7 }));
    body.position.y = 0.45;
    const head = new THREE.Mesh(this.headGeo, makeMat(0xe8c4a2, { roughness: 0.65 }));
    head.position.y = 0.95;
    g.add(body, head);
    g.userData.mats = [body.material, head.material];
    return g;
  }

  private clearSailors(): void {
    for (const s of this.sailors) {
      s.mesh.parent?.remove(s.mesh);
      const mats = s.mesh.userData.mats as THREE.Material[] | undefined;
      if (mats) for (const m of mats) m.dispose();
      // Geometries are pooled; only dispose unique materials.
      s.mesh.traverse((c) => {
        if (c instanceof THREE.Mesh) {
          /* geometries shared via pool */
        }
      });
    }
    this.sailors.length = 0;
  }

  dispose(): void {
    this.clearSailors();
    this.pool.dispose();
    disposeObject3D(this.object, { shared: true });
  }
}
