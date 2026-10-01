/**
 * GPU ↔ CPU consistency of the spectral ocean.
 *
 * The browser harness runs the renderer's GPU pipeline (time evolution → derived spectra →
 * Stockham inverse FFT → unpack) and reads the cascade textures back. Here, in Node, the same
 * fields are computed independently from the same h₀/ω with the CPU reference FFT
 * (src/ocean/fft.ts) and the formulas of docs/PHYSICS.md, one transform per field (no packing).
 */
import { expect, test } from '@playwright/test';
import { FFT } from '../src/ocean/fft';
import { buildGpuOceanData, type GpuCascade } from '../src/ocean/gpuData';
import { EnvironmentSchema, type OceanQuality, type WaveSystem } from '../src/schema/experiment';
import { openHarness, type FftResult, type HarnessGlobal } from './gpu-harness';

const SEA: WaveSystem[] = [
  {
    id: 'sea',
    name: 'Sea',
    kind: 'spectrum',
    enabled: true,
    spectrum: 'jonswap',
    hs: 3,
    tp: 9,
    gamma: 3.3,
    directionDeg: 250,
    depthLimited: true,
    spreading: { model: 'mitsuyasu', s: 10 },
    seed: 1234,
  },
  {
    id: 'wind',
    name: 'Wind',
    kind: 'wind',
    enabled: true,
    windSpeed: 12,
    fetchKm: 40,
    directionDeg: 200,
    spreading: { model: 'cos2s', s: 6 },
    seed: 99,
  },
];

const FIELDS = ['eta', 'dx', 'dy', 'etaX', 'etaY', 'dxx', 'dyy', 'dxy'] as const;
type Field = (typeof FIELDS)[number];

/** Texture channel of each field: [texture, component]. disp = (Dx, η, Dy, Dxy), deriv = (ηx, ηy, Dxx, Dyy). */
const CHANNEL: Record<Field, ['disp' | 'deriv', number]> = {
  dx: ['disp', 0],
  eta: ['disp', 1],
  dy: ['disp', 2],
  dxy: ['disp', 3],
  etaX: ['deriv', 0],
  etaY: ['deriv', 1],
  dxx: ['deriv', 2],
  dyy: ['deriv', 3],
};

function decode(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

/** CPU reference: all eight real fields of one cascade at time t (row-major, row ↔ y). */
function cpuFields(
  c: GpuCascade,
  t: number,
  lambda: number,
  depth: number,
): Record<Field, Float64Array> {
  const n = c.n;
  const fft = new FFT(n);
  const dk = (2 * Math.PI) / c.size;
  const spectra = Object.fromEntries(FIELDS.map((f) => [f, new Float64Array(2 * n * n)])) as Record<
    Field,
    Float64Array
  >;
  const m = (i: number) => (i < n / 2 ? i : i - n);
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const cell = iy * n + ix;
      const neg = ((n - iy) % n) * n + ((n - ix) % n);
      const ar = c.h0[4 * cell]!;
      const ai = c.h0[4 * cell + 1]!;
      const br = c.h0[4 * neg]!;
      const bi = c.h0[4 * neg + 1]!;
      const omega = c.h0[4 * cell + 2]!;
      const cs = Math.cos(omega * t);
      const sn = Math.sin(omega * t);
      // e1 = h0(k) e^{-iωt}; e2 = conj(h0(-k)) e^{+iωt}
      const hr = ar * cs + ai * sn + (br * cs + bi * sn);
      const hi = ai * cs - ar * sn + (br * sn - bi * cs);
      const kx = m(ix) * dk;
      const ky = m(iy) * dk;
      const k = Math.hypot(kx, ky);
      const kh = k * depth;
      const coth = k > 0 ? (kh > 20 ? 1 : 1 / Math.tanh(kh)) : 0;
      const ux = k > 0 ? (kx / k) * coth * lambda : 0;
      const uy = k > 0 ? (ky / k) * coth * lambda : 0;
      const j = 2 * cell;
      const set = (f: Field, re: number, im: number) => {
        spectra[f][j] = re;
        spectra[f][j + 1] = im;
      };
      set('eta', hr, hi);
      set('etaX', -kx * hi, kx * hr); // i kx h
      set('etaY', -ky * hi, ky * hr);
      set('dx', -ux * hi, ux * hr); // λ i k̂x coth h
      set('dy', -uy * hi, uy * hr);
      set('dxx', -kx * ux * hr, -kx * ux * hi); // −λ kx k̂x coth h
      set('dyy', -ky * uy * hr, -ky * uy * hi);
      set('dxy', -ky * ux * hr, -ky * ux * hi);
    }
  }
  const out = {} as Record<Field, Float64Array>;
  for (const f of FIELDS) {
    fft.inverse2D(spectra[f]);
    const real = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) real[i] = spectra[f][2 * i]!;
    out[f] = real;
  }
  return out;
}

interface Case {
  quality: OceanQuality;
  depth: number;
  forceHalfFloat?: boolean;
  tolerance: number;
}

const CASES: Case[] = [
  { quality: 'low', depth: 4000, tolerance: 1e-3 },
  { quality: 'high', depth: 4000, tolerance: 1e-3 },
  { quality: 'low', depth: 25, tolerance: 1e-3 },
  // RGBA16F fallback (mobile path): limited by half precision of the stored results.
  { quality: 'low', depth: 4000, forceHalfFloat: true, tolerance: 5e-3 },
];
const TIMES = [0.5, 37.25];

for (const cs of CASES) {
  const name = `N=${cs.quality === 'low' ? 64 : 256}, depth ${cs.depth} m${cs.forceHalfFloat ? ', half-float path' : ''}`;
  test(`GPU FFT fields match the CPU reference (${name})`, async ({ page }) => {
    test.setTimeout(120_000);
    await openHarness(page);
    const env = EnvironmentSchema.parse({ depth: cs.depth, choppiness: 1 });
    const res = await page.evaluate(
      (cfg) => (globalThis as unknown as HarnessGlobal).gpuHarness.fft(cfg),
      {
        waves: SEA,
        env: { depth: cs.depth, choppiness: 1 },
        quality: cs.quality,
        times: TIMES,
        forceHalfFloat: cs.forceHalfFloat ?? false,
      },
    );
    const r: FftResult = res;
    console.info(`[${name}] float path: ${r.floatPath}`);
    expect(r.floatPath).toBe(cs.forceHalfFloat ? 'float16' : 'float32');
    const data = buildGpuOceanData(SEA, env, cs.quality);
    expect(r.n).toBe(data.cascades[0]!.n);
    for (const step of r.results) {
      data.cascades.forEach((c, ci) => {
        const gpu = {
          disp: decode(step.cascades[ci]!.disp),
          deriv: decode(step.cascades[ci]!.deriv),
        };
        const cpu = cpuFields(c, step.t, data.choppiness, data.depth);
        const report: string[] = [];
        for (const f of FIELDS) {
          const [tex, ch] = CHANNEL[f];
          const g = gpu[tex];
          const ref = cpu[f];
          let maxRef = 0;
          let maxErr = 0;
          for (let i = 0; i < ref.length; i++) {
            maxRef = Math.max(maxRef, Math.abs(ref[i]!));
            maxErr = Math.max(maxErr, Math.abs(g[4 * i + ch]! - ref[i]!));
          }
          const rel = maxRef > 0 ? maxErr / maxRef : maxErr;
          report.push(`${f}=${rel.toExponential(2)}`);
          expect(maxRef, `${f} should be non-trivial`).toBeGreaterThan(0);
          expect(rel, `t=${step.t} cascade ${ci} (L=${c.size}) field ${f}`).toBeLessThan(
            cs.tolerance,
          );
        }
        console.info(`[${name}] t=${step.t} L=${c.size}: ${report.join(' ')}`);
      });
    }
  });
}

/** Propagation bearing (deg, the direction waves travel TOWARD) from η(x, t) samples. */
function bearingFromSamples(values: number[][], bases: [number, number][], d: number, dt: number) {
  // Labels per base: centre, +x, −x, +y, −y. Times: t − dt, t, t + dt.
  // For η = a cos(k d̂·x − ωt): −∇η · ∂η/∂t = a²kω sin²θ d̂, so Σ −∇η η_t ∥ d̂.
  let sx = 0;
  let sy = 0;
  const [before, now, after] = values as [number[], number[], number[]];
  const eta = (arr: number[], b: number, j: number) => arr[3 * (5 * b + j) + 2]!;
  for (let b = 0; b < bases.length; b++) {
    const gx = (eta(now, b, 1) - eta(now, b, 2)) / (2 * d);
    const gy = (eta(now, b, 3) - eta(now, b, 4)) / (2 * d);
    const et = (eta(after, b, 0) - eta(before, b, 0)) / (2 * dt);
    sx += -gx * et;
    sy += -gy * et;
  }
  return ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360;
}

for (const fromDeg of [270, 45, 160]) {
  test(`regular wave from ${fromDeg}° travels toward ${(fromDeg + 180) % 360}°`, async ({
    page,
  }) => {
    await openHarness(page);
    const bases: [number, number][] = [];
    for (let i = 0; i < 6; i++) bases.push([13.7 * i - 31, 7.9 * i + 5]);
    const d = 0.25;
    const labels: number[] = [];
    for (const [x, y] of bases) labels.push(x, y, x + d, y, x - d, y, x, y + d, x, y - d);
    const dt = 0.05;
    const wave: WaveSystem = {
      id: 'reg',
      name: 'Regular',
      kind: 'regular',
      enabled: true,
      height: 2,
      period: 8,
      directionDeg: fromDeg,
      phaseDeg: 0,
    };
    const res = await page.evaluate(
      (cfg) => (globalThis as unknown as HarnessGlobal).gpuHarness.sample(cfg),
      {
        waves: [wave],
        env: {},
        quality: 'low' as const,
        times: [10 - dt, 10, 10 + dt],
        labels,
      },
    );
    const bearing = bearingFromSamples(res.values, bases, d, dt);
    const expected = (fromDeg + 180) % 360;
    const diff = Math.abs(((((bearing - expected) % 360) + 540) % 360) - 180);
    console.info(`regular wave from ${fromDeg}°: measured travel bearing ${bearing.toFixed(2)}°`);
    expect(diff).toBeLessThan(1);
    // Horizontal displacement is along the propagation direction (Gerstner): D × d̂ ≈ 0.
    const now = res.values[1]!;
    const rad = (expected * Math.PI) / 180;
    const dir = [Math.sin(rad), Math.cos(rad)];
    for (let i = 0; i < labels.length / 2; i++) {
      const cross = now[3 * i]! * dir[1]! - now[3 * i + 1]! * dir[0]!;
      expect(Math.abs(cross)).toBeLessThan(1e-3);
    }
  });
}
