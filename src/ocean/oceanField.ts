/**
 * CPU ocean field — the physics-side "source of truth" for the water surface.
 *
 * It evaluates exactly the same spectral components the GPU renders (same h₀, same ω) on a
 * 128² grid per physics cascade, plus the analytic regular-wave components, and answers point
 * queries for vessels and instruments:
 *   - free-surface elevation η and slope at a world position (choppy displacement inverted),
 *   - total pressure (hydrostatic + linear dynamic, Wheeler-stretched) at any depth,
 *   - fluid particle velocity (deep-water attenuation per cascade).
 *
 * Fields are evaluated at "snapshot" instants and interpolated linearly in time, which is
 * accurate to (ωΔt)²/8 — < 0.4 % for 2 s waves at the default 20 Hz snapshot rate.
 */
import type { Environment, WaveSystem } from '../schema/experiment';
import {
  buildCascadeSpectrum,
  cascadeSpecs,
  CASCADE_SIZES,
  PHYSICS_GRID,
  type CascadeSpectrum,
} from './cascades';
import { pressureAttenuation, stokesSecondAmplitude, tanhKh } from './dispersion';
import { FFT, signedIndex } from './fft';
import { resolveSea, type ResolvedRegularWave, type ResolvedSea } from './systems';

/** Field slots evaluated per cascade (packed two-per-FFT). */
const enum F {
  Eta = 0,
  EtaX,
  EtaY,
  EtaXY,
  Dx,
  Dy,
  EtaT,
  Ux,
  Uy,
  P1,
  P2,
  P3,
  Count,
}

/** Non-dimensional depths k_ref·|z| of the dynamic-pressure levels below the surface. */
const PRESSURE_LEVELS_KZ = [0.5, 1.5, 3.5] as const;

export interface SurfaceSample {
  /** Free-surface elevation above mean water level [m]. */
  eta: number;
  /** Surface slope ∂η/∂x, ∂η/∂y. */
  slopeX: number;
  slopeY: number;
  /** Vertical surface velocity ∂η/∂t [m/s]. */
  etaT: number;
}

export interface FluidSample {
  /** Gauge pressure [Pa] (0 above the free surface). */
  pressure: number;
  /** Fluid particle velocity [m/s]. */
  u: number;
  v: number;
  w: number;
  /** Local surface elevation [m]. */
  eta: number;
}

export interface ColumnSample extends SurfaceSample {
  /** Dynamic pressure head [m] at each requested ζ (pressure = ρ g (−z + head)). */
  head: Float64Array;
  /** Fluid particle velocity components [m/s] at each requested ζ. */
  u: Float64Array;
  v: Float64Array;
  w: Float64Array;
}

export function createColumnSample(levels: number): ColumnSample {
  return {
    eta: 0,
    slopeX: 0,
    slopeY: 0,
    etaT: 0,
    head: new Float64Array(levels),
    u: new Float64Array(levels),
    v: new Float64Array(levels),
    w: new Float64Array(levels),
  };
}

interface CascadeFields {
  size: number;
  n: number;
  /** k_ref used for the vertical structure of pressure/velocity. */
  kRef: number;
  /** Depths (negative, metres below the stretched surface) of the pressure levels. */
  levels: [number, number, number];
  fields: Float64Array[];
}

interface Snapshot {
  t: number;
  cascades: CascadeFields[];
}

export interface OceanFieldOptions {
  /** Interval between field snapshots [s]. */
  snapshotInterval?: number;
  /** Override cascade sizes (tests). */
  cascadeSizes?: readonly number[];
  /** Physics grid resolution (tests may lower it). */
  physicsGrid?: number;
}

export class OceanField {
  readonly sea: ResolvedSea;
  readonly env: Environment;
  readonly cascades: CascadeSpectrum[];
  readonly snapshotInterval: number;
  private readonly fft: FFT;
  private readonly n: number;
  private readonly work: Float64Array[];
  private snapA: Snapshot | null = null;
  private snapB: Snapshot | null = null;
  private readonly kx: Float64Array;
  private readonly ky: Float64Array;
  private readonly rho: number;
  private readonly g: number;

  constructor(waves: readonly WaveSystem[], env: Environment, opts: OceanFieldOptions = {}) {
    this.env = env;
    this.sea = resolveSea(waves, env);
    this.n = opts.physicsGrid ?? PHYSICS_GRID;
    this.snapshotInterval = opts.snapshotInterval ?? 1 / 20;
    this.fft = new FFT(this.n);
    this.rho = env.waterDensity;
    this.g = env.gravity;
    const specs = cascadeSpecs(opts.cascadeSizes ?? CASCADE_SIZES).filter((s) => s.physics);
    // Cascades without energy (e.g. only regular waves, or calm water) are skipped entirely so
    // they cost no FFTs.
    this.cascades = specs
      .map((s) => buildCascadeSpectrum(s, this.n, this.sea.spectral, this.sea.dispersion))
      .filter((c) => c.variance > 0);
    this.work = Array.from({ length: F.Count / 2 }, () => new Float64Array(2 * this.n * this.n));
    this.kx = new Float64Array(this.n);
    this.ky = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) this.kx[i] = signedIndex(i, this.n);
    this.ky.set(this.kx);
  }

  get regularWaves(): readonly ResolvedRegularWave[] {
    return this.sea.regular;
  }

  /** Make sure snapshots bracket time t (computing new ones as needed). */
  prepare(t: number): void {
    const dt = this.snapshotInterval;
    const i0 = Math.floor(t / dt + 1e-9);
    const t0 = i0 * dt;
    const t1 = t0 + dt;
    if (this.snapA && this.snapB && Math.abs(this.snapA.t - t0) < 1e-9) return;
    // Stepping forward by one interval reuses the previous "B" snapshot; buffers are recycled
    // so steady-state stepping allocates nothing.
    if (this.snapB && Math.abs(this.snapB.t - t0) < 1e-9) {
      const spare = this.snapA;
      this.snapA = this.snapB;
      this.snapB = this.computeSnapshot(t1, spare);
    } else {
      const spareA = this.snapA;
      const spareB = this.snapB;
      this.snapA = this.computeSnapshot(t0, spareA);
      this.snapB = this.computeSnapshot(t1, spareB);
    }
  }

  private computeSnapshot(t: number, reuse: Snapshot | null): Snapshot {
    const cascades = this.cascades.map((c, i) => this.evaluateCascade(c, t, reuse?.cascades[i]));
    return { t, cascades };
  }

  private evaluateCascade(c: CascadeSpectrum, t: number, reuse?: CascadeFields): CascadeFields {
    const n = this.n;
    const dk = (2 * Math.PI) / c.spec.size;
    const lambda = this.env.choppiness;
    const depth = this.env.depth;
    const kRef = c.kMean > 0 ? c.kMean : (c.spec.kLow + Math.min(c.spec.kHigh, 1e3)) / 2 || 1;
    const levels: [number, number, number] = [
      -PRESSURE_LEVELS_KZ[0] / kRef,
      -PRESSURE_LEVELS_KZ[1] / kRef,
      -PRESSURE_LEVELS_KZ[2] / kRef,
    ];
    const [w0, w1, w2, w3, w4, w5] = this.work as [
      Float64Array,
      Float64Array,
      Float64Array,
      Float64Array,
      Float64Array,
      Float64Array,
    ];
    for (const w of this.work) w.fill(0);
    const h0 = c.h0;
    for (let iy = 0; iy < n; iy++) {
      const ky = this.ky[iy]! * dk;
      const iyNeg = (n - iy) % n;
      for (let ix = 0; ix < n; ix++) {
        const cell = iy * n + ix;
        const omega = c.omega[cell]!;
        const ixNeg = (n - ix) % n;
        const neg = iyNeg * n + ixNeg;
        const ar = h0[2 * cell]!;
        const ai = h0[2 * cell + 1]!;
        const br = h0[2 * neg]!;
        const bi = h0[2 * neg + 1]!;
        if (ar === 0 && ai === 0 && br === 0 && bi === 0) continue;
        const kx = this.kx[ix]! * dk;
        const k = Math.hypot(kx, ky);
        const cos = Math.cos(omega * t);
        const sin = Math.sin(omega * t);
        // e1 = h0(k) e^{-iωt},  e2 = conj(h0(-k)) e^{+iωt},  h = e1 + e2
        const e1r = ar * cos + ai * sin;
        const e1i = ai * cos - ar * sin;
        const e2r = br * cos + bi * sin;
        const e2i = br * sin - bi * cos;
        const hr = e1r + e2r;
        const hi = e1i + e2i;
        // ∂h/∂t = −iω e1 + iω e2
        const htr = omega * (e1i - e2i);
        const hti = omega * (-e1r + e2r);
        const coth = 1 / tanhKh(k, depth);
        const ux = (kx / k) * coth;
        const uy = (ky / k) * coth;
        const a1 = pressureAttenuation(k, levels[0], depth);
        const a2 = pressureAttenuation(k, levels[1], depth);
        const a3 = pressureAttenuation(k, levels[2], depth);
        const j = 2 * cell;
        // Pack two real fields A, B as Â + i·B̂. Multiplying by i: (r, i) → (−i, r).
        // w0: η + i·ηx       ηx = i kx h
        w0[j] = hr - kx * hr;
        w0[j + 1] = hi - kx * hi;
        // NB: i·(i kx h) = −kx h  → contributes (−kx·hr, −kx·hi)
        // w1: ηy + i·ηxy     ηy = i ky h, ηxy = −kx ky h
        w1[j] = -ky * hi + -(-kx * ky * hi);
        w1[j + 1] = ky * hr + -kx * ky * hr;
        // w2: Dx + i·Dy      D = λ i (k/|k|) coth(kh) h
        const dxr = -lambda * ux * hi;
        const dxi = lambda * ux * hr;
        const dyr = -lambda * uy * hi;
        const dyi = lambda * uy * hr;
        w2[j] = dxr - dyi;
        w2[j + 1] = dxi + dyr;
        // w3: ηt + i·Ux      Ux = i (kx/k) coth ∂h/∂t
        const uxr = -ux * hti;
        const uxi = ux * htr;
        w3[j] = htr - uxi;
        w3[j + 1] = hti + uxr;
        // w4: Uy + i·P1
        const uyr = -uy * hti;
        const uyi = uy * htr;
        w4[j] = uyr - a1 * hi;
        w4[j + 1] = uyi + a1 * hr;
        // w5: P2 + i·P3
        w5[j] = a2 * hr - a3 * hi;
        w5[j + 1] = a2 * hi + a3 * hr;
      }
    }
    const fields: Float64Array[] =
      reuse?.fields ?? Array.from({ length: F.Count }, () => new Float64Array(n * n));
    const pairs: [number, number][] = [
      [F.Eta, F.EtaX],
      [F.EtaY, F.EtaXY],
      [F.Dx, F.Dy],
      [F.EtaT, F.Ux],
      [F.Uy, F.P1],
      [F.P2, F.P3],
    ];
    for (let p = 0; p < pairs.length; p++) {
      const w = this.work[p]!;
      this.fft.inverse2D(w);
      const [a, b] = pairs[p]!;
      const fa = fields[a]!;
      const fb = fields[b]!;
      for (let i = 0; i < n * n; i++) {
        fa[i] = w[2 * i]!;
        fb[i] = w[2 * i + 1]!;
      }
    }
    return { size: c.spec.size, n, kRef, levels, fields };
  }

  // ---------------------------------------------------------------- sampling

  private interpWeight(t: number): number {
    if (!this.snapA || !this.snapB) this.prepare(t);
    const a = this.snapA!;
    const b = this.snapB!;
    if (t < a.t - 1e-9 || t > b.t + 1e-9) {
      this.prepare(t);
      return this.interpWeight(t);
    }
    return (t - a.t) / (b.t - a.t);
  }

  /** Horizontal choppy displacement of the surface particle labelled (x0, y0). */
  private displacement(x0: number, y0: number, t: number, w: number, out: [number, number]): void {
    let dx = 0;
    let dy = 0;
    const a = this.snapA!.cascades;
    const b = this.snapB!.cascades;
    for (let c = 0; c < a.length; c++) {
      const ca = a[c]!;
      const cb = b[c]!;
      dx += lerpField(ca, cb, F.Dx, x0, y0, w);
      dy += lerpField(ca, cb, F.Dy, x0, y0, w);
    }
    const lambda = this.env.choppiness;
    for (const r of this.sea.regular) {
      const theta = r.k * (r.dirX * x0 + r.dirY * y0) - r.omega * t + r.phase;
      const s = -lambda * r.amplitude * r.cothKh * Math.sin(theta);
      dx += s * r.dirX;
      dy += s * r.dirY;
    }
    out[0] = dx;
    out[1] = dy;
  }

  /**
   * Find the Lagrangian label (x0, y0) whose displaced position is the world point (x, y), by
   * fixed-point iteration x0 ← x − D(x0). Converges while the surface does not fold (J > 0).
   */
  private invertChoppy(x: number, y: number, t: number, w: number, out: [number, number]): void {
    let x0 = x;
    let y0 = y;
    const d: [number, number] = [0, 0];
    if (this.env.choppiness > 0) {
      for (let i = 0; i < 4; i++) {
        this.displacement(x0, y0, t, w, d);
        x0 = x - d[0];
        y0 = y - d[1];
      }
    }
    out[0] = x0;
    out[1] = y0;
  }

  private readonly label: [number, number] = [0, 0];

  /** Surface elevation, slope and vertical velocity at world point (x, y) and time t. */
  surface(x: number, y: number, t: number, out?: SurfaceSample): SurfaceSample {
    const res = out ?? { eta: 0, slopeX: 0, slopeY: 0, etaT: 0 };
    const w = this.interpWeight(t);
    this.invertChoppy(x, y, t, w, this.label);
    const [x0, y0] = this.label;
    let eta = 0;
    let sx = 0;
    let sy = 0;
    let et = 0;
    const a = this.snapA!.cascades;
    const b = this.snapB!.cascades;
    for (let c = 0; c < a.length; c++) {
      const ca = a[c]!;
      const cb = b[c]!;
      eta += (1 - w) * hermiteEta(ca, x0, y0) + w * hermiteEta(cb, x0, y0);
      sx += lerpField(ca, cb, F.EtaX, x0, y0, w);
      sy += lerpField(ca, cb, F.EtaY, x0, y0, w);
      et += lerpField(ca, cb, F.EtaT, x0, y0, w);
    }
    for (const r of this.sea.regular) {
      const theta = r.k * (r.dirX * x0 + r.dirY * y0) - r.omega * t + r.phase;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const a2 =
        r.stokes && this.env.choppiness > 0
          ? stokesSecondAmplitude(r.amplitude, r.k, this.env.depth)
          : 0;
      const c2 = Math.cos(2 * theta);
      const s2 = Math.sin(2 * theta);
      eta += r.amplitude * c + a2 * c2;
      sx += (-r.amplitude * r.k * s - 2 * a2 * r.k * s2) * r.dirX;
      sy += (-r.amplitude * r.k * s - 2 * a2 * r.k * s2) * r.dirY;
      et += r.amplitude * r.omega * s + 2 * a2 * r.omega * s2;
    }
    // Slopes are w.r.t. the Lagrangian label; good to first order in steepness.
    res.eta = eta;
    res.slopeX = sx;
    res.slopeY = sy;
    res.etaT = et;
    return res;
  }

  /**
   * Gauge pressure and fluid velocity at world point (x, y, z). Uses linear wave theory with
   * Wheeler stretching: the dynamic part is evaluated at ζ = (z − η)·h/(h + η), so the total
   * pressure vanishes exactly on the free surface.
   */
  fluid(x: number, y: number, z: number, t: number, out?: FluidSample): FluidSample {
    const res = out ?? { pressure: 0, u: 0, v: 0, w: 0, eta: 0 };
    const surf = this.surface(x, y, t, this.scratchSurface);
    const eta = surf.eta;
    res.eta = eta;
    if (z >= eta) {
      res.pressure = 0;
      res.u = 0;
      res.v = 0;
      res.w = 0;
      return res;
    }
    const h = this.env.depth;
    const zeta = ((z - eta) * h) / Math.max(h + eta, 1e-6);
    const wgt = this.interpWeight(t);
    const [x0, y0] = this.label; // set by surface()
    let head = 0;
    let u = 0;
    let v = 0;
    let wv = 0;
    const a = this.snapA!.cascades;
    const b = this.snapB!.cascades;
    for (let c = 0; c < a.length; c++) {
      const ca = a[c]!;
      const cb = b[c]!;
      const p0 = (1 - wgt) * hermiteEta(ca, x0, y0) + wgt * hermiteEta(cb, x0, y0);
      const p1 = lerpField(ca, cb, F.P1, x0, y0, wgt);
      const p2 = lerpField(ca, cb, F.P2, x0, y0, wgt);
      const p3 = lerpField(ca, cb, F.P3, x0, y0, wgt);
      head += profile(zeta, ca.levels, p0, p1, p2, p3, ca.kRef);
      const att = Math.exp(ca.kRef * Math.max(zeta, -h));
      u += att * lerpField(ca, cb, F.Ux, x0, y0, wgt);
      v += att * lerpField(ca, cb, F.Uy, x0, y0, wgt);
      wv += att * lerpField(ca, cb, F.EtaT, x0, y0, wgt);
    }
    for (const r of this.sea.regular) {
      const theta = r.k * (r.dirX * x0 + r.dirY * y0) - r.omega * t + r.phase;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const att = pressureAttenuation(r.k, zeta, h);
      const a2 =
        r.stokes && this.env.choppiness > 0
          ? stokesSecondAmplitude(r.amplitude, r.k, this.env.depth)
          : 0;
      head +=
        r.amplitude * c * att + a2 * Math.cos(2 * theta) * pressureAttenuation(2 * r.k, zeta, h);
      const uh = r.amplitude * r.omega * r.cothKh * c * att;
      u += uh * r.dirX;
      v += uh * r.dirY;
      wv += r.amplitude * r.omega * s * att;
    }
    res.pressure = this.rho * this.g * (head - z);
    res.u = u;
    res.v = v;
    res.w = wv;
    return res;
  }

  private readonly scratchSurface: SurfaceSample = { eta: 0, slopeX: 0, slopeY: 0, etaT: 0 };

  /**
   * Water column query: surface state plus dynamic pressure head and particle velocity at a set
   * of *stretched* depths ζ ≤ 0 (metres below the instantaneous surface). This is the efficient
   * path for vessels: the choppy inversion and surface evaluation are done once per column.
   *
   * Total gauge pressure at a point z below the surface is ρ g (−z + head(ζ)) with
   * ζ = (z − η)·h/(h + η).
   */
  column(
    x: number,
    y: number,
    t: number,
    zetas: ArrayLike<number>,
    out: ColumnSample,
  ): ColumnSample {
    const surf = this.surface(x, y, t, this.scratchSurface);
    out.eta = surf.eta;
    out.slopeX = surf.slopeX;
    out.slopeY = surf.slopeY;
    out.etaT = surf.etaT;
    const m = zetas.length;
    out.head.fill(0, 0, m);
    out.u.fill(0, 0, m);
    out.v.fill(0, 0, m);
    out.w.fill(0, 0, m);
    const wgt = this.interpWeight(t);
    const [x0, y0] = this.label;
    const h = this.env.depth;
    const a = this.snapA!.cascades;
    const b = this.snapB!.cascades;
    for (let c = 0; c < a.length; c++) {
      const ca = a[c]!;
      const cb = b[c]!;
      const p0 = (1 - wgt) * hermiteEta(ca, x0, y0) + wgt * hermiteEta(cb, x0, y0);
      const p1 = lerpField(ca, cb, F.P1, x0, y0, wgt);
      const p2 = lerpField(ca, cb, F.P2, x0, y0, wgt);
      const p3 = lerpField(ca, cb, F.P3, x0, y0, wgt);
      const u0 = lerpField(ca, cb, F.Ux, x0, y0, wgt);
      const v0 = lerpField(ca, cb, F.Uy, x0, y0, wgt);
      const w0 = lerpField(ca, cb, F.EtaT, x0, y0, wgt);
      for (let j = 0; j < m; j++) {
        const zeta = Math.min(0, zetas[j]!);
        out.head[j]! += profile(zeta, ca.levels, p0, p1, p2, p3, ca.kRef);
        const att = Math.exp(ca.kRef * Math.max(zeta, -h));
        out.u[j]! += att * u0;
        out.v[j]! += att * v0;
        out.w[j]! += att * w0;
      }
    }
    for (const r of this.sea.regular) {
      const theta = r.k * (r.dirX * x0 + r.dirY * y0) - r.omega * t + r.phase;
      const cs = Math.cos(theta);
      const sn = Math.sin(theta);
      const a2 =
        r.stokes && this.env.choppiness > 0
          ? stokesSecondAmplitude(r.amplitude, r.k, this.env.depth)
          : 0;
      const cs2 = Math.cos(2 * theta);
      for (let j = 0; j < m; j++) {
        const zeta = Math.min(0, zetas[j]!);
        const att = pressureAttenuation(r.k, zeta, h);
        out.head[j]! += r.amplitude * cs * att + a2 * cs2 * pressureAttenuation(2 * r.k, zeta, h);
        const uh = r.amplitude * r.omega * r.cothKh * cs * att;
        out.u[j]! += uh * r.dirX;
        out.v[j]! += uh * r.dirY;
        out.w[j]! += r.amplitude * r.omega * sn * att;
      }
    }
    return out;
  }

  /** Total expected H_s represented by the physics cascades + regular components. */
  get representedVariance(): number {
    let v = 0;
    for (const c of this.cascades) v += c.variance;
    // Focused-group energy is transient (one passing crest), not part of the stationary H_s.
    for (const r of this.sea.regular) if (!r.group) v += (r.amplitude * r.amplitude) / 2;
    return v;
  }
}

// ------------------------------------------------------------------ helpers

function wrapIndex(i: number, n: number): number {
  const r = i % n;
  return r < 0 ? r + n : r;
}

function catmullRom(field: Float64Array, n: number, size: number, x: number, y: number): number {
  const s = n / size;
  const u = x * s;
  const v = y * s;
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const fu = u - iu;
  const fv = v - iv;
  const wu = crWeights(fu);
  const wv = crWeights(fv);
  let acc = 0;
  for (let j = 0; j < 4; j++) {
    const row = wrapIndex(iv - 1 + j, n) * n;
    let r = 0;
    for (let i = 0; i < 4; i++) r += wu[i]! * field[row + wrapIndex(iu - 1 + i, n)]!;
    acc += wv[j]! * r;
  }
  return acc;
}

const crScratch = [
  [0, 0, 0, 0],
  [0, 0, 0, 0],
];
let crToggle = 0;
function crWeights(t: number): number[] {
  const w = crScratch[(crToggle = 1 - crToggle)]!;
  const t2 = t * t;
  const t3 = t2 * t;
  w[0] = 0.5 * (-t3 + 2 * t2 - t);
  w[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  w[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  w[3] = 0.5 * (t3 - t2);
  return w;
}

function lerpField(
  a: CascadeFields,
  b: CascadeFields,
  slot: number,
  x: number,
  y: number,
  w: number,
): number {
  const va = catmullRom(a.fields[slot]!, a.n, a.size, x, y);
  const vb = catmullRom(b.fields[slot]!, b.n, b.size, x, y);
  return va + (vb - va) * w;
}

/** Bicubic Hermite interpolation of η using spectrally exact ηx, ηy, ηxy. */
function hermiteEta(c: CascadeFields, x: number, y: number): number {
  const n = c.n;
  const h = c.size / n;
  const u = x / h;
  const v = y / h;
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const t = u - iu;
  const s = v - iv;
  const i0 = wrapIndex(iu, n);
  const i1 = wrapIndex(iu + 1, n);
  const j0 = wrapIndex(iv, n) * n;
  const j1 = wrapIndex(iv + 1, n) * n;
  const e = c.fields[F.Eta]!;
  const ex = c.fields[F.EtaX]!;
  const ey = c.fields[F.EtaY]!;
  const exy = c.fields[F.EtaXY]!;
  const t2 = t * t;
  const t3 = t2 * t;
  const s2 = s * s;
  const s3 = s2 * s;
  const H = [2 * t3 - 3 * t2 + 1, -2 * t3 + 3 * t2];
  const G = [t3 - 2 * t2 + t, t3 - t2];
  const Hs = [2 * s3 - 3 * s2 + 1, -2 * s3 + 3 * s2];
  const Gs = [s3 - 2 * s2 + s, s3 - s2];
  const idx = [
    [j0 + i0, j0 + i1],
    [j1 + i0, j1 + i1],
  ];
  let acc = 0;
  for (let b = 0; b < 2; b++) {
    for (let a = 0; a < 2; a++) {
      const k = idx[b]![a]!;
      acc +=
        H[a]! * Hs[b]! * e[k]! +
        G[a]! * Hs[b]! * h * ex[k]! +
        H[a]! * Gs[b]! * h * ey[k]! +
        G[a]! * Gs[b]! * h * h * exy[k]!;
    }
  }
  return acc;
}

/**
 * Vertical profile of the dynamic pressure head of one cascade: piece-wise linear between the
 * surface value and the three pre-computed levels, then exponential decay with k_ref.
 */
function profile(
  zeta: number,
  levels: readonly [number, number, number],
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  kRef: number,
): number {
  if (zeta >= 0) return p0;
  const [z1, z2, z3] = levels;
  if (zeta >= z1) return p0 + ((p1 - p0) * zeta) / z1;
  if (zeta >= z2) return p1 + ((p2 - p1) * (zeta - z1)) / (z2 - z1);
  if (zeta >= z3) return p2 + ((p3 - p2) * (zeta - z2)) / (z3 - z2);
  return p3 * Math.exp(kRef * (zeta - z3));
}
