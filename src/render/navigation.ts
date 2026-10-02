/**
 * Minimap support: camera pose in world axes and the island chart. Pure helpers so the
 * renderer only has to forward to them.
 */
import * as THREE from 'three';
import type { MapIsland, NavigationView } from './api';
import { ISLAND_FOOTPRINT, islandsNear } from './scenery/islands';

const dir = new THREE.Vector3();

/** Compass bearing [0, 360) of a Three.js direction (x east, −z north). */
export function bearingOfThree(x: number, z: number): number {
  const deg = THREE.MathUtils.radToDeg(Math.atan2(x, -z));
  return deg < 0 ? deg + 360 : deg >= 360 ? deg - 360 : deg;
}

/** Camera position and heading in world axes. Looking straight down, heading follows `up`. */
export function cameraNavigation(
  camera: THREE.PerspectiveCamera,
  explore: THREE.Vector3 | null,
): NavigationView {
  camera.getWorldDirection(dir);
  // Straight down (top view) the look direction has no heading: use the camera's up instead.
  if (Math.hypot(dir.x, dir.z) < 0.05) dir.copy(camera.up).applyQuaternion(camera.quaternion);
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  return {
    x: camera.position.x,
    y: -camera.position.z,
    headingDeg: bearingOfThree(dir.x, dir.z),
    fovDeg: THREE.MathUtils.radToDeg(hfov),
    explore: explore ? { x: explore.x, y: -explore.z } : null,
  };
}

/** Islands for the chart, nearest first, capped so a zoomed-out map stays cheap to draw. */
export function chartIslands(x: number, y: number, radius: number, max = 1200): MapIsland[] {
  return islandsNear(x, y, radius)
    .slice(0, max)
    .map((s) => ({
      key: s.key,
      x: s.x,
      y: s.y,
      radius: s.radius,
      reefRadius: s.radius * ISLAND_FOOTPRINT,
      lighthouse: s.lighthouse,
    }));
}
