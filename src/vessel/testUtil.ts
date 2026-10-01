/** Helpers for the vessel validation tests (not used at runtime). */
import { OceanField } from '../ocean/oceanField';
import type { VesselType } from '../schema/experiment';
import { env } from '../test/fixtures';
import { createVesselDefinition } from './definition';
import { Vessel } from './vessel';

declare const process: { stdout: { write(s: string): void } };

/** Print a measured result (tests double as a validation report). */
export const report = (...parts: unknown[]): void => {
  process.stdout.write(`\n[vessel] ${parts.join(' ')}`);
};

export const DT = 1 / 120;
export const calmSea = new OceanField([], env());

export function makeVessel(
  type: VesselType,
  opts: { speedKn?: number; headingDeg?: number; autopilot?: boolean; kgFactor?: number } = {},
  field: OceanField = calmSea,
): Vessel {
  const def = createVesselDefinition(type, 1, opts.kgFactor ?? 0.6);
  return new Vessel(
    type,
    def,
    {
      x: 0,
      y: 0,
      headingDeg: opts.headingDeg ?? 90,
      speedKn: opts.speedKn ?? 0,
      autopilot: opts.autopilot ?? false,
    },
    field,
  );
}

/** Step `v` with DT for `seconds` from t0, calling `sample(t)` after every step; returns t. */
export function run(v: Vessel, seconds: number, sample?: (t: number) => void, t0 = 0): number {
  let t = t0;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    v.step(DT, t);
    t = t0 + (i + 1) * DT;
    sample?.(t);
  }
  return t;
}

// ------------------------------------------------------------------ signal analysis

/** Times of upward zero crossings of a sampled signal (linear interpolation). */
export function upCrossings(t: readonly number[], x: readonly number[], level = 0): number[] {
  const out: number[] = [];
  for (let i = 1; i < x.length; i++) {
    const a = x[i - 1]! - level;
    const b = x[i]! - level;
    if (a < 0 && b >= 0) out.push(t[i - 1]! + ((t[i]! - t[i - 1]!) * -a) / (b - a));
  }
  return out;
}

/** Local maxima (value) of a sampled signal, refined by a parabola through three samples. */
export function peaks(x: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < x.length; i++) {
    const a = x[i - 1]!;
    const b = x[i]!;
    const c = x[i + 1]!;
    if (b > a && b >= c && b > 0) {
      const den = a - 2 * b + c;
      const d = den !== 0 ? (0.5 * (a - c)) / den : 0;
      out.push(b - 0.25 * (a - c) * d);
    }
  }
  return out;
}

export interface DecayAnalysis {
  /** Mean damped period over the analysed cycles [s]. */
  dampedPeriod: number;
  /** Mean logarithmic decrement and the equivalent damping ratio. */
  logDecrement: number;
  dampingRatio: number;
  /** Undamped natural period Td·√(1 − ζ²) [s]. */
  naturalPeriod: number;
  peaks: number[];
}

/** Period and damping of a free-decay record (uses the first `cycles` full cycles). */
export function analyseDecay(
  t: readonly number[],
  x: readonly number[],
  cycles = 4,
): DecayAnalysis {
  const up = upCrossings(t, x);
  const n = Math.min(cycles, up.length - 1);
  const dampedPeriod = (up[n]! - up[0]!) / n;
  const pk = peaks(x);
  const m = Math.min(cycles, pk.length - 1);
  let delta = 0;
  for (let i = 0; i < m; i++) delta += Math.log(pk[i]! / pk[i + 1]!);
  delta /= m;
  const zeta = delta / Math.sqrt(4 * Math.PI * Math.PI + delta * delta);
  return {
    dampedPeriod,
    logDecrement: delta,
    dampingRatio: zeta,
    naturalPeriod: dampedPeriod * Math.sqrt(1 - zeta * zeta),
    peaks: pk,
  };
}

/** Least-squares fit x ≈ c + a cos ωt + b sin ωt; returns the amplitude √(a² + b²). */
export function harmonicAmplitude(
  t: readonly number[],
  x: readonly number[],
  omega: number,
): number {
  // Normal equations for the 3 basis functions.
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const r = [0, 0, 0];
  for (let i = 0; i < t.length; i++) {
    const f = [1, Math.cos(omega * t[i]!), Math.sin(omega * t[i]!)];
    for (let p = 0; p < 3; p++) {
      r[p]! += f[p]! * x[i]!;
      for (let q = 0; q < 3; q++) m[3 * p + q]! += f[p]! * f[q]!;
    }
  }
  const sol = solve3(m, r);
  return Math.hypot(sol[1]!, sol[2]!);
}

function solve3(m: number[], r: number[]): number[] {
  const a = m.slice();
  const b = r.slice();
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let i = c + 1; i < 3; i++) if (Math.abs(a[3 * i + c]!) > Math.abs(a[3 * p + c]!)) p = i;
    for (let k = 0; k < 3; k++) [a[3 * c + k], a[3 * p + k]] = [a[3 * p + k]!, a[3 * c + k]!];
    [b[c], b[p]] = [b[p]!, b[c]!];
    for (let i = 0; i < 3; i++) {
      if (i === c) continue;
      const f = a[3 * i + c]! / a[3 * c + c]!;
      for (let k = 0; k < 3; k++) a[3 * i + k]! -= f * a[3 * c + k]!;
      b[i]! -= f * b[c]!;
    }
  }
  return [b[0]! / a[0]!, b[1]! / a[4]!, b[2]! / a[8]!];
}
