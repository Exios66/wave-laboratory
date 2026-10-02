import { describe, expect, it } from 'vitest';
import { daylightFromElevation, formatClock, sunAnglesFromHour, wrapHour } from './sun';

describe('wrapHour', () => {
  it('wraps negative and large values into [0, 24)', () => {
    expect(wrapHour(-1)).toBe(23);
    expect(wrapHour(24)).toBe(0);
    expect(wrapHour(25.5)).toBe(1.5);
  });
});

describe('sunAnglesFromHour', () => {
  it('puts the sun below the horizon at midnight', () => {
    expect(sunAnglesFromHour(0).elevationDeg).toBeLessThan(-5);
  });
  it('peaks near noon', () => {
    const noon = sunAnglesFromHour(12);
    const morning = sunAnglesFromHour(8);
    const afternoon = sunAnglesFromHour(16);
    expect(noon.elevationDeg).toBeGreaterThan(60);
    expect(noon.elevationDeg).toBeGreaterThan(morning.elevationDeg);
    expect(noon.elevationDeg).toBeGreaterThan(afternoon.elevationDeg);
  });
  it('rises in the east and sets in the west', () => {
    const rise = sunAnglesFromHour(5.5);
    const set = sunAnglesFromHour(18.5);
    expect(rise.azimuthDeg).toBeGreaterThan(70);
    expect(rise.azimuthDeg).toBeLessThan(100);
    expect(set.azimuthDeg).toBeGreaterThan(250);
    expect(set.azimuthDeg).toBeLessThan(300);
    expect(Math.abs(rise.elevationDeg)).toBeLessThan(2);
    expect(Math.abs(set.elevationDeg)).toBeLessThan(2);
  });
  it('moves the azimuth continuously through the day', () => {
    let last = sunAnglesFromHour(6).azimuthDeg;
    for (let h = 6.5; h <= 18; h += 0.5) {
      const az = sunAnglesFromHour(h).azimuthDeg;
      expect(az).toBeGreaterThanOrEqual(last - 1e-9);
      last = az;
    }
  });
});

describe('daylightFromElevation', () => {
  it('is full day at high sun and dark below the horizon', () => {
    expect(daylightFromElevation(40)).toBe(1);
    expect(daylightFromElevation(-10)).toBe(0);
    expect(daylightFromElevation(2)).toBeGreaterThan(0.4);
    expect(daylightFromElevation(2)).toBeLessThan(1);
  });
});

describe('formatClock', () => {
  it('formats hours as HH:MM', () => {
    expect(formatClock(10)).toBe('10:00');
    expect(formatClock(9.5)).toBe('09:30');
    expect(formatClock(0.0166)).toBe('00:00');
  });
});
