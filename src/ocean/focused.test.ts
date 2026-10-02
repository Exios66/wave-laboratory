import { describe, expect, it } from 'vitest';
import type { WaveSystem } from '../schema/experiment';
import { env } from '../test/fixtures';
import { OceanField } from './oceanField';
import { FOCUSED_COMPONENTS, resolveSea } from './systems';

const rogue = (o: Partial<Extract<WaveSystem, { kind: 'focused' }>> = {}): WaveSystem => ({
  id: 'rogue',
  name: 'Rogue',
  kind: 'focused',
  enabled: true,
  directionDeg: 270,
  crestHeight: 15,
  tp: 12,
  focusX: 200,
  focusY: -50,
  focusTime: 90,
  seed: 5,
  ...o,
});

describe('focused wave group (NewWave)', () => {
  it('resolves into linear components whose amplitudes sum to the crest height', () => {
    const sea = resolveSea([rogue()], env());
    expect(sea.regular.length).toBeLessThanOrEqual(FOCUSED_COMPONENTS);
    expect(sea.regular.every((r) => r.group === 'rogue' && !r.stokes)).toBe(true);
    const sum = sea.regular.reduce((a, r) => a + r.amplitude, 0);
    expect(sum).toBeCloseTo(15, 9);
    expect(sea.focused[0]?.crestHeight).toBe(15);
  });

  it('the crest reaches the requested elevation at the focus point and time', () => {
    const field = new OceanField([rogue()], env({ choppiness: 0 }));
    field.prepare(90);
    expect(field.surface(200, -50, 90).eta).toBeCloseTo(15, 6);
    // Well before focus the group is dispersed: the same point is far lower.
    field.prepare(20);
    expect(Math.abs(field.surface(200, -50, 20).eta)).toBeLessThan(6);
  });

  it('is transient energy: it does not change the stationary Hs', () => {
    const field = new OceanField([rogue()], env());
    expect(field.representedVariance).toBe(0);
  });
});
