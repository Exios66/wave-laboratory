import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { shaftStrength, sunScreen, type ShaftInputs } from './sunShafts';

function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 20000);
  c.position.set(10, 5, -3);
  c.lookAt(10, 5, -100);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

describe('sunScreen', () => {
  it('puts a sun straight ahead in the middle of the view', () => {
    const s = sunScreen(new THREE.Vector3(0, 0, -1), camera());
    expect(s.x).toBeCloseTo(0.5, 6);
    expect(s.y).toBeCloseTo(0.5, 6);
    expect(s.facing).toBeCloseTo(1, 6);
  });

  it('places a higher sun higher on screen and flags a sun behind the camera', () => {
    const up = sunScreen(new THREE.Vector3(0, 0.3, -1).normalize(), camera());
    expect(up.y).toBeGreaterThan(0.5);
    expect(sunScreen(new THREE.Vector3(0, 0.2, 1).normalize(), camera()).facing).toBeLessThan(0);
  });
});

const base: ShaftInputs = {
  sunY: 0.25,
  cloud: 0.5,
  fogDensity: 1e-4,
  night: 0,
  facing: 0.9,
  x: 0.5,
  y: 0.6,
};

describe('shaftStrength', () => {
  it('is zero at night, below the horizon, behind the camera and under full overcast', () => {
    expect(shaftStrength({ ...base, night: 1 })).toBe(0);
    expect(shaftStrength({ ...base, sunY: -0.1 })).toBe(0);
    expect(shaftStrength({ ...base, facing: -0.2 })).toBe(0);
    expect(shaftStrength({ ...base, cloud: 1 })).toBe(0);
  });

  it('peaks with broken cloud', () => {
    const at = (cloud: number) => shaftStrength({ ...base, cloud });
    expect(at(0.5)).toBeGreaterThan(at(0.05));
    expect(at(0.5)).toBeGreaterThan(at(0.9));
    expect(at(0.05)).toBeGreaterThan(0);
  });

  it('grows in hazy air', () => {
    expect(shaftStrength({ ...base, fogDensity: 4e-4 })).toBeGreaterThan(
      shaftStrength({ ...base, fogDensity: 2e-5 }),
    );
  });

  it('fades as the sun leaves the frame', () => {
    const on = shaftStrength(base);
    const edge = shaftStrength({ ...base, x: 1.15 });
    const far = shaftStrength({ ...base, x: 1.5 });
    expect(edge).toBeLessThan(on);
    expect(edge).toBeGreaterThan(0);
    expect(far).toBe(0);
  });

  it('stays within [0, 1]', () => {
    for (const cloud of [0, 0.3, 0.5, 0.7]) {
      for (const fogDensity of [0, 1e-4, 1e-3, 1e-2]) {
        const s = shaftStrength({ ...base, cloud, fogDensity, facing: 1 });
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });
});
