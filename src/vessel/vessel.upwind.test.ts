/**
 * Sloop yacht close-hauled performance (issue "Yacht with a fore-and-aft sail rig"): the rig must
 * drive the boat to windward at a sensible pointing angle, and it must not be the engine doing it.
 *
 * The engine is removed (zero maximum thrust) so only the sails and keel are measured. Measured
 * numbers are printed (stdout) so a test run doubles as a validation report.
 */
import { describe, expect, it, vi } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import { WeatherSchema } from '../schema/experiment';
import { env } from '../test/fixtures';
import { WeatherField } from '../weather/weather';
import { createVesselDefinition } from './definition';
import { report, run } from './testUtil';
import { Vessel } from './vessel';

vi.setConfig({ testTimeout: 300_000 });

const WIND = 8; // m/s from the north (true wind angle = heading on starboard tack)

/** A sloop under sail alone, heading `headingDeg` on autopilot with the wind from the north. */
function sailing(headingDeg: number): Vessel {
  const e = env({ windSpeed: WIND, windDirectionDeg: 0 });
  const def = createVesselDefinition('sloop-yacht');
  const noEngine = { ...def, propulsion: { ...def.propulsion, maxThrust: 0 } };
  return new Vessel(
    'sloop',
    noEngine,
    { x: 0, y: 0, headingDeg, speedKn: 12, autopilot: true },
    new OceanField([], e),
    { wind: new WeatherField(WeatherSchema.parse({ gustiness: 0 }), e) },
  );
}

/** Mean VMG [kn], speed [kn] and heel [deg] over the last 60 s of a 240 s run. */
function closeHauled(headingDeg: number): { vmg: number; speed: number; heel: number } {
  const v = sailing(headingDeg);
  let vmg = 0;
  let speed = 0;
  let heel = 0;
  let n = 0;
  run(v, 240, (t) => {
    if (t < 180) return;
    const tm = v.telemetry();
    vmg += tm.vmgKn;
    speed += tm.speedKn;
    heel += Math.abs(tm.rollDeg);
    n++;
  });
  return { vmg: vmg / n, speed: speed / n, heel: heel / n };
}

describe('sloop yacht close-hauled', () => {
  it('sails to windward at 40-50° to the true wind with a positive VMG and a moderate heel', () => {
    const angles = [30, 40, 50, 60];
    const res = angles.map((a) => ({ a, ...closeHauled(a) }));
    for (const r of res) {
      report(
        `sloop TWA ${r.a}°: speed`,
        r.speed.toFixed(2),
        'kn, VMG',
        r.vmg.toFixed(2),
        'kn, heel',
        r.heel.toFixed(1),
        '°',
      );
    }
    const best = res.reduce((p, q) => (q.vmg > p.vmg ? q : p));
    report('sloop best VMG at TWA', best.a, '°');
    expect(best.vmg).toBeGreaterThan(1.5);
    expect(best.a).toBeGreaterThanOrEqual(40);
    expect(best.a).toBeLessThanOrEqual(50);
    expect(best.heel).toBeGreaterThan(3);
    expect(best.heel).toBeLessThan(35);
  });

  it('cannot hold a head-to-wind course (in irons it makes no way to windward)', () => {
    const irons = closeHauled(0);
    report('sloop head to wind: VMG', irons.vmg.toFixed(2), 'kn');
    expect(irons.vmg).toBeLessThan(0.5);
  });
});
