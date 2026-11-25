import { describe, expect, it } from 'vitest';
import { ResolutionGovernor } from './deviceProfile';
import { FramePacer, frameCapFor, governorTarget, NO_SIGNALS, shouldRun } from './framePacing';

describe('frameCapFor', () => {
  it('is uncapped by default', () => expect(frameCapFor(NO_SIGNALS)).toBe(0));
  it('caps on save-data, software rendering and a low unplugged battery', () => {
    expect(frameCapFor({ ...NO_SIGNALS, saveData: true })).toBe(30);
    expect(frameCapFor({ ...NO_SIGNALS, software: true })).toBe(30);
    expect(frameCapFor({ ...NO_SIGNALS, batteryLevel: 0.15, charging: false })).toBe(30);
  });
  it('does not cap a low battery that is charging, or a healthy one', () => {
    expect(frameCapFor({ ...NO_SIGNALS, batteryLevel: 0.1, charging: true })).toBe(0);
    expect(frameCapFor({ ...NO_SIGNALS, batteryLevel: 0.6, charging: false })).toBe(0);
  });
});

describe('FramePacer', () => {
  const run = (cap: number, hz: number, seconds: number, jitter = 0) => {
    const p = new FramePacer(cap);
    let n = 0;
    for (let i = 0; i < hz * seconds; i++) {
      const j = jitter ? (((i * 7919) % 100) / 100) * jitter : 0;
      if (p.accept((i * 1000) / hz + j)) n++;
    }
    return n / seconds;
  };
  it('passes everything when uncapped', () => expect(run(0, 60, 2)).toBe(60));
  it('holds 30 fps on 60 Hz and 144 Hz displays, with jitter', () => {
    expect(run(30, 60, 4)).toBeCloseTo(30, 0);
    expect(run(30, 60, 4, 2)).toBeGreaterThan(28);
    expect(run(30, 60, 4, 2)).toBeLessThan(32);
    expect(run(30, 144, 4)).toBeGreaterThan(28);
    expect(run(30, 144, 4)).toBeLessThan(32);
  });
  it('does not burst to catch up after a stall', () => {
    const p = new FramePacer(30);
    p.accept(0);
    expect(p.accept(5000)).toBe(true);
    expect(p.accept(5016)).toBe(false);
  });
});

describe('shouldRun', () => {
  it('needs a visible tab and an on-screen canvas', () => {
    expect(shouldRun(false, true)).toBe(true);
    expect(shouldRun(true, true)).toBe(false);
    expect(shouldRun(false, false)).toBe(false);
  });
});

describe('capped frames and the resolution governor', () => {
  it('does not downscale a healthy 30 fps cap when the target follows the cap', () => {
    const g = new ResolutionGovernor(0.5, 1, governorTarget(55, 30));
    for (let i = 0; i < 300; i++) g.frame(1 / 30);
    expect(g.scale).toBe(1);
    const bad = new ResolutionGovernor(0.5, 1, 55);
    for (let i = 0; i < 300; i++) bad.frame(1 / 30);
    expect(bad.scale).toBeLessThan(1);
  });
});
