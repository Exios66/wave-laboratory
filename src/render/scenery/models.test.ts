import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelInstances, ModelLibrary, partsFromScene, type ModelPart } from './models';

/** A scene shaped like a decoded meshopt file: quantized positions, scale in the node. */
function quantizedScene(): THREE.Object3D {
  const root = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  // Unit-range int16 positions, scaled 10× by the node transform.
  const pos = new Int16Array([0, 0, 0, 32767, 0, 0, 0, 32767, 0, 0, 0, 32767]);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3, true));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(8), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const stone = new THREE.MeshStandardMaterial({ name: 'stone' });
  const wood = new THREE.MeshStandardMaterial({ name: 'wood' });
  const a = new THREE.Mesh(geo, stone);
  a.scale.setScalar(10);
  const b = new THREE.Mesh(geo, stone);
  b.scale.setScalar(10);
  b.position.set(0, 0, 20);
  const c = new THREE.Mesh(geo.clone(), wood);
  c.position.set(5, 0, 0);
  const node = new THREE.Group();
  node.position.y = 1;
  node.add(a, b, c);
  root.add(node);
  return root;
}

describe('scenery models', () => {
  afterEach(() => vi.restoreAllMocks());

  it('merges a scene to one float geometry per material with transforms baked in', () => {
    const parts = partsFromScene(quantizedScene());
    expect(parts).toHaveLength(2);
    const stone = parts.find((p) => p.material.name === 'stone')!;
    const box = stone.geometry.boundingBox!;
    // Both stone meshes, at full 10 m scale (not clamped to ±1 by the int16 attribute).
    expect(box.max.x).toBeCloseTo(10, 2);
    expect(box.min.y).toBeCloseTo(1, 5);
    expect(box.max.y).toBeCloseTo(11, 2);
    expect(box.max.z).toBeCloseTo(30, 2);
    expect(stone.geometry.getAttribute('position').array).toBeInstanceOf(Float32Array);
    expect(stone.geometry.getAttribute('normal')).toBeDefined();
    expect(stone.geometry.index!.count).toBe(12);
    const wood = parts.find((p) => p.material.name === 'wood')!;
    expect(wood.geometry.boundingBox!.min.x).toBeCloseTo(5, 5);
  });

  it('loads each model once and lifts its albedo', async () => {
    const load = vi.fn(() => Promise.resolve(quantizedScene()));
    const lib = new ModelLibrary('/models/', load);
    expect(lib.get('rock-a')).toBeNull();
    await Promise.all([lib.request('rock-a'), lib.request('rock-a', 'buoy')]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledWith('/models/rock-a.glb');
    expect(lib.ready('rock-a', 'buoy')).toBe(true);
    const m = lib.get('rock-a')![0]!.material as THREE.MeshStandardMaterial;
    expect(m.color.r).toBeGreaterThan(1);
    lib.dispose();
    expect(lib.get('rock-a')).toBeNull();
  });

  it('keeps the procedural look, with one warning, when a model fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const load = vi.fn(() => Promise.reject(new Error('404')));
    const lib = new ModelLibrary('/models/', load);
    await lib.request('lifebuoy');
    await lib.request('lifebuoy');
    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lib.get('lifebuoy')).toBeNull();
    expect(lib.ready('lifebuoy')).toBe(false);
    expect(lib.hasFailed('lifebuoy')).toBe(true);
  });

  it('draws many copies with one instanced mesh per part', () => {
    const parts: ModelPart[] = partsFromScene(quantizedScene());
    const inst = new ModelInstances(parts, 4, 'test');
    expect(inst.object.children).toHaveLength(2);
    expect(inst.drawCalls).toBe(0);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 6; i++) inst.set(i, m.makeTranslation(i * 100, 0, 0));
    inst.commit(6);
    expect(inst.count).toBe(4);
    expect(inst.drawCalls).toBe(2);
    const mesh = inst.object.children[0] as THREE.InstancedMesh;
    expect(mesh.boundingSphere!.radius).toBeGreaterThan(100);
    inst.commit(0);
    expect(inst.drawCalls).toBe(0);
    inst.dispose();
  });
});
