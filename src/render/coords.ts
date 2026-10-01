/**
 * World (z-up, x east, y north) ↔ three.js (y-up) conversions.
 *
 * docs/PHYSICS.md: world (x, y, z) → three (x, z, −y). This is a proper rotation (−90° about x),
 * so quaternions are converted by rotating their vector part the same way.
 */
import type { Quaternion, Vector3 } from 'three';

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

export interface WXYZ {
  w: number;
  x: number;
  y: number;
  z: number;
}

/** World point/vector (z-up) → three.js (y-up), written into `out`. */
export function worldToThree(x: number, y: number, z: number, out: Vector3): Vector3 {
  return out.set(x, z, -y);
}

/** three.js point/vector (y-up) → world (z-up), written into `out`. */
export function threeToWorld(v: Vector3, out: XYZ): XYZ {
  const x = v.x;
  const y = -v.z;
  const z = v.y;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/**
 * Body→world quaternion (z-up world) → quaternion acting in three.js space.
 * With C the frame change, q' = C q C⁻¹, i.e. the rotation axis is mapped by C.
 */
export function worldQuatToThree(q: WXYZ, out: Quaternion): Quaternion {
  return out.set(q.x, q.z, -q.y, q.w);
}

/** Compass bearing (deg, 0 = north, 90 = east) and elevation (deg) → unit vector in three space. */
export function bearingElevationToThree(
  bearingDeg: number,
  elevationDeg: number,
  out: Vector3,
): Vector3 {
  const az = (bearingDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  // World z-up: x = east = sin(az)cos(el), y = north = cos(az)cos(el), z = sin(el).
  return worldToThree(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el), out);
}
