/**
 * Temporal antialiasing, the parts that need no GPU: the sub-pixel jitter sequence, how to undo
 * it in texture space, when the camera has cut (history must be dropped), and how much history
 * to keep at a given distance. `TaaPass` uses them; they are tested in node.
 *
 * The reprojection is camera-only (there are no motion vectors), so history is kept only where
 * that is a fair guess: far from the eye. The near field (a ship's deck under the bridge camera)
 * shows the current frame alone, and the renderer skips TAA where whole subjects move with the
 * camera (the Plane view) or the depth buffer is in use downstream (underwater).
 */
import * as THREE from 'three';

/** Jitter positions per cycle. */
export const TAA_JITTER_SAMPLES = 8;

/** Radical inverse of `index` in `base` (the Halton sequence). */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

const JITTER: readonly (readonly [number, number])[] = (() => {
  const raw = Array.from({ length: TAA_JITTER_SAMPLES }, (_, k) => [
    halton(k + 1, 2),
    halton(k + 1, 3),
  ]);
  const mx = raw.reduce((s, p) => s + p[0]!, 0) / raw.length;
  const my = raw.reduce((s, p) => s + p[1]!, 0) / raw.length;
  return raw.map((p) => [p[0]! - mx, p[1]! - my] as const);
})();

/** Sub-pixel offset [px] for frame `frame`: Halton(2,3), centred so the cycle averages to 0. */
export function jitterOffset(frame: number): [number, number] {
  const n = TAA_JITTER_SAMPLES;
  const p = JITTER[((frame % n) + n) % n]!;
  return [p[0], p[1]];
}

/**
 * The texture-space shift that takes a pixel of a frame drawn with
 * `camera.setViewOffset(w, h, jx, jy, w, h)` back to where the unjittered camera sees it.
 */
export function unjitterUv(
  jitterPx: readonly [number, number],
  w: number,
  h: number,
): [number, number] {
  return [jitterPx[0] / w, -jitterPx[1] / h];
}

/** What the cut test needs of a camera: where it is, which way it looks, its vertical FOV [deg]. */
export interface CameraSnapshot {
  position: readonly [number, number, number];
  /** Unit view direction. */
  forward: readonly [number, number, number];
  fov: number;
}

/** A turn sharper than this between two frames is a cut [deg]. */
const CUT_TURN_DEG = 10;
/** A jump longer than this between two frames is a cut [m]. */
const CUT_JUMP_M = 30;
/** A field-of-view change beyond this fraction is a cut. */
const CUT_ZOOM = 0.05;

/**
 * Whether the view changed so much between frames that last frame's picture says nothing about
 * this one: a camera switch, a teleport or a snap zoom. A backstop; switches also reset directly.
 */
export function isCameraCut(prev: CameraSnapshot, next: CameraSnapshot): boolean {
  const [ax, ay, az] = prev.forward;
  const [bx, by, bz] = next.forward;
  const cos = (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz));
  if (cos < Math.cos((CUT_TURN_DEG * Math.PI) / 180)) return true;
  const [px, py, pz] = prev.position;
  const [qx, qy, qz] = next.position;
  if (Math.hypot(qx - px, qy - py, qz - pz) > CUT_JUMP_M) return true;
  return Math.abs(next.fov - prev.fov) > CUT_ZOOM * prev.fov;
}

/** Distance [m] below which only the current frame is shown, and above which history is full. */
export const HISTORY_NEAR_M = 5;
export const HISTORY_FAR_M = 40;
/** Share of the history in the blend far away (the classic 0.1 of the current frame). */
export const HISTORY_MAX = 0.9;

/** How much history to keep for a pixel `viewDistanceM` metres from the eye. */
export function historyWeight(viewDistanceM: number): number {
  const t = Math.min(
    1,
    Math.max(0, (viewDistanceM - HISTORY_NEAR_M) / (HISTORY_FAR_M - HISTORY_NEAR_M)),
  );
  return HISTORY_MAX * t * t * (3 - 2 * t);
}

const ndcScratch = new THREE.Vector4();

/**
 * Where a pixel of this frame was in the previous frame's image [uv], or null when it was
 * behind that camera. TaaPass's resolve shader mirrors this.
 *
 * The world position belongs to the pixel itself (`uv`, unjittered matrices), so a still camera
 * reads its history from the very same pixel every frame. Its depth is read where the jittered
 * frame drew that pixel (`uv - jitterUv`). Reprojecting the jittered sample position instead
 * shifts the history lookup by a different jitter each frame, and the history blurs.
 */
export function historyUv(
  uv: readonly [number, number],
  depthAt: (u: number, v: number) => number,
  invViewProj: THREE.Matrix4,
  prevViewProj: THREE.Matrix4,
  jitterUv: readonly [number, number],
  reversed: boolean,
): [number, number] | null {
  const d = depthAt(uv[0] - jitterUv[0], uv[1] - jitterUv[1]);
  const p = ndcScratch.set(uv[0] * 2 - 1, uv[1] * 2 - 1, reversed ? d : d * 2 - 1, 1);
  p.applyMatrix4(invViewProj);
  if (Math.abs(p.w) <= 1e-9) return null;
  p.set(p.x / p.w, p.y / p.w, p.z / p.w, 1).applyMatrix4(prevViewProj);
  if (p.w <= 1e-6) return null;
  return [(p.x / p.w) * 0.5 + 0.5, (p.y / p.w) * 0.5 + 0.5];
}
