/**
 * Sun shafts (crepuscular rays): where the sun sits on screen, and how strongly its light
 * streams through gaps in the cloud and past masts, islands and hulls (`SunShaftPass` draws them).
 *
 * The rays are light scattered by the air between the viewer and the occluders, so they are
 * strongest:
 *  - with broken cloud: a clear sky has only the rigging and islands to cast them, and full
 *    overcast leaves no direct sun;
 *  - in hazy air (a higher fog density: more scatterers along each ray);
 *  - with the sun in or near the frame. The screen-space method needs the sun's image to blur
 *    from, so the rays fade out as it leaves the view.
 */
import * as THREE from 'three';

export interface ShaftInputs {
  /** Sun direction's vertical component (sine of its elevation). */
  sunY: number;
  /** Cloud cover 0–1. */
  cloud: number;
  /** Exponential fog density of the air [1/m]. */
  fogDensity: number;
  /** Night 0–1 (scenery/lighting.ts). */
  night: number;
  /** Cosine between the view direction and the sun (≤ 0: behind the camera). */
  facing: number;
  /** Sun position on screen (uv, 0–1 inside the frame). */
  x: number;
  y: number;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const scratch = new THREE.Vector3();
const forward = new THREE.Vector3();

/** The sun (a direction, at infinity) on screen: uv and the cosine to the view direction. */
export function sunScreen(
  sunDir: THREE.Vector3,
  camera: THREE.Camera,
): { x: number; y: number; facing: number } {
  camera.getWorldDirection(forward);
  const facing = forward.dot(sunDir);
  scratch.copy(camera.position).addScaledVector(sunDir, 1000).project(camera);
  return { x: scratch.x * 0.5 + 0.5, y: scratch.y * 0.5 + 0.5, facing };
}

/** Strength of the shafts 0–1 (0 skips the pass). */
export function shaftStrength(s: ShaftInputs): number {
  if (s.facing <= 0) return 0;
  const day = smoothstep(-0.03, 0.05, s.sunY) * (1 - Math.min(1, Math.max(0, s.night)));
  const c = Math.min(1, Math.max(0, s.cloud));
  const broken = (0.35 + 0.65 * 4 * c * (1 - c)) * (1 - smoothstep(0.85, 0.98, c));
  const haze = 0.6 + 0.4 * smoothstep(5e-5, 4e-4, s.fogDensity);
  const off = Math.max(Math.abs(s.x - 0.5) - 0.5, Math.abs(s.y - 0.5) - 0.5, 0);
  const frame = 1 - smoothstep(0, 0.35, off);
  const toward = smoothstep(0, 0.2, s.facing);
  return Math.min(1, Math.max(0, day * broken * haze * frame * toward));
}
