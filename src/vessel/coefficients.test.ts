import { describe, expect, it } from 'vitest';
import {
  RUDDER_STALL,
  clarkeDerivatives,
  ittc57,
  lewisAddedMass,
  rudderLift,
  thrustImmersionFactor,
} from './coefficients';

describe('ittc57', () => {
  it('matches the correlation line above the clamp', () => {
    // C_F = 0.075 / (log₁₀ Re − 2)²; at Re = 1e6 the denominator is (6 − 2)² = 16.
    expect(ittc57(1e6)).toBeCloseTo(0.075 / 16, 12);
    // At Re = 4e8: log₁₀(4e8) − 2 = 6.602059991329623.
    expect(ittc57(4e8)).toBeCloseTo(
      0.075 / (Math.log10(4) + 8 - 2) ** 2, // log10(4e8) = log10 4 + 8
      12,
    );
  });

  it('clamps to the model-scale value at rest so C_F stays finite', () => {
    // Below Re = 1e5 the line is meaningless; the clamp pins Re at 1e5 → denominator (5 − 2)² = 9.
    expect(ittc57(0)).toBe(ittc57(1e5));
    expect(ittc57(1e3)).toBe(ittc57(1e5));
    expect(ittc57(0)).toBeCloseTo(0.075 / 9, 12);
  });
});

describe('lewisAddedMass', () => {
  const rho = 1025;

  it('falls back to the thin-plate limits when width or depth vanishes', () => {
    // Centre-plane section (b = 0): heave → ρπb²/8 = 0, sway → vertical plate ρπd²/2.
    expect(lewisAddedMass(0, 2, 4, rho)).toEqual({ a33: 0, a22: (rho * Math.PI * 4) / 2 });
    const b = 1e-7; // inside the ≤ 1e-6 branch
    const thin = lewisAddedMass(b, 2, 4 * b, rho);
    expect(thin.a33).toBeGreaterThan(0);
    expect(thin.a33).toBeCloseTo((rho * Math.PI * b * b) / 8, 14);
    expect(thin.a22).toBeCloseTo((rho * Math.PI * 4) / 2, 14);
  });

  it('clamps σ into [0.2, 1] and evaluates the documented Lewis chain exactly', () => {
    // σ = A/(b·d); anything outside [0.2, 1] behaves exactly like the clamped value.
    const upper = lewisAddedMass(2, 1, 2, rho); // σ = 1 exactly
    expect(lewisAddedMass(2, 1, 9, rho)).toEqual(upper); // σ = 4.5 → clamped to 1
    const lower = lewisAddedMass(2, 1, 0.4, rho); // σ = 0.2 exactly
    expect(lewisAddedMass(2, 1, 0.01, rho)).toEqual(lower); // σ = 0.005 → clamped to 0.2
    // Full chain at H₀ = 1 (so r = 0, a₁ = 0) with σ = 1:
    //   C₁ = 3 + 4σ/π, a₃ = (−C₁ + 3 + √(9−2C₁))/C₁, M = (b/2)/(1 + a₁ + a₃)
    const c1 = 3 + 4 / Math.PI;
    const a3 = (-c1 + 3 + Math.sqrt(9 - 2 * c1)) / c1;
    const m = 1 / (1 + a3);
    const k = ((rho * Math.PI) / 2) * m * m;
    expect(upper.a33).toBeCloseTo(k * (1 + 3 * a3 * a3), 12);
    expect(upper.a22).toBeCloseTo(k * (1 + 3 * a3 * a3), 12);
    expect(upper.a33).toBeCloseTo(upper.a22, 12); // symmetric section: a₁ = 0
  });
});

describe('rudderLift', () => {
  const slope = 3;

  it('is linear up to the stall angle', () => {
    expect(rudderLift(0.1, slope)).toBeCloseTo(0.3, 12);
    expect(rudderLift(RUDDER_STALL, slope)).toBe(slope * RUDDER_STALL);
  });

  it('drops to 55 % of the peak over the 20° after stall', () => {
    expect(rudderLift(RUDDER_STALL + Math.PI / 9, slope)).toBeCloseTo(
      slope * RUDDER_STALL * (1 - 0.45), // full drop
      12,
    );
    expect(rudderLift(RUDDER_STALL + Math.PI / 18, slope)).toBeCloseTo(
      slope * RUDDER_STALL * (1 - 0.45 * 0.5), // 10° = half of the drop
      12,
    );
    expect(rudderLift(RUDDER_STALL + 100, slope)).toBeCloseTo(slope * RUDDER_STALL * 0.55, 12);
  });

  it('keeps the sign of the deflection through and past stall', () => {
    expect(rudderLift(-0.2, slope)).toBeCloseTo(-slope * 0.2, 12);
    expect(rudderLift(-(RUDDER_STALL + Math.PI / 9), slope)).toBeCloseTo(
      -slope * RUDDER_STALL * 0.55,
      12,
    );
  });
});

describe('thrustImmersionFactor', () => {
  it('is fully wetted at h/R ≥ 1.5 and dry below h/R = −1', () => {
    expect(thrustImmersionFactor(1.5)).toBe(1);
    expect(thrustImmersionFactor(10)).toBe(1);
    expect(thrustImmersionFactor(-1)).toBe(0);
    expect(thrustImmersionFactor(-5)).toBe(0);
  });

  it('follows the smoothstep β = x²(3 − 2x), x = (h/R + 1)/2.5 in between', () => {
    // h/R = 0.25 → x = 0.5 → β = 0.5
    expect(thrustImmersionFactor(0.25)).toBeCloseTo(0.25 * (3 - 2 * 0.5), 12);
    // h/R = 1.25 → x = 0.9 → β = 0.972
    expect(thrustImmersionFactor(1.25)).toBeCloseTo(0.81 * (3 - 1.8), 12);
    // h/R = 0 → x = 0.4 → β = 0.352
    expect(thrustImmersionFactor(0)).toBeCloseTo(0.16 * (3 - 0.8), 12);
    // Monotone increasing across the transition.
    for (let x = -1.5; x < 1.5; x += 0.05) {
      expect(thrustImmersionFactor(x)).toBeLessThanOrEqual(thrustImmersionFactor(x + 0.05) + 1e-12);
    }
  });
});

describe('clarkeDerivatives', () => {
  // The module documents that in our z-up / y-port axes v, r, Y and N all change sign
  // relative to SNAME, so the prime-system regressions are used unchanged.
  it('evaluates the four Clarke regressions with the prime-system signs', () => {
    const l = 100;
    const b = 16;
    const t = 6;
    const cb = 0.7;
    const f = Math.PI * (t / l) ** 2;
    expect(clarkeDerivatives(l, b, t, cb)).toEqual({
      yv: -f * (1 + (0.4 * cb * b) / t),
      yr: -f * (-0.5 + 2.2 * (b / l) - 0.08 * (b / t)),
      nv: -f * (0.5 + 2.4 * (t / l)),
      nr: -f * (0.25 + 0.039 * (b / t) - 0.56 * (b / l)),
    });
    const d = clarkeDerivatives(l, b, t, cb);
    expect(d.yv).toBeLessThan(0); // greater sway force for a positive sway velocity
    expect(d.nv).toBeLessThan(0); // yaw moments agree with the double-flip
    expect(d.nr).toBeLessThan(0);
    // B/L small ⇒ the cross-coupling Y'r stays positive for a conventional hull.
    expect(d.yr).toBeGreaterThan(0);
  });
});
