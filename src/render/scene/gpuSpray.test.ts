import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GpuSprayPool } from './gpuSpray';
import type { SprayEmitter } from './particles';

const emitter = (x: number, life = 2): SprayEmitter => ({
  x,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  spread: 0,
  size: 1,
  life,
});

const tick = (p: GpuSprayPool, dt: number) => p.update(dt, 1, 400);
const ranges = (p: GpuSprayPool, name: string) =>
  (p.object.geometry.getAttribute(name) as THREE.BufferAttribute).updateRanges;

describe('GpuSprayPool', () => {
  it('is hidden until something is emitted and again after everything has died', () => {
    const pool = new GpuSprayPool(8);
    try {
      tick(pool, 0.1);
      expect(pool.object.visible).toBe(false);
      pool.emit(emitter(1, 0.5), 2);
      tick(pool, 0.1);
      expect(pool.object.visible).toBe(true);
      expect(pool.object.geometry.drawRange.count).toBe(2);
      tick(pool, 5);
      expect(pool.object.visible).toBe(false);
    } finally {
      pool.dispose();
    }
  });

  it('uploads only the written slots and splits at the ring wrap', () => {
    const pool = new GpuSprayPool(10);
    try {
      pool.emit(emitter(1), 8);
      tick(pool, 0.01);
      expect(ranges(pool, 'position')).toEqual([{ start: 0, count: 24 }]);
      pool.emit(emitter(2), 4); // slots 8,9 then 0,1
      tick(pool, 0.01);
      expect(ranges(pool, 'aVel')).toEqual([
        { start: 32, count: 8 },
        { start: 0, count: 8 },
      ]);
      expect(ranges(pool, 'aMisc').reduce((s, r) => s + r.count, 0)).toBe(16);
    } finally {
      pool.dispose();
    }
  });

  it('writes birth state, lifetime and the baked wind, and overwrites the oldest slot', () => {
    const pool = new GpuSprayPool(2);
    try {
      pool.emit({ ...emitter(5), vy: 3 }, 1, 7, -2);
      tick(pool, 1);
      pool.emit(emitter(6), 2);
      const g = pool.object.geometry;
      const misc = g.getAttribute('aMisc') as THREE.BufferAttribute;
      // Second emit wrote both slots at clock 1, replacing the first particle.
      expect(misc.getX(0)).toBeCloseTo(1);
      expect(misc.getX(1)).toBeCloseTo(1);
      expect(g.getAttribute('position').getX(0)).toBe(6);
    } finally {
      pool.dispose();
    }
  });

  it('keeps ages small by rebasing the clock', () => {
    const pool = new GpuSprayPool(4);
    try {
      pool.emit(emitter(1, 1e5), 1);
      for (let i = 0; i < 40; i++) tick(pool, 100);
      expect(pool.object.visible).toBe(true);
      const misc = pool.object.geometry.getAttribute('aMisc') as THREE.BufferAttribute;
      expect(misc.getX(0)).toBeLessThanOrEqual(0);
      expect(misc.getX(0)).toBeGreaterThan(-4000);
    } finally {
      pool.dispose();
    }
  });
});
