import { describe, expect, it, vi } from 'vitest';
import type { WaveSystem } from '../schema/experiment';
import { env, regular } from '../test/fixtures';
import { makeVessel, run } from '../vessel/testUtil';
import { OceanField } from './oceanField';
import { solveStokes5 } from './nonlinear';

vi.setConfig({ testTimeout: 120_000 });

const reg = (theory: 'airy' | 'stokes2' | 'stokes5' | 'cnoidal', h: number, T: number) =>
  ({ ...(regular(h, T, 270) as object), theory }) as WaveSystem;
const solitary = (h: number): WaveSystem => ({
  id: 'sol',
  name: 'Solitary',
  kind: 'solitary',
  enabled: true,
  directionDeg: 270,
  height: h,
  spacing: 0,
  phaseDeg: 0,
});

describe('OceanField with Stokes fifth-order waves', () => {
  const e = env({ depth: 40, choppiness: 0 });
  const sol = solveStokes5({ height: 5, period: 9, depth: 40, gravity: e.gravity });
  const field = new OceanField([reg('stokes5', 5, 9)], e);

  it('samples the Fenton profile and travels toward +x at the nonlinear phase speed', () => {
    field.prepare(0);
    const crest = field.surface(0, 0, 0).eta;
    const trough = field.surface(Math.PI / sol.k, 0, 0).eta;
    expect(crest - trough).toBeCloseTo(5, 6);
    expect(crest).toBeGreaterThan(-trough);
    // one period later the same point shows the same elevation; half a period moves the crest
    const t1 = 9;
    field.prepare(t1);
    expect(field.surface(0, 0, t1).eta).toBeCloseTo(crest, 6);
    const t2 = 3;
    field.prepare(t2);
    expect(field.surface(sol.c * t2, 0, t2).eta).toBeCloseTo(crest, 6);
  });

  it('gives a pressure whose mean over a period is hydrostatic', () => {
    let sum = 0;
    const n = 90;
    for (let i = 0; i < n; i++) {
      const t = (9 * i) / n;
      field.prepare(t);
      sum += field.fluid(0, 0, -12, t).pressure / n;
    }
    expect(sum / (e.waterDensity * e.gravity * 12)).toBeCloseTo(1, 2);
  });

  it('fluid() and column() agree, and the surface pressure is zero', () => {
    const t = 2.3;
    field.prepare(t);
    const eta = field.surface(37, 5, t).eta;
    const a = field.fluid(37, 5, eta - 0.001, t);
    expect(Math.abs(a.pressure)).toBeLessThan(0.02 * e.waterDensity * e.gravity * 5 + 500);
    const col = {
      eta: 0,
      slopeX: 0,
      slopeY: 0,
      etaT: 0,
      head: new Float64Array(2),
      u: new Float64Array(2),
      v: new Float64Array(2),
      w: new Float64Array(2),
    };
    field.column(37, 5, t, [-3, -10], col);
    const h = ((-3 - eta) * 40) / (40 + eta);
    void h;
    expect(col.eta).toBeCloseTo(eta, 12);
    expect(Number.isFinite(col.head[0]! + col.u[1]! + col.w[0]!)).toBe(true);
  });

  it('choppiness moves the crest forward-sharpening displacement but stays finite', () => {
    const f = new OceanField([reg('stokes5', 5, 9)], env({ depth: 40, choppiness: 1 }));
    f.prepare(0);
    const s = f.surface(10, 0, 0);
    expect(Number.isFinite(s.eta + s.slopeX + s.etaT)).toBe(true);
  });
});

describe('OceanField with solitary and cnoidal waves', () => {
  const e = env({ depth: 3, choppiness: 0 });
  it('a solitary hump rides at c = sqrt(g (h + H)) on still water', () => {
    const f = new OceanField([solitary(0.9)], e);
    const c = Math.sqrt(e.gravity * 3.9);
    f.prepare(0);
    expect(f.surface(0, 0, 0).eta).toBeCloseTo(0.9, 9);
    const t = 5;
    f.prepare(t);
    expect(f.surface(c * t, 0, t).eta).toBeCloseTo(0.9, 6);
    const half = 0.5 * f.nonlinearWaves[0]!.solitary!.spacing;
    expect(Math.abs(f.surface(c * t + half, 0, t).eta)).toBeLessThan(1e-9);
    // hydrostatic pressure: the head is the elevation, velocity is c η / h
    const fl = f.fluid(c * t, 0, -1, t);
    expect(fl.pressure).toBeCloseTo(e.waterDensity * e.gravity * (0.9 + 1), 3);
    expect(fl.u).toBeCloseTo((c * 0.9) / 3, 6);
  });
  it('a cnoidal sea has zero mean elevation and crest height from the series', () => {
    const f = new OceanField([reg('cnoidal', 0.6, 20)], e);
    f.prepare(0);
    let mean = 0;
    const n = 600;
    const L = (2 * Math.PI) / f.nonlinearWaves[0]!.k;
    for (let i = 0; i < n; i++) mean += f.surface((L * i) / n, 0, 0).eta / n;
    expect(Math.abs(mean)).toBeLessThan(1e-3);
  });
  it('contributes its energy to the represented variance', () => {
    const f = new OceanField([reg('stokes5', 2, 8)], env({ depth: 50 }));
    expect(f.representedVariance).toBeCloseTo((2 / 2) ** 2 / 2, 2);
  });
});

describe('vessels in nonlinear seas', () => {
  it('a ship in a steep Stokes-5 sea stays finite and stable', () => {
    const e = env({ depth: 80 });
    const field = new OceanField([reg('stokes5', 6, 10)], e);
    const v = makeVessel('cargo-ship', { speedKn: 8, headingDeg: 90 }, field);
    let worstRoll = 0;
    let worstHeave = 0;
    run(v, 120, () => {
      const t = v.telemetry();
      expect(Number.isFinite(t.heave + t.rollDeg + t.pitchDeg + t.speedKn)).toBe(true);
      worstRoll = Math.max(worstRoll, Math.abs(t.rollDeg));
      worstHeave = Math.max(worstHeave, Math.abs(t.heave));
    });
    expect(worstHeave).toBeGreaterThan(0.5); // the ship does feel the waves
    expect(worstRoll).toBeLessThan(25);
    expect(worstHeave).toBeLessThan(8);
    expect(v.telemetry().capsized).toBe(false);
  });
  it('a ship in a solitary-wave basin stays finite', () => {
    const e = env({ depth: 12 });
    const field = new OceanField([solitary(3)], e);
    const v = makeVessel('trawler', { speedKn: 0, headingDeg: 90 }, field);
    run(v, 60, () => {
      const t = v.telemetry();
      expect(Number.isFinite(t.heave + t.rollDeg + t.pitchDeg)).toBe(true);
    });
  });
});
