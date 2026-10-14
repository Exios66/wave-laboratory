import { describe, expect, it, vi } from 'vitest';
import {
  FloodingState,
  PUMP_DRAIN_TIME,
  planeForVolume,
  volumeBelowPlane,
  type Compartment,
  type FloodLoads,
} from './flooding';

// Two adjacent rectangular bays, each 10 × 10 × 6 m, with the bow bay first.
const bow: Compartment = {
  index: 0,
  xFwd: 10,
  xAft: 0,
  xc: 5,
  halfBeam: 5,
  zFloor: -3,
  zRoof: 3,
  capacity: 600,
  inertia: (10 * 10 ** 3) / 12,
};
const stern: Compartment = { ...bow, index: 1, xFwd: 0, xAft: -10, xc: -5 };
const state = () => new FloodingState([bow, stern], 1025, 9.80665);
const inputs = (eta = 0) => ({ nx: 0, ny: 0, nz: 1, originZ: 0, outsideLevel: () => eta });

describe('flooding state boundaries', () => {
  it.each([
    [100, 0],
    [0, 0],
    [-0.001, 1],
    [-100, 1],
  ])('maps body x=%s to bay %s', (x, index) => {
    expect(state().compartmentAt(x!)).toBe(index);
  });

  it('clamps fill to capacity and ignores missing bays', () => {
    const f = state();
    f.fill(0, 1000);
    f.fill(1, -10);
    f.fill(-1, 100);
    f.fill(2, 100);
    expect(Array.from(f.volume)).toEqual([600, 0]);
    expect(f.totalVolume).toBe(600);
    expect(f.totalMass).toBe(615000);
    expect(f.capacity).toBe(1200);
    expect(f.hasWater).toBe(true);
  });

  it('merges breaches by area-weighted position after clamping them inside the bay', () => {
    const f = state();
    f.breach(0, 2, 50, -30); // clamped to (5, -3)
    f.breach(0, 6, -5, 1);
    expect(f.breachArea[0]).toBe(8);
    expect(f.breachY[0]).toBeCloseTo(-2.5, 12);
    expect(f.breachZ[0]).toBeCloseTo(0, 12);
    expect(f.breachArea[1]).toBe(0);
    f.breach(0, 100, 5, 30);
    expect(f.breachArea[0]).toBe(60); // wall area, 10 × 6
    const position = [f.breachY[0], f.breachZ[0]];
    f.breach(0, 1, -5, -3);
    expect([f.breachY[0], f.breachZ[0]]).toEqual(position);
  });

  it('ignores nonpositive areas and invalid compartment indices', () => {
    const f = state();
    for (const area of [0, -1, NaN]) f.breach(0, area, 0, 0);
    for (const index of [-1, 2, 0.5]) f.breach(index, 1, 0, 0);
    expect(f.breached).toBe(false);
    expect(Array.from(f.breachArea)).toEqual([0, 0]);
  });

  it('sealing preserves water; resetting empties all bays and stops pumps', () => {
    const f = state();
    f.fill(0, 200);
    f.fill(1, 100);
    f.breach(0, 1, 5, -2);
    f.seal();
    expect(f.breached).toBe(false);
    expect(f.totalVolume).toBe(300);
    f.breach(1, 1, -5, -2);
    f.pumping = true;
    f.reset();
    expect(f.hasWater).toBe(false);
    expect(f.breached).toBe(false);
    expect(f.pumping).toBe(false);
    expect(f.totalMass).toBe(0);
  });

  it('counts free surface only in partially filled bays', () => {
    const f = state();
    expect(f.freeSurfaceMoment()).toBe(0);
    f.fill(0, 600);
    expect(f.freeSurfaceMoment()).toBe(0);
    f.fill(1, 300);
    expect(f.freeSurfaceMoment()).toBeCloseTo(1025 * stern.inertia, 6);
    expect(f.uprightCentroid(1)).toEqual({ x: -5, y: 0, z: -1.5 });
    expect(f.weightMoment(3)).toBeCloseTo(1025 * (600 * 3 + 300 * 1.5), 6);
  });

  it('clears reused force output when dry after previously carrying water', () => {
    const f = state();
    const out: FloodLoads = { fx: 0, fy: 0, fz: 0, mx: 0, my: 0, mz: 0 };
    f.fill(0, 300);
    expect(f.loads(0, 0, 1, out)).toBe(out);
    expect(out.fz).toBeCloseTo(-300 * 1025 * 9.80665, 6);
    expect(out.my).toBeCloseTo(-5 * out.fz, 6);
    f.reset();
    f.loads(0, 0, 1, out);
    expect(Object.values(out)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('flooding step boundaries', () => {
  it('drains only to the breach sill when the sea is below the hole', () => {
    const f = state();
    f.fill(0, 500); // water surface at z=2
    f.breach(0, 10, 5, -1);
    f.step(10000, inputs(-10));
    expect(f.volume[0]).toBeCloseTo(200, 6); // two metres remain below the sill
    f.step(10000, inputs(-10));
    expect(f.volume[0]).toBeCloseTo(200, 6);
    expect(f.volume[1]).toBe(0);
  });

  it('samples only breached bays at their body coordinates and respects the world origin', () => {
    const f = state();
    f.breach(1, 2, -5, -2);
    const outsideLevel = vi.fn(() => 10);
    f.step(10000, { ...inputs(), originZ: 10, outsideLevel });
    expect(outsideLevel).toHaveBeenCalledExactlyOnceWith(1, -5, -5, -2);
    expect(f.volume[1]).toBeCloseTo(300, 6);
    expect(f.volume[0]).toBe(0);
  });

  it('cannot overfill a submerged bay even for a very large time step', () => {
    const f = state();
    f.breach(0, 60, 5, -3);
    f.step(10000, inputs(100));
    expect(f.volume[0]).toBe(600);
    expect(f.volume[1]).toBe(0);
  });

  it('pumps at the specified rate, seals first, and stops after the last bay empties', () => {
    const f = state();
    f.fill(0, 600);
    f.fill(1, 150);
    f.breach(0, 10, 5, -2);
    f.pumping = true;
    const outsideLevel = vi.fn(() => 100);
    f.step(PUMP_DRAIN_TIME / 2, { ...inputs(), outsideLevel });
    expect(Array.from(f.volume)).toEqual([300, 0]);
    expect(f.pumping).toBe(true);
    expect(f.breached).toBe(false);
    expect(outsideLevel).not.toHaveBeenCalled();
    f.step(PUMP_DRAIN_TIME, inputs());
    expect(f.totalVolume).toBe(0);
    expect(f.pumping).toBe(false);
  });

  it.each([0, 0.1, 0.5, 0.9, 1])(
    'inverts volume at fill fraction %s with combined heel and trim',
    (fraction) => {
      // A normalized world-up vector tilted in both body axes, including end-wall clipping.
      const n = [0.6, 0.48, 0.64] as const;
      const plane = planeForVolume(bow, ...n, fraction * bow.capacity);
      expect(volumeBelowPlane(bow, ...n, plane)).toBeCloseTo(fraction * bow.capacity, 5);
    },
  );
});
