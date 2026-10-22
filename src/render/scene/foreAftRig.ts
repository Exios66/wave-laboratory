/**
 * Fore-and-aft (Bermuda sloop) rig and fin keel of a yacht: a round mast, a boom that swings to
 * the sheeting angle the physics chose, and main and jib cloth that bellies to leeward with the
 * apparent wind and shrinks as the crew reefs. The keel (fin and ballast bulb) is drawn from the
 * lateral foils so the underwater camera sees what the physics uses.
 *
 * Built in body coordinates (x forward, y port, z up) mapped to three.js as (x, z, −y). Sheet
 * angles are signed and positive to starboard, the convention of `autoTrim` in `vessel/sails.ts`.
 * Purely visual: nothing here feeds back into the simulation.
 */
import * as THREE from 'three';
import type { ForeAftRig, LateralFoil } from '../../vessel/api';

/** Cloth grid resolution along the foot and up the luff. */
const NU = 6;
const NV = 8;
/** Largest belly depth as a fraction of the foot length. */
const BELLY = 0.14;
/** Smallest fraction of the luff left standing when the sail is fully reefed. */
const MIN_SET = 0.06;

interface ClothView {
  mesh: THREE.Mesh;
  position: THREE.BufferAttribute;
  tack: THREE.Vector3;
  head: THREE.Vector3;
  foot: number;
  /** Booms are carried by the main only. */
  boom: THREE.Group | null;
}

export class ForeAftRigView {
  readonly group = new THREE.Group();
  private readonly cloths: ClothView[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly jibIndex: number;

  constructor(
    rig: ForeAftRig,
    foils: readonly LateralFoil[],
    colors: { wood: number; sail: number },
    pickId: string,
  ) {
    const wood = new THREE.MeshStandardMaterial({ color: colors.wood, roughness: 0.8 });
    const canvas = new THREE.MeshStandardMaterial({
      color: colors.sail,
      roughness: 0.92,
      side: THREE.DoubleSide,
    });
    const keel = new THREE.MeshStandardMaterial({
      color: 0x3a4250,
      roughness: 0.5,
      metalness: 0.3,
    });
    this.materials.push(wood, canvas, keel);
    const tag = (o: THREE.Object3D) => {
      o.userData.pickKind = 'vessel';
      o.userData.pickId = pickId;
    };

    const mastH = rig.mast.zTop - rig.mast.zFoot;
    const mastGeo = new THREE.CylinderGeometry(0.07, 0.11, mastH, 10);
    this.geometries.push(mastGeo);
    const mast = new THREE.Mesh(mastGeo, wood);
    mast.position.set(rig.mast.x, rig.mast.zFoot + mastH / 2, 0);
    tag(mast);
    this.group.add(mast);

    this.jibIndex = rig.sails.findIndex((s) => s.kind === 'jib');
    for (const s of rig.sails) {
      const tack = new THREE.Vector3(s.tack.x, s.tack.z, -s.tack.y);
      const head = new THREE.Vector3(s.head.x, s.head.z, -s.head.y);
      const geo = new THREE.BufferGeometry();
      const position = new THREE.BufferAttribute(new Float32Array((NU + 1) * (NV + 1) * 3), 3);
      geo.setAttribute('position', position);
      const index: number[] = [];
      for (let j = 0; j < NV; j++) {
        for (let i = 0; i < NU; i++) {
          const a = j * (NU + 1) + i;
          index.push(a, a + 1, a + NU + 1, a + 1, a + NU + 2, a + NU + 1);
        }
      }
      geo.setIndex(index);
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, canvas);
      // The cloth moves every frame inside its bounds; skip per-frame bounding-sphere upkeep.
      mesh.frustumCulled = false;
      tag(mesh);
      this.group.add(mesh);

      let boom: THREE.Group | null = null;
      if (s.kind === 'main') {
        boom = new THREE.Group();
        boom.position.copy(tack);
        const boomGeo = new THREE.CylinderGeometry(0.05, 0.05, s.foot, 8);
        boomGeo.rotateZ(Math.PI / 2); // along x
        this.geometries.push(boomGeo);
        const spar = new THREE.Mesh(boomGeo, wood);
        spar.position.x = -s.foot / 2; // trails aft of the mast
        tag(spar);
        boom.add(spar);
        this.group.add(boom);
      }
      this.cloths.push({ mesh, position, tack, head, foot: s.foot, boom });
    }
    this.update(1, 0, 0, 0);

    for (const f of foils) {
      const shape = new THREE.Shape();
      shape.moveTo(f.xLeRoot, f.zRoot);
      shape.lineTo(f.xLeRoot + f.chordRoot, f.zRoot);
      shape.lineTo(f.xLeTip + f.chordTip, f.zTip);
      shape.lineTo(f.xLeTip, f.zTip);
      shape.closePath();
      const fin = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
      fin.translate(0, 0, -0.04); // centred on the centre plane (shape y is three y, up)
      this.geometries.push(fin);
      const finMesh = new THREE.Mesh(fin, keel);
      tag(finMesh);
      this.group.add(finMesh);
      if (f.bulb) {
        const bulbGeo = new THREE.SphereGeometry(1, 16, 10);
        bulbGeo.scale(f.bulb.length / 2, f.bulb.radius, f.bulb.radius);
        this.geometries.push(bulbGeo);
        const bulb = new THREE.Mesh(bulbGeo, keel);
        bulb.position.set(f.bulb.x, f.bulb.z, 0);
        tag(bulb);
        this.group.add(bulb);
      }
    }
  }

  /**
   * @param set fraction of canvas set 0–1
   * @param mainDeg main sheet angle from the centre line (+ = boom to starboard)
   * @param jibDeg jib sheet angle from the centre line (+ = clew to starboard)
   * @param apparent apparent wind speed [m/s] (fuller cloth in more wind)
   */
  update(set: number, mainDeg: number, jibDeg: number, apparent: number): void {
    const hoist = Math.max(MIN_SET, Math.min(1, set));
    const fill = Math.min(1, apparent / 6) * Math.sqrt(Math.max(0, Math.min(1, set)));
    this.cloths.forEach((c, k) => {
      const deg = k === this.jibIndex ? jibDeg : mainDeg;
      const s = (deg * Math.PI) / 180;
      // Horizontal direction the foot trails (three x, z) and the leeward-pointing normal.
      const dx = -Math.cos(s);
      const dz = Math.sin(s);
      const side = s >= 0 ? 1 : -1;
      const nx = side * Math.sin(s);
      const nz = side * Math.cos(s);
      if (c.boom) c.boom.rotation.y = s;
      const hx = c.tack.x + (c.head.x - c.tack.x) * hoist;
      const hy = c.tack.y + (c.head.y - c.tack.y) * hoist;
      const hz = c.tack.z + (c.head.z - c.tack.z) * hoist;
      const pos = c.position;
      for (let j = 0; j <= NV; j++) {
        const v = j / NV;
        // Luff point, and the clew-to-head leech line the free edge follows.
        const lx = c.tack.x + (hx - c.tack.x) * v;
        const ly = c.tack.y + (hy - c.tack.y) * v;
        const lz = c.tack.z + (hz - c.tack.z) * v;
        const width = c.foot * (1 - v);
        for (let i = 0; i <= NU; i++) {
          const u = i / NU;
          // Belly is deepest mid-chord and about a third of the way up.
          const belly =
            c.foot * BELLY * fill * Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.1 + 0.8 * v));
          pos.setXYZ(
            j * (NU + 1) + i,
            lx + dx * width * u + nx * belly,
            ly,
            lz + dz * width * u + nz * belly,
          );
        }
      }
      pos.needsUpdate = true;
      c.mesh.geometry.computeVertexNormals();
    });
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
