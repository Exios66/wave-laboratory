/**
 * Fore-and-aft (Bermuda) rig types, the single source shared by the vessel API and the
 * sail-force model (sails.ts imports them here; api.ts re-exports them). Positions are plain
 * x/y/z triples so the data can cross a worker boundary; the frame they live in (CoG or keel)
 * is the caller's choice.
 */

/** Structural x/y/z triple (satisfied by core/vec's Vec3). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface ForeAftSail {
  kind: 'main' | 'jib';
  /** Sail area [m²] and geometric aspect ratio (luff² / area). */
  area: number;
  aspect: number;
  /** Tack (luff foot) and head; the sail trails aft from the luff. */
  tack: Vec3Like;
  head: Vec3Like;
  /** Foot length from tack to clew [m]. */
  foot: number;
}

export interface ForeAftRig {
  mast: { x: number; zFoot: number; zTop: number };
  sails: ForeAftSail[];
  /** Drag area of mast, boom and rigging [m²]. */
  rigDragArea: number;
}
