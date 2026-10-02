import { describe, expect, it } from 'vitest';
import {
  bearingToScreen,
  compassPoint,
  formatBearing,
  formatDistance,
  formatPosition,
  mapToWorld,
  stepRange,
  worldToMap,
  type MapFrame,
} from './minimapMath';

const north: MapFrame = { cx: 100, cy: -50, range: 1000, radiusPx: 100, upDeg: 0 };

describe('minimap projection', () => {
  it('draws north up and east right when north-up', () => {
    const n = worldToMap(north, 100, 950);
    expect(n.x).toBeCloseTo(0, 9);
    expect(n.y).toBeCloseTo(-100, 9);
    const e = worldToMap(north, 600, -50);
    expect(e.x).toBeCloseTo(50, 9);
    expect(e.y).toBeCloseTo(0, 9);
  });

  it('puts the heading up in heading-up mode', () => {
    const f: MapFrame = { ...north, upDeg: 90 };
    // Due east of the centre should now be straight up.
    const e = worldToMap(f, 1100, -50);
    expect(e.x).toBeCloseTo(0, 9);
    expect(e.y).toBeCloseTo(-100, 9);
    // North is then to the left.
    const n = worldToMap(f, 100, 950);
    expect(n.x).toBeCloseTo(-100, 9);
    expect(n.y).toBeCloseTo(0, 9);
  });

  it('round-trips map and world coordinates at any rotation', () => {
    for (const upDeg of [0, 37, 180, 300]) {
      const f: MapFrame = { ...north, upDeg };
      const p = worldToMap(f, 432, -777);
      const w = mapToWorld(f, p.x, p.y);
      expect(w.x).toBeCloseTo(432, 6);
      expect(w.y).toBeCloseTo(-777, 6);
    }
  });

  it('points a bearing the same way the projection does', () => {
    for (const upDeg of [0, 90, 215]) {
      const f: MapFrame = { ...north, upDeg };
      for (const b of [0, 45, 200]) {
        const p = worldToMap(
          f,
          f.cx + Math.sin((b * Math.PI) / 180) * 500,
          f.cy + Math.cos((b * Math.PI) / 180) * 500,
        );
        const a = bearingToScreen(f, b);
        expect(Math.cos(a) * 50).toBeCloseTo(p.x, 6);
        expect(Math.sin(a) * 50).toBeCloseTo(p.y, 6);
      }
    }
  });
});

describe('minimap controls and labels', () => {
  it('steps through the ranges and clamps at the ends', () => {
    expect(stepRange(1000, 1)).toBe(2000);
    expect(stepRange(1000, -1)).toBe(500);
    expect(stepRange(250, -1)).toBe(250);
    expect(stepRange(8000, 1)).toBe(8000);
    expect(stepRange(1500, -1)).toBe(1000);
  });

  it('formats distances, positions and bearings', () => {
    expect(formatDistance(240.4)).toBe('240 m');
    expect(formatDistance(1500)).toBe('1.5 km');
    expect(formatDistance(12000)).toBe('12 km');
    expect(formatPosition(-120, 1400)).toBe('N 1.4 km · W 120 m');
    expect(formatBearing(5)).toBe('005°');
    expect(formatBearing(359.7)).toBe('000°');
    expect(compassPoint(44)).toBe('NE');
    expect(compassPoint(350)).toBe('N');
  });
});
