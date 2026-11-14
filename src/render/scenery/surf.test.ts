import { describe, expect, it } from 'vitest';
import { surfBand, swashSpeed } from './surf';

describe('surfBand', () => {
  it('is a faint lap on a calm sea', () => {
    expect(surfBand(0, 8)).toEqual({ width: 0.5, strength: 0 });
  });

  it('is full surf from 2.5 m significant wave height', () => {
    expect(surfBand(2.5, 9).strength).toBe(1);
    expect(surfBand(6, 11).strength).toBe(1);
  });

  it('caps the band at 8 m wide', () => {
    expect(surfBand(20, 12).width).toBe(8);
  });

  it('grows with the sea state', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 12;
    for (let k = 0; k < 50; k++) {
      const [a, b] = [rand(), rand()].sort((x, y) => x - y) as [number, number];
      const lo = surfBand(a, 9);
      const hi = surfBand(b, 9);
      expect(hi.width).toBeGreaterThanOrEqual(lo.width);
      expect(hi.strength).toBeGreaterThanOrEqual(lo.strength);
    }
  });
});

describe('swashSpeed', () => {
  it('runs the swash once per peak wave period', () => {
    expect(swashSpeed(8)).toBeCloseTo((2 * Math.PI) / 8, 12);
  });

  it('stays finite and gentle for a missing or tiny period', () => {
    expect(swashSpeed(0)).toBeCloseTo((2 * Math.PI) / 2, 12);
    expect(swashSpeed(Number.NaN)).toBeCloseTo(0.8, 12);
  });
});
