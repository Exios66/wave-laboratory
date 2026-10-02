/**
 * Vessel validation in wind: windage heel and leeway, square-rig sailing performance, reefing
 * and capsize under a press of sail. Measured numbers are printed as a validation report.
 */
import { describe, expect, it, vi } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import { WeatherSchema, type VesselType } from '../schema/experiment';
import { env } from '../test/fixtures';
import { WeatherField } from '../weather/weather';
import { createVesselDefinition } from './definition';
import { report, run } from './testUtil';
import { Vessel } from './vessel';

vi.setConfig({ testTimeout: 300_000 });

function windy(
  type: VesselType,
  windSpeed: number,
  windFromDeg: number,
  o: { headingDeg?: number; speedKn?: number; autopilot?: boolean } = {},
) {
  const e = env({ windSpeed, windDirectionDeg: windFromDeg });
  const field = new OceanField([], e);
  const weather = new WeatherField(WeatherSchema.parse({ gustiness: 0 }), e);
  return new Vessel(
    type,
    createVesselDefinition(type),
    {
      x: 0,
      y: 0,
      headingDeg: o.headingDeg ?? 0,
      speedKn: o.speedKn ?? 0,
      autopilot: o.autopilot ?? true,
    },
    field,
    { wind: weather },
  );
}

describe('windage', () => {
  it('a container ship in a 25 m/s beam wind heels to leeward and makes leeway', () => {
    // Heading north, wind from the west (port side).
    const v = windy('cargo-ship', 25, 270, { headingDeg: 0, speedKn: 0, autopilot: false });
    let roll = 0;
    run(v, 240, () => (roll = v.telemetry().rollDeg));
    const tm = v.telemetry();
    report(
      'cargo-ship 25 m/s beam wind: heel',
      roll.toFixed(2),
      '° drift east',
      tm.position.x.toFixed(1),
      'm',
    );
    expect(roll).toBeGreaterThan(0.3); // starboard down
    expect(roll).toBeLessThan(8);
    expect(tm.position.x).toBeGreaterThan(5); // blown downwind (east)
    expect(tm.windForce).toBeGreaterThan(0);
    expect(tm.windFromDeg).toBeCloseTo(270, 6);
  });

  it('the carrier autopilot holds its course across a strong wind', () => {
    const v = windy('aircraft-carrier', 22, 270, { headingDeg: 0, speedKn: 20 });
    run(v, 300);
    const tm = v.telemetry();
    const err = Math.abs(((tm.headingDeg + 540) % 360) - 180);
    report(
      'carrier 22 m/s crosswind: heading',
      tm.headingDeg.toFixed(2),
      '° speed',
      tm.speedKn.toFixed(1),
      'kn',
    );
    expect(Math.min(err, 360 - err)).toBeLessThan(2);
    expect(tm.speedKn).toBeGreaterThan(17);
  });
});

describe('square rig', () => {
  it('sails on a beam reach in a fresh breeze, heeled to leeward', () => {
    const v = windy('pirate-ship', 10, 270, { headingDeg: 0, speedKn: 0, autopilot: true });
    v.command({ speedKn: 12 });
    run(v, 400);
    const tm = v.telemetry();
    report(
      'pirate ship beam reach 10 m/s: speed',
      tm.speedKn.toFixed(2),
      'kn heel',
      tm.rollDeg.toFixed(1),
      '° set',
      tm.sailSet.toFixed(2),
      'brace',
      tm.braceDeg.toFixed(0),
      '°',
    );
    expect(tm.speedKn).toBeGreaterThan(4.5);
    expect(tm.speedKn).toBeLessThan(11);
    expect(tm.rollDeg).toBeGreaterThan(2);
    expect(tm.rollDeg).toBeLessThan(20);
    expect(tm.sailSet).toBeGreaterThan(0.95);
  });

  it('runs downwind and stalls head to wind (in irons)', () => {
    const run1 = windy('pirate-ship', 10, 180, { headingDeg: 0, speedKn: 0 });
    run1.command({ speedKn: 12 });
    run(run1, 300);
    const irons = windy('pirate-ship', 10, 0, { headingDeg: 0, speedKn: 3 });
    irons.command({ speedKn: 12 });
    let minU = Infinity;
    run(irons, 120, () => (minU = Math.min(minU, irons.kinematics.velocity.y)));
    report(
      'pirate ship running',
      run1.telemetry().speedKn.toFixed(2),
      'kn; head to wind ends at',
      irons.kinematics.velocity.y.toFixed(2),
      'm/s north',
    );
    expect(run1.telemetry().speedKn).toBeGreaterThan(4);
    expect(irons.kinematics.velocity.y).toBeLessThan(0.5);
  });

  it('the crew reefs in a storm and she survives; a full press of sail lays her on her beam ends', () => {
    const reefed = windy('pirate-ship', 30, 270, { headingDeg: 0, speedKn: 4 });
    let maxHeel = 0;
    run(reefed, 200, () => (maxHeel = Math.max(maxHeel, Math.abs(reefed.telemetry().rollDeg))));
    const full = windy('pirate-ship', 30, 270, { headingDeg: 0, speedKn: 4, autopilot: false });
    full.command({ throttle: 1, rudderDeg: 0 });
    let fullHeel = 0;
    run(full, 200, () => (fullHeel = Math.max(fullHeel, Math.abs(full.telemetry().rollDeg))));
    report(
      'pirate ship 30 m/s beam: reefed max heel',
      maxHeel.toFixed(1),
      '° set',
      reefed.telemetry().sailSet.toFixed(2),
      '; full sail max heel',
      fullHeel.toFixed(1),
      '°',
    );
    expect(reefed.telemetry().capsized).toBe(false);
    expect(reefed.telemetry().sailSet).toBeLessThan(0.3);
    expect(maxHeel).toBeLessThan(30);
    expect(fullHeel).toBeGreaterThan(50);
  });
});
