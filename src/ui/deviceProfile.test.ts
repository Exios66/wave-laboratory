import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPLAY,
  effectiveQuality,
  parsePerformanceMode,
  resolvePostSettings,
  ResolutionGovernor,
  sanitizeDisplay,
  type DeviceProfile,
} from './deviceProfile';

const weak: DeviceProfile = {
  maxQuality: 'low',
  maxPixelRatio: 1,
  description: '',
  gpu: '',
  software: false,
  mobile: false,
};
const strong: DeviceProfile = {
  maxQuality: 'ultra',
  maxPixelRatio: 2,
  description: '',
  gpu: '',
  software: false,
  mobile: false,
};

describe('effectiveQuality', () => {
  it('caps the requested quality by the device in auto mode', () => {
    expect(effectiveQuality('high', 'auto', weak)).toBe('low');
    expect(effectiveQuality('high', 'auto', strong)).toBe('high');
  });
  it('uses an explicit level as chosen, whatever the device or request', () => {
    expect(effectiveQuality('high', 'ultra', weak)).toBe('ultra');
    expect(effectiveQuality('ultra', 'low', strong)).toBe('low');
  });
  it('reads settings saved by earlier versions', () => {
    expect(parsePerformanceMode('saver')).toBe('low');
    expect(parsePerformanceMode('quality')).toBe('ultra');
    expect(parsePerformanceMode('medium')).toBe('medium');
    expect(parsePerformanceMode('bogus')).toBe('auto');
    expect(parsePerformanceMode(null)).toBe('auto');
  });
});

describe('ResolutionGovernor', () => {
  it('drops resolution when slow and recovers with hysteresis', () => {
    const g = new ResolutionGovernor(0.5, 1, 55);
    for (let i = 0; i < 30; i++) g.frame(1 / 30);
    expect(g.scale).toBeLessThan(1);
    const low = g.scale;
    for (let i = 0; i < 60; i++) g.frame(1 / 60); // 1 s good
    expect(g.scale).toBe(low); // needs 3 good windows
    for (let i = 0; i < 180; i++) g.frame(1 / 60);
    expect(g.scale).toBeGreaterThan(low);
  });
  it('never leaves its bounds', () => {
    const g = new ResolutionGovernor(0.5, 1, 55);
    for (let i = 0; i < 2000; i++) g.frame(1 / 10);
    expect(g.scale).toBeCloseTo(0.5, 9);
  });
});

describe('resolvePostSettings', () => {
  const desktop = { software: false, mobile: false };
  it('blooms on auto only from medium quality on a real desktop GPU', () => {
    expect(resolvePostSettings(DEFAULT_DISPLAY, 'low', desktop).bloom).toBe(false);
    expect(resolvePostSettings(DEFAULT_DISPLAY, 'medium', desktop).bloom).toBe(true);
    expect(resolvePostSettings(DEFAULT_DISPLAY, 'high', desktop).bloom).toBe(true);
    expect(resolvePostSettings(DEFAULT_DISPLAY, 'ultra', desktop).bloom).toBe(true);
  });
  it('keeps auto bloom off on phones and software GPUs', () => {
    expect(
      resolvePostSettings(DEFAULT_DISPLAY, 'high', { software: false, mobile: true }).bloom,
    ).toBe(false);
    expect(
      resolvePostSettings(DEFAULT_DISPLAY, 'high', { software: true, mobile: false }).bloom,
    ).toBe(false);
  });
  it('honours an explicit choice whatever the device', () => {
    const slow = { software: true, mobile: true };
    expect(resolvePostSettings({ ...DEFAULT_DISPLAY, bloom: 'on' }, 'low', slow).bloom).toBe(true);
    expect(resolvePostSettings({ ...DEFAULT_DISPLAY, bloom: 'off' }, 'ultra', desktop).bloom).toBe(
      false,
    );
  });
  it('passes grain and vignette through, off by default', () => {
    expect(resolvePostSettings(DEFAULT_DISPLAY, 'high', desktop)).toMatchObject({
      grain: false,
      vignette: false,
    });
    const on = { bloom: 'off' as const, grain: true, vignette: true };
    expect(resolvePostSettings(on, 'low', desktop)).toEqual({
      bloom: false,
      grain: true,
      vignette: true,
    });
  });
});

describe('sanitizeDisplay', () => {
  it('falls back to defaults for missing or invalid input', () => {
    expect(sanitizeDisplay(null)).toEqual(DEFAULT_DISPLAY);
    expect(sanitizeDisplay('nope')).toEqual(DEFAULT_DISPLAY);
    expect(sanitizeDisplay({ bloom: 'maybe', grain: 'yes', vignette: 1 })).toEqual(DEFAULT_DISPLAY);
  });
  it('keeps valid values', () => {
    expect(sanitizeDisplay({ bloom: 'off', grain: true, vignette: true })).toEqual({
      bloom: 'off',
      grain: true,
      vignette: true,
    });
  });
});
