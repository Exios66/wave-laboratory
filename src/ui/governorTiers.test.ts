import { describe, expect, it } from 'vitest';
import { lowerQuality, ResolutionGovernor } from './deviceProfile';

/** Feed `seconds` of frames at a fixed rate; returns the tier changes. */
function run(g: ResolutionGovernor, seconds: number, fps: number) {
  const log: { t: number; tier: number }[] = [];
  for (let i = 0; i < seconds * fps; i++) {
    if (g.frame(1 / fps) && g.tierChanged) log.push({ t: i / fps, tier: g.tierSteps });
  }
  return log;
}

function make(max = 3): ResolutionGovernor {
  const g = new ResolutionGovernor(0.5, 1, 55);
  g.tierEnabled = true;
  g.maxTierSteps = max;
  return g;
}

describe('ResolutionGovernor quality tiers', () => {
  it('never touches the tier unless enabled', () => {
    const g = new ResolutionGovernor(0.5, 1, 55);
    g.maxTierSteps = 3;
    run(g, 120, 10);
    expect(g.tierSteps).toBe(0);
    expect(g.scale).toBe(0.5);
  });

  it('lowers resolution first, then drops tiers one at a time down to the limit', () => {
    const g = make();
    const log = run(g, 200, 10);
    expect(log.map((l) => l.tier)).toEqual([1, 2, 3]);
    expect(g.tierSteps).toBe(3);
    expect(log[0]!.t).toBeGreaterThan(5);
  });

  it('recovers slowly after the device speeds up, one tier per long good run', () => {
    const g = make();
    run(g, 60, 10);
    expect(g.tierSteps).toBe(3);
    const log = run(g, 200, 60);
    expect(log.map((l) => l.tier)).toEqual([2, 1, 0]);
    expect(log[0]!.t).toBeGreaterThanOrEqual(19);
  });

  it('does not flip-flop on a device that only fits the lower tier', () => {
    const g = make(1);
    const changes: number[] = [];
    for (let sec = 0; sec < 1200; sec++) {
      const fps = g.tierSteps === 0 ? 30 : 60;
      for (let i = 0; i < fps; i++) if (g.frame(1 / fps) && g.tierChanged) changes.push(sec);
    }
    // Retries back off (20, 40, 80, 160 s waits): about one retry per 3 minutes once backed off.
    expect(changes.length).toBeLessThanOrEqual(22);
    expect(changes.filter((s) => s > 600).length).toBeLessThanOrEqual(8);
  });

  it('steps back up on a capped stream that drops an odd frame (windows at 90 % count)', () => {
    const g = new ResolutionGovernor(0.5, 1, 30);
    g.tierEnabled = true;
    g.maxTierSteps = 2;
    run(g, 40, 8);
    expect(g.tierSteps).toBe(2);
    // 28 fps against a 30 fps cap: below the 98 % bar of the scale logic, above 90 %.
    const log = run(g, 200, 28);
    expect(log.map((l) => l.tier)).toEqual([1, 0]);
  });

  it('holds steady at the target with no change at all', () => {
    const g = make();
    expect(run(g, 300, 56)).toEqual([]);
    expect(g.scale).toBe(1);
  });

  it('ignores a one-off hitch', () => {
    const g = make();
    run(g, 5, 56);
    run(g, 1, 10);
    run(g, 20, 56);
    expect(g.tierSteps).toBe(0);
  });

  it('can be reset', () => {
    const g = make();
    run(g, 60, 10);
    g.resetTier();
    expect(g.tierSteps).toBe(0);
  });
});

describe('lowerQuality', () => {
  it('steps down and stops at low', () => {
    expect(lowerQuality('ultra', 1)).toBe('high');
    expect(lowerQuality('high', 5)).toBe('low');
    expect(lowerQuality('medium', 0)).toBe('medium');
  });
});
