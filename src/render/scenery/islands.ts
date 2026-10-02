/** Scattered paradise islands across the endless sea. */
import * as THREE from 'three';
import type { SceneryFrame, SceneryLayer } from './types';
import { disposeObject3D, GeometryPool, hash2, makeMat } from './util';

const CHUNK = 900;
const VIEW_CHUNKS = 2;

interface IslandSpec {
  key: string;
  wx: number;
  wz: number;
  scale: number;
  seed: number;
}

export class IslandLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private readonly pool = new GeometryPool();
  private readonly live = new Map<string, THREE.Group>();
  private readonly sandMat = makeMat(0xc2a878, { roughness: 0.92 });
  private readonly rockMat = makeMat(0x6b7a5a, { roughness: 0.88 });
  private readonly trunkMat = makeMat(0x5c4033, { roughness: 0.9 });
  private readonly frondMat = makeMat(0x2f6b3a, { roughness: 0.7 });
  private readonly mats = [this.sandMat, this.rockMat, this.trunkMat, this.frondMat];
  private readonly hillGeo = this.pool.share(new THREE.ConeGeometry(1, 1.2, 7));
  private readonly sandGeo = this.pool.share(new THREE.CylinderGeometry(1.4, 1.6, 0.35, 10));
  private readonly trunkGeo = this.pool.share(new THREE.CylinderGeometry(0.06, 0.09, 1.4, 5));
  private readonly frondGeo = this.pool.share(new THREE.ConeGeometry(0.55, 0.7, 5));
  private lastCx = Number.NaN;
  private lastCz = Number.NaN;

  constructor() {
    this.object.name = 'islands';
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
  }

  update(frame: SceneryFrame): void {
    if (!this.object.visible) return;
    const cx = Math.floor(frame.camera.position.x / CHUNK);
    const cz = Math.floor(frame.camera.position.z / CHUNK);
    if (cx !== this.lastCx || cz !== this.lastCz) {
      this.lastCx = cx;
      this.lastCz = cz;
      this.rebuild(cx, cz);
    }
    // Soft night dimming on foliage.
    const night = 1 - frame.daylight;
    this.frondMat.emissive.setRGB(0.02 * night, 0.05 * night, 0.02 * night);
    this.frondMat.emissiveIntensity = night * 0.15;
  }

  private rebuild(cx: number, cz: number): void {
    const wanted = new Set<string>();
    for (let ix = cx - VIEW_CHUNKS; ix <= cx + VIEW_CHUNKS; ix++) {
      for (let iz = cz - VIEW_CHUNKS; iz <= cz + VIEW_CHUNKS; iz++) {
        const specs = this.chunkIslands(ix, iz);
        for (const spec of specs) {
          wanted.add(spec.key);
          if (!this.live.has(spec.key)) {
            const g = this.buildIsland(spec);
            this.live.set(spec.key, g);
            this.object.add(g);
          }
        }
      }
    }
    for (const [key, g] of this.live) {
      if (wanted.has(key)) continue;
      this.object.remove(g);
      disposeObject3D(g, { shared: true });
      this.live.delete(key);
    }
  }

  private chunkIslands(ix: number, iz: number): IslandSpec[] {
    // Keep the origin chunk empty so ships start in open water.
    if (ix === 0 && iz === 0) return [];
    const n = 1 + Math.floor(hash2(ix, iz) * 2);
    const out: IslandSpec[] = [];
    for (let i = 0; i < n; i++) {
      const u = hash2(ix * 17 + i, iz * 31 + 3);
      const v = hash2(ix * 41 + 5, iz * 7 + i);
      // Skip placements too close to chunk centres that cluster oddly.
      if (u < 0.22) continue;
      const wx = (ix + u) * CHUNK;
      const wz = (iz + v) * CHUNK;
      // Keep a quiet ring around the world origin.
      if (Math.hypot(wx, wz) < 420) continue;
      out.push({
        key: `${ix}:${iz}:${i}`,
        wx,
        wz,
        scale: 18 + hash2(ix + i * 9, iz + 11) * 42,
        seed: Math.floor(hash2(ix + i, iz + 99) * 1e9),
      });
    }
    return out;
  }

  private buildIsland(spec: IslandSpec): THREE.Group {
    const g = new THREE.Group();
    g.name = `island-${spec.key}`;
    g.position.set(spec.wx, 0, spec.wz);
    const s = spec.scale;
    const sand = new THREE.Mesh(this.sandGeo, this.sandMat);
    sand.scale.set(s, s * 0.35, s);
    sand.position.y = -0.05 * s;
    g.add(sand);
    const hills = 2 + Math.floor(hash2(spec.seed, 1) * 3);
    for (let i = 0; i < hills; i++) {
      const hill = new THREE.Mesh(this.hillGeo, this.rockMat);
      const r = 0.25 + hash2(spec.seed, 10 + i) * 0.55;
      const ang = hash2(spec.seed, 20 + i) * Math.PI * 2;
      const hs = s * (0.35 + hash2(spec.seed, 30 + i) * 0.55);
      hill.position.set(Math.cos(ang) * r * s * 0.55, hs * 0.45, Math.sin(ang) * r * s * 0.55);
      hill.scale.set(hs * 0.7, hs, hs * 0.7);
      hill.rotation.y = ang;
      g.add(hill);
    }
    const palms = 3 + Math.floor(hash2(spec.seed, 2) * 5);
    for (let i = 0; i < palms; i++) {
      const palm = new THREE.Group();
      const ang = hash2(spec.seed, 40 + i) * Math.PI * 2;
      const r = (0.4 + hash2(spec.seed, 50 + i) * 0.7) * s * 0.55;
      palm.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r);
      const lean = (hash2(spec.seed, 60 + i) - 0.5) * 0.35;
      palm.rotation.z = lean;
      const trunk = new THREE.Mesh(this.trunkGeo, this.trunkMat);
      const th = s * (0.12 + hash2(spec.seed, 70 + i) * 0.1);
      trunk.scale.set(s * 0.04, th, s * 0.04);
      trunk.position.y = th * 0.5;
      palm.add(trunk);
      const frond = new THREE.Mesh(this.frondGeo, this.frondMat);
      frond.scale.set(s * 0.09, s * 0.08, s * 0.09);
      frond.position.y = th + s * 0.02;
      palm.add(frond);
      g.add(palm);
    }
    return g;
  }

  dispose(): void {
    for (const g of this.live.values()) {
      this.object.remove(g);
      disposeObject3D(g, { shared: true });
    }
    this.live.clear();
    this.pool.dispose();
    for (const m of this.mats) m.dispose();
  }
}
