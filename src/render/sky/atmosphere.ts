/**
 * Clear-sky colour from single scattering in a Rayleigh + Mie atmosphere (Nishita et al. 1993;
 * the coefficients follow Bruneton & Neyret 2008). The result is a small sky-view table the sky
 * dome and the ocean read on the GPU and the fog and lights read on the CPU, so all of them agree.
 *
 * The table holds only the colour and the angular distribution of the clear sky. Its brightness is
 * normalised to the renderer's tuned daylight curve (`skyLightLevel` in scenery/lighting.ts): the
 * mean horizon luminance equals the hand-tuned clear horizon times that level. The exposure the
 * rest of the scene was tuned against therefore does not move, while sunsets redden, the sky
 * whitens toward the horizon and the glow gathers around the sun.
 *
 * Table layout (`SKY_LUT_W` × `SKY_LUT_H`, linear RGB):
 *   u ∈ [0, 1] = angle between the view and sun azimuths / π (the sky is symmetric about the
 *                sun's vertical plane, so half the circle is enough);
 *   v ∈ [0, 1] = sqrt(elevation / (π/2)) for elevations 0 … 90° (dense near the horizon, where
 *                the colour changes fastest). Below the horizon the shader uses the v = 0 row.
 */

export const SKY_LUT_W = 32;
export const SKY_LUT_H = 32;

const R_EARTH = 6_360_000;
const R_ATMOS = 6_420_000;
const H_RAYLEIGH = 8_000;
const H_MIE = 1_200;
/** Rayleigh scattering at sea level [1/m] for 680, 550 and 440 nm. */
const BETA_R = [5.8e-6, 13.5e-6, 33.1e-6] as const;
/** Mie scattering at sea level for clean maritime air [1/m]; extinction is 1.11×. */
const BETA_M = 12e-6;
/**
 * Ozone absorption [1/m] at the peak of a tent profile 25 ± 15 km up (Hillaire 2020). It absorbs
 * orange more than blue, which deepens the zenith and gives twilight its blue-violet.
 */
const BETA_O3 = [0.65e-6, 1.881e-6, 0.085e-6] as const;
const MIE_EXT = 1.11;
const MIE_G = 0.76;
const VIEW_STEPS = 16;
const LIGHT_STEPS = 6;
/** Eye height above the sea [m]. */
const EYE = 20;
/**
 * Multiple scattering, approximated: a fill of this fraction of the dome's mean luminance, in the
 * zenith's colour, added everywhere. It keeps the sky away from the sun from going black at
 * twilight, where single scattering leaves only the sunlit upper air.
 */
const MULTI_FILL = 0.25;
/**
 * Saturation applied to the table about each texel's luminance (1 = physical). A mild grade so the
 * clear sky keeps the depth of blue the scene was tuned with.
 */
export const SKY_SATURATION = 1.3;

/** Rec. 709 luminance of linear RGB. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Relative ozone density at height h [m]. */
function ozone(h: number): number {
  return Math.max(0, 1 - Math.abs(h - 25_000) / 15_000);
}

/** Distance along a ray from height-radius `r0` with direction cosine `mu` to the sphere `R`. */
function rayToSphere(r0: number, mu: number, R: number): number {
  const b = r0 * mu;
  const c = r0 * r0 - R * R;
  const d = b * b - c;
  if (d < 0) return -1;
  const s = Math.sqrt(d);
  const t1 = -b - s;
  const t2 = -b + s;
  if (t1 > 0) return t1;
  return t2 > 0 ? t2 : -1;
}

/**
 * Optical depth (Rayleigh, Mie) from a point at radius `r` along cosine `mu` to the top of the
 * atmosphere, or null when the ray hits the ground (the point is in the earth's shadow).
 */
function opticalDepthToSpace(r: number, mu: number, out: [number, number, number]): boolean {
  const hitGround = rayToSphere(r, mu, R_EARTH);
  if (hitGround > 0 && mu < 0) return false;
  const len = rayToSphere(r, mu, R_ATMOS);
  const ds = len / LIGHT_STEPS;
  let odR = 0;
  let odM = 0;
  let odO = 0;
  for (let i = 0; i < LIGHT_STEPS; i++) {
    const t = (i + 0.5) * ds;
    const h = Math.sqrt(r * r + t * t + 2 * r * t * mu) - R_EARTH;
    odR += Math.exp(-h / H_RAYLEIGH) * ds;
    odM += Math.exp(-h / H_MIE) * ds;
    odO += ozone(h) * ds;
  }
  out[0] = odR;
  out[1] = odM;
  out[2] = odO;
  return true;
}

const od: [number, number, number] = [0, 0, 0];

/**
 * Transmittance of sunlight to the sea surface for a sun `elevation` [rad] (linear RGB, 1 = no
 * loss). `turbidity` scales the aerosol load (1 = clean maritime air, 3 = hazy).
 */
export function sunTransmittance(
  elevation: number,
  turbidity = 1,
  out: number[] = [0, 0, 0],
): number[] {
  const r = R_EARTH + EYE;
  if (!opticalDepthToSpace(r, Math.sin(elevation), od)) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const m = BETA_M * turbidity * MIE_EXT * od[1];
  for (let c = 0; c < 3; c++) out[c] = Math.exp(-(BETA_R[c]! * od[0] + m + BETA_O3[c]! * od[2]));
  return out;
}

/**
 * Single-scattered sky radiance [arbitrary units] seen from the sea surface along the direction
 * with `elevation` [rad] and azimuth `dAz` [rad] away from the sun, for a sun at `sunElevation`.
 */
export function skyRadiance(
  elevation: number,
  dAz: number,
  sunElevation: number,
  turbidity = 1,
  out: number[] = [0, 0, 0],
): number[] {
  const r0 = R_EARTH + EYE;
  const ce = Math.cos(elevation);
  const view = [ce * Math.cos(dAz), Math.sin(elevation), ce * Math.sin(dAz)];
  const cs = Math.cos(sunElevation);
  const sun = [cs, Math.sin(sunElevation), 0];
  const cosT = view[0]! * sun[0]! + view[1]! * sun[1]!;
  const phaseR = (3 / (16 * Math.PI)) * (1 + cosT * cosT);
  const g = MIE_G;
  const phaseM =
    ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + cosT * cosT))) /
    ((2 + g * g) * Math.pow(1 + g * g - 2 * g * cosT, 1.5));
  const len = rayToSphere(r0, view[1]!, R_ATMOS);
  const ds = len / VIEW_STEPS;
  const betaM = BETA_M * turbidity;
  let odR = 0;
  let odM = 0;
  let odO = 0;
  out[0] = out[1] = out[2] = 0;
  for (let i = 0; i < VIEW_STEPS; i++) {
    const t = (i + 0.5) * ds;
    // Sample point, with the eye at (0, r0, 0) and y up from the earth's centre.
    const px = view[0]! * t;
    const py = r0 + view[1]! * t;
    const pz = view[2]! * t;
    const r = Math.sqrt(px * px + py * py + pz * pz);
    const h = r - R_EARTH;
    const dR = Math.exp(-h / H_RAYLEIGH) * ds;
    const dM = Math.exp(-h / H_MIE) * ds;
    const dO = ozone(h) * ds;
    odR += dR * 0.5;
    odM += dM * 0.5;
    odO += dO * 0.5;
    // Sun direction cosine against the local vertical at the sample.
    const muS = (px * sun[0]! + py * sun[1]!) / r;
    if (opticalDepthToSpace(r, muS, od)) {
      for (let c = 0; c < 3; c++) {
        const tau =
          BETA_R[c]! * (odR + od[0]) +
          betaM * MIE_EXT * (odM + od[1]) +
          BETA_O3[c]! * (odO + od[2]);
        const att = Math.exp(-tau);
        out[c] = out[c]! + att * (dR * BETA_R[c]! * phaseR + dM * betaM * phaseM);
      }
    }
    odR += dR * 0.5;
    odM += dM * 0.5;
    odO += dO * 0.5;
  }
  return out;
}

/** Elevation [rad] of table row `j`. */
export function lutElevation(j: number): number {
  const v = j / (SKY_LUT_H - 1);
  return v * v * (Math.PI / 2);
}

/** Azimuth from the sun [rad] of table column `i`. */
export function lutAzimuth(i: number): number {
  return (i / (SKY_LUT_W - 1)) * Math.PI;
}

/**
 * Luminance of the tuned clear sky's mean radiance, 0.45 horizon + 0.55 zenith (`skyAmbient` in
 * the shader): horizon sRGB (0.78, 0.84, 0.90), zenith sRGB (0.16, 0.38, 0.72).
 */
export const TUNED_SKY_LUM =
  0.45 * luminance(0.5711, 0.6724, 0.7874) + 0.55 * luminance(0.0222, 0.1195, 0.4793);

export interface SkyTable {
  /** RGBA float texels, row-major, row = elevation, column = azimuth from the sun. */
  data: Float32Array;
  /** Mean horizon colour over all azimuths (linear RGB). */
  horizonMean: [number, number, number];
  /** Zenith colour (linear RGB). */
  zenith: [number, number, number];
  /** Mean radiance of the whole dome, every direction weighted by solid angle (linear RGB). */
  mean: [number, number, number];
}

/**
 * Fill the sky-view table for a sun at `sunElevation` [rad], normalised so the dome's mean
 * luminance equals the tuned clear sky's times `level` (the renderer's sky light level).
 * Below about −6° there is no direct scattering left, so the colour of a −6° sky is kept and only
 * its brightness follows `level` (the night gradient takes over in the shader).
 */
export function buildSkyTable(
  sunElevation: number,
  level: number,
  turbidity = 1,
  table?: SkyTable,
): SkyTable {
  const t: SkyTable = table ?? {
    data: new Float32Array(SKY_LUT_W * SKY_LUT_H * 4),
    horizonMean: [0, 0, 0],
    zenith: [0, 0, 0],
    mean: [0, 0, 0],
  };
  const sunEl = Math.max(sunElevation, (-6 * Math.PI) / 180);
  const px = [0, 0, 0];
  for (let j = 0; j < SKY_LUT_H; j++) {
    const el = lutElevation(j);
    for (let i = 0; i < SKY_LUT_W; i++) {
      skyRadiance(el, lutAzimuth(i), sunEl, turbidity, px);
      const k = 4 * (j * SKY_LUT_W + i);
      t.data[k] = px[0]!;
      t.data[k + 1] = px[1]!;
      t.data[k + 2] = px[2]!;
      t.data[k + 3] = 1;
    }
  }
  // Multiple-scattering fill and the saturation grade, before any means are taken.
  const domeLum = (() => {
    let sum = 0;
    let wsum = 0;
    for (let j = 0; j < SKY_LUT_H; j++) {
      const w = Math.cos(lutElevation(j)) * Math.max(j, 0.25);
      for (let i = 0; i < SKY_LUT_W; i++) {
        const k = 4 * (j * SKY_LUT_W + i);
        sum += w * luminance(t.data[k]!, t.data[k + 1]!, t.data[k + 2]!);
        wsum += w;
      }
    }
    return sum / wsum;
  })();
  const zk = 4 * ((SKY_LUT_H - 1) * SKY_LUT_W);
  const zl = luminance(t.data[zk]!, t.data[zk + 1]!, t.data[zk + 2]!);
  const fill = [0, 1, 2].map((c) => (zl > 0 ? (MULTI_FILL * domeLum * t.data[zk + c]!) / zl : 0));
  for (let k = 0; k < t.data.length; k += 4) {
    const r = t.data[k]! + fill[0]!;
    const g = t.data[k + 1]! + fill[1]!;
    const b = t.data[k + 2]! + fill[2]!;
    const y = luminance(r, g, b);
    t.data[k] = Math.max(0, y + (r - y) * SKY_SATURATION);
    t.data[k + 1] = Math.max(0, y + (g - y) * SKY_SATURATION);
    t.data[k + 2] = Math.max(0, y + (b - y) * SKY_SATURATION);
  }
  // Means: the horizon row (trapezoid over the half circle) and the dome by solid angle
  // (cos elevation × d elevation, with d elevation ∝ v dv for the squared row spacing).
  const mean = (j0: number, j1: number, weightRow: (j: number) => number, out: number[]) => {
    out[0] = out[1] = out[2] = 0;
    let wsum = 0;
    for (let j = j0; j <= j1; j++) {
      const wr = weightRow(j);
      for (let i = 0; i < SKY_LUT_W; i++) {
        const w = wr * (i === 0 || i === SKY_LUT_W - 1 ? 0.5 : 1);
        const k = 4 * (j * SKY_LUT_W + i);
        out[0] += w * t.data[k]!;
        out[1] += w * t.data[k + 1]!;
        out[2] += w * t.data[k + 2]!;
        wsum += w;
      }
    }
    for (let c = 0; c < 3; c++) out[c] = out[c]! / wsum;
  };
  mean(0, 0, () => 1, t.horizonMean);
  mean(0, SKY_LUT_H - 1, (j) => Math.cos(lutElevation(j)) * Math.max(j, 0.25), t.mean);
  const lum = luminance(t.mean[0], t.mean[1], t.mean[2]);
  const scale = lum > 0 ? (TUNED_SKY_LUM * level) / lum : 0;
  for (let k = 0; k < t.data.length; k += 4) {
    t.data[k] = t.data[k]! * scale;
    t.data[k + 1] = t.data[k + 1]! * scale;
    t.data[k + 2] = t.data[k + 2]! * scale;
  }
  for (let c = 0; c < 3; c++) {
    t.horizonMean[c] = t.horizonMean[c]! * scale;
    t.mean[c] = t.mean[c]! * scale;
  }
  const z = 4 * ((SKY_LUT_H - 1) * SKY_LUT_W);
  t.zenith[0] = t.data[z]!;
  t.zenith[1] = t.data[z + 1]!;
  t.zenith[2] = t.data[z + 2]!;
  return t;
}

/**
 * Bilinear sample of the table at `elevation` [rad] (clamped to the horizon) and azimuth
 * `dAz` [rad] from the sun: the same lookup the shader does, for the fog and the lights.
 */
export function sampleSkyTable(
  t: SkyTable,
  elevation: number,
  dAz: number,
  out: number[] = [0, 0, 0],
): number[] {
  let a = Math.abs(dAz) % (2 * Math.PI);
  if (a > Math.PI) a = 2 * Math.PI - a;
  const u = (a / Math.PI) * (SKY_LUT_W - 1);
  const v = Math.sqrt(Math.min(Math.max(elevation, 0), Math.PI / 2) / (Math.PI / 2));
  const y = v * (SKY_LUT_H - 1);
  const i0 = Math.min(Math.floor(u), SKY_LUT_W - 2);
  const j0 = Math.min(Math.floor(y), SKY_LUT_H - 2);
  const fu = u - i0;
  const fv = y - j0;
  for (let c = 0; c < 3; c++) {
    const at = (i: number, j: number) => t.data[4 * (j * SKY_LUT_W + i) + c]!;
    const top = at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu;
    const bot = at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu;
    out[c] = top * (1 - fv) + bot * fv;
  }
  return out;
}
