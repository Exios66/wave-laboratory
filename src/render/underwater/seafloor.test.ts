import { describe, expect, it } from 'vitest';
import { WATER_TYPES } from '../../ocean/waterTypes';
import {
  CAMERA_MAX_DEPTH,
  CAMERA_MIN_DEPTH,
  countDraws,
  depthGrade,
  floorDepthAt,
  floorModeAt,
  maxCameraDepth,
  maxCameraDepthAt,
  REEF_INFLUENCE,
  REEF_LAGOON,
  REEF_SLOPE,
  reefDepthAt,
  refractedSunDirection,
  seafloorMode,
  SHELF_MAX_DEPTH,
  shelfRelief,
  UNDERWATER_BUDGET,
  underwaterDraws,
  underwaterRays,
} from './seafloor';

describe('seafloor follows env.depth', () => {
  it('sits at env.depth plus bounded relief on a shelf', () => {
    for (const envDepth of [3, 10, 25, 60]) {
      const r = shelfRelief(envDepth);
      for (let i = 0; i < 400; i++) {
        const x = Math.sin(i * 12.9) * 900;
        const y = Math.cos(i * 7.7) * 900;
        const d = floorDepthAt(x, y, envDepth)!;
        expect(d).toBeGreaterThanOrEqual(envDepth - r - 1e-9);
        expect(d).toBeLessThanOrEqual(envDepth + r + 1e-9);
      }
    }
  });

  it('is blue water (no floor) beyond the shelf limit', () => {
    expect(seafloorMode(SHELF_MAX_DEPTH)).toBe('shelf');
    expect(seafloorMode(SHELF_MAX_DEPTH + 1)).toBe('blue');
    expect(seafloorMode(4000)).toBe('blue');
    expect(floorDepthAt(10, 20, 4000)).toBeNull();
    expect(floorDepthAt(10, 20, 30)).not.toBeNull();
  });

  it('keeps the camera clamp above the shallowest floor and within view limits', () => {
    for (const envDepth of [2, 5, 12, 20, 40, 60]) {
      const cam = maxCameraDepth(envDepth);
      expect(cam).toBeGreaterThanOrEqual(CAMERA_MIN_DEPTH);
      expect(cam).toBeLessThanOrEqual(CAMERA_MAX_DEPTH);
      if (envDepth >= 5) {
        let shallowest = Infinity;
        for (let i = 0; i < 2000; i++) {
          const d = floorDepthAt(Math.sin(i * 3.1) * 2000, Math.cos(i * 1.7) * 2000, envDepth)!;
          shallowest = Math.min(shallowest, d);
        }
        expect(cam).toBeLessThan(shallowest);
      }
    }
    expect(maxCameraDepth(4000)).toBe(CAMERA_MAX_DEPTH);
  });
});

describe('underwater draw budget', () => {
  it('never exceeds the per-tier cap in either mode', () => {
    for (const tier of ['lite', 'mid', 'full'] as const) {
      for (const mode of ['shelf', 'blue'] as const) {
        const n = countDraws(underwaterDraws(tier, mode));
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(UNDERWATER_BUDGET[tier]);
      }
    }
    expect(UNDERWATER_BUDGET).toEqual({ full: 6, mid: 3, lite: 1 });
  });

  it('drops the floor layers in blue water and keeps particulate', () => {
    const d = underwaterDraws('full', 'blue');
    expect(d.seabed || d.plants || d.hard || d.wrecks).toBe(false);
    expect(d.particles).toBe(true);
    expect(underwaterDraws('lite', 'shelf')).toMatchObject({ seabed: true, particles: false });
  });
});

describe('light', () => {
  it('refracts the sun toward the vertical (Snell)', () => {
    const sun = [Math.sin(1), Math.cos(1), 0] as const; // 57° from vertical
    const dir = refractedSunDirection(sun);
    expect(Math.hypot(...dir)).toBeCloseTo(1, 9);
    const sinW = Math.hypot(dir[0], dir[2]);
    expect(sinW).toBeCloseTo(Math.sin(1) / 1.333, 6);
    // Travels away from the sun horizontally, and downward.
    expect(dir[0]).toBeLessThan(0);
    expect(dir[1]).toBeLessThan(0);
    expect(refractedSunDirection([0, 1, 0])).toEqual([0, -1, 0]);
    expect(refractedSunDirection([1, -0.2, 0])).toEqual([0, -1, 0]);
  });

  it('scales god rays with daylight and sun height, and fades with depth', () => {
    const noon = underwaterRays([0, 1, 0], 1, 3, 0.05);
    const night = underwaterRays([0, 1, 0], 0, 3, 0.05);
    const low = underwaterRays([0.99, 0.1, 0], 1, 3, 0.05);
    const deep = underwaterRays([0, 1, 0], 1, 40, 0.3);
    expect(noon.strength).toBeGreaterThan(0.7);
    expect(night.strength).toBe(0);
    expect(low.strength).toBeLessThan(noon.strength);
    expect(deep.strength).toBeLessThan(noon.strength);
  });

  it('grades toward blue-green and loses saturation with depth', () => {
    const kd = WATER_TYPES['oceanic-i'].attenuation;
    const shallow = depthGrade(kd, 1);
    const deep = depthGrade(kd, 40);
    expect(deep.saturation).toBeLessThan(shallow.saturation);
    expect(deep.saturation).toBeGreaterThanOrEqual(0.6);
    expect(Math.max(...deep.tint)).toBeCloseTo(1, 9);
    expect(deep.tint[0]).toBeLessThan(deep.tint[2]);
    expect(depthGrade(kd, 0).tint).toEqual([1, 1, 1]);
  });
});

describe('island reefs in deep water', () => {
  const reef = { x: 1000, y: 500, radius: 40 };
  const lagoon = reef.radius * REEF_LAGOON;

  it('is shallow in the lagoon and shelves away at the reef slope', () => {
    expect(reefDepthAt(reef.x, reef.y, reef)).toBeCloseTo(1.5, 9);
    expect(reefDepthAt(reef.x + lagoon, reef.y, reef)).toBeCloseTo(4, 9);
    expect(reefDepthAt(reef.x + lagoon + 100, reef.y, reef)).toBeCloseTo(4 + REEF_SLOPE * 100, 9);
    expect(reefDepthAt(reef.x + lagoon + REEF_INFLUENCE + 1, reef.y, reef)).toBeNull();
  });

  it('keeps the open ocean blue and gives a floor only near a reef', () => {
    expect(floorDepthAt(0, 0, 4000, [reef])).toBeNull();
    expect(floorModeAt(0, 0, 4000, [reef])).toBe('blue');
    const near = floorDepthAt(reef.x + lagoon + 50, reef.y, 4000, [reef])!;
    expect(near).toBeGreaterThan(4);
    expect(near).toBeLessThan(15);
    expect(floorModeAt(reef.x + lagoon + 50, reef.y, 4000, [reef])).toBe('shelf');
    // No islands (ambience off): exactly the current blue water.
    expect(floorDepthAt(reef.x + lagoon + 50, reef.y, 4000, [])).toBeNull();
  });

  it('clamps the camera above the reef floor and leaves open water alone', () => {
    const x = reef.x + lagoon + 20;
    const cam = maxCameraDepthAt(x, reef.y, 4000, [reef]);
    expect(cam).toBeGreaterThanOrEqual(CAMERA_MIN_DEPTH);
    expect(cam).toBeLessThan(floorDepthAt(x, reef.y, 4000, [reef])!);
    expect(maxCameraDepthAt(0, 0, 4000, [reef])).toBe(CAMERA_MAX_DEPTH);
  });
});
