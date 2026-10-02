/**
 * Vessel-to-vessel collisions in the horizontal plane.
 *
 * Each hull is an oriented rectangle (length × beam about the CoG along the heading). Pairs are
 * culled by bounding circles, then tested with the separating-axis theorem; the axis of least
 * overlap gives the contact normal and the penetration depth. The response is an inelastic
 * impulse along the normal (restitution e) plus Coulomb friction along the hull side, on the
 * displacement masses, and a positional push that separates the hulls in inverse proportion to
 * their masses. Rotation is not exchanged (the impulse acts at the CoG), which keeps momentum
 * exactly conserved and is adequate for glancing and head-on blows at these speeds.
 */
import type { HullFootprint } from '../vessel/api';

/** Coefficient of restitution of a ship–ship impact (steel hulls crumple: nearly plastic). */
export const COLLISION_RESTITUTION = 0.2;
/** Hull-to-hull friction coefficient along the contact. */
export const COLLISION_FRICTION = 0.3;
/** Largest separating push per step [m] (deep overlaps resolve over a few steps). */
export const MAX_PUSH = 1;

export interface Contact {
  /** Unit normal from hull a to hull b. */
  nx: number;
  ny: number;
  /** Penetration depth along the normal [m]. */
  depth: number;
  /** Contact point (world) [m]. */
  x: number;
  y: number;
}

export interface CollisionResponse {
  /** Impulse on b [N·s] (a receives the opposite). */
  jx: number;
  jy: number;
  /** Separating displacements [m]. */
  pushA: { x: number; y: number };
  pushB: { x: number; y: number };
  /** Kinetic energy dissipated by the impact [J]. */
  energy: number;
  /** Closing speed along the normal before the impact [m/s] (0 when already separating). */
  closingSpeed: number;
}

function corners(f: HullFootprint): [number, number][] {
  const sx = -f.fy;
  const sy = f.fx;
  const out: [number, number][] = [];
  for (const [a, b] of [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ] as const) {
    out.push([
      f.x + a * f.halfLength * f.fx + b * f.halfBeam * sx,
      f.y + a * f.halfLength * f.fy + b * f.halfBeam * sy,
    ]);
  }
  return out;
}

function inside(f: HullFootprint, px: number, py: number): boolean {
  const dx = px - f.x;
  const dy = py - f.y;
  const along = dx * f.fx + dy * f.fy;
  const across = -dx * f.fy + dy * f.fx;
  return Math.abs(along) <= f.halfLength + 1e-9 && Math.abs(across) <= f.halfBeam + 1e-9;
}

/** Overlap of two hull rectangles, or null when they do not touch. */
export function footprintContact(a: HullFootprint, b: HullFootprint): Contact | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Broad phase: bounding circles.
  const r = Math.hypot(a.halfLength, a.halfBeam) + Math.hypot(b.halfLength, b.halfBeam);
  if (dx * dx + dy * dy > r * r) return null;
  // Narrow phase: separating axes (the two hulls' forward and side directions).
  const axes: [number, number][] = [
    [a.fx, a.fy],
    [-a.fy, a.fx],
    [b.fx, b.fy],
    [-b.fy, b.fx],
  ];
  let best = Infinity;
  let nx = 0;
  let ny = 0;
  for (const [ax, ay] of axes) {
    const ra =
      a.halfLength * Math.abs(a.fx * ax + a.fy * ay) +
      a.halfBeam * Math.abs(-a.fy * ax + a.fx * ay);
    const rb =
      b.halfLength * Math.abs(b.fx * ax + b.fy * ay) +
      b.halfBeam * Math.abs(-b.fy * ax + b.fx * ay);
    const d = dx * ax + dy * ay;
    const overlap = ra + rb - Math.abs(d);
    if (overlap <= 0) return null;
    if (overlap < best) {
      best = overlap;
      const s = d >= 0 ? 1 : -1;
      nx = s * ax;
      ny = s * ay;
    }
  }
  // Contact point: mean of the corners of each hull inside the other (midpoint as fallback).
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const [px, py] of corners(a)) {
    if (inside(b, px, py)) {
      cx += px;
      cy += py;
      n++;
    }
  }
  for (const [px, py] of corners(b)) {
    if (inside(a, px, py)) {
      cx += px;
      cy += py;
      n++;
    }
  }
  if (n === 0) {
    cx = (a.x + b.x) / 2;
    cy = (a.y + b.y) / 2;
  } else {
    cx /= n;
    cy /= n;
  }
  return { nx, ny, depth: best, x: cx, y: cy };
}

/** Impulse, push and dissipated energy for a contact between a and b. */
export function resolveContact(
  a: HullFootprint,
  b: HullFootprint,
  c: Contact,
  restitution = COLLISION_RESTITUTION,
  friction = COLLISION_FRICTION,
): CollisionResponse {
  const wa = 1 / a.mass;
  const wb = 1 / b.mass;
  const w = wa + wb;
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const vn = rvx * c.nx + rvy * c.ny;
  let jx = 0;
  let jy = 0;
  if (vn < 0) {
    // Normal impulse brings the closing speed to −e·vn.
    const jn = (-(1 + restitution) * vn) / w;
    // Friction opposes the sliding velocity, at most stopping it, at most μ·jn.
    const tx = -c.ny;
    const ty = c.nx;
    const vt = rvx * tx + rvy * ty;
    const jt = Math.max(-friction * jn, Math.min(friction * jn, -vt / w));
    jx = jn * c.nx + jt * tx;
    jy = jn * c.ny + jt * ty;
  }
  // Kinetic energy before − after (exact for the applied impulse).
  const ke = (m: number, x: number, y: number) => 0.5 * m * (x * x + y * y);
  const before = ke(a.mass, a.vx, a.vy) + ke(b.mass, b.vx, b.vy);
  const after =
    ke(a.mass, a.vx - jx * wa, a.vy - jy * wa) + ke(b.mass, b.vx + jx * wb, b.vy + jy * wb);
  const push = Math.min(c.depth, MAX_PUSH);
  const fa = (push * wa) / w;
  const fb = (push * wb) / w;
  return {
    jx,
    jy,
    pushA: { x: -fa * c.nx, y: -fa * c.ny },
    pushB: { x: fb * c.nx, y: fb * c.ny },
    energy: Math.max(0, before - after),
    closingSpeed: Math.max(0, -vn),
  };
}
