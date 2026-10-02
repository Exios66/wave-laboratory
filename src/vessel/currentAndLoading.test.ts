/**
 * Surface current sets a ship off its track; the loading condition changes displacement and draft.
 */
import { describe, expect, it, vi } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import { env } from '../test/fixtures';
import { createVesselDefinition } from './definition';
import { makeVessel, report, run } from './testUtil';
import { Vessel } from './vessel';

vi.setConfig({ testTimeout: 300_000 });

describe('surface current', () => {
  const current = new OceanField([], env({ currentSpeed: 1, currentDirectionDeg: 90 }));

  it('a drifting lifeboat is picked up by the current', () => {
    // Starts beam-on (heading north, current east): cross-flow drag picks it up within a minute,
    // the hull then swings end-on to the flow and friction closes the last few percent slowly.
    const v = makeVessel('lifeboat', { headingDeg: 0 }, current);
    run(v, 360);
    const tm = v.telemetry();
    report(
      'lifeboat',
      'drift in a 1 m/s east current after 360 s:',
      tm.velocity.x.toFixed(3),
      'm/s',
    );
    expect(tm.velocity.x).toBeGreaterThan(0.9);
    expect(tm.velocity.x).toBeLessThan(1.05);
    expect(Math.abs(tm.velocity.y)).toBeLessThan(0.05);
    expect(Math.abs(tm.heave)).toBeLessThan(0.01);
  });

  it('a ship on autopilot keeps its speed through the water and is set sideways', () => {
    const v = makeVessel('trawler', { speedKn: 8, headingDeg: 0, autopilot: true }, current);
    run(v, 240);
    const tm = v.telemetry();
    report(
      'trawler',
      'north at 8 kn in an east current: ground velocity',
      tm.velocity.x.toFixed(2),
      tm.velocity.y.toFixed(2),
    );
    // Set to the east by about the current (heading is held, so no crab angle correction).
    expect(tm.velocity.x).toBeGreaterThan(0.75);
    expect(tm.velocity.x).toBeLessThan(1.15);
    expect(tm.velocity.y).toBeGreaterThan(8 * 0.5144 * 0.85);
  });
});

describe('loading condition', () => {
  it('scales displacement and moves the waterline', () => {
    const design = createVesselDefinition('cargo-ship', 1, 0.6, 1);
    const light = createVesselDefinition('cargo-ship', 1, 0.6, 0.6);
    const deep = createVesselDefinition('cargo-ship', 1, 0.6, 1.15);
    expect(light.mass / design.mass).toBeCloseTo(0.6, 2);
    expect(deep.mass / design.mass).toBeCloseTo(1.15, 2);
    expect(light.draft).toBeLessThan(design.draft);
    expect(deep.draft).toBeGreaterThan(design.draft);
    expect(light.designDraft).toBeCloseTo(design.draft, 9);
    expect(design.draft).toBeCloseTo(design.designDraft, 9);
    report(
      'cargo-ship',
      'draft light/design/deep:',
      light.draft.toFixed(2),
      design.draft.toFixed(2),
      deep.draft.toFixed(2),
      'm; GM',
      light.gm.toFixed(2),
      design.gm.toFixed(2),
      deep.gm.toFixed(2),
    );
  });

  it('a lightly loaded ship floats at rest at its new draft', () => {
    const def = createVesselDefinition('trawler', 1, 0.6, 0.7);
    const light = new Vessel(
      'trawler',
      def,
      { x: 0, y: 0, headingDeg: 90, speedKn: 0, autopilot: false },
      new OceanField([], env()),
    );
    let maxHeave = 0;
    run(light, 30, () => {
      maxHeave = Math.max(maxHeave, Math.abs(light.telemetry().heave));
    });
    expect(maxHeave).toBeLessThan(1e-3);
    expect(light.telemetry().submergence).toBeCloseTo(1, 4);
  });
});
