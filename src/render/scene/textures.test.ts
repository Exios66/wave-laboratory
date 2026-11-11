import { describe, expect, it } from 'vitest';
import { DETAIL_SLOPE_RANGE, surfaceDetailData } from './textures';

describe('surface detail texture', () => {
  const size = 64;
  const data = surfaceDetailData(size);
  const slope = (i: number, c: number) => (data[4 * i + c]! / 255 - 0.5) * 2 * DETAIL_SLOPE_RANGE;

  it('is deterministic', () => {
    expect(surfaceDetailData(size)).toEqual(data);
  });

  it('stores ripple slopes with zero mean and E[sx² + sy²] ≈ 2', () => {
    let mean = 0;
    let ms = 0;
    for (let i = 0; i < size * size; i++) {
      mean += slope(i, 0) + slope(i, 1);
      ms += slope(i, 0) ** 2 + slope(i, 1) ** 2;
    }
    expect(Math.abs(mean / (size * size))).toBeLessThan(0.05);
    expect(ms / (size * size)).toBeGreaterThan(1.8);
    expect(ms / (size * size)).toBeLessThan(2.2);
  });

  it('tiles: the first and last rows and columns join smoothly', () => {
    let seam = 0;
    let inner = 0;
    for (let y = 0; y < size; y++) {
      for (let c = 0; c < 4; c++) {
        seam += Math.abs(data[4 * (y * size) + c]! - data[4 * (y * size + size - 1) + c]!);
        inner += Math.abs(data[4 * (y * size + 1) + c]! - data[4 * (y * size) + c]!);
      }
    }
    expect(seam).toBeLessThan(inner * 1.6);
  });
});
