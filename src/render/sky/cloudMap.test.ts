import { describe, expect, it } from 'vitest';
import { CLOUD_MAP_EXTENT_KM, CLOUD_MAP_SIZE, cloudMapOrigin } from './cloudMap';

const texel = CLOUD_MAP_EXTENT_KM / CLOUD_MAP_SIZE;

describe('cloudMapOrigin', () => {
  it('centres a new map on the eye, on the texel lattice', () => {
    const o = cloudMapOrigin(null, 3.217, -11.05)!;
    expect(o).not.toBeNull();
    expect(Math.abs(o[0] - 3.217)).toBeLessThanOrEqual(texel / 2 + 1e-9);
    expect(Math.abs(o[1] + 11.05)).toBeLessThanOrEqual(texel / 2 + 1e-9);
    expect((o[0] / texel) % 1).toBeCloseTo(0, 6);
    expect(Math.abs((o[1] / texel) % 1)).toBeCloseTo(0, 6);
  });

  it('keeps the map while the eye stays within an eighth of its extent', () => {
    const o: [number, number] = [0, 0];
    expect(cloudMapOrigin(o, CLOUD_MAP_EXTENT_KM / 8 - 0.01, 0)).toBeNull();
    expect(cloudMapOrigin(o, 0, -CLOUD_MAP_EXTENT_KM / 8 + 0.01)).toBeNull();
  });

  it('re-centres once the eye moves further', () => {
    const o: [number, number] = [0, 0];
    const n = cloudMapOrigin(o, CLOUD_MAP_EXTENT_KM / 8 + 0.5, 1)!;
    expect(n).not.toBeNull();
    expect(n[0]).toBeCloseTo(Math.round((CLOUD_MAP_EXTENT_KM / 8 + 0.5) / texel) * texel, 9);
    expect(n[1]).toBeCloseTo(Math.round(1 / texel) * texel, 9);
  });

  it('covers the far fade of the march from any eye it keeps', () => {
    // The march fades distant cloud out by 25 km; the kept map must reach that far.
    expect(CLOUD_MAP_EXTENT_KM / 2 - CLOUD_MAP_EXTENT_KM / 8).toBeGreaterThanOrEqual(25);
  });
});
