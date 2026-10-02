import { describe, expect, it } from 'vitest';
import {
  effectiveQuality,
  parsePerformanceMode,
  ResolutionGovernor,
  type DeviceProfile,
} from './deviceProfile';

const weak: DeviceProfile = { maxQuality: 'low', maxPixelRatio: 1, description: '', gpu: '' };
const strong: DeviceProfile = { maxQuality: 'ultra', maxPixelRatio: 2, description: '', gpu: '' };

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
