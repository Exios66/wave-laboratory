/**
 * Clock → sun angles for the decorative day:night cycle.
 * Artistic mid-latitude day: sunrise ≈ 05:30, noon peak ≈ 72°, sunset ≈ 18:30.
 * Azimuth is a compass bearing toward the sun (0 = north, clockwise), matching Environment.
 */

export interface SunAngles {
  elevationDeg: number;
  azimuthDeg: number;
}

const SUNRISE = 5.5;
const SUNSET = 18.5;
const DAY_LEN = SUNSET - SUNRISE;
const PEAK_ELEV = 72;

/** Wrap clock hours into [0, 24). */
export function wrapHour(hour: number): number {
  return ((hour % 24) + 24) % 24;
}

/** Sun elevation and azimuth from clock time [h]. */
export function sunAnglesFromHour(hour: number): SunAngles {
  const h = wrapHour(hour);
  let elevationDeg: number;
  if (h < SUNRISE || h > SUNSET) {
    // Night: deepest under the horizon near 00:00.
    const midNight = h < SUNRISE ? h + (24 - SUNSET) : h - SUNSET;
    const nightLen = 24 - DAY_LEN;
    const u = nightLen > 0 ? midNight / nightLen : 0;
    elevationDeg = -4 - 14 * Math.sin(Math.min(1, Math.max(0, u)) * Math.PI);
  } else {
    const u = (h - SUNRISE) / DAY_LEN;
    elevationDeg = Math.sin(u * Math.PI) * PEAK_ELEV;
  }
  // East-northeast at sunrise → south at noon → west-northwest at sunset; keep drifting at night.
  const azT = h < SUNRISE ? 0 : h > SUNSET ? 1 : (h - SUNRISE) / DAY_LEN;
  const azimuthDeg = (80 + azT * 200) % 360;
  return { elevationDeg, azimuthDeg };
}

/**
 * Daylight amount 0–1 from sun elevation.
 * Soft twilight band so dawn/dusk still light the sea a little.
 */
export function daylightFromElevation(elevationDeg: number): number {
  return Math.min(1, Math.max(0, (elevationDeg + 6) / 16));
}

/** Format clock hours as HH:MM for the settings UI. */
export function formatClock(hour: number): string {
  const h = wrapHour(hour);
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
