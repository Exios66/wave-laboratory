/**
 * Flooding validation in waves: a small craft driven hard into steep head seas is holed in the
 * forefoot by heavy slams and ships water in its bow compartment, and a big ship in ordinary
 * seas stays dry.
 */
import { describe, expect, it, vi } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import { env, regular } from '../test/fixtures';
import { makeVessel, report, run } from './testUtil';

vi.setConfig({ testTimeout: 300_000 });

describe('slam breach', () => {
  it('a patrol boat at 20 kn in steep head seas is holed at the bow and floods', () => {
    const field = new OceanField([regular(4, 6, 90)], env(), { physicsGrid: 8 });
    const boat = makeVessel('patrol-boat', { speedKn: 20, autopilot: true }, field);
    run(boat, 60);
    const fl = boat.telemetry().flooding;
    report(
      `patrol boat, H 4 m T 6 s head seas, 60 s at 20 kn: bow breach ${fl.breachArea[0]!.toFixed(3)} m²,`,
      `flooded ${fl.totalVolume.toFixed(2)} m³ (${(100 * fl.totalFraction).toFixed(2)} %),`,
      `GM ${fl.gmIntact.toFixed(2)} → ${fl.gmEffective.toFixed(2)} m`,
    );
    expect(fl.breachArea[0]!).toBeGreaterThan(0);
    for (let i = 1; i < fl.breachArea.length; i++) expect(fl.breachArea[i]).toBe(0);
    expect(fl.fill[0]!).toBeGreaterThan(0);
    expect(Number.isFinite(boat.telemetry().heave)).toBe(true);
  });

  it('a container ship in a moderate sea stays dry', () => {
    const field = new OceanField([regular(2, 9, 90)], env(), { physicsGrid: 8 });
    const ship = makeVessel('cargo-ship', { speedKn: 12, autopilot: true }, field);
    run(ship, 60);
    expect(ship.telemetry().flooding.totalVolume).toBe(0);
    expect(ship.flooding.breached).toBe(false);
  });
});
