/**
 * Vessel meshes built from `VesselDefinition.renderHull` and `superstructure` boxes.
 *
 * Geometry is converted once from the body frame (x fwd, y port, z up, relative to the CoG) to the
 * three.js-oriented body frame (x, z, −y); each frame the group is placed with
 * position (x, z, −y) and the body→world quaternion mapped the same way (see coords.ts).
 */
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  ShaderMaterial,
  type Material,
  type Object3D,
} from 'three';
import {
  mergeGeometries,
  mergeVertices,
  toCreasedNormals,
} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VesselDefinition, VesselTelemetry, VisualBox } from '../../vessel/api';
import { worldQuatToThree, worldToThree } from '../coords';

type BoxMaterialHint = VisualBox['material'];

const BOX_STYLE: Record<BoxMaterialHint, { color: string; roughness: number; metalness: number }> =
  {
    hull: { color: '#1f2c3b', roughness: 0.55, metalness: 0.1 },
    deck: { color: '#6f7468', roughness: 0.85, metalness: 0 },
    superstructure: { color: '#e9e7e1', roughness: 0.5, metalness: 0.05 },
    glass: { color: '#16242e', roughness: 0.08, metalness: 0.6 },
    cargo: { color: '#b9532f', roughness: 0.7, metalness: 0.15 },
    accent: { color: '#f0b43c', roughness: 0.5, metalness: 0.1 },
  };

/** Hull paint scheme: antifouling below the design waterline, boot-top stripe, topsides. */
const HULL_BOTTOM = new Color('#7d2a22');
const HULL_BOOT = new Color('#141414');
const HULL_TOP = new Color('#22324a');

export interface VesselEntry {
  id: string;
  definition: VesselDefinition;
  group: Group;
  outline: Mesh;
  /** Meshes that can be picked. */
  pickables: Object3D[];
  materials: Material[];
  geometries: BufferGeometry[];
}

const OUTLINE_VERTEX = /* glsl */ `
uniform float uWidth;
void main() {
  // Inverted-hull outline: push back faces outwards along the smooth normal.
  vec3 p = position + normalize(normal) * uWidth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const OUTLINE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
  #include <colorspace_fragment>
}
`;

/** Convert body-frame (z-up) xyz triples to three's orientation (x, z, −y), in place copy. */
function bodyToThree(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i]!;
    out[i + 1] = src[i + 2]!;
    out[i + 2] = -src[i + 1]!;
  }
  return out;
}

function hullMaterial(def: VesselDefinition): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 });
  // Waterline height in the body frame: keel at z = −KG, design waterline at z = T − KG.
  const waterline = def.draft - def.kg;
  const boot = Math.max(0.05, 0.035 * def.depth);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterline = { value: waterline };
    shader.uniforms.uBoot = { value: boot };
    shader.uniforms.uBottom = { value: HULL_BOTTOM };
    shader.uniforms.uBootColor = { value: HULL_BOOT };
    shader.uniforms.uTop = { value: HULL_TOP };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vBodyZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBodyZ = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vBodyZ;\nuniform float uWaterline;\nuniform float uBoot;\nuniform vec3 uBottom;\nuniform vec3 uBootColor;\nuniform vec3 uTop;',
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        // Paint bands by body-frame height (geometry is in three orientation: body z = y).
        'vec3 paint = vBodyZ < uWaterline ? uBottom : (vBodyZ < uWaterline + uBoot ? uBootColor : uTop);\nvec4 diffuseColor = vec4( paint, opacity );',
      );
  };
  mat.customProgramCacheKey = () => 'lab-hull-paint';
  return mat;
}

export function createVesselEntry(id: string, def: VesselDefinition): VesselEntry {
  const group = new Group();
  group.name = `Vessel:${id}`;
  const materials: Material[] = [];
  const geometries: BufferGeometry[] = [];
  const pickables: Object3D[] = [];

  // Hull: creased normals keep chines/knuckles sharp while smooth hulls stay smooth.
  const hullIndexed = new BufferGeometry();
  hullIndexed.setAttribute(
    'position',
    new BufferAttribute(bodyToThree(def.renderHull.positions), 3),
  );
  hullIndexed.setIndex(new BufferAttribute(def.renderHull.indices, 1));
  const hullGeom = toCreasedNormals(hullIndexed, Math.PI / 6);
  hullGeom.computeBoundingSphere();
  const hullMat = hullMaterial(def);
  const hull = new Mesh(hullGeom, hullMat);
  hull.name = 'Hull';
  hull.userData.pickId = id;
  group.add(hull);
  pickables.push(hull);
  materials.push(hullMat);
  geometries.push(hullGeom);

  // Superstructure boxes merged per material hint (one draw call per hint).
  const byHint = new Map<BoxMaterialHint, BufferGeometry[]>();
  for (const box of def.superstructure) {
    const g = new BoxGeometry(box.size.x, box.size.z, box.size.y);
    g.translate(box.center.x, box.center.z, -box.center.y);
    const list = byHint.get(box.material) ?? [];
    list.push(g);
    byHint.set(box.material, list);
  }
  const outlineParts: BufferGeometry[] = [stripToPositions(hullIndexed)];
  for (const [hint, list] of byHint) {
    const merged = mergeGeometries(list, false);
    for (const g of list) {
      outlineParts.push(stripToPositions(g));
      g.dispose();
    }
    if (!merged) continue;
    merged.computeBoundingSphere();
    const style = BOX_STYLE[hint];
    const mat = new MeshStandardMaterial({
      color: style.color,
      roughness: style.roughness,
      metalness: style.metalness,
    });
    const mesh = new Mesh(merged, mat);
    mesh.name = `Boxes:${hint}`;
    mesh.userData.pickId = id;
    group.add(mesh);
    pickables.push(mesh);
    materials.push(mat);
    geometries.push(merged);
  }
  hullIndexed.dispose();

  // Selection outline: smooth-normal copy of hull + boxes, rendered back faces only.
  const outlineMerged = mergeGeometries(outlineParts, false);
  for (const g of outlineParts) g.dispose();
  const outlineGeom = outlineMerged ? mergeVertices(outlineMerged, 1e-3) : new BufferGeometry();
  outlineMerged?.dispose();
  if (outlineGeom.getAttribute('position')) outlineGeom.computeVertexNormals();
  const outlineMat = new ShaderMaterial({
    name: 'SelectionOutline',
    vertexShader: OUTLINE_VERTEX,
    fragmentShader: OUTLINE_FRAGMENT,
    uniforms: {
      uWidth: { value: Math.min(0.6, Math.max(0.08, 0.006 * def.length)) },
      uColor: { value: new Color('#ffb627') },
    },
    side: BackSide,
  });
  const outline = new Mesh(outlineGeom, outlineMat);
  outline.name = 'SelectionOutline';
  outline.visible = false;
  outline.raycast = () => {};
  group.add(outline);
  materials.push(outlineMat);
  geometries.push(outlineGeom);

  return { id, definition: def, group, outline, pickables, materials, geometries };
}

/** Position-only, non-indexed-safe copy (so mergeVertices can weld shared corners). */
function stripToPositions(g: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry();
  const pos = g.getAttribute('position');
  out.setAttribute('position', pos.clone());
  const index = g.getIndex();
  if (index) out.setIndex(index.clone());
  return out;
}

/** Place a vessel from telemetry (world z-up) into the three.js scene. */
export function placeVessel(entry: VesselEntry, state: VesselTelemetry): void {
  worldToThree(state.position.x, state.position.y, state.position.z, entry.group.position);
  worldQuatToThree(state.attitude, entry.group.quaternion);
}

export function disposeVesselEntry(entry: VesselEntry): void {
  entry.group.removeFromParent();
  for (const m of entry.materials) m.dispose();
  for (const g of entry.geometries) g.dispose();
}
