import { describe, expect, it } from 'vitest';
import { dayPhase, formatClock } from './clock';

describe('formatClock', () => {
  it('formats and wraps clock hours', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(6.7)).toBe('06:42');
    expect(formatClock(23.999)).toBe('23:59');
    expect(formatClock(24)).toBe('00:00');
    expect(formatClock(-1)).toBe('23:00');
  });
});

describe('dayPhase', () => {
  it('names the part of the day', () => {
    expect(dayPhase(12)).toBe('day');
    expect(dayPhase(6)).toBe('dawn');
    expect(dayPhase(18)).toBe('dusk');
    expect(dayPhase(2)).toBe('night');
    expect(dayPhase(21)).toBe('night');
  });
});
