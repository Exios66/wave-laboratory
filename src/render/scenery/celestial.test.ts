import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  CELESTIAL_POLE,
  GALACTIC_CENTRE,
  GALACTIC_POLE,
  OBSERVER_LATITUDE_DEG,
  skyToStars,
  starsToSky,
} from './celestial';
import { NOON_ELEVATION_DEG, directionFromAngles, moonPositionAt, sunPositionAt } from './lighting';

function sunDir(h: number): THREE.Vector3 {
  const p = sunPositionAt(h);
  return directionFromAngles(p.elevationDeg, p.azimuthDeg);
}

describe('star frame', () => {
  it('turns with the sun, so the sun is fixed among the stars', () => {
    const ref = sunDir(12).applyMatrix3(skyToStars(12));
    for (const h of [0, 3.5, 6, 9, 15, 18, 21.25]) {
      const s = sunDir(h).applyMatrix3(skyToStars(h));
      expect(s.distanceTo(ref)).toBeLessThan(1e-6);
    }
  });

  it('matches the lighting module direction convention', () => {
    expect(CELESTIAL_POLE.distanceTo(directionFromAngles(OBSERVER_LATITUDE_DEG, 0))).toBeLessThan(
      1e-9,
    );
  });

  it('keeps the pole fixed at the observer latitude in the north', () => {
    expect(OBSERVER_LATITUDE_DEG).toBeCloseTo(90 - NOON_ELEVATION_DEG, 6);
    for (const h of [0, 7, 19]) {
      const p = CELESTIAL_POLE.clone().applyMatrix3(skyToStars(h));
      expect(p.distanceTo(CELESTIAL_POLE)).toBeLessThan(1e-6);
    }
  });

  it('round-trips between sky and star frames', () => {
    const d = directionFromAngles(40, 120);
    const back = starsToSky(d.clone().applyMatrix3(skyToStars(22.5)), 22.5);
    expect(back.distanceTo(d)).toBeLessThan(1e-6);
  });
});

describe('Milky Way placement', () => {
  it('has an orthonormal galactic frame', () => {
    expect(GALACTIC_POLE.length()).toBeCloseTo(1, 6);
    expect(GALACTIC_CENTRE.dot(GALACTIC_POLE)).toBeCloseTo(0, 6);
  });

  it('puts the galactic core above the horizon through the night, well clear of the moon', () => {
    for (const h of [22, 0, 3, 5]) {
      const core = starsToSky(GALACTIC_CENTRE, h);
      expect(core.y).toBeGreaterThan(0.15);
      const m = moonPositionAt(h);
      const moon = directionFromAngles(m.elevationDeg, m.azimuthDeg);
      expect(THREE.MathUtils.radToDeg(core.angleTo(moon))).toBeGreaterThan(55);
    }
  });

  it('arches the band high across the night sky', () => {
    // Highest point of the band at midnight: the plane's normal tilts far from the zenith.
    const pole = starsToSky(GALACTIC_POLE, 0);
    expect(Math.abs(pole.y)).toBeLessThan(0.5);
  });
});
