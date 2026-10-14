/** Sloop fore-and-aft rig and fin-keel foils wired into the Vessel force path. */
import { describe, expect, it, vi } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import type { VesselDefinition } from './api';
import { env } from '../test/fixtures';
import { createVesselDefinition } from './definition';
import { Vessel, type VesselOptions } from './vessel';

vi.setConfig({ testTimeout: 60_000 });

const DT = 1 / 120;
const field = new OceanField([], env());

/** Constant 10 m wind blowing FROM `fromDeg` (compass, 90 = east = starboard of a north-facing hull). */
const steadyWind = (speed: number, fromDeg: number): VesselOptions['wind'] => ({
  windAt: (_x, _y, _t, out) => {
    const to = ((fromDeg + 180) % 360) * (Math.PI / 180);
    out.u = speed * Math.sin(to);
    out.v = speed * Math.cos(to);
    out.speed = speed;
  },
});

function sloop(foils: boolean): Vessel {
  let def: VesselDefinition = createVesselDefinition('sloop-yacht');
  if (!foils) def = { ...def, foils: [] };
  return new Vessel(
    foils ? 'sloop' : 'sloop-bare',
    def,
    { x: 0, y: 0, headingDeg: 0, speedKn: 3, autopilot: true },
    field,
    { wind: steadyWind(6, 90) },
  );
}

/** Run `seconds` from rest, returning the leeway samples of the last `tail` seconds. */
function sailAndRecord(v: Vessel, seconds: number, tail = 10): number[] {
  const n = Math.round(seconds / DT);
  const first = Math.round((seconds - tail) / DT);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    v.step(DT, i * DT);
    if (i >= first) out.push(v.telemetry().leewayDeg);
  }
  return out;
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('sloop fore-and-aft rig force path', () => {
  it('a sloop in a steady beam wind sails with leeway and set sheets', () => {
    const v = sloop(true);
    const tail = sailAndRecord(v, 45);
    const tel = v.telemetry();
    const leeway = mean(tail);
    // Wind from starboard: the boat drifts to port (+ leeway) at a sane angle.
    expect(leeway).toBeGreaterThan(0.5);
    expect(leeway).toBeLessThan(30);
    // The sails carry real aerodynamic force and the sheets are set on the lee side.
    expect(tel.windForce).toBeGreaterThan(50);
    expect(tel.jibDeg).toBeLessThan(0);
    expect(tel.braceDeg).toBeLessThan(0);
    expect(Math.abs(tel.jibDeg)).toBeGreaterThan(0.5);
    expect(Math.abs(tel.sailAlphaDeg)).toBeGreaterThan(0.5);
  });

  it('the fin keel cuts the leeway of the same rig with no foils', () => {
    const keel = sailAndRecord(sloop(true), 45);
    const bare = sailAndRecord(sloop(false), 45);
    expect(Math.abs(mean(bare))).toBeGreaterThan(Math.abs(mean(keel)) + 1);
  });

  it('non-rig hulls report exactly zero sailing telemetry', () => {
    const v = new Vessel(
      'trawler',
      createVesselDefinition('trawler'),
      { x: 0, y: 0, headingDeg: 0, speedKn: 3, autopilot: true },
      field,
      { wind: steadyWind(6, 90) },
    );
    for (let i = 0; i < Math.round(10 / DT); i++) v.step(DT, i * DT);
    const tel = v.telemetry();
    expect(tel.jibDeg).toBe(0);
    expect(tel.sailAlphaDeg).toBe(0);
    expect(tel.leewayDeg).toBe(0);
    expect(tel.vmgKn).toBe(0);
  });
});
