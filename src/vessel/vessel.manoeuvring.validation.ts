/**
 * Vessel validation: propulsion (steady speed under full throttle), rudder conventions and
 * the heading autopilot.
 *
 * Measured numbers are printed (stdout) so a test run doubles as a validation report.
 */
import { describe, expect, it, vi } from 'vitest';
import { KNOT } from '../core/units';
import { VesselTypeSchema } from '../schema/experiment';
import { createVesselDefinition } from './definition';
import { makeVessel, report, run } from './testUtil';

vi.setConfig({ testTimeout: 300_000 });

describe('propulsion and steering', () => {
  for (const type of VesselTypeSchema.options) {
    it(`${type} reaches a plausible steady speed under full throttle`, () => {
      const def = createVesselDefinition(type);
      const vmaxKn = def.maxSpeed / KNOT;
      // Autopilot holds the course (several of these hulls are directionally unstable with
      // the rudder fixed amidships); a speed demand far above V_max saturates the throttle.
      const v = makeVessel(type, { speedKn: 0.95 * vmaxKn, autopilot: true });
      v.command({ speedKn: 2 * vmaxKn });
      const t = run(v, 150);
      const s1 = v.telemetry().speedKn;
      run(v, 30, undefined, t);
      const tm = v.telemetry();
      report(
        type,
        `full throttle: ${tm.speedKn.toFixed(2)} kn (V_max ${vmaxKn.toFixed(1)} kn),`,
        `thrust ${(tm.thrust / 1000).toFixed(1)} kN, trim ${tm.pitchDeg.toFixed(2)}°`,
      );
      expect(v.diagnostics().throttle).toBe(1);
      expect(tm.speedKn).toBeGreaterThan(0.7 * vmaxKn);
      expect(tm.speedKn).toBeLessThan(1.3 * vmaxKn);
      expect(Math.abs(tm.speedKn - s1)).toBeLessThan(0.02 * vmaxKn); // steady
      expect(Math.abs(tm.headingDeg - 90)).toBeLessThan(1);
    });
  }

  for (const type of ['cargo-ship', 'trawler', 'patrol-boat', 'lifeboat'] as const) {
    it(`${type} autopilot turns 30° and settles without large overshoot`, () => {
      const def = createVesselDefinition(type);
      const v = makeVessel(type, { speedKn: 0.8 * (def.maxSpeed / KNOT), autopilot: true });
      run(v, 5);
      v.command({ headingDeg: 120 });
      let overshoot = 0;
      let settled = Infinity;
      let lastOutside = 0;
      const window = 300 * Math.sqrt(def.length / 120);
      run(v, window, (t) => {
        const hdg = v.telemetry().headingDeg;
        overshoot = Math.max(overshoot, hdg - 120);
        if (Math.abs(hdg - 120) > 2) lastOutside = t;
      });
      settled = lastOutside;
      const tm = v.telemetry();
      report(
        type,
        `autopilot 90°→120°: settled (±2°) after ${settled.toFixed(1)} s,`,
        `overshoot ${overshoot.toFixed(2)}°, final ${tm.headingDeg.toFixed(2)}°`,
      );
      expect(settled).toBeLessThan(0.8 * window);
      expect(overshoot).toBeLessThan(5);
      expect(Math.abs(tm.headingDeg - 120)).toBeLessThan(1);
    });
  }

  it('positive rudder turns to port (heading decreases)', () => {
    const v = makeVessel('cargo-ship', { speedKn: 12 });
    v.command({ autopilot: false, rudderDeg: 20, throttle: 0.6 });
    run(v, 60);
    const tm = v.telemetry();
    // Port turn from 090° → heading decreases (counter-clockwise from above).
    expect(tm.headingDeg).toBeLessThan(85);
    expect(tm.rudderDeg).toBeCloseTo(20, 6);
    expect(tm.angularVelocity.z).toBeGreaterThan(0);
  });

  it('rudder rate is limited to the steering-gear rate', () => {
    const v = makeVessel('cargo-ship', { speedKn: 12 });
    v.command({ autopilot: false, rudderDeg: 35, throttle: 0.6 });
    run(v, 5);
    expect(v.telemetry().rudderDeg).toBeCloseTo(5 * 2.3, 1);
  });
});
