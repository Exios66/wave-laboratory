/**
 * Anchor lines: a quasi-static elastic catenary with a frictionless seabed, and an anchor that
 * drags when the pull exceeds its holding capacity. Pure maths (no three.js); the vessel applies
 * the resulting force at its hawse pipe.
 *
 * Geometry: the fairlead is a height `h` above the anchor level and a horizontal distance `X`
 * from the anchor; the line has unstretched length `L`, submerged weight per metre `w` and axial
 * stiffness `EA`. With horizontal tension H (the same all along a frictionless line) and the
 * vertical tension V at the fairlead (Jonkman 2007, eqs. 2-28 to 2-31):
 *
 *   part on the seabed (V ≤ wL):
 *     X = (L − V/w) + (H/w) asinh(V/H) + H L / EA
 *     h = (H/w) (√(1 + (V/H)²) − 1) + V² / (2 EA w)
 *   fully lifted (V > wL, the anchor end is pulled up with V − wL):
 *     X = (H/w) [asinh(V/H) − asinh((V − wL)/H)] + H L / EA
 *     h = (H/w) [√(1 + (V/H)²) − √(1 + ((V − wL)/H)²)] + (V L − w L²/2) / EA
 *
 * For given H the first `h` equation is a quadratic in (V/H)², so V(H) is explicit; X(H) then
 * increases monotonically and is solved by a bracketed false-position/bisection search that
 * cannot fail to converge (no Newton divergence at slack or near-vertical lines). A line that
 * can lie slack on the bottom (X ≤ L − s₀, s₀ the length hanging vertically) exerts only its
 * hanging weight; a line shorter than the water is deep is a straight elastic bar.
 */

const G = 9.80665;
/** Steel density [kg/m³]; submerged chain weighs (1 − ρ/ρ_steel) of its air weight. */
const STEEL_DENSITY = 7850;
/** Studless chain: mass per metre 0.0219 d² [kg/m, d in mm] and EA = 47.4e9 d² [N, d in m]. */
const CHAIN_MASS_PER_D2 = 0.0219;
const CHAIN_EA_PER_D2 = 47.4e9;
/** Anchor mass [kg] per d² [mm²] of chain; holding capacity = factor × anchor weight (soft seabed). */
const ANCHOR_MASS_PER_D2 = 1.5;
export const HOLDING_FACTOR = 12;
/** Anchor drag speed [m/s] per unit of overload (H/holding − 1) and its cap. */
const DRAG_GAIN = 30;
const DRAG_MAX = 20;
/** A floating pennant to a buoy is lighter than chain on the bottom. */
const PENNANT_WEIGHT_FACTOR = 0.25;
/** Fraction of critical damping the chain adds to the surge/sway of the moored ship. */
const LINE_DAMPING = 0.08;
/** Offset [m] of the finite difference for the line stiffness. */
const STIFFNESS_STEP = 0.05;

export interface MooringGear {
  /** Chain diameter [mm]. */
  chainDiameter: number;
  /** Submerged weight per metre [N/m] and axial stiffness EA [N]. */
  w: number;
  ea: number;
  /** Anchor mass [kg] and holding capacity (horizontal pull at the anchor) [N]. */
  anchorMass: number;
  holding: number;
  /** Chain carried [m]. */
  capacity: number;
}

/**
 * Ground tackle scaled with the ship: chain diameter ≈ 5.5 (Δ/t)^¼ mm (30 mm at 1000 t, 130 mm
 * for a VLCC), as in the classification societies' equipment tables to within their spread.
 */
export function mooringGear(
  displacementKg: number,
  lengthM: number,
  rho = 1025,
  g = G,
  buoy = false,
): MooringGear {
  const d = 5.5 * Math.pow(Math.max(displacementKg, 1000) / 1000, 0.25);
  const wChain = g * (1 - rho / STEEL_DENSITY) * CHAIN_MASS_PER_D2 * d * d;
  const anchorMass = ANCHOR_MASS_PER_D2 * d * d;
  return {
    chainDiameter: d,
    w: buoy ? PENNANT_WEIGHT_FACTOR * wChain : wChain,
    ea: CHAIN_EA_PER_D2 * (d / 1000) * (d / 1000),
    anchorMass,
    holding: buoy ? Infinity : HOLDING_FACTOR * anchorMass * g,
    capacity: 90 + 1.2 * lengthM,
  };
}

export type CatenaryRegime = 'slack' | 'grounded' | 'suspended' | 'taut';

export interface CatenarySolution {
  regime: CatenaryRegime;
  /** Horizontal tension [N] and vertical tension at the fairlead [N] (positive = pulls down). */
  H: number;
  V: number;
  /** Fairlead tension magnitude [N]. */
  T: number;
  /** Unstretched length of line on the bottom and hanging free [m]. */
  grounded: number;
  suspended: number;
  /** Horizontal distance from the anchor to the touchdown point [m]. */
  touchdown: number;
  /** Solver iterations (diagnostic). */
  iterations: number;
}

export function emptySolution(): CatenarySolution {
  return {
    regime: 'slack',
    H: 0,
    V: 0,
    T: 0,
    grounded: 0,
    suspended: 0,
    touchdown: 0,
    iterations: 0,
  };
}

/** Vertical fairlead tension for horizontal tension H (explicit when part lies on the bottom). */
function verticalTension(H: number, h: number, L: number, w: number, ea: number): number {
  const c = (w * h) / H;
  const k = H / (2 * ea);
  const cc = c * (2 + c);
  const b = 1 + 2 * (1 + c) * k;
  const disc = Math.sqrt(Math.max(0, b * b - 4 * k * k * cc));
  const V = H * Math.sqrt((2 * cc) / (b + disc));
  const wL = w * L;
  if (V <= wL) return V;
  // Fully lifted: bisect z(V) = h for V > wL (z increases monotonically with V).
  const z = (v: number): number => {
    const a = v / H;
    const bb = (v - wL) / H;
    const sa = Math.sqrt(1 + a * a);
    const sb = Math.sqrt(1 + bb * bb);
    // sa − sb = (a − b)(a + b) / (sa + sb), without cancellation
    const dsq = ((a - bb) * (a + bb)) / (sa + sb);
    return (H / w) * dsq + (v * L - 0.5 * wL * L) / ea;
  };
  let lo = wL;
  let hi = Math.max(2 * wL, 2 * V);
  for (let i = 0; i < 200 && z(hi) < h; i++) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (z(mid) < h) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-13 * hi) break;
  }
  return 0.5 * (lo + hi);
}

/** Horizontal reach X(H) of the line (V from `verticalTension`). */
function reach(H: number, V: number, L: number, w: number, ea: number): number {
  const wL = w * L;
  if (V <= wL) return L - V / w + (H / w) * Math.asinh(V / H) + (H * L) / ea;
  return (H / w) * (Math.asinh(V / H) - Math.asinh((V - wL) / H)) + (H * L) / ea;
}

function setTaut(out: CatenarySolution, X: number, h: number, L: number, ea: number): void {
  const D = Math.hypot(X, h);
  const T = (ea * Math.max(0, D - L)) / L;
  out.regime = 'taut';
  out.T = T;
  out.H = D > 0 ? (T * X) / D : 0;
  out.V = D > 0 ? (T * h) / D : 0;
  out.grounded = 0;
  out.suspended = L;
  out.touchdown = 0;
}

/**
 * Solve the elastic catenary for fairlead offset (X, h), line length L, weight w and stiffness
 * EA. Always returns finite numbers; zero horizontal tension for a slack line.
 */
export function solveCatenary(
  X: number,
  h: number,
  L: number,
  w: number,
  ea: number,
  out: CatenarySolution = emptySolution(),
): CatenarySolution {
  X = Math.max(0, X);
  h = Math.max(1e-3, h);
  L = Math.max(1e-3, L);
  w = Math.max(1e-9, w);
  ea = Math.max(1, ea);
  out.iterations = 0;
  // Length hanging vertically when the horizontal pull is zero: h = s + w s² / (2 EA).
  const s0 = (ea / w) * (Math.sqrt(1 + (2 * w * h) / ea) - 1);
  if (L <= s0) {
    setTaut(out, X, h, L, ea);
    return out;
  }
  const lb0 = L - s0;
  if (X <= lb0) {
    out.regime = 'slack';
    out.H = 0;
    out.V = w * s0;
    out.T = out.V;
    out.grounded = lb0;
    out.suspended = s0;
    out.touchdown = Math.min(X, lb0);
    return out;
  }
  const f = (H: number): number => reach(H, verticalTension(H, h, L, w, ea), L, w, ea) - X;
  let lo = 1e-9 * w * L;
  let flo = f(lo);
  if (flo >= 0) {
    // Practically slack: the reach at vanishing tension already covers X.
    out.H = lo;
  } else {
    let hi = Math.max(w * L, 1);
    let fhi = f(hi);
    let guard = 0;
    while (fhi < 0 && guard++ < 120) {
      lo = hi;
      flo = fhi;
      hi *= 2;
      fhi = f(hi);
    }
    if (!(fhi >= 0) || !Number.isFinite(fhi)) {
      setTaut(out, X, h, L, ea);
      return out;
    }
    let it = 0;
    for (; it < 200; it++) {
      let mid = hi - (fhi * (hi - lo)) / (fhi - flo);
      if (!(mid > lo && mid < hi) || it % 3 === 2)
        mid = hi / lo > 100 ? Math.sqrt(lo * hi) : 0.5 * (lo + hi);
      const fm = f(mid);
      if (fm < 0) {
        lo = mid;
        flo = fm;
      } else {
        hi = mid;
        fhi = fm;
      }
      if (Math.abs(fm) <= 1e-11 * (X + h + 1) || hi - lo <= 1e-14 * hi) break;
    }
    out.iterations = it;
    out.H = Math.abs(flo) < Math.abs(fhi) ? lo : hi;
  }
  const V = verticalTension(out.H, h, L, w, ea);
  out.V = V;
  out.T = Math.hypot(out.H, V);
  if (V <= w * L) {
    out.regime = 'grounded';
    out.suspended = V / w;
    out.grounded = L - out.suspended;
    out.touchdown = out.grounded * (1 + out.H / ea);
  } else {
    out.regime = 'suspended';
    out.suspended = L;
    out.grounded = 0;
    out.touchdown = 0;
  }
  if (!Number.isFinite(out.T)) setTaut(out, X, h, L, ea);
  return out;
}

/**
 * Sample the line from the anchor to the fairlead as flat [d₀, z₀, d₁, z₁, …]: d the horizontal
 * distance from the anchor and z the height above the anchor level, `n` points on the hanging
 * part (the bottom part is a straight segment).
 */
export function catenaryProfile(
  sol: CatenarySolution,
  X: number,
  h: number,
  L: number,
  w: number,
  ea: number,
  n = 24,
): number[] {
  const out: number[] = [];
  if (sol.regime === 'taut') {
    out.push(0, 0, X, h);
    return out;
  }
  if (sol.regime === 'slack') {
    out.push(0, 0, X, 0, X, h);
    return out;
  }
  const H = Math.max(sol.H, 1e-9);
  const Va = Math.max(0, sol.V - w * L);
  const x0 = sol.touchdown;
  out.push(0, 0);
  if (x0 > 0) out.push(x0, 0);
  const Ls = sol.suspended;
  const a0 = Va / H;
  const s0 = Math.sqrt(1 + a0 * a0);
  for (let i = 1; i <= n; i++) {
    const s = (Ls * i) / n;
    const v = Va + w * s;
    const a = v / H;
    out.push(
      x0 + (H / w) * (Math.asinh(a) - Math.asinh(a0)) + (H * s) / ea,
      (H / w) * (Math.sqrt(1 + a * a) - s0) + (Va * s + 0.5 * w * s * s) / ea,
    );
  }
  return out;
}

export interface MooringForce {
  /** Force on the vessel at the fairlead (world, z up) [N]. */
  fx: number;
  fy: number;
  fz: number;
}

/** A deployed anchor line and the anchor on the bottom (or a buoy at the surface). */
export class Mooring {
  deployed = false;
  readonly kind: 'anchor' | 'buoy';
  /** Anchor/buoy position (world) [m]; z is the seabed (anchor) or 0 (buoy). */
  anchorX = 0;
  anchorY = 0;
  anchorZ = 0;
  /** Unstretched line length [m]. */
  length = 0;
  dragging = false;
  readonly gear: MooringGear;
  readonly solution = emptySolution();
  /** Last fairlead position evaluated and the horizontal distance/height from the anchor [m]. */
  fairX = 0;
  fairY = 0;
  fairZ = 0;
  offset = 0;
  height = 0;
  /** Ship mass including added mass in surge [kg], for the line damping (0 = undamped). */
  mass = 0;
  private readonly depth: number;
  private readonly probe = emptySolution();

  constructor(gear: MooringGear, depth: number, kind: 'anchor' | 'buoy' = 'anchor') {
    this.gear = gear;
    this.depth = depth;
    this.kind = kind;
  }

  /** Line length for a scope (line length ÷ water depth), limited by the chain carried. */
  lengthForScope(scope: number): number {
    return Math.min(this.gear.capacity, Math.max(1.05 * this.depth, scope * this.depth));
  }

  /** The water is shallow enough that the chain reaches the bottom. */
  get available(): boolean {
    return this.kind === 'buoy' || this.gear.capacity >= 1.1 * this.depth;
  }

  deploy(x: number, y: number, length: number): void {
    this.anchorX = x;
    this.anchorY = y;
    this.anchorZ = this.kind === 'buoy' ? 0 : -this.depth;
    this.length = length;
    this.deployed = true;
    this.dragging = false;
    this.solution.regime = 'slack';
    this.solution.H = 0;
    this.solution.V = 0;
    this.solution.T = 0;
  }

  weigh(): void {
    this.deployed = false;
    this.dragging = false;
    const s = this.solution;
    s.H = 0;
    s.V = 0;
    s.T = 0;
  }

  /** Solve the line for a fairlead at (x, y, z) and write the force on the vessel to `out`. */
  force(x: number, y: number, z: number, out: MooringForce, vx = 0, vy = 0): MooringForce {
    out.fx = 0;
    out.fy = 0;
    out.fz = 0;
    if (!this.deployed) return out;
    const dx = x - this.anchorX;
    const dy = y - this.anchorY;
    const X = Math.hypot(dx, dy);
    const h = z - this.anchorZ;
    this.fairX = x;
    this.fairY = y;
    this.fairZ = z;
    this.offset = X;
    this.height = h;
    const sol = solveCatenary(X, h, this.length, this.gear.w, this.gear.ea, this.solution);
    if (X > 1e-6) {
      // Horizontal tension pulls the fairlead toward the anchor.
      let pull = sol.H;
      // Line drag and bottom friction damp the surge on the chain: a fraction of critical
      // damping for the tangent stiffness k = dH/dX and the ship's mass.
      if (this.mass > 0 && sol.H > 0) {
        const keep = this.probe;
        solveCatenary(X + STIFFNESS_STEP, h, this.length, this.gear.w, this.gear.ea, keep);
        const k = (keep.H - sol.H) / STIFFNESS_STEP;
        const vr = (vx * dx + vy * dy) / X; // velocity away from the anchor
        if (k > 0) pull += 2 * LINE_DAMPING * Math.sqrt(k * this.mass) * vr;
      }
      out.fx = (-pull * dx) / X;
      out.fy = (-pull * dy) / X;
    }
    out.fz = -sol.V;
    return out;
  }

  /** Let the anchor drag toward the vessel while the horizontal pull exceeds its holding. */
  step(dt: number): void {
    if (!this.deployed) return;
    const over = this.solution.H / this.gear.holding - 1;
    this.dragging = over > 0;
    if (!this.dragging || this.offset < 1e-6) return;
    const move = Math.min(DRAG_MAX, DRAG_GAIN * over) * dt;
    const f = Math.min(move, this.offset) / this.offset;
    this.anchorX += (this.fairX - this.anchorX) * f;
    this.anchorY += (this.fairY - this.anchorY) * f;
  }

  /** Line shape for drawing (see `catenaryProfile`); empty when not deployed. */
  profile(n = 24): number[] {
    if (!this.deployed) return [];
    return catenaryProfile(
      this.solution,
      this.offset,
      this.height,
      this.length,
      this.gear.w,
      this.gear.ea,
      n,
    );
  }
}
