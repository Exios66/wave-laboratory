import { describe, expect, it } from 'vitest';
import { nonlinearSurface } from '../../ocean/nonlinearEval';
import { resolveSea } from '../../ocean/systems';
import type { WaveSystem } from '../../schema/experiment';
import { env, regular } from '../../test/fixtures';
import {
  MAX_NONLINEAR,
  mirrorNonlinearSample,
  packNonlinear,
  NL_HARMONIC_VECS,
} from './nonlinearMirror';

const reg = (theory: 'stokes5' | 'cnoidal', h: number, T: number, dir = 270) =>
  ({ ...(regular(h, T, dir) as object), theory }) as WaveSystem;
const solitary = (h: number, dir = 250): WaveSystem => ({
  id: 'sol',
  name: 'S',
  kind: 'solitary',
  enabled: true,
  directionDeg: dir,
  height: h,
  spacing: 0,
  phaseDeg: 30,
});

describe('GLSL mirror of the nonlinear waves', () => {
  const cases: { name: string; waves: WaveSystem[]; depth: number }[] = [
    { name: 'Stokes 5', waves: [reg('stokes5', 5, 9, 200)], depth: 40 },
    { name: 'cnoidal', waves: [reg('cnoidal', 0.6, 20, 300)], depth: 3 },
    { name: 'solitary', waves: [solitary(0.9)], depth: 3 },
    {
      name: 'three at once',
      waves: [reg('stokes5', 3, 7, 10), reg('cnoidal', 0.4, 22, 90), solitary(0.5)],
      depth: 3,
    },
  ];
  for (const cs of cases) {
    it(`matches the CPU field: ${cs.name}`, () => {
      const e = env({ depth: cs.depth, choppiness: 0.8 });
      const sea = resolveSea(cs.waves, e);
      const packed = packNonlinear(sea.nonlinear, e.depth);
      expect(packed.count).toBe(sea.nonlinear.length);
      const sf = { eta: 0, dEta: 0, etaT: 0, disp: 0 };
      let maxEta = 0;
      let maxDisp = 0;
      let maxSlope = 0;
      for (let i = 0; i < 400; i++) {
        const x = Math.sin(i * 12.9898) * 300;
        const y = Math.cos(i * 78.233) * 300;
        const t = (i % 17) * 1.7;
        let eta = 0;
        let dx = 0;
        let dy = 0;
        let sx = 0;
        for (const w of sea.nonlinear) {
          nonlinearSurface(w, x, y, t, sf);
          eta += sf.eta;
          dx += e.choppiness * sf.disp * w.dirX;
          dy += e.choppiness * sf.disp * w.dirY;
          sx += sf.dEta * w.dirX;
        }
        // mesh spacing 0.01 m keeps every harmonic unfaded
        const m = mirrorNonlinearSample(packed, x, y, t, e.choppiness, 0.01);
        maxEta = Math.max(maxEta, Math.abs(m.z - eta));
        maxDisp = Math.max(maxDisp, Math.abs(m.x - dx), Math.abs(m.y - dy));
        maxSlope = Math.max(maxSlope, Math.abs(m.slope[0]! - sx));
      }
      expect(maxEta).toBeLessThan(2e-4);
      expect(maxDisp).toBeLessThan(2e-4);
      expect(maxSlope).toBeLessThan(2e-4);
    });
  }
  it('fades harmonics the mesh cannot resolve, like the linear waves', () => {
    const e = env({ depth: 40, choppiness: 1 });
    const sea = resolveSea([reg('stokes5', 5, 9)], e);
    const packed = packNonlinear(sea.nonlinear, e.depth);
    const wavelength = (2 * Math.PI) / sea.nonlinear[0]!.k;
    // mesh spacing of a quarter wavelength: only the fundamental survives, partly
    const coarse = mirrorNonlinearSample(packed, 3, 4, 1, 1, wavelength / 4);
    expect(Math.abs(coarse.z)).toBeLessThan(0.5 * 5);
    const fine = mirrorNonlinearSample(packed, 3, 4, 1, 1, 0.01);
    expect(fine.z).not.toBe(coarse.z);
  });
  it('packs at most MAX_NONLINEAR waves and 6 vec4 of harmonics each', () => {
    expect(NL_HARMONIC_VECS * 4).toBe(24);
    const many = Array.from({ length: MAX_NONLINEAR + 2 }, (_, i) => ({
      ...(reg('stokes5', 2, 8) as object),
      id: `w${i}`,
    })) as WaveSystem[];
    const e = env({ depth: 40 });
    const packed = packNonlinear(resolveSea(many, e).nonlinear, e.depth);
    expect(packed.count).toBe(MAX_NONLINEAR);
    expect(packed.h.length).toBe(MAX_NONLINEAR * NL_HARMONIC_VECS * 4);
  });
});
