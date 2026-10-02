/** Unit conversion helpers. Internally everything is SI; these exist for display/input only. */

export const KNOT = 1852 / 3600; // m/s
export const DEG = Math.PI / 180;

export const knotsToMs = (kn: number): number => kn * KNOT;
export const msToKnots = (ms: number): number => ms / KNOT;
export const degToRad = (d: number): number => d * DEG;
export const radToDeg = (r: number): number => r / DEG;

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  let r = a % twoPi;
  if (r <= -Math.PI) r += twoPi;
  else if (r > Math.PI) r -= twoPi;
  return r;
}

/** Beaufort number from 10 m wind speed [m/s] (WMO code 1100 upper limits). */
export function beaufortFromWind(u10: number): number {
  const limits = [0.2, 1.5, 3.3, 5.4, 7.9, 10.7, 13.8, 17.1, 20.7, 24.4, 28.4, 32.6];
  for (let i = 0; i < limits.length; i++) if (u10 <= limits[i]!) return i;
  return 12;
}

/** Representative 10 m wind speed [m/s] at the middle of a Beaufort class. */
export function windFromBeaufort(bf: number): number {
  const mid = [0.1, 0.9, 2.4, 4.4, 6.7, 9.3, 12.3, 15.5, 18.9, 22.6, 26.5, 30.5, 34];
  const i = Math.max(0, Math.min(12, Math.round(bf)));
  return mid[i]!;
}

/** WMO sea state code (0–9) from significant wave height [m]. */
export function wmoSeaState(hs: number): { code: number; label: string } {
  const table: [number, string][] = [
    [0, 'Calm (glassy)'],
    [0.1, 'Calm (rippled)'],
    [0.5, 'Smooth'],
    [1.25, 'Slight'],
    [2.5, 'Moderate'],
    [4, 'Rough'],
    [6, 'Very rough'],
    [9, 'High'],
    [14, 'Very high'],
  ];
  for (let i = 0; i < table.length; i++) {
    // Upper bounds are inclusive (WMO code 3700); tolerate floating-point round-off.
    if (hs <= table[i]![0] * (1 + 1e-6)) return { code: i, label: table[i]![1] };
  }
  return { code: 9, label: 'Phenomenal' };
}
