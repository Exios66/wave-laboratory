/**
 * Square rig of a sailing vessel: masts, yards braced to the angle the physics chose, and sails
 * that billow with the apparent wind and are furled up to their yards as the crew reefs.
 * Built in body coordinates (x forward, y port, z up) mapped to three.js as (x, z, −y).
 */
import * as THREE from 'three';
import type { SailPlan } from '../../vessel/api';

interface SailView {
  pivot: THREE.Group;
  sail: THREE.Mesh;
}

export class RigView {
  readonly group = new THREE.Group();
  private readonly sails: SailView[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(plan: SailPlan, colors: { wood: number; sail: number }, pickId: string) {
    const wood = new THREE.MeshStandardMaterial({ color: colors.wood, roughness: 0.8 });
    const canvas = new THREE.MeshStandardMaterial({
      color: colors.sail,
      roughness: 0.92,
      side: THREE.DoubleSide,
    });
    this.materials.push(wood, canvas);
    const tag = (o: THREE.Object3D) => {
      o.userData.pickKind = 'vessel';
      o.userData.pickId = pickId;
    };
    for (const mast of plan.masts) {
      const h = mast.zTop - mast.zFoot;
      const geo = new THREE.CylinderGeometry(0.16, 0.3, h, 10);
      this.geometries.push(geo);
      const m = new THREE.Mesh(geo, wood);
      m.position.set(mast.x, mast.zFoot + h / 2, 0);
      tag(m);
      this.group.add(m);
      for (const s of mast.sails) {
        const pivot = new THREE.Group();
        pivot.position.set(mast.x, s.zYard, 0);
        const yardGeo = new THREE.CylinderGeometry(0.1, 0.1, 2 * s.halfSpan + 0.6, 8);
        this.geometries.push(yardGeo);
        const yard = new THREE.Mesh(yardGeo, wood);
        yard.rotation.x = Math.PI / 2; // along body y (three −z)
        tag(yard);
        pivot.add(yard);
        const sailGeo = sailGeometry(s.halfSpan, s.drop);
        this.geometries.push(sailGeo);
        const sail = new THREE.Mesh(sailGeo, canvas);
        sail.position.x = 0.25;
        tag(sail);
        pivot.add(sail);
        this.group.add(pivot);
        this.sails.push({ pivot, sail });
      }
    }
  }

  /**
   * @param set fraction of canvas set 0–1
   * @param braceDeg yard angle from the centre line (+ = braced for wind from port)
   * @param awaDeg apparent wind angle off the bow (+ = from port)
   * @param apparent apparent wind speed [m/s]
   */
  update(set: number, braceDeg: number, awaDeg: number, apparent: number): void {
    const brace = Math.abs(braceDeg);
    // Square (90°) leaves the yards athwartships; less brace swings the windward yardarm
    // forward: wind from port → rotate clockwise seen from above.
    const yaw = (((90 - brace) * Math.PI) / 180) * (braceDeg >= 0 ? -1 : 1);
    const b = (awaDeg * Math.PI) / 180;
    // Air flow direction in the body frame (toward), and the sail's forward normal.
    const fx = -Math.cos(b);
    const fy = -Math.sin(b);
    const nx = Math.cos(yaw);
    const ny = Math.sin(yaw);
    const side = fx * nx + fy * ny >= 0 ? 1 : -1;
    const billow = side * Math.min(1, apparent / 6) * Math.sqrt(Math.max(set, 0));
    const drop = Math.max(0.06, set);
    for (const s of this.sails) {
      s.pivot.rotation.y = yaw;
      s.sail.scale.set(0.05 + Math.abs(billow), drop, 1);
      s.sail.scale.x *= Math.sign(billow) || 1;
    }
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

/**
 * Sail cloth hanging below its yard (three.js local: y down from the yard, z across) with a
 * unit belly along +x; the mesh is scaled to set the belly depth and the furled height.
 */
function sailGeometry(halfSpan: number, drop: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(2 * halfSpan, drop, 10, 8);
  geo.rotateY(Math.PI / 2); // plane spans three z (body y) and y
  geo.translate(0, -drop / 2, 0);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const across = pos.getZ(i) / halfSpan;
    const down = -pos.getY(i) / drop;
    // The foot is narrower than the head on the upper sails; the belly is deepest mid-sail.
    pos.setZ(i, pos.getZ(i) * (1 - 0.08 * down));
    const belly = (1 - across * across) * Math.sin(Math.PI * Math.min(1, down * 0.9 + 0.1));
    pos.setX(i, belly * drop * 0.16);
  }
  geo.computeVertexNormals();
  return geo;
}
