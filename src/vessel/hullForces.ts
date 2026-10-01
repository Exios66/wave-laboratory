/**
 * Per-substep hull/water interaction: pressure integration over the instantaneous wetted hull
 * plus panel cross-flow drag and event detection.
 *
 * Pressure integration follows Kerner (2015, "Water interaction model for boats in video
 * games", Game Developer / Gamasutra): every hull triangle is classified by the signs of its
 * vertex heights h = z − η above the local free surface; partially submerged triangles are cut
 * at the waterline (one wet vertex → one triangle, two → two triangles) and only the wet parts
 * are integrated. The pressure is the total gauge pressure p = ρ g (−z + head(ζ)) from linear
 * theory with Wheeler stretching (hydrostatic + Froude–Krylov), evaluated at the hull vertices
 * and taken linear over each (sub)triangle, with p = 0 on the cut (the free surface).
 *
 * Quadrature: for linear p over a triangle with vertices r_i and area vector S = n A,
 *     F = −∫ p n dA = −S (p₀ + p₁ + p₂)/3
 *     M = −∫ p (r × n) dA = −(1/12) [Σ p_i r_i + (Σ p_i)(Σ r_i)] × S
 * (∫ φ_i φ_j dA = A(1 + δ_ij)/12 for linear shape functions). Both are exact for linear
 * pressure, so the hydrostatic force and moment on the polyhedral hull in calm water are exact
 * and identical to the `hydrostatics` module — the vessel floats at rest to round-off.
 *
 * Everything is accumulated in the body frame about the CoG (vertex positions there are
 * constant); only the water sampling needs world coordinates.
 */
import type { TriangleMesh } from './api';
import type { LocalWater } from './waterPatch';

/** Rigid-body state as seen by the force routines (body velocities, world position). */
export interface RigidState {
  px: number;
  py: number;
  pz: number;
  /** Row-major rotation body → world. */
  rot: Float64Array;
  /** Body-frame linear and angular velocity. */
  u: number;
  v: number;
  w: number;
  p: number;
  q: number;
  r: number;
}

export interface HullForceOptions {
  rho: number;
  g: number;
  /** Cross-flow drag coefficient of the hull panels (see `crossFlowDrag`). */
  crossFlowCd: number;
  /** Triangles that can slam (forward bottom panels) and the relative-velocity threshold. */
  slamMask: Uint8Array;
  slamThreshold: number;
  deckEdge: Uint32Array;
}

export class HullForces {
  // ---- results of the last `compute` (body frame, about the CoG) ----
  fx = 0;
  fy = 0;
  fz = 0;
  mx = 0;
  my = 0;
  mz = 0;
  /** Displaced volume below the local (wavy) surface [m³]. */
  volume = 0;
  wettedArea = 0;
  /** Centroid of the wetted surface (body frame). */
  wetX = 0;
  wetY = 0;
  wetZ = 0;
  /** Wetted-area-weighted mean water particle velocity (body frame). */
  waterU = 0;
  waterV = 0;
  waterW = 0;
  slamming = false;
  /** Largest relative normal entry velocity among slam-prone panels [m/s]. */
  slamVelocity = 0;
  greenWater = false;
  /** World-frame horizontal bounding box of the hull vertices. */
  minX = 0;
  maxX = 0;
  minY = 0;
  maxY = 0;

  private readonly bx: Float64Array;
  private readonly by: Float64Array;
  private readonly bz: Float64Array;
  private readonly tri: Uint32Array;
  private readonly nx: Float64Array;
  private readonly ny: Float64Array;
  private readonly nz: Float64Array;
  private readonly area: Float64Array;
  // per-vertex scratch
  private readonly h: Float64Array;
  private readonly pr: Float64Array;
  private readonly wu: Float64Array;
  private readonly wv: Float64Array;
  private readonly ww: Float64Array;
  private readonly opts: HullForceOptions;

  constructor(mesh: TriangleMesh, opts: HullForceOptions) {
    this.opts = opts;
    const n = mesh.positions.length / 3;
    this.bx = new Float64Array(n);
    this.by = new Float64Array(n);
    this.bz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.bx[i] = mesh.positions[3 * i]!;
      this.by[i] = mesh.positions[3 * i + 1]!;
      this.bz[i] = mesh.positions[3 * i + 2]!;
    }
    // Drop degenerate (zero-area) triangles: they contribute nothing to any integral.
    const keep: number[] = [];
    const nrm: number[] = [];
    const ar: number[] = [];
    const ix = mesh.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t]!;
      const b = ix[t + 1]!;
      const c = ix[t + 2]!;
      const ux = this.bx[b]! - this.bx[a]!;
      const uy = this.by[b]! - this.by[a]!;
      const uz = this.bz[b]! - this.bz[a]!;
      const vx = this.bx[c]! - this.bx[a]!;
      const vy = this.by[c]! - this.by[a]!;
      const vz = this.bz[c]! - this.bz[a]!;
      const sx = 0.5 * (uy * vz - uz * vy);
      const sy = 0.5 * (uz * vx - ux * vz);
      const sz = 0.5 * (ux * vy - uy * vx);
      const A = Math.hypot(sx, sy, sz);
      if (A < 1e-9) continue;
      keep.push(a, b, c, opts.slamMask[t / 3]!);
      nrm.push(sx / A, sy / A, sz / A);
      ar.push(A);
    }
    this.tri = new Uint32Array(keep);
    this.nx = new Float64Array(ar.length);
    this.ny = new Float64Array(ar.length);
    this.nz = new Float64Array(ar.length);
    this.area = Float64Array.from(ar);
    for (let k = 0; k < ar.length; k++) {
      this.nx[k] = nrm[3 * k]!;
      this.ny[k] = nrm[3 * k + 1]!;
      this.nz[k] = nrm[3 * k + 2]!;
    }
    this.h = new Float64Array(n);
    this.pr = new Float64Array(n);
    this.wu = new Float64Array(n);
    this.wv = new Float64Array(n);
    this.ww = new Float64Array(n);
  }

  /** Number of non-degenerate triangles integrated per call. */
  get triangleCount(): number {
    return this.area.length;
  }

  compute(s: RigidState, water: LocalWater): void {
    const { rho, g } = this.opts;
    const R = s.rot;
    const r0 = R[0]!;
    const r1 = R[1]!;
    const r2 = R[2]!;
    const r3 = R[3]!;
    const r4 = R[4]!;
    const r5 = R[5]!;
    const r6 = R[6]!;
    const r7 = R[7]!;
    const r8 = R[8]!;
    const nv = this.bx.length;
    const rhoG = rho * g;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    // ---- vertices: world position, height above the local surface, pressure, water velocity
    for (let i = 0; i < nv; i++) {
      const bx = this.bx[i]!;
      const by = this.by[i]!;
      const bz = this.bz[i]!;
      const x = s.px + r0 * bx + r1 * by + r2 * bz;
      const y = s.py + r3 * bx + r4 * by + r5 * bz;
      const z = s.pz + r6 * bx + r7 * by + r8 * bz;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const eta = water.surface(x, y);
      const h = z - eta;
      this.h[i] = h;
      if (h < 0) {
        this.pr[i] = rhoG * water.fluidBelow(x, y, z, eta, false);
        // World → body (transpose) for the water particle velocity.
        const u = water.u;
        const v = water.v;
        const w = water.w;
        this.wu[i] = r0 * u + r3 * v + r6 * w;
        this.wv[i] = r1 * u + r4 * v + r7 * w;
        this.ww[i] = r2 * u + r5 * v + r8 * w;
      } else {
        this.pr[i] = 0;
      }
    }
    this.minX = minX;
    this.maxX = maxX;
    this.minY = minY;
    this.maxY = maxY;

    // ---- green water: any deck-edge vertex below the local surface
    let green = false;
    const de = this.opts.deckEdge;
    for (let k = 0; k < de.length; k++) {
      if (this.h[de[k]!]! < 0) {
        green = true;
        break;
      }
    }
    this.greenWater = green;

    acc.reset(r6, r7, r8);
    const cd = 0.5 * rho * this.opts.crossFlowCd;
    const slamV = this.opts.slamThreshold;
    let slamMax = 0;
    let waterU = 0;
    let waterV = 0;
    let waterW = 0;
    let dragFx = 0;
    let dragFy = 0;
    let dragFz = 0;
    let dragMx = 0;
    let dragMy = 0;
    let dragMz = 0;
    const tri = this.tri;
    const H = this.h;
    const P = this.pr;
    const BX = this.bx;
    const BY = this.by;
    const BZ = this.bz;
    const nt = this.area.length;
    for (let k = 0; k < nt; k++) {
      let i0 = tri[4 * k]!;
      let i1 = tri[4 * k + 1]!;
      let i2 = tri[4 * k + 2]!;
      const h0 = H[i0]!;
      const h1 = H[i1]!;
      const h2 = H[i2]!;
      const w0 = h0 < 0;
      const w1 = h1 < 0;
      const w2 = h2 < 0;
      const count = (w0 ? 1 : 0) + (w1 ? 1 : 0) + (w2 ? 1 : 0);
      if (count === 0) continue;
      const area0 = acc.area;
      const cx0 = acc.cx;
      const cy0 = acc.cy;
      const cz0 = acc.cz;
      let wu = 0;
      let wv = 0;
      let ww = 0;
      if (count === 3) {
        acc.tri(
          BX[i0]!,
          BY[i0]!,
          BZ[i0]!,
          P[i0]!,
          h0,
          BX[i1]!,
          BY[i1]!,
          BZ[i1]!,
          P[i1]!,
          h1,
          BX[i2]!,
          BY[i2]!,
          BZ[i2]!,
          P[i2]!,
          h2,
        );
        wu = (this.wu[i0]! + this.wu[i1]! + this.wu[i2]!) / 3;
        wv = (this.wv[i0]! + this.wv[i1]! + this.wv[i2]!) / 3;
        ww = (this.ww[i0]! + this.ww[i1]! + this.ww[i2]!) / 3;
      } else {
        // Rotate so vertex 0 is the odd one (the only wet one, or the only dry one).
        const odd = count === 1 ? (w0 ? 0 : w1 ? 1 : 2) : !w0 ? 0 : !w1 ? 1 : 2;
        if (odd === 1) {
          const t = i0;
          i0 = i1;
          i1 = i2;
          i2 = t;
        } else if (odd === 2) {
          const t = i2;
          i2 = i1;
          i1 = i0;
          i0 = t;
        }
        const z0 = H[i0]!;
        const z1 = H[i1]!;
        const z2 = H[i2]!;
        const t1 = z0 / (z0 - z1);
        const t2 = z0 / (z0 - z2);
        const ax = BX[i0]!;
        const ay = BY[i0]!;
        const az = BZ[i0]!;
        const px = ax + (BX[i1]! - ax) * t1;
        const py = ay + (BY[i1]! - ay) * t1;
        const pz = az + (BZ[i1]! - az) * t1;
        const qx = ax + (BX[i2]! - ax) * t2;
        const qy = ay + (BY[i2]! - ay) * t2;
        const qz = az + (BZ[i2]! - az) * t2;
        if (count === 1) {
          acc.tri(ax, ay, az, P[i0]!, z0, px, py, pz, 0, 0, qx, qy, qz, 0, 0);
          wu = this.wu[i0]!;
          wv = this.wv[i0]!;
          ww = this.ww[i0]!;
        } else {
          acc.tri(
            px,
            py,
            pz,
            0,
            0,
            BX[i1]!,
            BY[i1]!,
            BZ[i1]!,
            P[i1]!,
            z1,
            BX[i2]!,
            BY[i2]!,
            BZ[i2]!,
            P[i2]!,
            z2,
          );
          acc.tri(px, py, pz, 0, 0, BX[i2]!, BY[i2]!, BZ[i2]!, P[i2]!, z2, qx, qy, qz, 0, 0);
          wu = 0.5 * (this.wu[i1]! + this.wu[i2]!);
          wv = 0.5 * (this.wv[i1]! + this.wv[i2]!);
          ww = 0.5 * (this.ww[i1]! + this.ww[i2]!);
        }
      }
      // Wet area and its centroid for this triangle (from the accumulator deltas).
      const aw = acc.area - area0;
      if (aw <= 0) continue;
      const cx = (acc.cx - cx0) / aw;
      const cy = (acc.cy - cy0) / aw;
      const cz = (acc.cz - cz0) / aw;
      waterU += aw * wu;
      waterV += aw * wv;
      waterW += aw * ww;
      // Panel velocity relative to the water (body frame).
      const nX = this.nx[k]!;
      const nY = this.ny[k]!;
      const nZ = this.nz[k]!;
      const ru = s.u + s.q * cz - s.r * cy - wu;
      const rv = s.v + s.r * cx - s.p * cz - wv;
      const rw = s.w + s.p * cy - s.q * cx - ww;
      // Cross-flow drag: only the velocity component normal to the ship's longitudinal axis
      // (slender-body cross-flow principle); surge resistance is modelled separately (ITTC).
      const vn = rv * nY + rw * nZ;
      if (vn > 0) {
        const f = -cd * aw * vn * vn;
        const fx = f * nX;
        const fy = f * nY;
        const fz = f * nZ;
        dragFx += fx;
        dragFy += fy;
        dragFz += fz;
        dragMx += cy * fz - cz * fy;
        dragMy += cz * fx - cx * fz;
        dragMz += cx * fy - cy * fx;
      }
      if (tri[4 * k + 3]! !== 0 && count < 3) {
        const vEntry = ru * nX + rv * nY + rw * nZ;
        if (vEntry > slamMax) slamMax = vEntry;
      }
    }
    this.fx = acc.fx + dragFx;
    this.fy = acc.fy + dragFy;
    this.fz = acc.fz + dragFz;
    this.mx = acc.mx + dragMx;
    this.my = acc.my + dragMy;
    this.mz = acc.mz + dragMz;
    this.volume = acc.vol;
    this.wettedArea = acc.area;
    const A = acc.area > 0 ? acc.area : 1;
    this.wetX = acc.cx / A;
    this.wetY = acc.cy / A;
    this.wetZ = acc.cz / A;
    this.waterU = waterU / A;
    this.waterV = waterV / A;
    this.waterW = waterW / A;
    this.slamVelocity = slamMax;
    this.slamming = slamMax > slamV;
  }
}

/** Pressure-force accumulator (body frame). Module-level to keep the hot loop allocation-free. */
class PressureAcc {
  fx = 0;
  fy = 0;
  fz = 0;
  mx = 0;
  my = 0;
  mz = 0;
  vol = 0;
  area = 0;
  /** Area-weighted centroid sums. */
  cx = 0;
  cy = 0;
  cz = 0;
  /** Third row of the rotation (world z of the body axes), for the volume integral. */
  private r6 = 0;
  private r7 = 0;
  private r8 = 1;

  reset(r6: number, r7: number, r8: number): void {
    this.fx = this.fy = this.fz = this.mx = this.my = this.mz = 0;
    this.vol = this.area = this.cx = this.cy = this.cz = 0;
    this.r6 = r6;
    this.r7 = r7;
    this.r8 = r8;
  }

  /** Integrate linear pressure p and height h over the triangle (a, b, c), body coordinates. */
  tri(
    ax: number,
    ay: number,
    az: number,
    pa: number,
    ha: number,
    bx: number,
    by: number,
    bz: number,
    pb: number,
    hb: number,
    cx: number,
    cy: number,
    cz: number,
    pc: number,
    hc: number,
  ): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const sx = 0.5 * (uy * vz - uz * vy);
    const sy = 0.5 * (uz * vx - ux * vz);
    const sz = 0.5 * (ux * vy - uy * vx);
    const psum = pa + pb + pc;
    const k = psum / 3;
    this.fx -= sx * k;
    this.fy -= sy * k;
    this.fz -= sz * k;
    // Q = Σ p_i r_i + (Σ p_i)(Σ r_i);  M = −(Q × S)/12
    const qx = pa * ax + pb * bx + pc * cx + psum * (ax + bx + cx);
    const qy = pa * ay + pb * by + pc * cy + psum * (ay + by + cy);
    const qz = pa * az + pb * bz + pc * cz + psum * (az + bz + cz);
    this.mx -= (qy * sz - qz * sy) / 12;
    this.my -= (qz * sx - qx * sz) / 12;
    this.mz -= (qx * sy - qy * sx) / 12;
    // Displaced volume below the local surface: V = ∫ h n_z,world dA (exact in calm water).
    const swz = this.r6 * sx + this.r7 * sy + this.r8 * sz;
    this.vol += (swz * (ha + hb + hc)) / 3;
    const A = Math.hypot(sx, sy, sz);
    this.area += A;
    this.cx += (A * (ax + bx + cx)) / 3;
    this.cy += (A * (ay + by + cy)) / 3;
    this.cz += (A * (az + bz + cz)) / 3;
  }
}

const acc = new PressureAcc();
