import { describe, expect, it } from 'vitest';
import {
  catenaryProfile,
  HOLDING_FACTOR,
  Mooring,
  mooringGear,
  solveCatenary,
  type MooringForce,
} from './mooring';

const W = 1000; // N/m
const RIGID = 1e16; // EA of an inextensible line

describe('inextensible catenary (hand calculation)', () => {
  // Take H = 20 kN, w = 1 kN/m, fairlead 40 m above the bottom, 200 m of line.
  // Hanging length Ls = √(h² + 2 h H / w) = √3200 = 56.569 m, V = w Ls = 56.569 kN,
  // reach X = (L − Ls) + (H/w) asinh(Ls H⁻¹ w) = 143.431 + 20 asinh(2.8284) = 178.69 m.
  const H0 = 20e3;
  const h = 40;
  const L = 200;
  const Ls = Math.sqrt(h * h + (2 * h * H0) / W);
  const X = L - Ls + (H0 / W) * Math.asinh((W * Ls) / H0);

  it('recovers the horizontal tension, hanging length and fairlead tension', () => {
    expect(Ls).toBeCloseTo(56.5685, 3);
    expect(X).toBeCloseTo(178.69, 1);
    const s = solveCatenary(X, h, L, W, RIGID);
    expect(s.regime).toBe('grounded');
    expect(s.H).toBeCloseTo(H0, -1); // within 5 N of 20 kN
    expect(s.suspended).toBeCloseTo(Ls, 3);
    expect(s.grounded).toBeCloseTo(L - Ls, 3);
    expect(s.V).toBeCloseTo(W * Ls, -1);
    expect(s.T).toBeCloseTo(Math.hypot(H0, W * Ls), -1);
    // Fairlead tension from the standard result T = H + w h
    expect(s.T).toBeCloseTo(H0 + W * h, -1);
    expect(s.touchdown).toBeCloseTo(L - Ls, 3);
  });

  it('fully suspended line: V − wL pulls the anchor up', () => {
    // Taut: chord 150 m on a 151 m line.
    const s = solveCatenary(Math.sqrt(150 ** 2 - 40 ** 2), 40, 151, W, RIGID);
    expect(s.regime).toBe('suspended');
    expect(s.V).toBeGreaterThan(W * 151);
    expect(Number.isFinite(s.H)).toBe(true);
    expect(s.T).toBeGreaterThan(s.V);
  });
});

describe('elastic stretch', () => {
  // Integrate the elastic catenary ODE independently: along the unstretched coordinate s the
  // tension is T = √(H² + (V_a + w s)²), strain T/EA, so
  // dx/ds = (H/T)(1 + T/EA), dz/ds = (V/T)(1 + T/EA).
  function integrate(H: number, V: number, L: number, w: number, ea: number) {
    const Va = Math.max(0, V - w * L);
    const Ls = (V - Va) / w;
    const N = 20000;
    let x = 0;
    let z = 0;
    for (let i = 0; i < N; i++) {
      const s = ((i + 0.5) * Ls) / N;
      const v = Va + w * s;
      const T = Math.hypot(H, v);
      x += ((H / T) * (1 + T / ea) * Ls) / N;
      z += ((v / T) * (1 + T / ea) * Ls) / N;
    }
    return { x, z, Ls };
  }

  for (const ea of [2e5, 5e6, 3e8]) {
    it(`reproduces the geometry by direct integration (EA = ${ea.toExponential(0)} N)`, () => {
      const X = 130;
      const hh = 30;
      const LL = 150;
      const s = solveCatenary(X, hh, LL, W, ea);
      expect(['grounded', 'suspended']).toContain(s.regime);
      const r = integrate(s.H, s.V, LL, W, ea);
      expect(r.z).toBeCloseTo(hh, 4);
      expect(s.grounded * (1 + s.H / ea) + r.x).toBeCloseTo(X, 4);
    });
  }

  it('a softer line carries less tension at the same offset, and stretches', () => {
    const stiff = solveCatenary(148, 30, 150, W, 1e9);
    const soft = solveCatenary(148, 30, 150, W, 2e6);
    expect(soft.H).toBeLessThan(stiff.H);
    expect(soft.H).toBeGreaterThan(0);
  });

  it('beyond the line length the tension is EA times the strain', () => {
    const ea = 1e8;
    const D = 100;
    const L = 99; // 1 % strain along a (nearly) straight line
    const s = solveCatenary(Math.sqrt(D * D - 20 * 20), 20, L, 10, ea); // light line: little sag
    expect(s.T).toBeCloseTo((ea * (D - L)) / L, -4);
    expect(s.T / ((ea * (D - L)) / L)).toBeGreaterThan(0.999);
    expect(s.T / ((ea * (D - L)) / L)).toBeLessThan(1.001);
  });
});

describe('slack and degenerate lines', () => {
  it('a slack line exerts no horizontal force, only its hanging weight', () => {
    const s = solveCatenary(20, 30, 200, W, 1e9);
    expect(s.regime).toBe('slack');
    expect(s.H).toBe(0);
    expect(s.V).toBeCloseTo(W * 30, -3);
    // the rest of the chain lies on the bottom
    expect(s.grounded).toBeGreaterThan(160);
  });

  it('is finite for zero, tiny and vertical offsets, short lines and huge strains', () => {
    for (const X of [0, 1e-9, 1e-3, 0.5, 1000, 5e4])
      for (const h of [0, 1e-6, 0.1, 5, 300])
        for (const L of [0.5, 5, 40, 400, 5000])
          for (const ea of [1e3, 1e6, 1e9, 1e12])
            for (const w of [1, 500, 1e4]) {
              const s = solveCatenary(X, h, L, w, ea);
              for (const v of [s.H, s.V, s.T, s.grounded, s.suspended, s.touchdown])
                expect(Number.isFinite(v)).toBe(true);
              expect(s.H).toBeGreaterThanOrEqual(0);
            }
  });

  it('a line too short to reach the bottom is a straight elastic bar', () => {
    const s = solveCatenary(30, 100, 60, W, 1e7);
    expect(s.regime).toBe('taut');
    expect(s.T).toBeCloseTo((1e7 * (Math.hypot(30, 100) - 60)) / 60, 0);
    expect(s.H / s.V).toBeCloseTo(0.3, 6);
  });
});

describe('restoring force', () => {
  it('horizontal tension rises monotonically and continuously with offset', () => {
    let prev = -1;
    for (let X = 0; X <= 210; X += 0.5) {
      const s = solveCatenary(X, 30, 200, W, 5e7);
      expect(s.H).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(s.T).toBeGreaterThanOrEqual(0);
      prev = s.H;
    }
    expect(prev).toBeGreaterThan(5e5); // stretched beyond the length: stiff
  });

  it('has no jump where the line first lifts off the bottom', () => {
    // Slack limit X = L − s0.
    const L = 200;
    const lim = L - 30;
    const a = solveCatenary(lim - 1e-4, 30, L, W, 1e9);
    const b = solveCatenary(lim + 1e-4, 30, L, W, 1e9);
    expect(Math.abs(b.H - a.H)).toBeLessThan(2e3);
    expect(Math.abs(b.T - a.T)).toBeLessThan(2e3);
  });
});

describe('profile', () => {
  it('runs from the anchor to the fairlead along the catenary', () => {
    const X = 150;
    const h = 30;
    const L = 200;
    const sol = solveCatenary(X, h, L, W, 3e8);
    const p = catenaryProfile(sol, X, h, L, W, 3e8, 24);
    expect(p[0]).toBe(0);
    expect(p[1]).toBe(0);
    expect(p[p.length - 2]).toBeCloseTo(X, 3);
    expect(p[p.length - 1]).toBeCloseTo(h, 3);
    for (let i = 3; i < p.length; i += 2) expect(p[i]!).toBeGreaterThanOrEqual(p[i - 2]! - 1e-9);
  });
});

describe('ground tackle', () => {
  it('scales with the ship', () => {
    const small = mooringGear(15e3, 10);
    const cargo = mooringGear(60e6, 180);
    const vlcc = mooringGear(350e6, 330);
    expect(cargo.chainDiameter).toBeGreaterThan(small.chainDiameter);
    expect(vlcc.chainDiameter).toBeGreaterThan(cargo.chainDiameter);
    expect(vlcc.w).toBeGreaterThan(cargo.w);
    expect(cargo.holding).toBeCloseTo(HOLDING_FACTOR * cargo.anchorMass * 9.80665, 3);
    expect(mooringGear(1e6, 50, 1025, 9.80665, true).holding).toBe(Infinity);
  });
});

describe('anchor line and drag', () => {
  const gear = { ...mooringGear(2e6, 70), w: W, ea: 5e8, holding: 150e3 };
  const out: MooringForce = { fx: 0, fy: 0, fz: 0 };

  it('pulls the vessel back toward the anchor and down', () => {
    const m = new Mooring(gear, 30);
    m.deploy(0, 0, 150);
    m.force(0, 0, 30 - 30 + 10, out);
    // directly above: slack, only a vertical pull
    expect(out.fx).toBe(0);
    expect(out.fy).toBe(0);
    m.force(140, 0, 8, out);
    expect(out.fx).toBeLessThan(0);
    expect(out.fy).toBeCloseTo(0, 9);
    expect(out.fz).toBeLessThan(0);
    m.force(0, -140, 8, out);
    expect(out.fy).toBeGreaterThan(0);
  });

  it('holds below the holding limit and drags above it', () => {
    const m = new Mooring(gear, 30);
    m.deploy(0, 0, 150);
    m.force(147, 0, 3, out); // 3 m above the bottom? fairlead z is world; the bottom is −30
    // z = 3 → h = 33
    expect(m.solution.H).toBeGreaterThan(0);
    // set a position with H below the limit
    m.force(120, 0, 3, out);
    expect(m.solution.H).toBeLessThan(gear.holding);
    m.step(1);
    expect(m.dragging).toBe(false);
    expect(m.anchorX).toBe(0);
    // pull harder than the holding limit
    let X = 120;
    while (m.solution.H <= gear.holding && X < 200) {
      X += 0.25;
      m.force(X, 0, 3, out);
    }
    expect(m.solution.H).toBeGreaterThan(gear.holding);
    m.step(0.1);
    expect(m.dragging).toBe(true);
    expect(m.anchorX).toBeGreaterThan(0); // dragged toward the vessel
    expect(m.anchorX).toBeLessThan(X);
    expect(m.anchorY).toBeCloseTo(0, 9);
  });

  it('never drags past the vessel and ignores a weighed anchor', () => {
    const m = new Mooring({ ...gear, holding: 1 }, 30);
    m.deploy(0, 0, 150);
    m.force(149, 0, 3, out);
    m.step(1000);
    expect(m.anchorX).toBeLessThanOrEqual(149 + 1e-9);
    m.weigh();
    m.force(100, 0, 3, out);
    expect(out.fx).toBe(0);
    expect(out.fz).toBe(0);
    expect(m.profile()).toEqual([]);
  });

  it('a buoy never drags and the chain is limited by the chain carried', () => {
    const buoy = new Mooring({ ...gear, holding: Infinity }, 30, 'buoy');
    buoy.deploy(0, 0, 40);
    buoy.force(39, 0, 3, out);
    buoy.step(10);
    expect(buoy.dragging).toBe(false);
    expect(buoy.anchorZ).toBe(0);
    const m = new Mooring({ ...gear, capacity: 200 }, 100);
    expect(m.lengthForScope(7)).toBe(200);
    expect(m.lengthForScope(3)).toBe(200);
    expect(new Mooring({ ...gear, capacity: 200 }, 30).lengthForScope(5)).toBe(150);
    expect(new Mooring({ ...gear, capacity: 200 }, 4000).available).toBe(false);
  });
});
