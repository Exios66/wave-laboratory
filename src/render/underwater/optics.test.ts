import { describe, expect, it } from 'vitest';
import { WATER_TYPES } from '../../ocean/waterTypes';
import {
  attenuate,
  clampBelowSurface,
  fallbackFogDensity,
  linearizeDepth,
  linearizeReversedDepth,
  nextUnderwaterState,
  snellWindowHalfAngle,
  underwaterInscatter,
} from './optics';

const deg = (r: number) => (r * 180) / Math.PI;

describe('Snell window', () => {
  it('is about 48.6 degrees for sea water', () => {
    expect(deg(snellWindowHalfAngle())).toBeCloseTo(48.6, 1);
  });
  it('is 90 degrees when the indices match', () => {
    expect(deg(snellWindowHalfAngle(1))).toBeCloseTo(90, 6);
  });
});

describe('attenuate', () => {
  it('is the identity at zero path and never brightens', () => {
    expect(attenuate([1, 0.5, 0.25], [0.3, 0.1, 0.05], 0)).toEqual([1, 0.5, 0.25]);
    for (const c of attenuate([1, 1, 1], [0.3, 0.1, 0.05], 10)) expect(c).toBeLessThan(1);
  });
  it('follows exp(-Kd d) per channel', () => {
    const out = attenuate([2, 2, 2], [0.5, 0.25, 0.1], 4);
    expect(out[0]).toBeCloseTo(2 * Math.exp(-2), 12);
    expect(out[1]).toBeCloseTo(2 * Math.exp(-1), 12);
    expect(out[2]).toBeCloseTo(2 * Math.exp(-0.4), 12);
  });
  it('lets blue survive longest in clear oceanic water', () => {
    const [r, g, b] = attenuate([1, 1, 1], WATER_TYPES['oceanic-i'].attenuation, 20);
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
  });
  it('lets green survive longest in turbid coastal water', () => {
    const [r, g, b] = attenuate([1, 1, 1], WATER_TYPES['coastal-9'].attenuation, 5);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });
});

describe('underwaterInscatter', () => {
  const { scatter, attenuation } = WATER_TYPES['oceanic-i'];
  const sum = (c: readonly number[]) => c[0]! + c[1]! + c[2]!;
  it('darkens with depth and at night', () => {
    const shallow = underwaterInscatter(scatter, attenuation, 2, 1, 0);
    const deep = underwaterInscatter(scatter, attenuation, 40, 1, 0);
    const night = underwaterInscatter(scatter, attenuation, 2, 1, 1);
    expect(sum(deep)).toBeLessThan(sum(shallow));
    expect(sum(night)).toBeLessThan(0.3 * sum(shallow));
  });
  it('loses red before blue with depth', () => {
    const a = underwaterInscatter(scatter, attenuation, 0, 1, 0);
    const b = underwaterInscatter(scatter, attenuation, 20, 1, 0);
    expect(b[0] / a[0]).toBeLessThan(b[2] / a[2]);
  });
  it('is never negative or NaN for odd inputs', () => {
    for (const c of underwaterInscatter(scatter, attenuation, -5, 2, -1)) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('nextUnderwaterState', () => {
  it('enters only once clearly below and leaves only once clearly above', () => {
    expect(nextUnderwaterState(-0.1, 0, false)).toBe(false);
    expect(nextUnderwaterState(-0.2, 0, false)).toBe(true);
    expect(nextUnderwaterState(0.1, 0, true)).toBe(true);
    expect(nextUnderwaterState(0.2, 0, true)).toBe(false);
  });
  it('follows the wave surface, not the mean level', () => {
    expect(nextUnderwaterState(1, 2, false)).toBe(true);
    expect(nextUnderwaterState(1, -2, true)).toBe(false);
  });
  it('does not chatter for a camera jittering inside the band', () => {
    let state = false;
    let flips = 0;
    for (let i = 0; i < 100; i++) {
      const next = nextUnderwaterState(0.1 * Math.sin(i), 0, state);
      if (next !== state) flips++;
      state = next;
    }
    expect(flips).toBe(0);
  });
});

describe('clampBelowSurface', () => {
  it('keeps the eye under the surface by the margin', () => {
    expect(clampBelowSurface(3, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(clampBelowSurface(-4, 1, 0.5)).toBe(-4);
  });
  it('stays underwater by the hysteresis once clamped', () => {
    const y = clampBelowSurface(5, 0.7, 0.5);
    expect(nextUnderwaterState(y, 0.7, false)).toBe(true);
  });
});

describe('depth linearisation', () => {
  const near = 0.2;
  const far = 40000;
  // Forward projection exactly as Matrix4.makePerspective builds it.
  const reversed = (d: number) => (near * (far - d)) / (d * (far - near));
  const standard = (d: number) => (far * (d - near)) / (d * (far - near));
  it('inverts the reversed-depth projection', () => {
    for (const d of [0.2, 1, 7.5, 120, 5000, 39000]) {
      expect(linearizeReversedDepth(reversed(d), near, far) / d).toBeCloseTo(1, 6);
    }
  });
  it('maps the buffer ends to the near and far planes', () => {
    expect(linearizeReversedDepth(1, near, far)).toBeCloseTo(near, 9);
    expect(linearizeReversedDepth(0, near, far)).toBeCloseTo(far, 6);
  });
  it('inverts the conventional projection too', () => {
    for (const d of [0.5, 10, 300]) {
      expect(linearizeDepth(standard(d), near, far) / d).toBeCloseTo(1, 6);
    }
  });
});

describe('fallbackFogDensity', () => {
  it('uses the green K_d with a floor', () => {
    expect(fallbackFogDensity([0.3, 0.12, 0.17])).toBe(0.12);
    expect(fallbackFogDensity([0.3, 0.001, 0.17])).toBe(0.004);
  });
});
