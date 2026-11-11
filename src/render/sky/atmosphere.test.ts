import { describe, expect, it } from 'vitest';
import {
  buildSkyTable,
  luminance,
  sampleSkyTable,
  SKY_LUT_W,
  skyRadiance,
  TUNED_SKY_LUM,
  sunTransmittance,
} from './atmosphere';

const DEG = Math.PI / 180;
const ratio = (c: number[]) => c[2]! / c[0]!; // blue over red

describe('atmosphere', () => {
  it('makes the zenith bluer than the horizon at noon', () => {
    const z = skyRadiance(89 * DEG, 0, 60 * DEG);
    const h = skyRadiance(1 * DEG, 90 * DEG, 60 * DEG);
    expect(ratio(z)).toBeGreaterThan(ratio(h));
    expect(ratio(z)).toBeGreaterThan(1.5);
  });

  it('reddens the horizon toward the sun as it sets', () => {
    const noon = skyRadiance(2 * DEG, 0, 60 * DEG);
    const sunset = skyRadiance(2 * DEG, 0, 1 * DEG);
    expect(ratio(sunset)).toBeLessThan(ratio(noon));
    expect(sunset[0]!).toBeGreaterThan(sunset[2]!);
  });

  it('brightens toward the sun (forward scattering)', () => {
    const toward = skyRadiance(10 * DEG, 0, 15 * DEG);
    const away = skyRadiance(10 * DEG, Math.PI, 15 * DEG);
    expect(luminance(toward[0]!, toward[1]!, toward[2]!)).toBeGreaterThan(
      luminance(away[0]!, away[1]!, away[2]!),
    );
  });

  it('dims and reddens the sunlight at low sun', () => {
    const high = sunTransmittance(60 * DEG);
    const low = sunTransmittance(2 * DEG);
    expect(high[0]!).toBeGreaterThan(0.8);
    expect(low[1]!).toBeLessThan(high[1]!);
    expect(low[0]! / low[2]!).toBeGreaterThan(high[0]! / high[2]!);
    expect(sunTransmittance(-5 * DEG)).toEqual([0, 0, 0]);
  });

  it('normalises the dome mean to the tuned level', () => {
    const t = buildSkyTable(30 * DEG, 0.8);
    const [r, g, b] = t.mean;
    expect(luminance(r, g, b)).toBeCloseTo(TUNED_SKY_LUM * 0.8, 6);
    // Still finite and positive for a sun below the horizon.
    const dusk = buildSkyTable(-10 * DEG, 0.1);
    expect(dusk.data.every((x) => Number.isFinite(x) && x >= 0)).toBe(true);
    expect(luminance(...dusk.horizonMean)).toBeGreaterThan(0);
  });

  it('samples texel centres exactly and is symmetric about the sun', () => {
    const t = buildSkyTable(20 * DEG, 1);
    const c = sampleSkyTable(t, 0, Math.PI);
    const k = 4 * (SKY_LUT_W - 1);
    expect(c[0]).toBeCloseTo(t.data[k]!, 9);
    const a = sampleSkyTable(t, 15 * DEG, 0.7);
    const b = sampleSkyTable(t, 15 * DEG, -0.7);
    expect(a).toEqual(b);
  });
});
