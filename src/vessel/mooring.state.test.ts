import { describe, expect, it } from 'vitest';
import { Mooring, catenaryProfile, emptySolution, mooringGear, solveCatenary } from './mooring';

const gear = mooringGear(1e6, 100);
const output = () => ({ fx: 0, fy: 0, fz: 0 });

describe('mooring lifecycle and damping', () => {
  it('includes the exact depth availability boundary and permits surface buoys in deep water', () => {
    const boundary = 1.1 * 30;
    expect(new Mooring({ ...gear, capacity: boundary }, 30).available).toBe(true);
    expect(new Mooring({ ...gear, capacity: boundary - 1e-6 }, 30).available).toBe(false);
    expect(new Mooring(gear, 10000, 'buoy').available).toBe(true);
    expect(new Mooring(gear, 30).lengthForScope(0)).toBeCloseTo(31.5, 12);
  });

  it('clears stale force and drag state when weighed and redeploys at the new position', () => {
    const m = new Mooring({ ...gear, holding: 1 }, 30);
    m.deploy(0, 0, 150);
    m.force(149, 0, 3, output());
    m.step(0.1);
    expect(m.dragging).toBe(true);
    m.weigh();
    const out = { fx: 1, fy: 2, fz: 3 };
    expect(m.force(149, 0, 3, out)).toBe(out);
    expect(out).toEqual(output());
    expect(m.dragging).toBe(false);
    expect(m.profile()).toEqual([]);
    m.deploy(10, -20, 120);
    expect(m.deployed).toBe(true);
    expect(m.anchorX).toBe(10);
    expect(m.anchorY).toBe(-20);
    expect(m.anchorZ).toBe(-30);
    expect(m.solution.T).toBe(0);
    expect(m.length).toBe(120);
  });

  it('damps radial velocity but leaves tangential motion and the static solution unchanged', () => {
    const m = new Mooring(gear, 30);
    m.mass = 1e6;
    m.deploy(0, 0, 150);
    const stationary = m.force(140, 0, 3, output());
    const tension = m.solution.H;
    expect(tension).toBeGreaterThan(0);
    const outward = m.force(140, 0, 3, output(), 0.1, 0);
    const inward = m.force(140, 0, 3, output(), -0.1, 0);
    const tangent = m.force(140, 0, 3, output(), 0, 20);
    expect(outward.fx).toBeLessThan(stationary.fx);
    expect(inward.fx).toBeGreaterThan(stationary.fx);
    expect((outward.fx + inward.fx) / 2).toBeCloseTo(stationary.fx, 8);
    expect(tangent).toEqual(stationary);
    expect(outward.fz).toBe(stationary.fz);
    expect(m.solution.H).toBe(tension);
  });

  it('has no horizontal damping on a slack line, even with radial motion', () => {
    const m = new Mooring(gear, 30);
    m.mass = 1e6;
    m.deploy(0, 0, 150);
    const f = m.force(10, 0, 3, output(), 20, 0);
    expect(f.fx).toBeCloseTo(0, 12);
    expect(f.fy).toBeCloseTo(0, 12);
    expect(f.fz).toBeLessThan(0);
  });

  it('caps anchor drag speed and follows the direction of the pull in both axes', () => {
    const m = new Mooring({ ...gear, holding: 1 }, 30);
    m.deploy(0, 0, 150);
    m.force(120, 90, 3, output()); // radial unit vector (0.8, 0.6)
    m.step(0.1);
    expect(m.dragging).toBe(true);
    expect(m.anchorX).toBeCloseTo(1.6, 12);
    expect(m.anchorY).toBeCloseTo(1.2, 12);
    expect(m.anchorZ).toBe(-30);
  });
});

describe('catenary output reuse and profiles', () => {
  it('replaces an earlier loaded solution when the line becomes slack or taut', () => {
    const out = emptySolution();
    solveCatenary(148, 30, 150, 1000, 3e8, out);
    expect(out.H).toBeGreaterThan(0);
    expect(solveCatenary(0, 30, 150, 1000, 3e8, out)).toBe(out);
    expect(out.H).toBe(0);
    expect(out.regime).toBe('slack');
    expect(out.iterations).toBe(0);
    solveCatenary(30, 100, 60, 1000, 3e8, out);
    expect(out.regime).toBe('taut');
    expect(out.grounded).toBe(0);
    expect(out.touchdown).toBe(0);
    expect(out.suspended).toBe(60);
  });

  it.each([
    { regime: 'slack', x: 20, h: 30, length: 200 },
    { regime: 'grounded', x: 180, h: 40, length: 200 },
    { regime: 'suspended', x: Math.sqrt(150 ** 2 - 40 ** 2), h: 40, length: 151 },
    { regime: 'taut', x: 30, h: 100, length: 60 },
  ])(
    '$regime profile joins anchor to fairlead and never goes below the seabed',
    ({ regime, x, h, length }) => {
      const sol = solveCatenary(x, h, length, 1000, 1e12);
      expect(sol.regime).toBe(regime);
      const profile = catenaryProfile(sol, x, h, length, 1000, 1e12, 12);
      expect(profile.slice(0, 2)).toEqual([0, 0]);
      expect(profile.at(-2)).toBeCloseTo(x, 5);
      expect(profile.at(-1)).toBeCloseTo(h, 5);
      for (let i = 2; i < profile.length; i += 2) {
        expect(profile[i]!).toBeGreaterThanOrEqual(profile[i - 2]! - 1e-9);
        expect(profile[i + 1]!).toBeGreaterThanOrEqual(0);
      }
    },
  );
});
