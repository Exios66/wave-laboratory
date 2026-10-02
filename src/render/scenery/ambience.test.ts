import { describe, expect, it } from 'vitest';
import { calmFromConditions, ease } from './ambience';

describe('calmFromConditions', () => {
  it('is fully calm in a light breeze and small sea', () => {
    expect(calmFromConditions(0.6, 5)).toBe(1);
  });
  it('is stormy in a gale or a big sea', () => {
    expect(calmFromConditions(1, 20)).toBe(0);
    expect(calmFromConditions(3, 4)).toBe(0);
  });
  it('lets a weather system make it rougher but not calmer', () => {
    expect(calmFromConditions(0.5, 4, 1)).toBe(0);
    expect(calmFromConditions(3, 4, 0)).toBe(0);
  });
  it('falls monotonically as the sea builds', () => {
    let last = 2;
    for (let hs = 0; hs <= 3; hs += 0.1) {
      const c = calmFromConditions(hs, 6);
      expect(c).toBeLessThanOrEqual(last);
      last = c;
    }
  });
});

describe('ease', () => {
  it('approaches the target', () => {
    expect(ease(0, 1, 1e6, 2)).toBeCloseTo(1);
    expect(ease(0, 1, 0, 2)).toBe(0);
  });
});
