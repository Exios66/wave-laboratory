/**
 * Vessel validation: calm-water equilibrium, free heave/roll decay (PLAN §8 V10) and static
 * stability in the time domain.
 *
 * Measured numbers are printed (stdout) so a test run doubles as a validation report.
 */
import { describe, expect, it, vi } from 'vitest';
import { VesselTypeSchema } from '../schema/experiment';
import { analyseDecay, makeVessel, report, run } from './testUtil';

vi.setConfig({ testTimeout: 300_000 });

describe('calm-water equilibrium', () => {
  for (const type of VesselTypeSchema.options) {
    it(`${type} floats at rest: drift < 1 mm and < 0.01° over 60 s`, () => {
      const v = makeVessel(type);
      let maxHeave = 0;
      let maxAngle = 0;
      run(v, 60, () => {
        const tm = v.telemetry();
        maxHeave = Math.max(maxHeave, Math.abs(tm.heave));
        maxAngle = Math.max(maxAngle, Math.abs(tm.rollDeg), Math.abs(tm.pitchDeg));
      });
      const tm = v.telemetry();
      const drift = Math.hypot(tm.position.x, tm.position.y);
      report(
        type,
        'calm 60 s: max |heave|',
        maxHeave.toExponential(2),
        'm, max |angle|',
        maxAngle.toExponential(2),
        '°, horizontal drift',
        drift.toExponential(2),
        'm',
      );
      expect(maxHeave).toBeLessThan(1e-3);
      expect(drift).toBeLessThan(1e-3);
      expect(maxAngle).toBeLessThan(0.01);
      expect(tm.submergence).toBeCloseTo(1, 6);
      expect(tm.capsized || tm.slamming || tm.greenWater).toBe(false);
    });
  }
});

describe('free decay (V10)', () => {
  for (const type of ['box-barge', 'cargo-ship'] as const) {
    it(`${type} heave decay period within 3 % of 2π√((m + A33)/(ρ g A_wp))`, () => {
      const v = makeVessel(type);
      const h = v.hydro;
      const awp = v.definition.hydrostatics.waterplaneArea;
      const expected = 2 * Math.PI * Math.sqrt((h.mass + h.addedMass[14]!) / (h.rho * h.g * awp));
      v.applyOffset({ heave: 0.3 });
      const ts: number[] = [];
      const xs: number[] = [];
      run(v, 6 * expected, (t) => {
        ts.push(t);
        xs.push(v.telemetry().heave);
      });
      const d = analyseDecay(ts, xs, 3);
      const err = d.naturalPeriod / expected - 1;
      report(
        type,
        `heave: expected Tn ${expected.toFixed(3)} s, measured Td ${d.dampedPeriod.toFixed(3)} s,`,
        `ζ ${d.dampingRatio.toFixed(3)} → Tn ${d.naturalPeriod.toFixed(3)} s (error ${(100 * err).toFixed(2)} %)`,
      );
      expect(Math.abs(err)).toBeLessThan(0.03);
      // The motion decays: successive peaks shrink.
      expect(d.peaks[2]!).toBeLessThan(0.6 * d.peaks[0]!);
      expect(Math.abs(xs[xs.length - 1]!)).toBeLessThan(0.05);
    });

    it(`${type} roll decay period within 5 % of 2π√((Ixx + A44)/(m g GM))`, () => {
      const v = makeVessel(type);
      const h = v.hydro;
      const gm = v.definition.gm;
      const expected = 2 * Math.PI * Math.sqrt((h.ixx + h.addedMass[21]!) / (h.mass * h.g * gm));
      v.applyOffset({ rollDeg: 5 });
      const ts: number[] = [];
      const xs: number[] = [];
      run(v, 6 * expected, (t) => {
        ts.push(t);
        xs.push(v.telemetry().rollDeg);
      });
      const d = analyseDecay(ts, xs, 3);
      const err = d.naturalPeriod / expected - 1;
      report(
        type,
        `roll: expected Tn ${expected.toFixed(3)} s, measured Td ${d.dampedPeriod.toFixed(3)} s,`,
        `ζ ${d.dampingRatio.toFixed(3)} → Tn ${d.naturalPeriod.toFixed(3)} s (error ${(100 * err).toFixed(2)} %)`,
      );
      expect(Math.abs(err)).toBeLessThan(0.05);
      expect(d.peaks[2]!).toBeLessThan(0.9 * d.peaks[0]!);
      expect(d.dampingRatio).toBeGreaterThan(0.02);
    });
  }
});

describe('stability', () => {
  it('negative GM (barge, KG = 1.2 D) lists or capsizes; normal loading stays upright', () => {
    const unstable = makeVessel('box-barge', { kgFactor: 1.2 });
    const stable = makeVessel('box-barge', { kgFactor: 0.6 });
    expect(unstable.definition.gm).toBeLessThan(0);
    for (const v of [unstable, stable]) v.applyOffset({ rollDeg: 0.5 });
    let maxStable = 0;
    run(unstable, 120);
    run(stable, 120, () => {
      maxStable = Math.max(maxStable, Math.abs(stable.telemetry().rollDeg));
    });
    const u = unstable.telemetry();
    report(
      `negative GM barge (GM ${unstable.definition.gm.toFixed(2)} m): heel ${unstable.heelDeg.toFixed(1)}°,`,
      `capsized ${u.capsized}; stable barge max roll ${maxStable.toFixed(3)}°`,
    );
    expect(unstable.heelDeg > 10 || u.capsized).toBe(true);
    expect(maxStable).toBeLessThan(0.6);
    expect(stable.telemetry().capsized).toBe(false);
  });
});
