import { describe, expect, it } from 'vitest';
import {
  NOON_ELEVATION_DEG,
  directionFromAngles,
  moonPositionAt,
  skyLightLevel,
  skyMood,
  sunPositionAt,
} from './lighting';

describe('sunPositionAt', () => {
  it('rises in the east at 06:00, peaks in the south at noon and sets in the west at 18:00', () => {
    const rise = sunPositionAt(6);
    expect(rise.elevationDeg).toBeCloseTo(0, 6);
    expect(rise.azimuthDeg).toBeCloseTo(90, 6);
    const noon = sunPositionAt(12);
    expect(noon.elevationDeg).toBeCloseTo(NOON_ELEVATION_DEG, 6);
    expect(noon.azimuthDeg).toBeCloseTo(180, 6);
    const set = sunPositionAt(18);
    expect(set.elevationDeg).toBeCloseTo(0, 6);
    expect(set.azimuthDeg).toBeCloseTo(270, 6);
  });

  it('is below the horizon at night, lowest in the north at midnight', () => {
    const midnight = sunPositionAt(0);
    expect(midnight.elevationDeg).toBeCloseTo(-NOON_ELEVATION_DEG, 6);
    expect(Math.min(midnight.azimuthDeg, 360 - midnight.azimuthDeg)).toBeCloseTo(0, 6);
    for (const h of [19, 22, 2, 5]) expect(sunPositionAt(h).elevationDeg).toBeLessThan(0);
    for (const h of [7, 9, 15, 17]) expect(sunPositionAt(h).elevationDeg).toBeGreaterThan(0);
  });

  it('sweeps east → south → west through the day and wraps the clock', () => {
    const az = [7, 9, 11, 13, 15, 17].map((h) => sunPositionAt(h).azimuthDeg);
    for (let i = 1; i < az.length; i++) expect(az[i]!).toBeGreaterThan(az[i - 1]!);
    expect(az[0]!).toBeGreaterThan(90);
    expect(az[az.length - 1]!).toBeLessThan(270);
    expect(sunPositionAt(36).elevationDeg).toBeCloseTo(sunPositionAt(12).elevationDeg, 9);
    expect(sunPositionAt(-6).azimuthDeg).toBeCloseTo(sunPositionAt(18).azimuthDeg, 9);
  });

  it('is symmetric about noon', () => {
    for (const d of [1, 3, 5.5]) {
      const am = sunPositionAt(12 - d);
      const pm = sunPositionAt(12 + d);
      expect(am.elevationDeg).toBeCloseTo(pm.elevationDeg, 9);
      expect(am.azimuthDeg + pm.azimuthDeg).toBeCloseTo(360, 6);
    }
  });
});

describe('moonPositionAt', () => {
  it('is up at night and down at midday', () => {
    expect(moonPositionAt(0).elevationDeg).toBeGreaterThan(45);
    expect(moonPositionAt(12).elevationDeg).toBeLessThan(-45);
  });
});

describe('directionFromAngles', () => {
  it('maps compass bearings to Three.js axes (north = −z, east = +x)', () => {
    const north = directionFromAngles(0, 0);
    expect(north.z).toBeCloseTo(-1, 9);
    const east = directionFromAngles(0, 90);
    expect(east.x).toBeCloseTo(1, 9);
    const zenith = directionFromAngles(90, 123);
    expect(zenith.y).toBeCloseTo(1, 9);
    expect(directionFromAngles(30, 200).length()).toBeCloseTo(1, 9);
  });
});

describe('skyMood', () => {
  it('goes from full day to deep night as the sun sets', () => {
    const day = skyMood(40);
    expect(day.daylight).toBe(1);
    expect(day.night).toBe(0);
    expect(day.stars).toBe(0);
    const night = skyMood(-40);
    expect(night.daylight).toBe(0);
    expect(night.night).toBe(1);
    expect(night.stars).toBe(1);
  });

  it('glows golden around sunset but not at noon or midnight', () => {
    expect(skyMood(2).dusk).toBeGreaterThan(0.7);
    expect(skyMood(45).dusk).toBe(0);
    expect(skyMood(-40).dusk).toBe(0);
  });

  it('daylight is monotonic in sun elevation', () => {
    let prev = -1;
    for (let e = -30; e <= 30; e += 1) {
      const d = skyMood(e).daylight;
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe('skyLightLevel', () => {
  it('matches the weather sky curve by day and in fixed-sun mode', () => {
    expect(skyLightLevel(1, 0, 0)).toBe(1);
    expect(skyLightLevel(0, 0, 0)).toBeCloseTo(0.25, 9);
    expect(skyLightLevel(-0.5, 0, 0)).toBeCloseTo(0.08, 9);
  });

  it('keeps a moonlight floor at night and brightens the golden hour', () => {
    expect(skyLightLevel(-0.8, 1, 0)).toBeCloseTo(0.22, 9);
    expect(skyLightLevel(0, 0, 1)).toBeCloseTo(0.5, 9);
  });
});
