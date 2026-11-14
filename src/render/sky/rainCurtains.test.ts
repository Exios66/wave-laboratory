import { describe, expect, it } from 'vitest';
import type { CameraMode } from '../api';
import {
  curtainCount,
  curtainPlacement,
  CURTAIN_CAP,
  DROPLET_CAP,
  DROPLET_MAX_LIFE,
  lensDropletRate,
  lensSprayRate,
  shownDroplets,
  paintDroplet,
  stepDroplets,
  type Droplet,
} from './rainCurtains';

const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe('curtainCount', () => {
  it('shows none in drizzle (under 2 mm/h)', () => {
    expect(curtainCount(0, 'full')).toBe(0);
    expect(curtainCount(1.99, 'full')).toBe(0);
    expect(curtainCount(Number.NaN, 'full')).toBe(0);
  });

  it('adds one curtain per 4 mm/h, up to the tier cap', () => {
    expect(curtainCount(2, 'full')).toBe(1);
    expect(curtainCount(12, 'full')).toBe(3);
    expect(curtainCount(200, 'full')).toBe(8);
    expect(curtainCount(200, 'mid')).toBe(5);
    expect(curtainCount(200, 'lite')).toBe(0);
    expect(CURTAIN_CAP).toEqual({ full: 8, mid: 5, lite: 0 });
  });
});

describe('curtainPlacement', () => {
  it('stays within the distance, width and upwind bounds', () => {
    for (let seed = 0; seed < 40; seed++) {
      for (let i = 0; i < 8; i++) {
        const wind = (seed * 0.77) % (2 * Math.PI);
        const p = curtainPlacement(seed, i, wind);
        expect(p.distanceM).toBeGreaterThanOrEqual(2000);
        expect(p.distanceM).toBeLessThanOrEqual(8000);
        expect(p.widthM).toBeGreaterThanOrEqual(400);
        expect(p.widthM).toBeLessThanOrEqual(1500);
        expect(angleDiff(p.bearing, wind)).toBeLessThanOrEqual(Math.PI / 3 + 1e-9);
      }
    }
  });

  it('is deterministic for the same seed', () => {
    expect(curtainPlacement(7, 3, 1.2)).toEqual(curtainPlacement(7, 3, 1.2));
    expect(curtainPlacement(7, 3, 1.2)).not.toEqual(curtainPlacement(8, 3, 1.2));
  });
});

describe('lensDropletRate', () => {
  it('wets the lens only above water on the ship-side cameras', () => {
    const wet: CameraMode[] = ['bridge', 'follow', 'orbit'];
    const dry: CameraMode[] = ['top', 'plane', 'underwater'];
    for (const c of wet) expect(lensDropletRate(30, 0, c)).toBeGreaterThan(0);
    for (const c of dry) expect(lensDropletRate(30, 5, c)).toBe(0);
  });

  it('is zero without rain or spray, and grows with both', () => {
    expect(lensDropletRate(0, 0, 'bridge')).toBe(0);
    expect(lensDropletRate(Number.NaN, Number.NaN, 'bridge')).toBe(0);
    expect(lensDropletRate(20, 0, 'bridge')).toBeGreaterThan(lensDropletRate(5, 0, 'bridge'));
    expect(lensDropletRate(0, 4, 'bridge')).toBeGreaterThan(0);
    expect(lensDropletRate(5, 4, 'bridge')).toBeGreaterThan(lensDropletRate(5, 0, 'bridge'));
  });
});

describe('stepDroplets', () => {
  const seq = (...v: number[]) => {
    let i = 0;
    return () => v[i++ % v.length]!;
  };

  it('spawns at the rate, carrying the fraction between frames', () => {
    const s = { drops: [] as Droplet[], carry: 0 };
    stepDroplets(s, 3, 0.5, seq(0.5));
    expect(s.drops).toHaveLength(1);
    stepDroplets(s, 3, 0.5, seq(0.5));
    expect(s.drops).toHaveLength(3);
  });

  it('ages every drop and removes it at the end of its life (at most 4 s)', () => {
    const s = { drops: [] as Droplet[], carry: 0 };
    stepDroplets(s, 1, 1, seq(0.99));
    expect(s.drops).toHaveLength(1);
    const d = s.drops[0]!;
    expect(d.life).toBeGreaterThan(0);
    expect(d.life).toBeLessThanOrEqual(DROPLET_MAX_LIFE);
    expect(d.x).toBeGreaterThanOrEqual(0);
    expect(d.x).toBeLessThanOrEqual(1);
    for (let k = 0; k < 5; k++) stepDroplets(s, 0, 1, seq(0.5));
    expect(s.drops).toHaveLength(0);
  });

  it(`never holds more than ${DROPLET_CAP} drops`, () => {
    const s = { drops: [] as Droplet[], carry: 0 };
    for (let k = 0; k < 20; k++) stepDroplets(s, 12, 1, Math.random);
    expect(s.drops.length).toBeLessThanOrEqual(DROPLET_CAP);
  });

  it('ignores a non-finite or negative step', () => {
    const s = { drops: [] as Droplet[], carry: 0 };
    stepDroplets(s, 5, Number.NaN, seq(0.5));
    stepDroplets(s, 5, -1, seq(0.5));
    expect(s.drops).toHaveLength(0);
    expect(s.carry).toBe(0);
  });
});

describe('paintDroplet', () => {
  const size = 32;
  const px = (d: Uint8Array, x: number, y: number) =>
    Array.from(d.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));

  it('is a round drop: flat at the centre, clear outside the rim', () => {
    const d = paintDroplet(size);
    expect(d).toHaveLength(size * size * 4);
    const c = px(d, size / 2, size / 2);
    expect(Math.abs(c[0]! - 128)).toBeLessThanOrEqual(8);
    expect(Math.abs(c[1]! - 128)).toBeLessThanOrEqual(8);
    expect(c[3]).toBeGreaterThan(200);
    expect(px(d, 0, 0)[3]).toBe(0);
    expect(px(d, size - 1, size / 2)[3]).toBe(0);
  });

  it('bends light outward toward the rim, mirror-symmetric', () => {
    const d = paintDroplet(size);
    const right = px(d, size / 2 + 10, size / 2)[0]!;
    const left = px(d, size / 2 - 10, size / 2)[0]!;
    expect(right).toBeGreaterThan(160);
    expect(left).toBeLessThan(96);
    expect(Math.abs(right - 128 - (128 - left))).toBeLessThanOrEqual(16);
  });

  it('is the same every time', () => {
    expect(paintDroplet(size)).toEqual(paintDroplet(size));
  });
});

describe('lensSprayRate', () => {
  it('blows spindrift onto a lens near the sea in a gale only', () => {
    expect(lensSprayRate(10, 3)).toBe(0);
    expect(lensSprayRate(25, 3)).toBeCloseTo(4, 6);
  });

  it('keeps a camera high above the sea dry of spray', () => {
    expect(lensSprayRate(30, 40)).toBe(0);
    expect(lensSprayRate(30, 300)).toBe(0);
    expect(lensSprayRate(30, 15)).toBeLessThan(lensSprayRate(30, 3));
    expect(lensSprayRate(30, Number.NaN)).toBe(0);
  });
});

describe('shownDroplets', () => {
  const drops: Droplet[] = [{ x: 0.5, y: 0.5, r: 0.02, age: 0, life: 3 }];

  it('shows the drops on the wet cameras above water', () => {
    expect(shownDroplets(drops, 'bridge', 'full', false)).toBe(drops);
    expect(shownDroplets(drops, 'orbit', 'mid', false)).toBe(drops);
  });

  it('hides them (keeping them for later) on dry cameras, the lite tier and underwater', () => {
    expect(shownDroplets(drops, 'top', 'full', false)).toEqual([]);
    expect(shownDroplets(drops, 'plane', 'full', false)).toEqual([]);
    expect(shownDroplets(drops, 'bridge', 'lite', false)).toEqual([]);
    expect(shownDroplets(drops, 'bridge', 'full', true)).toEqual([]);
    expect(drops).toHaveLength(1);
  });
});
