import { describe, expect, it } from 'vitest';
import { env, regular } from '../test/fixtures';
import {
  BREAKING_JACOBIAN,
  energyDensity,
  overlayScale,
  regularOverlay,
  sumRegularOverlay,
} from './overlays';
import { OceanField } from './oceanField';
import { resolveSea } from './systems';

function setup(height: number, period: number, depth: number) {
  const e = env({ depth, choppiness: 0 });
  const sea = resolveSea([regular(height, period, 270)], e);
  return { e, sea, field: new OceanField([regular(height, period, 270)], e) };
}

describe('regular-wave overlay mirror of the shader', () => {
  for (const depth of [25, 4000]) {
    it(`surface orbital velocity matches OceanField (depth ${depth} m)`, () => {
      const { e, sea, field } = setup(2, 8, depth);
      for (const [x, y, t] of [
        [0, 5, 0],
        [13, -7, 2.2],
        [-40, 21, 7.9],
      ] as const) {
        const m = sumRegularOverlay(sea.regular, x, y, t, 0, e.depth, 0);
        const eta = field.surface(x, y, t).eta;
        const f = field.fluid(x, y, eta - 1e-9, t);
        expect(m.eta).toBeCloseTo(eta, 9);
        expect(m.u).toBeCloseTo(f.u, 6);
        expect(m.v).toBeCloseTo(f.v, 6);
        expect(m.w).toBeCloseTo(f.w, 6);
      }
    });
  }

  it('is the textbook a*omega magnitude in deep water', () => {
    const { e, sea } = setup(2, 8, 4000);
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      const m = sumRegularOverlay(sea.regular, i * 3.1, 0, 0, 0, e.depth, 0);
      peak = Math.max(peak, Math.hypot(m.u, m.v, m.w));
    }
    // Deep water orbits are circles: the speed is a*omega everywhere.
    expect(peak).toBeCloseTo(1 * ((2 * Math.PI) / 8), 3);
  });

  it('dynamic pressure at depth matches the linear OceanField head', () => {
    for (const depth of [30, 4000]) {
      const { e, sea, field } = setup(0.2, 8, depth);
      const amp = 0.1;
      for (const d of [0, 3, 12]) {
        for (const [x, t] of [
          [0, 0],
          [17, 3.3],
          [-31, 6.1],
        ] as const) {
          const m = sumRegularOverlay(sea.regular, x, 5, t, d, e.depth, 0);
          const total = field.fluid(x, 5, -d, t).pressure;
          const head = total / (e.waterDensity * e.gravity) - d;
          expect(m.etaAtt).toBeCloseTo(head, 0);
          expect(Math.abs(m.etaAtt - head)).toBeLessThan(0.03 * amp);
        }
      }
    }
  });

  it('attenuates with depth like exp(-k d) in deep water', () => {
    const { e, sea } = setup(2, 8, 4000);
    const r = sea.regular[0]!;
    const top = regularOverlay(r, 0, 0, 0, 0, e.depth, 0);
    const deep = regularOverlay(r, 0, 0, 0, 10, e.depth, 0);
    expect(deep.etaAtt / top.etaAtt).toBeCloseTo(Math.exp(-r.k * 10), 6);
  });
});

describe('overlay scales and energy', () => {
  it('energy density is half rho g eta squared', () => {
    expect(energyDensity(2, 1025, 9.81)).toBeCloseTo(0.5 * 1025 * 9.81 * 4, 6);
    expect(energyDensity(-2, 1025, 9.81)).toBeCloseTo(energyDensity(2, 1025, 9.81), 9);
  });

  it('ranges grow with Hs and stay readable in a calm sea', () => {
    const calm = overlayScale(0.05, 1025, 9.81);
    const rough = overlayScale(6, 1025, 9.81);
    expect(calm.height).toBeCloseTo(0.25, 9);
    expect(rough.height).toBeCloseTo(4.5, 9);
    expect(rough.pressure).toBeCloseTo(1025 * 9.81 * 4.5, 6);
    expect(rough.energy).toBeCloseTo(0.5 * 1025 * 9.81 * 4.5 ** 2, 6);
    expect(rough.velocity).toBeGreaterThan(calm.velocity);
    expect(calm.velocity).toBeGreaterThan(0.1);
  });

  it('flags breaking below a positive Jacobian threshold', () => {
    expect(BREAKING_JACOBIAN).toBeGreaterThan(0);
    expect(BREAKING_JACOBIAN).toBeLessThan(1);
  });
});
