import { describe, expect, it } from 'vitest';
import { SEAWATER_DENSITY, STANDARD_GRAVITY } from '../core/constants';
import { Pcg32 } from '../core/rng';
import { createVesselDefinition } from './definition';
import { clarkeDerivatives } from './coefficients';
import {
  HEAVE_DAMPING_RATIO,
  STRIP_COUNT,
  buildHydroModel,
  invert6,
} from './hydroModel';

/** Row-major 6×6 matrix product. */
function mul(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(36);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += a[i * 6 + k]! * b[k * 6 + j]!;
      out[i * 6 + j] = s;
    }
  }
  return out;
}

function expectIdentity(q: Float64Array, digits = 9): void {
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      expect(q[i * 6 + j]!).toBeCloseTo(i === j ? 1 : 0, digits);
    }
  }
}

/** Build a random SPD matrix: R·Rᵀ + 6·I is strictly diagonally dominant. */
function spdFrom(rng: Pcg32): Float64Array {
  const r = new Float64Array(36);
  for (let i = 0; i < 36; i++) r[i] = rng.nextGaussian();
  const m = new Float64Array(36);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += r[i * 6 + k]! * r[j * 6 + k]!;
      m[i * 6 + j] = s;
    }
    m[i * 6 + i]! += 6;
  }
  return m;
}

describe('invert6', () => {
  it('inverts the identity exactly', () => {
    const eye = new Float64Array(36);
    for (let i = 0; i < 6; i++) eye[i * 6 + i] = 1;
    expect(invert6(eye)).toEqual(eye);
  });

  it('satisfies M⁻¹·M ≈ I for a fixed SPD matrix (entries known by hand)', () => {
    // Tridiagonal, strictly diagonally dominant ⇒ SPD.
    const m = new Float64Array([
      5, 1, 0, 0, 0, 0,
      1, 6, 1, 0, 0, 0,
      0, 1, 7, 1, 0, 0,
      0, 0, 1, 8, 1, 0,
      0, 0, 0, 1, 9, 1,
      0, 0, 0, 0, 1, 10,
    ]);
    expectIdentity(mul(invert6(m), m), 12);
    // The argument itself is not mutated.
    const copy = Float64Array.from(m);
    invert6(m);
    expect(m).toEqual(copy);
  });

  it('property: seeded random SPD matrices invert to within 1e-9', () => {
    const rng = new Pcg32(20261014, 7);
    for (let trial = 0; trial < 8; trial++) {
      const m = spdFrom(rng);
      expectIdentity(mul(invert6(m), m), 9);
      expectIdentity(mul(m, invert6(m)), 9);
    }
  });

  it('rejects a singular matrix', () => {
    const singular = new Float64Array(36);
    for (let i = 0; i < 6; i++) singular[i * 6 + i] = 1;
    singular[0] = 0;
    singular[6] = 0; // first row all zeros → pivot search hits zero
    expect(() => invert6(singular)).toThrow(RangeError);
  });
});

describe('buildHydroModel (box barge)', () => {
  const def = createVesselDefinition('box-barge');
  const h = buildHydroModel(def, SEAWATER_DENSITY, STANDARD_GRAVITY);

  it('distributes the strips over the waterline length', () => {
    expect(h.stripX).toHaveLength(STRIP_COUNT);
    // Mid-strip stations spanning 19/20 of the waterline length (20 strips).
    expect(h.stripX[STRIP_COUNT - 1]! - h.stripX[0]!).toBeCloseTo(
      ((STRIP_COUNT - 1) / STRIP_COUNT) * h.lwl,
      9,
    );
    expect(h.stripA33.every((v) => v >= 0)).toBe(true);
    expect(h.stripA22.every((v) => v >= 0)).toBe(true);
  });

  it('achieves the tuned heave damping ratio with non-negative strip damping', () => {
    expect(h.zetaHeave).toBeCloseTo(HEAVE_DAMPING_RATIO, 6);
    for (const b of h.stripB33) expect(b).toBeGreaterThanOrEqual(0);
  });

  it('assembles a symmetric added-mass matrix with a positive diagonal', () => {
    const A = h.addedMass;
    for (const [i, j] of [
      [1, 5],
      [2, 4],
    ] as const) {
      expect(A[i * 6 + j]!).toBe(A[j * 6 + i]!);
    }
    for (let k = 0; k < 6; k++) expect(A[k * 6 + k]!).toBeGreaterThan(0);
    expect(A[0 + 1]!).toBe(0); // no Lewis coupling into surge
  });

  it('massInverse really inverts M_RB + A', () => {
    const m = new Float64Array(h.addedMass);
    m[0]! += h.mass;
    m[7]! += h.mass;
    m[14]! += h.mass;
    m[21]! += def.inertia.x;
    m[28]! += def.inertia.y;
    m[35]! += def.inertia.z;
    expectIdentity(mul(m, h.massInverse), 9);
  });

  it('natural frequencies follow their stiffness/inertia pairs from the same strips', () => {
    let a33 = 0;
    let a55 = 0;
    for (let i = 0; i < STRIP_COUNT; i++) {
      a33 += h.stripA33[i]!;
      a55 += h.stripA33[i]! * h.stripX[i]! ** 2;
    }
    expect(h.omegaHeave).toBeCloseTo(
      Math.sqrt(h.c33 / (h.mass + a33)),
      9,
    );
    expect(h.omegaPitch).toBeCloseTo(
      Math.sqrt(Math.max(h.c55, 0) / (def.inertia.y + a55)),
      9,
    );
    expect(h.omegaHeave).toBeGreaterThan(0);
    expect(h.omegaPitch).toBeGreaterThan(0);
  });

  it('passes the Clarke derivatives through for a hull without a keel fin', () => {
    expect(def.keelFin).toBeNull();
    expect(h.clarke).toEqual(
      clarkeDerivatives(h.lwl, h.bwl, def.draft, h.blockCoefficient),
    );
  });

  it('places the manoeuvring force below the waterline and slams per Ochi', () => {
    expect(h.waterlineZ).toBeCloseTo(def.draft - def.kg, 9);
    expect(h.lateralZ).toBeCloseTo(h.waterlineZ - 0.5 * def.draft, 9);
    expect(h.slamThreshold).toBeCloseTo(0.093 * Math.sqrt(STANDARD_GRAVITY * h.lwl), 12);
  });
});
