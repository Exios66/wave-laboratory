import { describe, expect, it } from 'vitest';
import { BREAKING_JACOBIAN } from '../ocean/overlays';
import { legendSpec } from './overlayLegend';

const sea = { hs: 2, rho: 1025, g: 9.80665 };

describe('overlay legends', () => {
  it('state quantity, unit and range in text for every overlay', () => {
    for (const mode of [
      'height',
      'steepness',
      'foam',
      'jacobian',
      'velocity',
      'pressure',
      'energy',
    ] as const) {
      const spec = legendSpec(mode, { ...sea, depth: 0 });
      expect(spec.title.length).toBeGreaterThan(3);
      expect(spec.ticks.length).toBeGreaterThanOrEqual(3);
      expect(spec.note.length).toBeGreaterThan(10);
    }
  });

  it('scales velocity, pressure and energy with Hs and says so', () => {
    const calm = legendSpec('pressure', { ...sea, hs: 1, depth: 0 });
    const rough = legendSpec('pressure', { ...sea, hs: 4, depth: 0 });
    expect(rough.ticks.at(-1)).not.toBe(calm.ticks.at(-1));
    expect(calm.ticks.at(-1)).toMatch(/kPa/);
    expect(legendSpec('velocity', { ...sea, depth: 0 }).ticks.at(-1)).toMatch(/m\/s/);
    expect(legendSpec('energy', { ...sea, depth: 0 }).ticks.at(-1)).toMatch(/J\/m²/);
    expect(legendSpec('velocity', { ...sea, depth: 0 }).note).toMatch(/H_s/);
  });

  it('names the depth of the pressure overlay and the instantaneous energy', () => {
    expect(legendSpec('pressure', { ...sea, depth: 5 }).title).toMatch(/5 m/);
    expect(legendSpec('energy', { ...sea, depth: 0 }).note).toMatch(/instantaneous/i);
  });

  it('explains the breaking flag with its threshold', () => {
    expect(legendSpec('jacobian', { ...sea, depth: 0 }).note).toContain(
      BREAKING_JACOBIAN.toFixed(2),
    );
  });
});
