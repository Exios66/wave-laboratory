import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SprayPool } from './particles';
import type { SprayEmitter } from './particles';

const emitter = (x: number, life = 100): SprayEmitter => ({
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

function livePositions(pool: SprayPool): number[] {
  const geometry = pool.object.geometry;
  const position = geometry.getAttribute('position');
  return Array.from({ length: geometry.drawRange.count }, (_, i) => position.getX(i));
}

describe('SprayPool', () => {
  it('fills the free slot after compaction without overwriting survivors', () => {
    const pool = new SprayPool(4);
    try {
      pool.emit(emitter(10), 1);
      pool.emit(emitter(20, 0.1), 1);
      pool.emit(emitter(30), 2);
      pool.update(1, new THREE.Vector3(), 1, 400);
      expect(livePositions(pool)).toEqual([10, 30, 30]);

      pool.emit(emitter(40), 1);
      pool.update(0, new THREE.Vector3(), 1, 400);
      expect(livePositions(pool)).toEqual([10, 30, 30, 40]);
    } finally {
      pool.dispose();
    }
  });

  it('preserves the ring cursor across updates when the pool is full', () => {
    const pool = new SprayPool(4);
    try {
      pool.emit(emitter(10), 4);
      pool.emit(emitter(20), 1);
      pool.update(0, new THREE.Vector3(), 1, 400);
      expect(livePositions(pool)).toEqual([20, 10, 10, 10]);

      pool.emit(emitter(30), 1);
      pool.update(0, new THREE.Vector3(), 1, 400);
      expect(livePositions(pool)).toEqual([20, 30, 10, 10]);
    } finally {
      pool.dispose();
    }
  });
});
