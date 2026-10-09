import { describe, expect, it } from 'vitest';
import { foreAftCoefficients, sailAero } from './sails';

describe.each(['main', 'jib'] as const)('%s sail aerodynamics', (kind) => {
  it.each([0, -1, -Infinity, NaN])('rejects aspect ratio %s', (aspect) => {
    expect(() => sailAero(kind, aspect)).toThrow(RangeError);
  });

  it.each([0.5, 2, 5])('produces finite lift and drag for aspect ratio %s', (aspect) => {
    const aero = sailAero(kind, aspect);
    const { cl, cd } = foreAftCoefficients(Math.PI / 18, aero);
    expect(Number.isFinite(cl)).toBe(true);
    expect(Number.isFinite(cd)).toBe(true);
    expect(cl).toBeGreaterThan(0);
    expect(cd).toBeGreaterThan(0);
  });
});
