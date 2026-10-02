/**
 * The night sky's turning star frame and the Milky Way's place in it.
 *
 * The sun path in `lighting.ts` is the celestial equator of an observer at latitude
 * 90° − NOON_ELEVATION_DEG, so the stars turn about a pole that high in the north and
 * keep step with the clock: they rise in the east and set in the west like the sun and moon.
 * One turn per 24 h (solar, not sidereal) keeps the same stars overhead at the same clock time.
 */
import * as THREE from 'three';

/** Latitude implied by the sun path [deg]: 90° − NOON_ELEVATION_DEG in `lighting.ts`. */
export const OBSERVER_LATITUDE_DEG = 30;

/** Same convention as `directionFromAngles` in lighting.ts (which imports this module). */
function directionFromAngles(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
  const elev = THREE.MathUtils.degToRad(elevationDeg);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3(
    Math.sin(az) * Math.cos(elev),
    Math.sin(elev),
    -Math.cos(az) * Math.cos(elev),
  ).normalize();
}

/** Unit vector toward the celestial pole, Three.js axes (due north, latitude-high). */
export const CELESTIAL_POLE = directionFromAngles(OBSERVER_LATITUDE_DEG, 0);

/**
 * Galactic centre and a second point on the galactic plane, both in the star frame. The star
 * frame coincides with the horizon frame at midnight, so these are where they stand at 00:00:
 * the bright core in the north-east and the band arching over the zenith to the west-south-west.
 * The moon here is always near full and fixed among the stars (it sits opposite the sun), so
 * the core is placed some 60° from it; it rises about 20:30 and rides high until dawn.
 */
export const GALACTIC_CENTRE = directionFromAngles(40, 60);
const GALACTIC_SECOND = directionFromAngles(62, 240);
/** Unit normal of the galactic plane (galactic north pole). */
export const GALACTIC_POLE = new THREE.Vector3()
  .crossVectors(GALACTIC_CENTRE, GALACTIC_SECOND)
  .normalize();

const rot = new THREE.Matrix4();

/**
 * Matrix taking a sky direction (Three.js axes) at clock time `hours` into the fixed star
 * frame. The sky turns westward about the pole, so undoing that is a turn of +hours·15°.
 */
export function skyToStars(hours: number, out = new THREE.Matrix3()): THREE.Matrix3 {
  const angle = (((hours % 24) + 24) % 24) * (Math.PI / 12);
  rot.makeRotationAxis(CELESTIAL_POLE, angle);
  return out.setFromMatrix4(rot);
}

/** Sky direction (Three.js axes) of a star-frame direction at clock time `hours`. */
export function starsToSky(
  star: THREE.Vector3,
  hours: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const m = skyToStars(hours).transpose();
  return out.copy(star).applyMatrix3(m);
}
