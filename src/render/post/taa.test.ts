import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  TAA_JITTER_SAMPLES,
  halton,
  historyWeight,
  isCameraCut,
  jitterOffset,
  historyUv,
  unjitterUv,
  type CameraSnapshot,
} from './taa';

describe('halton', () => {
  it('gives the radical inverse of the index in the base', () => {
    expect(halton(1, 2)).toBe(0.5);
    expect(halton(2, 2)).toBe(0.25);
    expect(halton(3, 2)).toBe(0.75);
    expect(halton(1, 3)).toBeCloseTo(1 / 3, 12);
    expect(halton(2, 3)).toBeCloseTo(2 / 3, 12);
    expect(halton(4, 3)).toBeCloseTo(4 / 9, 12);
  });
});

describe('jitterOffset', () => {
  it('cycles through 8 sub-pixel offsets whose mean is the pixel centre', () => {
    expect(TAA_JITTER_SAMPLES).toBe(8);
    let sx = 0;
    let sy = 0;
    for (let f = 0; f < 8; f++) {
      const [x, y] = jitterOffset(f);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
      sx += x;
      sy += y;
    }
    expect(Math.abs(sx / 8)).toBeLessThan(1e-3);
    expect(Math.abs(sy / 8)).toBeLessThan(1e-3);
    expect(jitterOffset(8)).toEqual(jitterOffset(0));
    expect(jitterOffset(13)).toEqual(jitterOffset(5));
  });

  it('gives distinct offsets within a cycle', () => {
    const seen = new Set<string>();
    for (let f = 0; f < 8; f++) seen.add(jitterOffset(f).join(','));
    expect(seen.size).toBe(8);
  });
});

describe('unjitterUv', () => {
  it("undoes three.js's setViewOffset shift for a point anywhere on screen", () => {
    const W = 640;
    const H = 360;
    const cam = new THREE.PerspectiveCamera(55, W / H, 0.5, 5000);
    cam.position.set(3, 20, 40);
    cam.lookAt(10, 0, -100);
    cam.updateMatrixWorld();
    const uv = (p: THREE.Vector3): [number, number] => {
      const v = p.clone().project(cam);
      return [(v.x + 1) / 2, (v.y + 1) / 2];
    };
    const points = [new THREE.Vector3(10, 0, -100), new THREE.Vector3(-60, 5, -300)];
    for (const [jx, jy] of [
      [0.3, -0.2],
      [-0.45, 0.4],
    ] as const) {
      for (const p of points) {
        const [u0, v0] = uv(p);
        cam.setViewOffset(W, H, jx, jy, W, H);
        const [u1, v1] = uv(p);
        cam.clearViewOffset();
        // A jittered render shows the point at (u1, v1); the shift recovers (u0, v0).
        const [du, dv] = unjitterUv([jx, jy], W, H);
        expect(u1 + du).toBeCloseTo(u0, 9);
        expect(v1 + dv).toBeCloseTo(v0, 9);
      }
    }
  });
});

describe('isCameraCut', () => {
  const at = (
    position: [number, number, number],
    yawDeg: number,
    pitchDeg = -10,
    fov = 55,
  ): CameraSnapshot => {
    const y = (yawDeg * Math.PI) / 180;
    const p = (pitchDeg * Math.PI) / 180;
    return {
      position,
      forward: [Math.cos(p) * Math.sin(y), Math.sin(p), -Math.cos(p) * Math.cos(y)],
      fov,
    };
  };

  it('ignores a still camera and ordinary motion', () => {
    const a = at([0, 40, 200], 0);
    expect(isCameraCut(a, a)).toBe(false);
    // A 0.1° orbit step.
    expect(isCameraCut(a, at([0.35, 40, 200], 0.1))).toBe(false);
    // An aircraft at 300 m covering 1.2 m in a frame.
    expect(isCameraCut(at([0, 300, 0], 45), at([0.85, 300, -0.85], 45))).toBe(false);
  });

  it('treats a sharp turn, a jump or a zoom as a cut', () => {
    const a = at([0, 40, 200], 0);
    expect(isCameraCut(a, at([0, 40, 200], 30))).toBe(true);
    expect(isCameraCut(a, at([0, 40, 0], 0))).toBe(true);
    expect(isCameraCut(a, at([0, 40, 200], 0, -10, 70))).toBe(true);
  });
});

describe('historyWeight', () => {
  it('keeps only the current frame up close and blends far away', () => {
    expect(historyWeight(0)).toBe(0);
    expect(historyWeight(5)).toBe(0);
    expect(historyWeight(40)).toBeCloseTo(0.9, 12);
    expect(historyWeight(5000)).toBeCloseTo(0.9, 12);
    let last = -1;
    for (let d = 0; d <= 60; d += 0.5) {
      const w = historyWeight(d);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
  });
});

describe('historyUv', () => {
  const camera = (x: number, yaw: number) => {
    const c = new THREE.PerspectiveCamera(55, 16 / 9, 0.5, 5000);
    c.position.set(x, 30, 0);
    c.rotation.set(-0.2, yaw, 0, 'YXZ');
    c.updateMatrixWorld();
    return c;
  };
  const viewProj = (c: THREE.PerspectiveCamera) =>
    new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
  /** Depth-buffer value (standard [0, 1]) of a world point seen by `c`, and its uv. */
  const project = (c: THREE.PerspectiveCamera, p: THREE.Vector3) => {
    const n = p.clone().applyMatrix4(viewProj(c));
    return { uv: [n.x * 0.5 + 0.5, n.y * 0.5 + 0.5] as [number, number], depth: n.z * 0.5 + 0.5 };
  };

  it('keeps a still camera on the same pixel, whatever the jitter', () => {
    const c = camera(0, 0.3);
    const vp = viewProj(c);
    const inv = vp.clone().invert();
    for (const jitter of [
      [0, 0],
      [0.3 / 800, -0.2 / 450],
      [-0.45 / 800, 0.4 / 450],
    ] as [number, number][]) {
      for (const uv of [
        [0.5, 0.5],
        [0.2, 0.7],
        [0.9, 0.35],
      ] as [number, number][]) {
        const got = historyUv(uv, () => 0.97, inv, vp, jitter, false)!;
        expect(got[0]).toBeCloseTo(uv[0], 9);
        expect(got[1]).toBeCloseTo(uv[1], 9);
      }
    }
  });

  it('reads the depth where the jittered frame drew the pixel', () => {
    const c = camera(0, 0);
    const vp = viewProj(c);
    const seen: [number, number][] = [];
    historyUv(
      [0.4, 0.6],
      (u, v) => (seen.push([u, v]), 0.9),
      vp.clone().invert(),
      vp,
      [0.001, -0.002],
      false,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBeCloseTo(0.399, 12);
    expect(seen[0]![1]).toBeCloseTo(0.602, 12);
  });

  it('follows a moving camera to where the point was last frame', () => {
    const prev = camera(0, 0.1);
    const now = camera(4, 0.13);
    const point = new THREE.Vector3(60, 0, -400);
    const a = project(prev, point);
    const b = project(now, point);
    const got = historyUv(
      b.uv,
      () => b.depth,
      viewProj(now).invert(),
      viewProj(prev),
      [0, 0],
      false,
    )!;
    expect(got[0]).toBeCloseTo(a.uv[0], 6);
    expect(got[1]).toBeCloseTo(a.uv[1], 6);
  });
});
