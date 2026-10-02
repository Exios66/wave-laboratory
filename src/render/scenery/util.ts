/** Shared helpers for decorative scenery layers (geometry, disposal, deterministic noise). */
import * as THREE from 'three';

/** Integer hash → [0, 1). Stable across platforms. */
export function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Mix two integers into a [0, 1) value. */
export function hash2(a: number, b: number): number {
  return hash01(Math.imul(a | 0, 0x27d4eb2d) ^ (b | 0));
}

/**
 * Dispose mesh resources under `root`. Pass `shared: true` when geometries/materials are
 * owned by a GeometryPool or layer fields — then only the object graph is dropped.
 */
export function disposeObject3D(root: THREE.Object3D, opts: { shared?: boolean } = {}): void {
  const shared = opts.shared === true;
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (!shared) child.geometry.dispose();
    if (!shared) {
      const mat = child.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat.dispose();
    }
  });
}

/** Shared low-poly geometries reused across instances (disposed with the layer). */
export class GeometryPool {
  private readonly geos: THREE.BufferGeometry[] = [];

  share(geo: THREE.BufferGeometry): THREE.BufferGeometry {
    this.geos.push(geo);
    return geo;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    this.geos.length = 0;
  }
}

export function makeMat(
  color: number,
  opts: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.85,
    metalness: 0.02,
    ...opts,
  });
}
