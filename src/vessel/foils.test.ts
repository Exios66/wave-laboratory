import { describe, expect, it } from 'vitest';
import type { LateralFoil } from './api';
import {
  END_PLATE,
  FOIL_STALL,
  KEEL_CD0,
  foilAero,
  foilCoefficients,
  foilForce,
  helmboldSlope,
} from './foils';

const foil: LateralFoil = {
  xLeRoot: 0,
  xLeTip: 0,
  chordRoot: 1,
  chordTip: 1,
  zRoot: 0,
  zTip: -2,
  area: 2,
  span: 2,
  aspect: 2,
  xCe: -0.5,
  zCe: -1,
  bulb: null,
};
const aero = foilAero(foil);
const force = (u: number, v: number, area = 2, rho = 1025) =>
  foilForce(u, v, area, aero, rho, { fx: 0, fy: 0 });

describe('foil coefficients', () => {
  it('accounts for the hull end plate and approaches the two-dimensional lift slope', () => {
    expect(aero.aspectEff).toBeCloseTo(2 * END_PLATE, 12);
    expect(aero.slope).toBeCloseTo(helmboldSlope(aero.aspectEff), 12);
    expect(helmboldSlope(0)).toBe(0);
    expect(helmboldSlope(1)).toBeLessThan(helmboldSlope(4));
    expect(helmboldSlope(1e6)).toBeCloseTo(2 * Math.PI, 4);
  });

  it.each([0, 0.1, FOIL_STALL, FOIL_STALL + 0.1, Math.PI / 2])(
    'has odd lift and even, positive drag at alpha=%s',
    (alpha) => {
      const a = foilCoefficients(alpha, aero);
      const b = foilCoefficients(-alpha, aero);
      expect(b.cl).toBeCloseTo(-a.cl, 12);
      expect(b.cd).toBeCloseTo(a.cd, 12);
      expect(a.cd).toBeGreaterThanOrEqual(KEEL_CD0);
    },
  );

  it('matches attached-flow lift and induced drag, including a custom profile drag', () => {
    const { cl, cd } = foilCoefficients(0.1, aero, 0.04);
    expect(cl).toBeCloseTo(aero.slope * 0.1, 12);
    expect(cd).toBeCloseTo(0.04 + cl ** 2 / (Math.PI * aero.aspectEff), 12);
    expect(foilCoefficients(0, aero)).toEqual({ cl: 0, cd: KEEL_CD0 });
    const broadside = foilCoefficients(Math.PI / 2, aero);
    expect(broadside.cl).toBeCloseTo(0, 12);
    expect(broadside.cd).toBeCloseTo(KEEL_CD0 + 1.2, 12);
  });

  it.each([FOIL_STALL, FOIL_STALL + (12 * Math.PI) / 180])(
    'joins the stall regimes continuously at %s',
    (alpha) => {
      const left = foilCoefficients(alpha - 1e-8, aero);
      const right = foilCoefficients(alpha + 1e-8, aero);
      expect(left.cl).toBeCloseTo(right.cl, 6);
      expect(left.cd).toBeCloseTo(right.cd, 6);
    },
  );
});

describe('foil force', () => {
  it('clears a reused output at rest and below the speed threshold', () => {
    const out = { fx: 123, fy: -456 };
    expect(foilForce(0, 0, 2, aero, 1025, out)).toBe(out);
    expect(out).toEqual({ fx: 0, fy: 0 });
    foilForce(1e-7, -1e-7, 2, aero, 1025, out);
    expect(out).toEqual({ fx: 0, fy: 0 });
  });

  it.each([1, -1])('opposes leeway and dissipates energy for travel direction %s', (direction) => {
    const u = 4 * direction;
    const v = 0.4;
    const f = force(u, v);
    expect(f.fy).toBeLessThan(0);
    const mirrored = force(u, -v);
    expect(mirrored.fx).toBeCloseTo(f.fx, 9);
    expect(mirrored.fy).toBeCloseTo(-f.fy, 9);
    const cd = foilCoefficients(Math.atan2(v, Math.abs(u)), aero).cd;
    // Lift does no work; only drag contributes to force dot velocity.
    expect(f.fx * u + f.fy * v).toBeCloseTo(-0.5 * 1025 * 2 * cd * Math.hypot(u, v) ** 3, 7);
  });

  it('reverses fore-aft force astern and scales with speed squared, density and area', () => {
    const f = force(4, 0.4);
    const astern = force(-4, 0.4);
    expect(astern.fx).toBeCloseTo(-f.fx, 9);
    expect(astern.fy).toBeCloseTo(f.fy, 9);
    for (const scaled of [force(8, 0.8), force(4, 0.4, 8), force(4, 0.4, 2, 4100)]) {
      expect(scaled.fx).toBeCloseTo(4 * f.fx, 8);
      expect(scaled.fy).toBeCloseTo(4 * f.fy, 8);
    }
  });

  it('produces pure profile drag in axial flow and no force without area', () => {
    expect(force(4, 0).fx).toBeCloseTo(-0.5 * 1025 * 16 * 2 * KEEL_CD0, 9);
    expect(force(4, 0).fy).toBeCloseTo(0, 12);
    expect(force(4, 0.4, 0).fx).toBeCloseTo(0, 12);
    expect(force(4, 0.4, 0).fy).toBeCloseTo(0, 12);
  });
});
