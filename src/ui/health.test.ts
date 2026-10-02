import { describe, expect, it } from 'vitest';
import type { SimFrame } from '../sim/types';
import type { VesselTelemetry } from '../vessel/api';
import { HealthNotifier, healthPercent, healthTone } from './health';

const frame = (
  vessels: Partial<VesselTelemetry>[],
  collisions: SimFrame['collisions'] = [],
): SimFrame => ({ vessels, collisions }) as unknown as SimFrame;

describe('health notices', () => {
  it('announces collisions at most every few seconds and a disabled vessel once', () => {
    const n = new HealthNotifier();
    const names = (id: string) => id.toUpperCase();
    const hit = { a: 'a', b: 'b', x: 0, y: 0, t: 1, severity: 0.3 };
    expect(n.check(frame([], [hit]), names, 0)).toEqual(['Collision: A and B.']);
    expect(n.check(frame([], [hit]), names, 1000)).toEqual([]);
    expect(n.check(frame([], [{ ...hit, severity: 0.8 }]), names, 5000)).toEqual([
      'Heavy collision: A and B.',
    ]);
    const dead = frame([{ id: 'a', disabled: true }]);
    expect(n.check(dead, names, 6000)).toHaveLength(1);
    expect(n.check(dead, names, 7000)).toHaveLength(0);
    n.check(frame([{ id: 'a', disabled: false }]), names, 8000);
    expect(n.check(dead, names, 9000)).toHaveLength(1);
  });

  it('formats health', () => {
    expect(healthPercent(0.724)).toBe(72);
    expect(healthPercent(0.001)).toBe(1);
    expect(healthPercent(0)).toBe(0);
    expect(healthTone(0.9)).toBe('ok');
    expect(healthTone(0.4)).toBe('warning');
    expect(healthTone(0.1)).toBe('danger');
  });
});
