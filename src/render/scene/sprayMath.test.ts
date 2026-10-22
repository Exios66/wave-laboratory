import { describe, expect, it } from 'vitest';
import {
  drawCount,
  flightPosition,
  makeRng,
  planRingWrite,
  pointVerticalSpeed,
  scheduleCrestBursts,
  slamStrength,
  spindriftRate,
  spindriftStrength,
  sprayAlpha,
} from './sprayMath';
import type { FlightParams } from './sprayMath';

type S = [number, number, number, number, number, number];

/** Reference: classic RK4 on dv/dt = -k (v - w) + (0, -g, 0), dx/dt = v. */
function rk4(p: FlightParams, t: number, steps: number): [number, number, number] {
  const f = (s: S): S => [
    s[3],
    s[4],
    s[5],
    -p.drag * (s[3] - p.wx),
    -p.drag * s[4] - p.g,
    -p.drag * (s[5] - p.wz),
  ];
  const add = (a: S, b: S, h: number): S => a.map((v, i) => v + h * b[i]!) as S;
  let s: S = [p.x0, p.y0, p.z0, p.vx, p.vy, p.vz];
  const h = t / steps;
  for (let i = 0; i < steps; i++) {
    const k1 = f(s);
    const k2 = f(add(s, k1, h / 2));
    const k3 = f(add(s, k2, h / 2));
    const k4 = f(add(s, k3, h));
    s = s.map((v, j) => v + (h / 6) * (k1[j]! + 2 * k2[j]! + 2 * k3[j]! + k4[j]!)) as S;
  }
  return [s[0], s[1], s[2]];
}

const base: FlightParams = {
  x0: 3,
  y0: 1.5,
  z0: -7,
  vx: 6,
  vy: 9,
  vz: -4,
  wx: 12,
  wz: -3,
  drag: 1.4,
  g: 9.81 * 0.8,
};

describe('flightPosition', () => {
  it('matches an RK4 integration of the same ODE', () => {
    for (const p of [
      base,
      { ...base, drag: 0.05 },
      { ...base, drag: 6, vy: 14 },
      { ...base, g: -0.035 * 9.81, drag: 0.7 }, // buoyant smoke-like
    ]) {
      for (const t of [0, 0.1, 0.9, 2.5, 6]) {
        const a = flightPosition(p, t);
        const b = rk4(p, t, 600);
        for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 6);
      }
    }
  });

  it('starts at the birth position and relaxes toward the wind drift', () => {
    expect(flightPosition(base, 0)).toEqual([3, 1.5, -7]);
    const [x1] = flightPosition(base, 20);
    const [x2] = flightPosition(base, 21);
    expect(x2 - x1).toBeCloseTo(base.wx, 3);
  });

  it('is finite with zero drag', () => {
    const [x, y] = flightPosition({ ...base, drag: 0 }, 2);
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });
});

describe('sprayAlpha', () => {
  it('fades in and out and stays in range', () => {
    expect(sprayAlpha(0)).toBe(0);
    expect(sprayAlpha(1)).toBe(0);
    expect(sprayAlpha(0.2)).toBeGreaterThan(sprayAlpha(0.9));
    for (let u = 0; u <= 1; u += 0.05) expect(sprayAlpha(u)).toBeLessThanOrEqual(1);
  });
});

describe('planRingWrite', () => {
  it('stays contiguous when it fits and splits at the wrap', () => {
    expect(planRingWrite(2, 3, 10)).toEqual([{ start: 2, count: 3 }]);
    expect(planRingWrite(8, 5, 10)).toEqual([
      { start: 8, count: 2 },
      { start: 0, count: 3 },
    ]);
  });
  it('keeps the newest slots when the write exceeds the ring', () => {
    const r = planRingWrite(3, 25, 10);
    expect(r.reduce((s, x) => s + x.count, 0)).toBe(10);
    expect(r[0]!.start).toBe((3 + 15) % 10);
  });
  it('ignores empty writes', () => {
    expect(planRingWrite(0, 0, 10)).toEqual([]);
    expect(planRingWrite(0, 3, 0)).toEqual([]);
  });
});

describe('emitter schedulers', () => {
  it('scales slamming with the bow vertical speed', () => {
    expect(slamStrength(0.2)).toBe(0);
    expect(slamStrength(-4)).toBeGreaterThan(slamStrength(-2));
    expect(slamStrength(30)).toBe(1);
    expect(pointVerticalSpeed({ z: 1 }, { x: 0.5, y: 0 }, { x: 0, y: 4 })).toBeCloseTo(3);
  });

  it('starts spindrift at Beaufort 8 and rises with the wind', () => {
    expect(spindriftStrength(15)).toBe(0);
    expect(spindriftRate(15)).toBe(0);
    expect(spindriftRate(22)).toBeGreaterThan(spindriftRate(18));
    expect(spindriftRate(60)).toBeGreaterThan(spindriftRate(22));
  });

  it('keeps the fractional remainder and drops surplus past the cap', () => {
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const [n, rest] = drawCount(2.5, 0.1, carry, 10);
      total += n;
      carry = rest;
    }
    expect(total).toBe(25);
    expect(drawCount(1e6, 1, 0, 10)).toEqual([10, 0]);
  });

  it('is calm below the whitecap onset and deterministic otherwise', () => {
    expect(scheduleCrestBursts(4, 1, 1, 0, 1, makeRng(1)).bursts).toHaveLength(0);
    const a = scheduleCrestBursts(18, 4, 0.5, 0, 1, makeRng(7));
    const b = scheduleCrestBursts(18, 4, 0.5, 0, 1, makeRng(7));
    expect(a).toEqual(b);
    expect(a.bursts.length).toBeGreaterThan(0);
    for (const x of a.bursts) {
      expect(Math.hypot(x.dx, x.dz)).toBeGreaterThanOrEqual(14);
      expect(x.count).toBeGreaterThanOrEqual(3);
    }
    const heavy = scheduleCrestBursts(25, 6, 1, 0, 1, makeRng(3)).bursts.length;
    const light = scheduleCrestBursts(9, 1, 1, 0, 1, makeRng(3)).bursts.length;
    expect(heavy).toBeGreaterThan(light);
  });
});
