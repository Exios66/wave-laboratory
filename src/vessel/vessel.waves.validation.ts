/**
 * Vessel validation in waves: long-wave heave RAO and seaway events (slamming, green water).
 *
 * Measured numbers are printed (stdout) so a test run doubles as a validation report.
 */
import { describe, expect, it, vi } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import { env, regular } from '../test/fixtures';
import { harmonicAmplitude, makeVessel, report, run } from './testUtil';

vi.setConfig({ testTimeout: 300_000 });

describe('long regular waves', () => {
  for (const type of ['box-barge', 'cargo-ship'] as const) {
    it(`${type} heave RAO ≈ 1 for T = 20 s head seas`, () => {
      // Regular waves only: a tiny FFT grid keeps the (empty) spectral cascades cheap.
      const a = 1;
      const period = 20;
      const field = new OceanField([regular(2 * a, period, 90)], env(), { physicsGrid: 8 });
      const v = makeVessel(type, { headingDeg: 90 }, field);
      const ts: number[] = [];
      const xs: number[] = [];
      run(v, 12 * period, (t) => {
        if (t > 6 * period) {
          ts.push(t);
          xs.push(v.telemetry().heave);
        }
      });
      const rao = harmonicAmplitude(ts, xs, (2 * Math.PI) / period) / a;
      report(
        type,
        `heave RAO at T = ${period} s (λ/L = ${((9.80665 * period ** 2) / (2 * Math.PI) / v.hydro.lwl).toFixed(1)}): ${rao.toFixed(4)}`,
      );
      expect(Math.abs(rao - 1)).toBeLessThan(0.05);
    });
  }
});

describe('seaway', () => {
  it('detects slamming and green water for a small fast craft in steep head seas', () => {
    const field = new OceanField([regular(4, 6, 90)], env(), { physicsGrid: 8 });
    const v = makeVessel('patrol-boat', { speedKn: 20, autopilot: true }, field);
    let slams = 0;
    let green = 0;
    let maxBow = 0;
    run(v, 60, () => {
      const tm = v.telemetry();
      if (tm.slamming) slams++;
      if (tm.greenWater) green++;
      maxBow = Math.max(maxBow, Math.abs(tm.bowAccel));
    });
    report(
      `patrol boat 20 kn, H 4 m T 6 s head seas: slam steps ${slams}, green-water steps ${green},`,
      `max |bow accel| ${maxBow.toFixed(2)} m/s²`,
    );
    expect(slams).toBeGreaterThan(0);
    expect(green).toBeGreaterThan(0);
    expect(maxBow).toBeGreaterThan(2);
    expect(v.telemetry().capsized).toBe(false);
  });
});
