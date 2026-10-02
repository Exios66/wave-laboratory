/** Geometry and formatting for the minimap (pure, so it can be tested without a canvas). */

/** Map radii the zoom buttons step through [m]. */
export const MAP_RANGES = [250, 500, 1000, 2000, 4000, 8000] as const;
export const DEFAULT_RANGE = 1000;

export interface MapFrame {
  /** World point at the centre of the map [m]. */
  cx: number;
  cy: number;
  /** Map radius in world metres, and in CSS pixels. */
  range: number;
  radiusPx: number;
  /** Compass bearing drawn pointing up (0 = north up). */
  upDeg: number;
}

const RAD = Math.PI / 180;

/** World (x east, y north) → map pixels relative to the map centre (x right, y down). */
export function worldToMap(f: MapFrame, x: number, y: number): { x: number; y: number } {
  const s = f.radiusPx / f.range;
  const dx = x - f.cx;
  const dy = y - f.cy;
  const a = f.upDeg * RAD;
  const c = Math.cos(a);
  const n = Math.sin(a);
  // Rotate the world so bearing upDeg points up the screen.
  return { x: (dx * c - dy * n) * s, y: -(dx * n + dy * c) * s };
}

/** Inverse of {@link worldToMap}. */
export function mapToWorld(f: MapFrame, px: number, py: number): { x: number; y: number } {
  const s = f.range / f.radiusPx;
  const a = f.upDeg * RAD;
  const c = Math.cos(a);
  const n = Math.sin(a);
  const u = px * s;
  const v = -py * s;
  return { x: f.cx + u * c + v * n, y: f.cy - u * n + v * c };
}

/** Screen angle (canvas radians, 0 = right, clockwise) of a compass bearing on the map. */
export function bearingToScreen(f: MapFrame, bearingDeg: number): number {
  return (bearingDeg - f.upDeg - 90) * RAD;
}

/** The next map range in or out from `range` (clamped to the list). */
export function stepRange(range: number, dir: 1 | -1): number {
  const i = MAP_RANGES.findIndex((r) => r >= range);
  const at = i < 0 ? MAP_RANGES.length - 1 : i;
  const next = Math.min(MAP_RANGES.length - 1, Math.max(0, at + dir));
  return MAP_RANGES[next]!;
}

export function formatDistance(m: number): string {
  const a = Math.abs(m);
  if (a >= 1000) return `${(m / 1000).toFixed(a >= 10000 ? 0 : 1)} km`;
  return `${Math.round(m)} m`;
}

/** "E 120 m · N 1.4 km" style offset from the lab origin. */
export function formatPosition(x: number, y: number): string {
  const ew = `${x < 0 ? 'W' : 'E'} ${formatDistance(Math.abs(x))}`;
  const ns = `${y < 0 ? 'S' : 'N'} ${formatDistance(Math.abs(y))}`;
  return `${ns} · ${ew}`;
}

/** "045°" */
export function formatBearing(deg: number): string {
  const d = Math.round(((deg % 360) + 360) % 360) % 360;
  return `${String(d).padStart(3, '0')}°`;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export function compassPoint(deg: number): (typeof POINTS)[number] {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return POINTS[i]!;
}
