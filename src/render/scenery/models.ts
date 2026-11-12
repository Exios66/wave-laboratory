/**
 * CC0 scenery models (Poly Haven, see public/models/CREDITS.md), loaded on demand.
 *
 * Each model is flattened to one geometry per material ("parts") so a layer can draw many copies
 * with one InstancedMesh per part. Nothing waits on a model: layers keep their procedural meshes
 * until `get()` returns parts, and keep them for good if a load fails (one warning, no retry).
 *
 * The files are meshopt-compressed GLB with WebP textures, written by scripts/fetch-models.mjs.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type ModelName = 'rock-a' | 'rock-b' | 'buoy' | 'lifebuoy';

/**
 * Per-model albedo lift. The scenery around these models (sand, grass, huts) is bright, flat
 * vertex colour; the scanned rock and wood textures are dark, true-to-life albedo, which reads
 * as black next to it. A colour multiplier and a little self-light from the albedo bring them
 * into the same key.
 */
const LOOK: Record<ModelName, { tint: number; lift: number }> = {
  'rock-a': { tint: 2.3, lift: 0.12 },
  'rock-b': { tint: 1.4, lift: 0.08 },
  buoy: { tint: 1, lift: 0 },
  lifebuoy: { tint: 1.2, lift: 0.05 },
};

/** One material's share of a model, with every node transform baked in. */
export interface ModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/**
 * A plain Float32 copy of an attribute. Meshopt-compressed files store positions and normals as
 * quantized (normalized integer) data with the scale in the node transform; baking that
 * transform into an integer attribute would clamp it to ±1.
 */
function toFloat(
  a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): THREE.BufferAttribute {
  const n = a.itemSize;
  const out = new Float32Array(a.count * n);
  for (let i = 0; i < a.count; i++) {
    for (let k = 0; k < n; k++) out[i * n + k] = a.getComponent(i, k);
  }
  return new THREE.BufferAttribute(out, n);
}

/**
 * Flatten a loaded scene into one merged geometry per material (positions, normals, UVs; other
 * attributes are dropped so every mesh merges).
 */
export function partsFromScene(root: THREE.Object3D): ModelPart[] {
  root.updateMatrixWorld(true);
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const material = mats[0]!;
    const src = mesh.geometry;
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv'] as const) {
      const a = src.getAttribute(name);
      if (a) g.setAttribute(name, toFloat(a));
    }
    if (src.index) g.setIndex(src.index.clone());
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g.applyMatrix4(mesh.matrixWorld);
    const list = byMaterial.get(material) ?? [];
    list.push(g);
    byMaterial.set(material, list);
  });
  const parts: ModelPart[] = [];
  for (const [material, list] of byMaterial) {
    // Merge only geometries with the same attribute set.
    const key = (g: THREE.BufferGeometry) =>
      `${g.index ? 'i' : 'n'}:${Object.keys(g.attributes).sort().join(',')}`;
    const groups = new Map<string, THREE.BufferGeometry[]>();
    for (const g of list) groups.set(key(g), [...(groups.get(key(g)) ?? []), g]);
    for (const same of groups.values()) {
      const merged = same.length === 1 ? same[0]! : mergeGeometries(same);
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      parts.push({ geometry: merged, material });
      if (same.length > 1) for (const g of same) g.dispose();
    }
  }
  return parts;
}

type Loader = (url: string) => Promise<THREE.Object3D>;

function gltfLoader(): Loader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return (url) => loader.loadAsync(url).then((gltf) => gltf.scene);
}

export class ModelLibrary {
  private readonly parts = new Map<ModelName, ModelPart[]>();
  private readonly pending = new Map<ModelName, Promise<void>>();
  private readonly failed = new Set<ModelName>();
  private load: Loader | null;
  private disposed = false;

  /**
   * @param baseUrl where the GLB files are served (`<base>models/`)
   * @param loader injectable for tests; defaults to GLTFLoader with the meshopt decoder
   */
  constructor(
    private readonly baseUrl: string,
    loader?: Loader,
  ) {
    this.load = loader ?? null;
  }

  /** Start loading `names` (once each); returns when all have settled. */
  request(...names: ModelName[]): Promise<void> {
    return Promise.all(names.map((n) => this.start(n))).then(() => undefined);
  }

  /** The model's parts once loaded, else null (still loading, failed, or never requested). */
  get(name: ModelName): ModelPart[] | null {
    return this.parts.get(name) ?? null;
  }

  /** True when every model named is loaded. */
  ready(...names: ModelName[]): boolean {
    return names.every((n) => this.parts.has(n));
  }

  private start(name: ModelName): Promise<void> {
    const existing = this.pending.get(name);
    if (existing) return existing;
    this.load ??= gltfLoader();
    const p = this.load(`${this.baseUrl}${name}.glb`)
      .then((scene) => {
        const parts = partsFromScene(scene);
        // The renderer went away while this was loading: free it rather than keep it.
        if (this.disposed) {
          disposeParts(parts);
          return;
        }
        const look = LOOK[name];
        for (const part of parts) {
          const m = part.material as THREE.MeshStandardMaterial;
          if (!m.isMeshStandardMaterial) continue;
          m.envMapIntensity = 1;
          m.color.multiplyScalar(look.tint);
          if (look.lift > 0 && m.map) {
            m.emissiveMap = m.map;
            m.emissive.setScalar(look.lift);
          }
        }
        this.parts.set(name, parts);
      })
      .catch((err: unknown) => {
        this.failed.add(name);
        console.warn(`Scenery model ${name} did not load; keeping the procedural look.`, err);
      });
    this.pending.set(name, p);
    return p;
  }

  /** Whether a model failed to load (the procedural mesh stays). */
  hasFailed(name: ModelName): boolean {
    return this.failed.has(name);
  }

  dispose(): void {
    this.disposed = true;
    for (const parts of this.parts.values()) disposeParts(parts);
    this.parts.clear();
  }
}

function disposeParts(parts: readonly ModelPart[]): void {
  for (const p of parts) {
    p.geometry.dispose();
    const m = p.material as THREE.MeshStandardMaterial;
    for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap]) t?.dispose();
    m.dispose();
  }
}

/**
 * Many copies of one model: an InstancedMesh per part, all sharing the same instance matrices.
 * Write matrices with `set`, then `commit` the count.
 */
export class ModelInstances {
  readonly object = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[];
  readonly capacity: number;

  constructor(parts: ModelPart[], capacity: number, name: string) {
    this.capacity = capacity;
    this.object.name = name;
    this.meshes = parts.map((p, i) => {
      const m = new THREE.InstancedMesh(p.geometry, p.material, capacity);
      m.name = `${name}-${i}`;
      m.count = 0;
      this.object.add(m);
      return m;
    });
  }

  set(i: number, matrix: THREE.Matrix4): void {
    if (i >= this.capacity) return;
    for (const m of this.meshes) m.setMatrixAt(i, matrix);
  }

  commit(count: number): void {
    const n = Math.min(count, this.capacity);
    for (const m of this.meshes) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      // Bounds over the live instances, so the group is culled (and kept out of the shadow
      // pass) when none of it is near.
      if (n > 0) m.computeBoundingSphere();
    }
  }

  get count(): number {
    return this.meshes[0]?.count ?? 0;
  }

  /** Draw calls this adds when anything is shown. */
  get drawCalls(): number {
    return this.count > 0 ? this.meshes.length : 0;
  }

  dispose(): void {
    for (const m of this.meshes) m.dispose();
  }
}
