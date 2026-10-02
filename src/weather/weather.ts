/**
 * Deterministic weather around the environment's mean wind.
 *
 * Wind (what the vessels feel and the picture shows):
 *   U(x, t) = U₁₀ · m_sq(x, t) · (1 + u′(x, t)),  direction = mean + veer_sq(x, t) + v′(x, t)
 *  - u′, v′: longitudinal and lateral turbulence as a sum of `GUST_MODES` Fourier modes drawn
 *    from the von Kármán spectrum
 *        S_u(f) = 4 σ_u² (L/U) / (1 + 70.8 (f L/U)²)^(5/6),   L = 180 m (marine surface layer),
 *    with σ_u = I·U (I = `gustiness`) and σ_v = 0.75 σ_u (ESDU 85020). The field is advected
 *    with the mean wind (Taylor's frozen turbulence) and each mode also varies across the
 *    wind, so gusts arrive as moving patches ("cat's paws") rather than everywhere at once.
 *  - squalls: fronts that move downwind at the mean wind speed, arriving on average every
 *    `intervalMin`, with a sharp gust-front rise, a plateau of `strength`·U and a slower decay,
 *    a clockwise veer and heavy rain.
 * Everything is a pure function of (seed, x, y, t), so the worker, the renderer and the tests
 * see exactly the same weather.
 */
import { Pcg32, deriveSeed } from '../core/rng';
import { DEG } from '../core/units';
import type { Environment, Weather } from '../schema/experiment';

export const GUST_MODES = 24;
/** Integral length scale of longitudinal turbulence near the sea surface [m]. */
export const TURBULENCE_LENGTH = 180;
const F_MIN = 0.0015;
const F_MAX = 0.6;

export interface GustMode {
  /** Frequency [Hz]. */
  f: number;
  /** Amplitude of the relative longitudinal (along-wind) fluctuation u′/U. */
  au: number;
  /** Amplitude of the lateral fluctuation v′/U. */
  av: number;
  phaseU: number;
  phaseV: number;
  /** Cross-wind wavenumber as a fraction of the along-wind wavenumber 2πf/U. */
  cross: number;
}

export interface WindSample {
  /** Air velocity at 10 m, world frame [m/s] (the direction the air moves TOWARD). */
  u: number;
  v: number;
  speed: number;
  /** Squall intensity 0–1 at this point. */
  squall: number;
}

/** von Kármán longitudinal spectrum [m²/s² per Hz]. */
export function vonKarmanSpectrum(f: number, sigma: number, U: number, L = TURBULENCE_LENGTH) {
  const n = (f * L) / U;
  return (4 * sigma * sigma * (L / U)) / (1 + 70.8 * n * n) ** (5 / 6);
}

/**
 * Whitecap coverage fraction (Monahan & O'Muircheartaigh 1980): W = 3.84·10⁻⁶ U₁₀^3.41,
 * capped at 1 (it reaches ~40 % around 30 m/s).
 */
export function whitecapFraction(u10: number): number {
  return Math.min(1, 3.84e-6 * Math.max(0, u10) ** 3.41);
}

/**
 * Visibility in rain [km], combining clear-air visibility with rain extinction through
 * Koschmieder's law (β = 3.912 / V). Rain extinction follows the usual empirical power law
 * β_rain ≈ 0.25 R^0.63 km⁻¹ (R in mm/h), which gives ~2 km in 50 mm/h rain.
 */
export function rainVisibilityKm(clearKm: number, rainMmH: number): number {
  const beta = 3.912 / Math.max(0.05, clearKm) + 0.25 * Math.max(0, rainMmH) ** 0.63;
  return 3.912 / beta;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Hash of (seed, integer) to [0, 1). */
function hash01(seed: number, i: number): number {
  return deriveSeed(seed, i) / 4294967296;
}

export class WeatherField {
  readonly weather: Weather;
  /** Mean 10 m wind speed [m/s] and the unit vector it blows toward. */
  readonly meanSpeed: number;
  readonly dirX: number;
  readonly dirY: number;
  readonly modes: GustMode[];
  private readonly seed: number;
  /** Speed used for advection of gusts and squall fronts [m/s] (never zero). */
  readonly advection: number;

  constructor(weather: Weather, env: Pick<Environment, 'windSpeed' | 'windDirectionDeg'>) {
    this.weather = weather;
    this.meanSpeed = env.windSpeed;
    // Wind direction is a compass "from" bearing; the air moves the opposite way.
    const theta = (-90 - env.windDirectionDeg) * DEG;
    this.dirX = Math.cos(theta);
    this.dirY = Math.sin(theta);
    this.seed = weather.seed >>> 0;
    this.advection = Math.max(2, this.meanSpeed);
    this.modes = buildGustModes(weather.gustiness, this.advection, this.seed);
  }

  /** Time the k-th squall front passes the origin [s]. */
  squallTime(k: number): number {
    const interval = this.weather.squalls.intervalMin * 60;
    return (k + 0.25 + 0.5 * hash01(this.seed ^ 0x5a17, k)) * interval;
  }

  /** Squall intensity 0–1 at a point (fronts move downwind). */
  squall(x: number, y: number, t: number): number {
    const sq = this.weather.squalls;
    if (!sq.enabled) return 0;
    const interval = sq.intervalMin * 60;
    const dur = sq.durationMin * 60;
    // Local time: when the front passing the origin at t₀ reaches this point.
    const along = x * this.dirX + y * this.dirY;
    const tau = t - along / this.advection;
    const k0 = Math.floor(tau / interval);
    let e = 0;
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      if (k < 0) continue;
      const tk = this.squallTime(k);
      const s = tau - tk;
      const rise = smoothstep(-0.08 * dur, 0, s);
      const fall = 1 - smoothstep(0.55 * dur, 1.4 * dur, s);
      e = Math.max(e, rise * fall);
    }
    return e;
  }

  /** Relative gust fluctuations (u′/U along, v′/U across the mean wind) at a point. */
  gust(x: number, y: number, t: number, out: { u: number; v: number }): void {
    const along = x * this.dirX + y * this.dirY;
    const across = -x * this.dirY + y * this.dirX;
    const U = this.advection;
    let gu = 0;
    let gv = 0;
    for (const m of this.modes) {
      const w = 2 * Math.PI * m.f;
      const kx = w / U;
      const arg = w * t - kx * along + kx * m.cross * across;
      gu += m.au * Math.cos(arg + m.phaseU);
      gv += m.av * Math.cos(arg + m.phaseV);
    }
    out.u = gu;
    out.v = gv;
  }

  private readonly g = { u: 0, v: 0 };

  /** 10 m wind at a point and time. */
  windAt(x: number, y: number, t: number, out: WindSample): WindSample {
    const U = this.meanSpeed;
    if (U <= 0) {
      out.u = 0;
      out.v = 0;
      out.speed = 0;
      out.squall = 0;
      return out;
    }
    const sq = this.squall(x, y, t);
    const s = this.weather.squalls;
    const mult = 1 + (s.strength - 1) * sq;
    this.gust(x, y, t, this.g);
    const turb = 1 + 0.5 * sq; // gustier inside a squall
    const along = U * mult * (1 + this.g.u * turb);
    const lateral = U * mult * this.g.v * turb;
    const veer = -s.veerDeg * DEG * sq; // clockwise veer = negative mathematical rotation
    const c = Math.cos(veer);
    const sn = Math.sin(veer);
    const dx = this.dirX * c - this.dirY * sn;
    const dy = this.dirX * sn + this.dirY * c;
    // Lateral component is perpendicular (to the left) of the veered direction.
    out.u = Math.max(0, along) * dx - lateral * dy;
    out.v = Math.max(0, along) * dy + lateral * dx;
    out.speed = Math.hypot(out.u, out.v);
    out.squall = sq;
    return out;
  }

  /** Rain rate [mm/h] at a point (squalls bring heavy showers). */
  rainAt(x: number, y: number, t: number): number {
    const base = this.weather.rainMmH;
    if (!this.weather.squalls.enabled) return base;
    const sq = this.squall(x, y, t);
    return base + sq * Math.max(25, 2 * base);
  }

  /** Cloud cover 0–1 at a point. */
  cloudAt(x: number, y: number, t: number): number {
    const base = this.weather.cloudCover;
    if (!this.weather.squalls.enabled) return base;
    return Math.max(base, 0.95 * smoothstep(0, 0.6, this.squall(x, y, t)));
  }

  /**
   * Lightning flash brightness 0–1 at time t. Strikes are a Poisson-like process (one hash per
   * 0.25 s slot) whose rate rises with rain and squalls; each flash flickers for ~0.3 s.
   */
  lightning(t: number, squall = 0, rain = this.weather.rainMmH): number {
    if (!this.weather.lightning) return 0;
    const slot = 0.25;
    const rate = 0.02 + 0.12 * squall + 0.002 * Math.min(rain, 80); // strikes per second
    const p = rate * slot;
    const k = Math.floor(t / slot);
    let flash = 0;
    for (let j = k - 1; j <= k; j++) {
      if (j < 0 || hash01(this.seed ^ 0x11d7, j) >= p) continue;
      const age = t - j * slot;
      if (age < 0) continue;
      const flicker = 0.6 + 0.4 * Math.cos(age * 70 + j);
      flash = Math.max(flash, Math.exp(-age / 0.09) * flicker);
    }
    return Math.min(1, flash);
  }
}

/** Gust modes for a turbulence intensity, normalised to exactly σ_u = I (relative). */
export function buildGustModes(intensity: number, U: number, seed: number): GustMode[] {
  if (!(intensity > 0)) return [];
  const rng = new Pcg32(deriveSeed(seed, 0x6057), 11);
  const modes: GustMode[] = [];
  const ratio = (F_MAX / F_MIN) ** (1 / GUST_MODES);
  let variance = 0;
  for (let i = 0; i < GUST_MODES; i++) {
    const f0 = F_MIN * ratio ** i;
    const f1 = f0 * ratio;
    // Jitter inside the band so the sum is not periodic.
    const f = f0 + (f1 - f0) * (0.25 + 0.5 * rng.nextFloat());
    const s = vonKarmanSpectrum(f, intensity, U);
    const a = Math.sqrt(2 * s * (f1 - f0));
    variance += (a * a) / 2;
    modes.push({
      f,
      au: a,
      av: 0,
      phaseU: 2 * Math.PI * rng.nextFloat(),
      phaseV: 2 * Math.PI * rng.nextFloat(),
      cross: 2 * rng.nextFloat() - 1,
    });
  }
  // The truncated band misses a little variance: rescale so σ_u is exactly the request.
  const scale = variance > 0 ? intensity / Math.sqrt(variance) : 0;
  for (const m of modes) {
    m.au *= scale;
    m.av = 0.75 * m.au;
  }
  return modes;
}
