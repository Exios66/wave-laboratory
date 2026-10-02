/** Little sailors walking the decks. */
import * as THREE from 'three';
import type { VesselDefinition } from '../../vessel/api';
import type { SceneryFrame, SceneryLayer, SceneryVessel } from './types';
import { disposeObject3D, GeometryPool, hash01 } from './util';

interface Sailor {
  mesh: THREE.Group;
  vesselId: string;
  /** Phase along the deck walk [0–2). */
  phase: number;
  speed: number;
  lane: number;
  aft: THREE.Vector3;
  fwd: THREE.Vector3;
  /** Vessel body-frame group this sailor is attached to. */
  host: THREE.Group;
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
  private readonly bodyGeo = this.pool.share(new THREE.BoxGeometry(0.45, 1.1, 0.35));
  private readonly headGeo = this.pool.share(new THREE.SphereGeometry(0.22, 8, 6));
  private readonly mastGeo = this.pool.share(new THREE.BoxGeometry(2, 24, 2));
  private enabled = true;

  constructor() {
    this.object.name = 'sailors';
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.object.visible = enabled;
    for (const s of this.sailors) s.mesh.visible = enabled;
  }

  setVessels(vessels: readonly SceneryVessel[]): void {
    this.clearSailors();
    if (vessels.length === 0) {
      this.publishDebug();
      return;
    }
    for (const v of vessels) {
      try {
        this.spawnForVessel(v);
      } catch (err) {
        console.error('[scenery/sailors] failed to spawn crew on', v.id, err);
      }
    }
    this.publishDebug();
  }

  update(frame: SceneryFrame): void {
    if (!this.enabled) return;
    for (const s of this.sailors) {
      const motion = frame.vessels.find((v) => v.id === s.vesselId);
      if (motion?.capsized) {
        s.mesh.visible = false;
        continue;
      }
      s.mesh.visible = true;
      if (s.speed <= 0) continue; // static mast marker
      const seaFactor = 0.35 + 0.65 * frame.calm;
      s.phase = (s.phase + frame.dt * s.speed * seaFactor) % 2;
      const u = s.phase < 1 ? s.phase : 2 - s.phase;
      const x = THREE.MathUtils.lerp(s.aft.x, s.fwd.x, u);
      const y = THREE.MathUtils.lerp(s.aft.y, s.fwd.y, u) + s.lane;
      const z = THREE.MathUtils.lerp(s.aft.z, s.fwd.z, u);
      // Body → Three on the host: (x, z, −y). Host already carries world motion.
      s.mesh.position.set(x, z, -y);
      s.mesh.rotation.y = s.phase < 1 ? 0 : Math.PI;
      s.mesh.position.y += Math.sin(s.phase * Math.PI * 2) * 0.05;
    }
    if (frame.wallT % 2 < frame.dt) this.publishDebug();
  }

  private spawnForVessel(v: SceneryVessel): void {
    const def = v.definition;
    const count = Math.min(10, Math.max(2, Math.round(def.length / 22)));
    const bow = def.points.bow;
    const zDeck = deckHeight(def);
    const aftX = -def.length * 0.18;
    const fwdX = Math.min(bow.x - def.length * 0.06, def.length * 0.38);
    const sideBias = def.beam > 12 ? 0.455 : 0.2;

    // Magenta mast on the bow — unmistakable if the host group is the rendered vessel.
    const mastMat = new THREE.MeshBasicMaterial({ color: 0xff00ff, toneMapped: false });
    const mast = new THREE.Group();
    mast.name = 'sailor-mast';
    const mastMesh = new THREE.Mesh(this.mastGeo, mastMat);
    mastMesh.position.y = 12;
    mastMesh.frustumCulled = false;
    mast.add(mastMesh);
    mast.position.set(fwdX, zDeck, 0);
    mast.frustumCulled = false;
    mast.userData.mats = [mastMat];
    v.group.add(mast);
    this.sailors.push({
      mesh: mast,
      vesselId: v.id,
      phase: 0,
      speed: 0,
      lane: 0,
      aft: new THREE.Vector3(fwdX, 0, zDeck),
      fwd: new THREE.Vector3(fwdX, 0, zDeck),
      host: v.group,
    });

    for (let i = 0; i < count; i++) {
      const seed = Math.imul(Math.round(def.length * 1000) + i, 2654435761) >>> 0;
      const mesh = this.makeSailor(seed);
      const lane = (i % 2 === 0 ? 1 : -1) * def.beam * (sideBias + hash01(seed + 3) * 0.015);
      mesh.position.set(aftX, zDeck, -lane);
      const scale = def.beam > 12 ? 7 : Math.min(3.2, Math.max(1.4, def.beam * 0.22));
      mesh.scale.setScalar(scale);
      mesh.frustumCulled = false;
      v.group.add(mesh);
      this.sailors.push({
        mesh,
        vesselId: v.id,
        phase: hash01(seed + 1),
        speed: 0.1 + hash01(seed + 2) * 0.08,
        lane,
        aft: new THREE.Vector3(aftX, 0, zDeck),
        fwd: new THREE.Vector3(fwdX, 0, zDeck),
        host: v.group,
      });
    }
  }

  private makeSailor(seed: number): THREE.Group {
    const g = new THREE.Group();
    g.name = 'sailor';
    const bodyColor = BODY_COLORS[Math.floor(hash01(seed) * BODY_COLORS.length)]!;
    const bodyMat = new THREE.MeshBasicMaterial({ color: bodyColor, toneMapped: false });
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffe4c8, toneMapped: false });
    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xffff66, toneMapped: false });
    const body = new THREE.Mesh(this.bodyGeo, bodyMat);
    body.position.y = 0.55;
    body.frustumCulled = false;
    const head = new THREE.Mesh(this.headGeo, headMat);
    head.position.y = 1.25;
    head.frustumCulled = false;
    const beacon = new THREE.Mesh(this.headGeo, beaconMat);
    beacon.position.y = 1.7;
    beacon.scale.setScalar(0.7);
    beacon.frustumCulled = false;
    g.add(body, head, beacon);
    g.userData.mats = [bodyMat, headMat, beaconMat];
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

  private publishDebug(): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as {
      __labSailors?: number;
      __labSailorPos?: number[][];
      __labSailorParents?: string[];
    };
    w.__labSailors = this.sailors.length;
    w.__labSailorParents = this.sailors.map(
      (s) => `${s.mesh.name}@${s.host.uuid.slice(0, 8)}:parent=${s.mesh.parent?.uuid.slice(0, 8) ?? 'none'}`,
    );
    w.__labSailorPos = this.sailors.map((s) => {
      const p = new THREE.Vector3();
      s.mesh.getWorldPosition(p);
      return [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1), s.mesh.visible ? 1 : 0];
    });
  }

  dispose(): void {
    this.clearSailors();
    this.pool.dispose();
    disposeObject3D(this.object, { shared: true });
  }
}
