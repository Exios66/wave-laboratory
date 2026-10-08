/**
 * Mooring validation: a ship at anchor in a swell and a gale stays inside its watch circle,
 * settles where the catenary pull balances the wind, drags once the load beats the anchor, and
 * drifts away when the anchor is weighed.
 */
import { describe, expect, it, vi } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import { WeatherSchema, type VesselType } from '../schema/experiment';
import { env, regular } from '../test/fixtures';
import { WeatherField } from '../weather/weather';
import { createVesselDefinition } from './definition';
import { DT, report, run } from './testUtil';
import { Vessel } from './vessel';

vi.setConfig({ testTimeout: 600_000 });

const DEPTH = 30;

/** Cargo ship at the origin heading `headingDeg`, wind from `windFromDeg`, optional swell. */
function moored(
  windSpeed: number,
  windFromDeg: number,
  swell = false,
  headingDeg = 90,
  scope = 5,
  type: VesselType = 'cargo-ship',
) {
  const e = env({ depth: DEPTH, windSpeed, windDirectionDeg: windFromDeg });
  const field = new OceanField(swell ? [regular(2, 8, windFromDeg)] : [], e);
  const weather = new WeatherField(WeatherSchema.parse({ gustiness: 0 }), e);
  const v = new Vessel(
    'ship',
    createVesselDefinition(type),
    { x: 0, y: 0, headingDeg, speedKn: 0, autopilot: false },
    field,
    { wind: weather },
  );
  v.command({ anchor: 'drop', anchorScope: scope });
  return v;
}

/** Run `seconds` after a settling time and average the chain pull and wind load. */
function measure(v: Vessel, settle: number, seconds: number) {
  const t0 = run(v, settle);
  let sumH = 0;
  let sumW = 0;
  let n = 0;
  let maxR = 0;
  run(
    v,
    seconds,
    () => {
      const tm = v.telemetry();
      sumH += tm.mooring.horizontalTension;
      sumW += tm.windForce;
      n++;
      maxR = Math.max(maxR, tm.mooring.distance);
    },
    t0,
  );
  return { meanH: sumH / n, meanWind: sumW / n, maxR };
}

describe('ship at anchor', () => {
  it('in steady wind the chain pull balances the wind load', () => {
    const v = moored(15, 90, false, 90, 3, 'trawler');
    const r = measure(v, 300, 300);
    const m = v.telemetry().mooring;
    report(
      `trawler at anchor (${DEPTH} m, scope 3, ${m.lineLength.toFixed(0)} m of chain), 15 m/s wind:`,
      `H ${(r.meanH / 1e3).toFixed(1)} kN vs wind load ${(r.meanWind / 1e3).toFixed(1)} kN,`,
      `lifted ${m.suspendedLength.toFixed(0)} m, ${m.groundedLength.toFixed(0)} m on the bottom`,
    );
    expect(m.dragging).toBe(false);
    expect(m.regime).toBe('grounded');
    // Wind load plus the small current/viscous drag on the drifting hull.
    expect(r.meanH / r.meanWind).toBeGreaterThan(0.9);
    expect(r.meanH / r.meanWind).toBeLessThan(1.15);
  });

  it('holds in a swell and a 15 m/s wind within a bounded watch circle', () => {
    // Heading east, wind and swell from the east: the ship lies head to wind.
    const v = moored(15, 90, true);
    const r = measure(v, 120, 300);
    const tm = v.telemetry();
    const m = tm.mooring;
    report(
      '15 m/s wind + 2 m swell: mean H',
      `${(r.meanH / 1e3).toFixed(0)} kN (wind alone ${(r.meanWind / 1e3).toFixed(0)} kN, the rest is wave drift),`,
      `watch circle ${r.maxR.toFixed(0)} m of ${m.lineLength.toFixed(0)} m chain, heading ${tm.headingDeg.toFixed(0)}°`,
    );
    expect(m.deployed).toBe(true);
    expect(m.dragging).toBe(false);
    expect(r.maxR).toBeLessThan(m.lineLength);
    expect(r.maxR).toBeGreaterThan(20); // blown back until the chain comes tight
    expect(r.meanH).toBeGreaterThan(0.9 * r.meanWind); // wave drift only adds
    const err = Math.abs(((tm.headingDeg - 90 + 540) % 360) - 180);
    expect(err).toBeLessThan(35);
    expect(Math.abs(tm.heave)).toBeLessThan(5);
    expect(m.tension).toBeGreaterThan(m.horizontalTension);
  });

  it('weathervanes: lying across the wind, the ship swings head to wind on its anchor', () => {
    const v = moored(18, 0, false, 90); // wind from the north, ship heading east
    run(v, 600);
    const tm = v.telemetry();
    const err = Math.abs(((tm.headingDeg - 0 + 540) % 360) - 180);
    report(`beam wind 18 m/s: heading ${tm.headingDeg.toFixed(0)}° (wind from 0°)`);
    expect(Math.min(err, 360 - err)).toBeLessThan(60);
  });

  it('drags in a gale that beats the anchor, holds in a lesser wind', () => {
    const calm = moored(15, 90);
    const x0 = calm.mooring.anchorX;
    run(calm, 240);
    expect(calm.telemetry().mooring.dragging).toBe(false);
    expect(calm.mooring.anchorX).toBe(x0);
    expect(x0).toBeGreaterThan(50); // let go under the bow
    const gale = moored(45, 90);
    run(gale, 400);
    const m = gale.telemetry().mooring;
    report(
      `45 m/s gale: anchor dragged to ${gale.mooring.anchorX.toFixed(0)} m, H/holding ${m.loadFraction.toFixed(2)}`,
    );
    // The anchor was pulled toward the ship (wind from the east, so west of where it was set).
    expect(gale.mooring.anchorX).toBeLessThan(x0 - 5);
  });

  it('weighing the anchor frees the ship, which then drifts downwind', () => {
    const v = moored(15, 90);
    let t = run(v, 200);
    const xHeld = v.telemetry().position.x;
    v.command({ anchor: 'weigh' });
    expect(v.telemetry().mooring.deployed).toBe(false);
    t = run(v, 120, undefined, t);
    const tm = v.telemetry();
    report(`weighed anchor: drifted from x ${xHeld.toFixed(0)} to ${tm.position.x.toFixed(0)} m`);
    expect(tm.mooring.tension).toBe(0);
    expect(tm.position.x).toBeLessThan(xHeld - 20); // wind from the east carries it west
    expect(t).toBeGreaterThan(300 - DT);
  });
});
