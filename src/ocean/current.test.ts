import { describe, expect, it } from 'vitest';
import { EnvironmentSchema, type WaveSystem } from '../schema/experiment';
import { seaDiagnostics } from '../sim/diagnostics';
import { currentVelocity, OceanField } from './oceanField';

const swell: WaveSystem = {
  id: 'swell',
  name: 'Swell',
  enabled: true,
  kind: 'regular',
  height: 2,
  period: 9,
  directionDeg: 270, // from the west: travels east
  phaseDeg: 0,
};
const sea: WaveSystem = {
  id: 'sea',
  name: 'Sea',
  enabled: true,
  kind: 'spectrum',
  spectrum: 'jonswap',
  hs: 2,
  tp: 8,
  gamma: 3.3,
  directionDeg: 270,
  depthLimited: true,
  spreading: { model: 'mitsuyasu', s: 10 },
  seed: 3,
};

describe('uniform surface current', () => {
  it('points where the current flows toward', () => {
    const east = currentVelocity(
      EnvironmentSchema.parse({ currentSpeed: 2, currentDirectionDeg: 90 }),
    );
    expect(east.x).toBeCloseTo(2, 9);
    expect(east.y).toBeCloseTo(0, 9);
    const north = currentVelocity(EnvironmentSchema.parse({ currentSpeed: 1 }));
    expect(north.y).toBeCloseTo(1, 9);
    expect(currentVelocity(EnvironmentSchema.parse({}))).toEqual({ x: 0, y: 0 });
  });

  it('carries the whole sea with it and adds to the particle velocity', () => {
    const still = new OceanField([swell, sea], EnvironmentSchema.parse({}), { physicsGrid: 32 });
    const moving = new OceanField(
      [swell, sea],
      EnvironmentSchema.parse({ currentSpeed: 1.5, currentDirectionDeg: 45 }),
      { physicsGrid: 32 },
    );
    const ux = moving.currentX;
    const uy = moving.currentY;
    for (const [x, y, t] of [
      [3, -7, 0],
      [40, 12, 7.3],
      [-25, 60, 31.05],
    ] as const) {
      const a = moving.surface(x, y, t);
      const b = still.surface(x - ux * t, y - uy * t, t);
      expect(a.eta).toBeCloseTo(b.eta, 9);
      // Seen from a fixed point the surface changes faster or slower (Doppler).
      expect(a.etaT).toBeCloseTo(b.etaT - ux * b.slopeX - uy * b.slopeY, 9);
      const fa = moving.fluid(x, y, -6, t);
      const fb = still.fluid(x - ux * t, y - uy * t, -6, t);
      expect(fa.u).toBeCloseTo(fb.u + ux, 9);
      expect(fa.v).toBeCloseTo(fb.v + uy, 9);
      expect(fa.w).toBeCloseTo(fb.w, 9);
      expect(fa.pressure).toBeCloseTo(fb.pressure, 6);
    }
  });

  it('Doppler shifts a regular wave by k·U', () => {
    const env = EnvironmentSchema.parse({ currentSpeed: 1, currentDirectionDeg: 90 });
    const f = new OceanField([swell], env, { physicsGrid: 16 });
    const r = f.regularWaves[0]!;
    // Count zero up-crossings at a fixed point over many periods.
    const T = 600;
    let crossings = 0;
    let prev = f.surface(0, 0, 0).eta;
    for (let t = 0.05; t <= T; t += 0.05) {
      const e = f.surface(0, 0, t).eta;
      if (prev < 0 && e >= 0) crossings++;
      prev = e;
    }
    const expected = ((r.omega + r.k * 1) * T) / (2 * Math.PI);
    expect(Math.abs(crossings - expected)).toBeLessThanOrEqual(1);
  });

  it('warns when a current opposes the waves strongly', () => {
    const against = new OceanField(
      [sea],
      EnvironmentSchema.parse({ currentSpeed: 4, currentDirectionDeg: 270 }),
      { physicsGrid: 16 },
    );
    const w = seaDiagnostics(against.sea, 2, { x: against.currentX, y: against.currentY }).warnings;
    expect(w.some((m) => /opposing current|blocked/.test(m))).toBe(true);
    const following = seaDiagnostics(against.sea, 2, { x: 4, y: 0 }).warnings;
    expect(following.some((m) => /current/.test(m))).toBe(false);
  });
});
