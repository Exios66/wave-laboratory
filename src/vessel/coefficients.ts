/**
 * Empirical and semi-analytical hydrodynamic coefficients used by the fidelity-L0 vessel model.
 * Every formula cites its source; the module is free of state so it can be unit-tested.
 */

/** ITTC-1957 model–ship correlation line: C_F = 0.075 / (log₁₀ Re − 2)². */
export function ittc57(re: number): number {
  // Below Re ≈ 1e5 the line is meaningless (laminar flow); clamp so C_F stays finite at rest.
  const l = Math.log10(Math.max(re, 1e5)) - 2;
  return 0.075 / (l * l);
}

/**
 * Form factor (1 + k) after Watanabe, as recommended by the ITTC (1978 performance
 * prediction method): k = −0.095 + 25.6 C_B / ((L/B)² √(B/T)). Clamped to 0 ≤ k ≤ 1.2 because
 * the regression was fitted to conventional merchant hulls.
 */
export function formFactor(cb: number, l: number, b: number, t: number): number {
  const k = -0.095 + (25.6 * cb) / ((l / b) ** 2 * Math.sqrt(b / t));
  return 1 + Math.min(1.2, Math.max(0, k));
}

/** ITTC correlation (roughness) allowance C_A for ship-scale predictions. */
export const CORRELATION_ALLOWANCE = 4e-4;

/**
 * Residuary (wave-making) resistance coefficient C_R(Fn), a deliberately simple smooth fit:
 * C_R = 1.5·10⁻³ x⁴ / (1 + x⁴/8), x = Fn/0.25. It reproduces the steep Fn⁴ rise of wave
 * resistance of displacement ships below the main hump (C_R ≈ 1.5·10⁻³ at Fn 0.25, cf. Holtrop
 * & Mennen 1982 for typical merchant forms) and saturates at 1.2·10⁻² in the semi-planing range
 * where real hulls are carried by dynamic lift that this L0 model does not resolve.
 */
export function residuaryCoefficient(fn: number): number {
  const x = fn / 0.25;
  const x4 = x * x * x * x;
  return (1.5e-3 * x4) / (1 + x4 / 8);
}

export interface ResistanceParams {
  /** Wetted surface [m²], waterline length [m], form factor (1 + k). */
  wettedArea: number;
  length: number;
  formFactor: number;
  rho: number;
  nu: number;
  g: number;
}

/** Total calm-water resistance coefficient C_T = (1 + k) C_F + C_A + C_R at speed V. */
export function resistanceCoefficient(v: number, p: ResistanceParams): number {
  const speed = Math.abs(v);
  const re = (speed * p.length) / p.nu;
  const fn = speed / Math.sqrt(p.g * p.length);
  return p.formFactor * ittc57(re) + CORRELATION_ALLOWANCE + residuaryCoefficient(fn);
}

/** Calm-water resistance R = ½ ρ S V² C_T [N]. */
export function calmWaterResistance(v: number, p: ResistanceParams): number {
  return 0.5 * p.rho * p.wettedArea * v * v * resistanceCoefficient(v, p);
}

/**
 * Infinite-frequency 2-D added masses of a Lewis-form section (Lewis 1929; see Journée &
 * Massie, "Offshore Hydromechanics", §6.4). Inputs: waterline beam b, draft d and submerged
 * area A. Lewis coefficients from H₀ = b/2d and σ = A/(b d):
 *     C₁ = (3 + 4σ/π) + (1 − 4σ/π)((H₀ − 1)/(H₀ + 1))²
 *     a₃ = (−C₁ + 3 + √(9 − 2C₁)) / C₁,   a₁ = (H₀ − 1)/(H₀ + 1)·(1 + a₃)
 *     M  = (b/2)/(1 + a₁ + a₃)
 *     a33 = ρ π/2 M² ((1 + a₁)² + 3a₃²),   a22 = ρ π/2 M² ((1 − a₁)² + 3a₃²)
 * (Limits check: a flat plate gives ρπb²/8 in heave, a vertical plate ρπd²/2 in sway.)
 */
export function lewisAddedMass(
  b: number,
  d: number,
  area: number,
  rho: number,
): { a33: number; a22: number } {
  if (b <= 1e-6 || d <= 1e-6) {
    // Zero-width (centre-plane) or dry section: thin-plate limits.
    return { a33: (rho * Math.PI * b * b) / 8, a22: (rho * Math.PI * d * d) / 2 };
  }
  const h0 = b / (2 * d);
  const sigma = Math.min(1, Math.max(0.2, area / (b * d)));
  const r = (h0 - 1) / (h0 + 1);
  const c1 = 3 + (4 * sigma) / Math.PI + (1 - (4 * sigma) / Math.PI) * r * r;
  const a3 = (-c1 + 3 + Math.sqrt(Math.max(0, 9 - 2 * c1))) / c1;
  const a1 = r * (1 + a3);
  const m = b / 2 / (1 + a1 + a3);
  const k = ((rho * Math.PI) / 2) * m * m;
  return {
    a33: k * ((1 + a1) ** 2 + 3 * a3 * a3),
    a22: k * ((1 - a1) ** 2 + 3 * a3 * a3),
  };
}

/**
 * Surge added mass after Söding (1982): A11 = m / (π √(L³/∇) − 14). Clamped to 2–15 % of the
 * mass, outside of which the regression (merchant ships, L³/∇ ≳ 30) is not meaningful.
 */
export function surgeAddedMass(mass: number, length: number, volume: number): number {
  const den = Math.PI * Math.sqrt((length * length * length) / volume) - 14;
  const ratio = den > 0 ? 1 / den : 0.15;
  return mass * Math.min(0.15, Math.max(0.02, ratio));
}

/**
 * Linear manoeuvring derivatives (non-dimensional, "prime" system with ½ρL²U and ½ρL³U)
 * from Clarke, Gedling & Hine (1983), regressions on captive-model data:
 *     Y'_v = −π(T/L)² (1 + 0.40 C_B B/T)
 *     Y'_r = −π(T/L)² (−1/2 + 2.2 B/L − 0.080 B/T)
 *     N'_v = −π(T/L)² (1/2 + 2.4 T/L)
 *     N'_r = −π(T/L)² (1/4 + 0.039 B/T − 0.56 B/L)
 * In our z-up / y-port axes both v, r and Y, N change sign relative to SNAME, so the same
 * coefficients apply unchanged.
 */
export function clarkeDerivatives(
  l: number,
  b: number,
  t: number,
  cb: number,
): { yv: number; yr: number; nv: number; nr: number } {
  const f = Math.PI * (t / l) ** 2;
  return {
    yv: -f * (1 + (0.4 * cb * b) / t),
    yr: -f * (-0.5 + (2.2 * b) / l - (0.08 * b) / t),
    nv: -f * (0.5 + (2.4 * t) / l),
    nr: -f * (0.25 + (0.039 * b) / t - (0.56 * b) / l),
  };
}

/**
 * Lift-curve slope of an all-movable rudder [1/rad] after Fujii & Tsuda (1961):
 * dC_L/dα = 6.13 Λ / (Λ + 2.25), Λ = geometric aspect ratio.
 */
export function rudderLiftSlope(aspect: number): number {
  return (6.13 * aspect) / (aspect + 2.25);
}

/** Rudder stall angle [rad] (free-stream rudders stall at ≈ 30–35°; Molland & Turnock 2007). */
export const RUDDER_STALL = (35 * Math.PI) / 180;

/**
 * Rudder lift coefficient: linear up to stall, then a post-stall drop to ~55 % of the peak
 * over the next 20°, then constant.
 */
export function rudderLift(alpha: number, slope: number): number {
  const a = Math.abs(alpha);
  if (a <= RUDDER_STALL) return slope * alpha;
  const peak = slope * RUDDER_STALL;
  const drop = Math.min(1, (a - RUDDER_STALL) / ((20 * Math.PI) / 180));
  return Math.sign(alpha) * peak * (1 - 0.45 * drop);
}

/**
 * Ikeda's lift component of roll damping (Ikeda, Himeno & Tanaka 1978):
 *     B_L = ½ ρ S_L U k_N l_O l_R [1 + 1.4 OG/l_R + 0.7 OG²/(l_O l_R)]
 * with S_L = L T, k_N = 2πT/L + κ(4.1 B/L − 0.045), l_O = 0.3 T, l_R = 0.5 T, OG the depth of
 * the CoG below the waterline (negative when G is above it) and κ = 0, 0.1, 0.3 for midship
 * coefficients C_M ≤ 0.92, ≤ 0.97 and above. Units N·m·s/rad.
 */
export function ikedaLiftDamping(
  rho: number,
  speed: number,
  l: number,
  b: number,
  t: number,
  og: number,
  cm: number,
): number {
  const kappa = cm <= 0.92 ? 0 : cm <= 0.97 ? 0.1 : 0.3;
  const kN = (2 * Math.PI * t) / l + kappa * ((4.1 * b) / l - 0.045);
  const lO = 0.3 * t;
  const lR = 0.5 * t;
  const bracket = Math.max(0, 1 + (1.4 * og) / lR + (0.7 * og * og) / (lO * lR));
  return 0.5 * rho * l * t * Math.abs(speed) * kN * lO * lR * bracket;
}

/**
 * Ochi's (1964) slamming criterion: a bottom slam occurs when the relative vertical velocity
 * near the bow exceeds 0.093 √(g L) while the forefoot re-enters the water.
 */
export function ochiThreshold(g: number, length: number): number {
  return 0.093 * Math.sqrt(g * length);
}

/**
 * Propeller thrust loss due to emergence/ventilation as a function of the immersion ratio
 * h/R (shaft depth over propeller radius). A smooth fit to the trend reported by Minsaas,
 * Thon & Kauczynski (1987) and Faltinsen (2005): β ≈ 1 when h/R ≳ 1.5, falling roughly
 * linearly to 0 when the tips are about to leave the water completely (h/R ≈ −1).
 */
export function thrustImmersionFactor(hOverR: number): number {
  const x = (hOverR + 1) / 2.5;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}
