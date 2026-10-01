/**
 * Ocean geometry: camera-centred nested clipmap levels plus a horizon skirt.
 *
 * Level l has vertex spacing s_l = s₀·2^l and covers the square c_l ± M·s_l (M = CELLS) in label
 * (x₀) space. Its centre c_l is snapped to multiples of 2·s_l so vertices never swim, and so the
 * level's grid always coincides with every other vertex of level l + 1. Level 0 is a full grid;
 * levels ≥ 1 are rings whose hole (M/2 − 1 cells) is one cell smaller than the finer level, which
 * leaves a one-cell overlap that absorbs the ±1 cell offset between snapped centres. The fragment
 * shader discards whatever part of that overlap the finer level covers, and CDLOD-style morphing
 * makes the finer level's outer edge match the coarser grid exactly.
 */
import type { Vector3 } from 'three';
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  Vector2,
  type IUniform,
  type ShaderMaterial,
} from 'three';
import { createLevelUniforms, createWaterMaterial } from '../materials/waterMaterial';

export interface OceanMeshDensity {
  /** Half extent of every level in cells M (even). */
  cells: number;
  /** Number of nested levels. */
  levels: number;
}

/** Desktop density: 11 levels of 128² cells (~290 k triangles). */
export const DENSITY_HIGH: OceanMeshDensity = { cells: 64, levels: 11 };
/** Mobile / low-quality density: 12 levels of 64² cells (~80 k triangles). */
export const DENSITY_LOW: OceanMeshDensity = { cells: 32, levels: 12 };
/** Rings of the horizon skirt. */
const SKIRT_RINGS = 12;
/** Outer half extent of the skirt [m]. */
export const SKIRT_OUTER = 2.5e5;

interface LevelMesh {
  mesh: Mesh;
  material: ShaderMaterial;
  uniforms: Record<string, IUniform>;
}

export class OceanSurface {
  readonly group = new Group();
  private readonly gridGeometry: BufferGeometry;
  private readonly ringGeometry: BufferGeometry;
  private readonly skirtGeometry: BufferGeometry;
  private readonly levels: LevelMesh[] = [];
  private readonly skirt: LevelMesh;
  private readonly materials: ShaderMaterial[] = [];
  /** log₂ of the finest vertex spacing (adapted to the camera height with hysteresis). */
  private spacingLog2 = -3;
  private readonly centers: Vector2[] = [];
  private readonly cells: number;
  private readonly levelCount: number;

  constructor(
    cascadeCount: number,
    shared: Record<string, IUniform>,
    density: OceanMeshDensity = DENSITY_HIGH,
  ) {
    this.group.name = 'Ocean';
    this.cells = density.cells;
    this.levelCount = density.levels;
    const CELLS = this.cells;
    this.gridGeometry = buildGrid(CELLS, -1);
    this.ringGeometry = buildGrid(CELLS, CELLS / 2 - 1);
    this.skirtGeometry = buildSkirt(CELLS, SKIRT_RINGS);
    for (let l = 0; l < this.levelCount; l++) {
      const uniforms = createLevelUniforms();
      uniforms.uCells!.value = CELLS;
      const material = createWaterMaterial(cascadeCount, shared, uniforms);
      const mesh = new Mesh(l === 0 ? this.gridGeometry : this.ringGeometry, material);
      mesh.frustumCulled = false; // displaced on the GPU and camera-centred
      mesh.renderOrder = l; // front to back
      mesh.name = `OceanLevel${l}`;
      this.group.add(mesh);
      this.levels.push({ mesh, material, uniforms });
      this.materials.push(material);
      this.centers.push(new Vector2());
    }
    const uniforms = createLevelUniforms();
    uniforms.uMode!.value = 1;
    uniforms.uSkirtOuter!.value = SKIRT_OUTER;
    const material = createWaterMaterial(cascadeCount, shared, uniforms);
    const mesh = new Mesh(this.skirtGeometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = this.levelCount;
    mesh.name = 'OceanSkirt';
    this.group.add(mesh);
    this.skirt = { mesh, material, uniforms };
    this.materials.push(material);
  }

  /** All water materials (for overlay/tone-mapping switches). */
  get allMaterials(): readonly ShaderMaterial[] {
    return this.materials;
  }

  /** Re-centre the levels on the camera (three.js position). */
  update(cameraPosition: Vector3): void {
    const camX = cameraPosition.x;
    const camY = -cameraPosition.z; // world north
    const height = Math.max(0.5, Math.abs(cameraPosition.y));
    const CELLS = this.cells;
    const LEVEL_COUNT = this.levelCount;
    // Aim for ~0.5 % of the viewing distance per cell near the camera (scaled for coarser
    // meshes); hysteresis avoids flip-flopping between two spacings.
    const target = 0.005 * height * (64 / CELLS);
    const desired = Math.log2(Math.min(2, Math.max(1 / 32, target)));
    if (Math.abs(desired - this.spacingLog2) > 0.75) this.spacingLog2 = Math.round(desired);

    for (let l = 0; l < LEVEL_COUNT; l++) {
      const s = Math.pow(2, this.spacingLog2 + l);
      const snap = 2 * s;
      const c = this.centers[l]!.set(
        Math.round(camX / snap) * snap,
        Math.round(camY / snap) * snap,
      );
      const u = this.levels[l]!.uniforms;
      (u.uCenter!.value as Vector2).copy(c);
      u.uSpacing!.value = s;
      if (l > 0) {
        (u.uFineCenter!.value as Vector2).copy(this.centers[l - 1]!);
        // The shader shrinks this by one pixel footprint (MSAA-safe discard, see waterMaterial).
        u.uFineHalf!.value = CELLS * (s / 2);
      } else {
        u.uFineHalf!.value = -1;
      }
    }
    const sLast = Math.pow(2, this.spacingLog2 + LEVEL_COUNT - 1);
    const su = this.skirt.uniforms;
    (su.uCenter!.value as Vector2).copy(this.centers[LEVEL_COUNT - 1]!);
    su.uSkirtExtent!.value = CELLS * sLast;
    su.uSkirtSpacing!.value = 2 * sLast;
  }

  dispose(): void {
    this.gridGeometry.dispose();
    this.ringGeometry.dispose();
    this.skirtGeometry.dispose();
    for (const m of this.materials) m.dispose();
    this.group.removeFromParent();
  }
}

/**
 * (2M)×(2M) cell grid in integer cell coordinates [−M, M]², optionally without the cells inside
 * the square hole [−hole, hole]². Triangles are counter-clockwise seen from above (+z world),
 * which is front-facing in three.js after the (x, y, z) → (x, z, −y) mapping.
 */
function buildGrid(m: number, hole: number): BufferGeometry {
  const side = 2 * m + 1;
  const positions = new Float32Array(side * side * 3);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const o = 3 * (j * side + i);
      positions[o] = i - m;
      positions[o + 1] = j - m;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < 2 * m; j++) {
    for (let i = 0; i < 2 * m; i++) {
      const x0 = i - m;
      const y0 = j - m;
      if (hole > 0 && x0 >= -hole && x0 + 1 <= hole && y0 >= -hole && y0 + 1 <= hole) continue;
      const a = j * side + i;
      const b = a + 1;
      const c = a + side + 1;
      const d = a + side;
      // Alternate the diagonal so the triangulation is symmetric about the centre.
      if (x0 < 0 !== y0 < 0) idx.push(a, b, c, a, c, d);
      else idx.push(a, b, d, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(new BufferAttribute(new Uint32Array(idx), 1));
  return g;
}

/**
 * Skirt: square rings (unit square perimeter, 2/M spacing — matching the last level's morphed
 * edge, which only keeps even vertices) at ring parameter z = r / rings.
 */
function buildSkirt(m: number, rings: number): BufferGeometry {
  const per = 4 * m; // perimeter points (M segments per side)
  const positions = new Float32Array(per * (rings + 1) * 3);
  for (let r = 0; r <= rings; r++) {
    for (let p = 0; p < per; p++) {
      const side = Math.floor(p / m);
      const t = -1 + (2 * (p % m)) / m;
      let x: number;
      let y: number;
      // Counter-clockwise: bottom (y = −1, x ↑), right (x = 1, y ↑), top (y = 1, x ↓), left.
      if (side === 0) [x, y] = [t, -1];
      else if (side === 1) [x, y] = [1, t];
      else if (side === 2) [x, y] = [-t, 1];
      else [x, y] = [-1, -t];
      const o = 3 * (r * per + p);
      positions[o] = x;
      positions[o + 1] = y;
      positions[o + 2] = r / rings;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let p = 0; p < per; p++) {
      const i0 = r * per + p;
      const i1 = r * per + ((p + 1) % per);
      const o0 = (r + 1) * per + p;
      const o1 = (r + 1) * per + ((p + 1) % per);
      idx.push(i0, o0, o1, i0, o1, i1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(new BufferAttribute(new Uint32Array(idx), 1));
  return g;
}
