import { describe, expect, it } from 'vitest';
import { wmoSeaState } from './units';

describe('wmoSeaState', () => {
  it('keeps a height that displays as 2.50 m in Moderate', () => {
    expect(wmoSeaState(2.5)).toEqual({ code: 4, label: 'Moderate' });
    expect(wmoSeaState(2.504)).toEqual({ code: 4, label: 'Moderate' });
  });

  it('steps up only once the displayed height leaves the bin', () => {
    expect(wmoSeaState(2.506)).toEqual({ code: 5, label: 'Rough' });
    expect(wmoSeaState(4)).toEqual({ code: 5, label: 'Rough' });
    expect(wmoSeaState(4.006)).toEqual({ code: 6, label: 'Very rough' });
  });
});
