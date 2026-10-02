/**
 * Local water patch: a cheap, interpolated copy of the ocean around one vessel.
 *
 * `OceanField.column` costs ~10 µs (choppy inversion + cascade interpolation), far too much to
 * call for every hull vertex at every substep. Instead each vessel samples a small
 * world-aligned grid of water columns (≤ 280 by default) covering its footprint, at the ocean snapshot
 * instants t_k = k·Δt_snap, and keeps two such patches (t_k and t_{k+1}). Any query in between
 * is bilinear in space, piece-wise linear over a few stretched depth levels, and linear in time
 * — the same temporal scheme the ocean itself uses, so no accuracy is lost in time.
 *
 * Spatial resolution: the grid spacing adapts to the vessel size, up to 280 columns.
 * Waves shorter than about four spacings are smoothed (the Smith effect of hull averaging)
 * and are still rendered. A 118 m ship resolves down to roughly 12–15 m; a lifeboat, to the
 * 0.4 m floor.
 *
 * Timing: the field holds snapshots A ≤ t < B. At t ∈ [t_k, t_{k+1}) we call
 * `field.prepare(t_k)` (a no-op when the simulation already did it) and sample the next patch
 * exactly at t_{k+1} = B, which the field serves without computing new snapshots.
 */
import { createColumnSample, type ColumnSample, type OceanField } from '../ocean/oceanField';

export interface Footprint {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

class Patch {
  t = NaN;
  nx = 0;
  ny = 0;
  x0 = 0;
  y0 = 0;
  invDx = 0;
  invDy = 0;
  readonly eta: Float64Array;
  /** Per column × level: dynamic head [m], particle velocity [m/s]. */
  readonly head: Float64Array;
  readonly u: Float64Array;
  readonly v: Float64Array;
  readonly w: Float64Array;

  constructor(maxColumns: number, levels: number) {
    this.eta = new Float64Array(maxColumns);
    this.head = new Float64Array(maxColumns * levels);
    this.u = new Float64Array(maxColumns * levels);
    this.v = new Float64Array(maxColumns * levels);
    this.w = new Float64Array(maxColumns * levels);
  }
}

export class LocalWater {
  /** True when the field has no waves at all: the water is flat and still (fast path). */
  readonly calm: boolean;
  /** Stretched depths ζ ≤ 0 of the sampled levels (decreasing). */
  readonly levels: Float64Array;
  readonly maxColumns: number;
  readonly minSpacing: number;
  private readonly field: OceanField;
  private readonly depth: number;
  private readonly interval: number;
  private prev: Patch;
  private next: Patch;
  private k = Number.NaN;
  private wt = 0;
  private readonly sample: ColumnSample;
  /** Number of `column` calls made so far (diagnostics). */
  columnCalls = 0;

  // ---- query results (written by fluid()) ----
  eta = 0;
  head = 0;
  u = 0;
  v = 0;
  w = 0;
  /** Local (Eulerian) water acceleration ∂u/∂t [m/s²]. */
  au = 0;
  av = 0;
  aw = 0;

  constructor(field: OceanField, levels: readonly number[], maxColumns = 220, minSpacing = 0.35) {
    this.field = field;
    this.calm = field.sea.spectral.length === 0 && field.sea.regular.length === 0;
    this.levels = Float64Array.from(levels);
    this.maxColumns = maxColumns;
    this.minSpacing = minSpacing;
    this.depth = field.env.depth;
    this.interval = field.snapshotInterval;
    this.prev = new Patch(maxColumns, levels.length);
    this.next = new Patch(maxColumns, levels.length);
    this.sample = createColumnSample(levels.length);
  }

  /**
   * Make sure the two patches bracket time t. `footprint(tTarget)` must return the horizontal
   * region the hull may occupy at tTarget (it is only called when a new patch is sampled).
   */
  update(t: number, footprint: (tTarget: number) => Footprint): void {
    if (this.calm) return;
    const dt = this.interval;
    const k = Math.floor(t / dt + 1e-9);
    if (k !== this.k) {
      const tk = k * dt;
      this.field.prepare(tk);
      if (k === this.k + 1) {
        const spare = this.prev;
        this.prev = this.next;
        this.next = spare;
      } else {
        this.fill(this.prev, tk, footprint(tk));
      }
      this.fill(this.next, (k + 1) * dt, footprint((k + 1) * dt));
      this.k = k;
    }
    this.wt = Math.min(1, Math.max(0, (t - this.prev.t) / (this.next.t - this.prev.t)));
    this.lx = NaN;
  }

  private fill(p: Patch, t: number, fp: Footprint): void {
    if (
      !Number.isFinite(fp.minX) ||
      !Number.isFinite(fp.maxX) ||
      !Number.isFinite(fp.minY) ||
      !Number.isFinite(fp.maxY)
    ) {
      // A diverged vessel state would otherwise spin the sizing loop below forever and freeze
      // the worker; throwing reaches the UI as a simulation error.
      throw new RangeError('Vessel state is not finite (the simulation diverged).');
    }
    const w = Math.max(fp.maxX - fp.minX, 1e-3);
    const h = Math.max(fp.maxY - fp.minY, 1e-3);
    let s = Math.max(this.minSpacing, Math.sqrt((w * h) / this.maxColumns));
    let nx = 0;
    let ny = 0;
    for (let i = 0; i < 1000; i++) {
      nx = Math.ceil(w / s) + 1;
      ny = Math.ceil(h / s) + 1;
      if (nx * ny <= this.maxColumns) break;
      s *= 1.04;
    }
    p.t = t;
    p.nx = nx;
    p.ny = ny;
    p.x0 = fp.minX;
    p.y0 = fp.minY;
    const dx = w / (nx - 1);
    const dy = h / (ny - 1);
    p.invDx = 1 / dx;
    p.invDy = 1 / dy;
    const m = this.levels.length;
    const col = this.sample;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        this.field.column(fp.minX + i * dx, fp.minY + j * dy, t, this.levels, col);
        const c = j * nx + i;
        p.eta[c] = col.eta;
        const o = c * m;
        for (let l = 0; l < m; l++) {
          p.head[o + l] = col.head[l]!;
          p.u[o + l] = col.u[l]!;
          p.v[o + l] = col.v[l]!;
          p.w[o + l] = col.w[l]!;
        }
      }
    }
    this.columnCalls += nx * ny;
  }

  /** Free-surface elevation at (x, y) at the time set by the last `update`. */
  surface(x: number, y: number): number {
    if (this.calm) return 0;
    this.locate(x, y);
    const a = cellEta(this.prev, this.cellA);
    const b = cellEta(this.next, this.cellB);
    return a + (b - a) * this.wt;
  }

  /** Last located point: `surface` followed by `fluidBelow` at the same (x, y) shares it. */
  private lx = NaN;
  private ly = NaN;
  /** Cells of the last located point in the previous (A) and next (B) patch. */
  private readonly cellA = newCell();
  private readonly cellB = newCell();

  private locate(x: number, y: number): void {
    if (x === this.lx && y === this.ly) return;
    locate(this.prev, x, y, this.cellA);
    locate(this.next, x, y, this.cellB);
    this.lx = x;
    this.ly = y;
  }

  /**
   * Sample the water at (x, y, z): sets `eta`, `head` (pressure = ρ g (−z + head) when
   * z < eta), particle velocity `u, v, w` and, if `accel`, the local acceleration.
   * Returns the gauge pressure divided by ρg (≤ 0 means above the surface).
   */
  fluid(x: number, y: number, z: number, accel: boolean): number {
    if (this.calm) return this.fluidBelow(x, y, z, 0, accel);
    return this.fluidBelow(x, y, z, this.surface(x, y), accel);
  }

  /** As {@link fluid}, with the local surface elevation `eta` already known. */
  fluidBelow(x: number, y: number, z: number, eta: number, accel: boolean): number {
    this.eta = eta;
    if (this.calm) {
      this.head = this.u = this.v = this.w = 0;
      this.au = this.av = this.aw = 0;
      return -z;
    }
    this.locate(x, y);
    const wt = this.wt;
    // Wheeler stretching: ζ = (z − η) h / (h + η).
    const zeta = ((z - eta) * this.depth) / Math.max(this.depth + eta, 1e-6);
    // Level bracket ζ_j ≥ ζ > ζ_{j+1} (end values held outside the sampled range).
    const lv = this.levels;
    const m = lv.length;
    let j = 0;
    let f = 0;
    if (zeta <= lv[m - 1]!) {
      j = m - 2;
      f = 1;
    } else if (zeta < lv[0]!) {
      while (j < m - 2 && zeta < lv[j + 1]!) j++;
      f = (lv[j]! - zeta) / (lv[j]! - lv[j + 1]!);
    }
    const p = this.prev;
    const q = this.next;
    const cellA = this.cellA;
    const cellB = this.cellB;
    const ha = blend(p.head, cellA, m, j, f);
    const ua = blend(p.u, cellA, m, j, f);
    const va = blend(p.v, cellA, m, j, f);
    const wa = blend(p.w, cellA, m, j, f);
    const hb = blend(q.head, cellB, m, j, f);
    const ub = blend(q.u, cellB, m, j, f);
    const vb = blend(q.v, cellB, m, j, f);
    const wb = blend(q.w, cellB, m, j, f);
    this.head = ha + (hb - ha) * wt;
    this.u = ua + (ub - ua) * wt;
    this.v = va + (vb - va) * wt;
    this.w = wa + (wb - wa) * wt;
    if (accel) {
      const inv = 1 / (q.t - p.t);
      this.au = (ub - ua) * inv;
      this.av = (vb - va) * inv;
      this.aw = (wb - wa) * inv;
    }
    return -z + this.head;
  }
}

/** Bilinear cell: corner indices and weights. */
interface Cell {
  c00: number;
  c10: number;
  c01: number;
  c11: number;
  w00: number;
  w10: number;
  w01: number;
  w11: number;
}

const newCell = (): Cell => ({ c00: 0, c10: 0, c01: 0, c11: 0, w00: 0, w10: 0, w01: 0, w11: 0 });

function locate(p: Patch, x: number, y: number, cell: Cell): void {
  let fx = (x - p.x0) * p.invDx;
  let fy = (y - p.y0) * p.invDy;
  // Clamp to the patch (the footprint includes a margin, so this only guards round-off).
  const mx = p.nx - 1.000001;
  const my = p.ny - 1.000001;
  fx = fx < 0 ? 0 : fx > mx ? mx : fx;
  fy = fy < 0 ? 0 : fy > my ? my : fy;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const c00 = iy * p.nx + ix;
  cell.c00 = c00;
  cell.c10 = c00 + 1;
  cell.c01 = c00 + p.nx;
  cell.c11 = c00 + p.nx + 1;
  cell.w00 = (1 - tx) * (1 - ty);
  cell.w10 = tx * (1 - ty);
  cell.w01 = (1 - tx) * ty;
  cell.w11 = tx * ty;
}

function cellEta(p: Patch, c: Cell): number {
  const e = p.eta;
  return c.w00 * e[c.c00]! + c.w10 * e[c.c10]! + c.w01 * e[c.c01]! + c.w11 * e[c.c11]!;
}

/** Bilinear (cell) × linear (levels j, j+1 with weight f on j+1) blend of one field. */
function blend(q: Float64Array, c: Cell, m: number, j: number, f: number): number {
  const g = 1 - f;
  const a00 = c.c00 * m + j;
  const a10 = c.c10 * m + j;
  const a01 = c.c01 * m + j;
  const a11 = c.c11 * m + j;
  return (
    c.w00 * (g * q[a00]! + f * q[a00 + 1]!) +
    c.w10 * (g * q[a10]! + f * q[a10 + 1]!) +
    c.w01 * (g * q[a01]! + f * q[a01 + 1]!) +
    c.w11 * (g * q[a11]! + f * q[a11 + 1]!)
  );
}
