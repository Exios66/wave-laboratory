import { describe, expect, it } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import type { MooringConfig } from '../schema/experiment';
import { env } from '../test/fixtures';
import { createVesselDefinition } from './definition';
import { Vessel } from './vessel';

const definition = createVesselDefinition('box-barge');
const shallow = new OceanField([], env({ depth: 20, windSpeed: 0 }));
const vessel = (mooring?: MooringConfig, depth = 20, damage = true) =>
  new Vessel(
    'barge',
    definition,
    { x: 30, y: -20, headingDeg: 90, speedKn: 0, autopilot: false, mooring },
    depth === 20 ? shallow : new OceanField([], env({ depth, windSpeed: 0 })),
    { damage, compartments: 4 },
  );

describe('vessel anchor commands and telemetry', () => {
  it('starts at configured coordinates and gives explicit length priority over scope', () => {
    const v = vessel({ kind: 'anchor', x: 0, y: 0, scope: 5, length: 60 });
    const m = v.telemetry().mooring;
    expect(m.deployed).toBe(true);
    expect(m.anchor).toEqual({ x: 0, y: 0, z: -20 });
    expect(m.lineLength).toBe(60);
    expect(m.scope).toBe(3);
  });

  it('drops beneath the bow, changes scope in place, and clears telemetry when weighed', () => {
    const v = vessel();
    v.command({ anchor: 'drop', anchorScope: 3 });
    const down = v.telemetry().mooring;
    expect(down.anchor.x).toBeGreaterThan(30);
    expect(down.anchor.y).toBeCloseTo(-20, 9);
    expect(down.lineLength).toBe(60);
    v.command({ anchor: 'drop', anchorScope: 4 });
    expect(v.telemetry().mooring.anchor).toEqual(down.anchor);
    expect(v.telemetry().mooring.lineLength).toBe(80);
    // Evaluate a loaded line so the weigh assertion checks stale telemetry as well.
    v.mooring.force(down.anchor.x + 79, down.anchor.y, 3, { fx: 0, fy: 0, fz: 0 });
    expect(v.telemetry().mooring.tension).toBeGreaterThan(0);
    v.command({ anchor: 'weigh' });
    expect(v.telemetry().mooring).toMatchObject({
      deployed: false,
      lineLength: 0,
      scope: 0,
      tension: 0,
      horizontalTension: 0,
      fairleadAngleDeg: 0,
      suspendedLength: 0,
      groundedLength: 0,
      touchdownDistance: 0,
      loadFraction: 0,
      distance: 0,
      dragging: false,
      profile: [],
    });
  });

  it('limits explicit line length by minimum reach and chain capacity', () => {
    const v = vessel();
    v.command({ anchor: 'drop', anchorLength: 1 });
    expect(v.telemetry().mooring.lineLength).toBeCloseTo(21, 12);
    v.command({ anchor: 'drop', anchorLength: 3000, anchorScope: 3 });
    const m = v.telemetry().mooring;
    expect(m.lineLength).toBe(m.chainCapacity);
  });

  it('refuses both an initial and a commanded anchor where the chain cannot reach', () => {
    const v = vessel({ kind: 'anchor', scope: 5 }, 1000);
    expect(v.telemetry().mooring.available).toBe(false);
    expect(v.telemetry().mooring.deployed).toBe(false);
    v.command({ anchor: 'drop' });
    expect(v.telemetry().mooring.deployed).toBe(false);
  });

  it('permits deep-water buoy moorings with finite public holding telemetry', () => {
    const v = vessel({ kind: 'buoy', scope: 5, x: 0, y: 0 }, 1000);
    v.mooring.force(140, 0, 3, { fx: 0, fy: 0, fz: 0 });
    const m = v.telemetry().mooring;
    expect(m).toMatchObject({
      kind: 'buoy',
      available: true,
      deployed: true,
      holdingLimit: 0,
      loadFraction: 0,
    });
    expect(m.anchor.z).toBe(0);
    expect(m.tension).toBeGreaterThan(0);
    expect(m.profile.length).toBeGreaterThan(0);
  });
});

describe('vessel flood commands', () => {
  it('manual flooding works with damage disabled and rounds the requested bay', () => {
    const v = vessel(undefined, 20, false);
    v.command({ flood: { compartment: 1.6, area: 0.25 } });
    expect(Array.from(v.flooding.breachArea)).toEqual([0, 0, 0.25, 0]);
    expect(v.telemetry().health).toBe(1);
  });

  it('starting pumps plugs breaches immediately; stopping pumps retains existing water', () => {
    const v = vessel();
    v.flooding.fill(1, 20);
    v.command({ flood: { compartment: 1 } });
    expect(v.flooding.breached).toBe(true);
    v.command({ pump: true });
    expect(v.flooding.breached).toBe(false);
    expect(v.telemetry().flooding.pumping).toBe(true);
    v.command({ pump: false });
    expect(v.flooding.totalVolume).toBe(20);
    expect(v.telemetry().flooding.pumping).toBe(false);
    v.command({ pump: true });
    v.command({ flood: { compartment: 0, area: 0.1 } });
    expect(v.flooding.pumping).toBe(false);
    expect(v.flooding.breachArea[0]).toBe(0.1);
  });

  it('repair restores health and starts pumping only if there is water aboard', () => {
    const v = vessel();
    v.applyDamage(0.5, 'collision', { x: 30, y: -20 });
    v.command({ repair: true });
    expect(v.telemetry().health).toBe(1);
    expect(v.flooding.breached).toBe(false);
    expect(v.flooding.pumping).toBe(false);
    v.flooding.fill(1, 20);
    v.command({ repair: true });
    expect(v.flooding.pumping).toBe(true);
    expect(v.flooding.totalVolume).toBe(20);
  });

  it.each([0.019999, 0.02])(
    'opens a collision breach at the 2 percent damage threshold: %s',
    (amount) => {
      const v = vessel();
      v.applyDamage(amount, 'collision', { x: 30, y: -14 });
      expect(v.flooding.breached).toBe(amount >= 0.02);
      if (amount >= 0.02) {
        const hit = v.flooding.breachArea.findIndex((area) => area > 0);
        expect(v.flooding.breachY[hit]).toBeGreaterThan(0); // port side of an eastbound hull
        expect(v.flooding.breachArea[hit]).toBeCloseTo(
          0.1 * definition.beam * definition.depth * amount,
          9,
        );
      }
    },
  );

  it('returns independent flood telemetry arrays for each snapshot', () => {
    const v = vessel();
    v.flooding.fill(0, 20);
    v.command({ flood: { compartment: 0, area: 0.25 } });
    const old = v.telemetry().flooding;
    old.fill[0] = 99;
    old.volume[0] = 99;
    old.breachArea[0] = 99;
    const current = v.telemetry().flooding;
    expect(current.volume[0]).toBe(20);
    expect(current.breachArea[0]).toBe(0.25);
    expect(current.fill[0]).toBeCloseTo(20 / v.flooding.compartments[0]!.capacity, 12);
    expect(current.totalFraction).toBeCloseTo(20 / v.flooding.capacity, 12);
  });
});
