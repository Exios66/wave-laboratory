import { describe, expect, it } from 'vitest';
import type { WaveSystem } from '../schema/experiment';
import { env, regular } from '../test/fixtures';
import { resolveSea } from './systems';

const e = env({ depth: 20, gravity: 9.81 });
const withTheory = (theory: 'airy' | 'stokes2' | 'stokes5' | 'cnoidal', h = 2): WaveSystem => ({
  ...(regular(h, 9, 270) as WaveSystem & { kind: 'regular' }),
  theory,
});

describe('resolveSea with wave theories', () => {
  it('keeps the legacy path for stokes2 and for an absent theory', () => {
    const a = resolveSea([regular(2, 9, 270)], e);
    const b = resolveSea([withTheory('stokes2')], e);
    expect(a.regular).toHaveLength(1);
    expect(a.regular[0]!.stokes).toBe(true);
    expect(b.regular[0]).toEqual({ ...a.regular[0]!, id: b.regular[0]!.id });
    expect(a.nonlinear).toHaveLength(0);
  });
  it('airy is the linear wave without the second-order term', () => {
    const s = resolveSea([withTheory('airy')], e);
    expect(s.regular[0]!.stokes).toBe(false);
  });
  it('stokes5 resolves to a harmonic wave with its own k, not into the linear list', () => {
    const s = resolveSea([withTheory('stokes5')], e);
    expect(s.regular).toHaveLength(0);
    const w = s.nonlinear[0]!;
    expect(w.kind).toBe('harmonic');
    expect(w.harmonics.length).toBeGreaterThanOrEqual(5);
    expect(w.omega).toBeCloseTo((2 * Math.PI) / 9, 12);
    expect(w.dirX).toBeCloseTo(1, 12); // from the west, travelling toward +x
    expect(w.theory).toBe('stokes5');
  });
  it('cnoidal resolves to a harmonic wave and reports Ursell', () => {
    const s = resolveSea(
      [{ ...withTheory('cnoidal', 0.5), period: 25 } as WaveSystem],
      env({ depth: 3 }),
    );
    const w = s.nonlinear[0]!;
    expect(w.kind).toBe('harmonic');
    expect(w.theory).toBe('cnoidal');
    expect(w.ursell).toBeGreaterThan(20);
    expect(w.omega).toBeCloseTo((2 * Math.PI) / 25, 6);
  });
  it('a solitary system resolves to a solitary wave with a notice when clamped', () => {
    const sys: WaveSystem = {
      id: 's',
      name: 'S',
      kind: 'solitary',
      enabled: true,
      directionDeg: 270,
      height: 5,
      spacing: 0,
      phaseDeg: 0,
    };
    const s = resolveSea([sys], env({ depth: 3 }));
    const w = s.nonlinear[0]!;
    expect(w.kind).toBe('solitary');
    expect(w.solitary!.heightUsed).toBeCloseTo(0.78 * 3, 9);
    expect(w.notice).toMatch(/0\.78/);
  });
  it('zero height produces nothing', () => {
    expect(resolveSea([withTheory('stokes5', 0)], e).nonlinear).toHaveLength(0);
  });
});
