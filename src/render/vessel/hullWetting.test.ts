import { describe, expect, it } from 'vitest';
import { HullWetState, stepWetEnvelope, wetTarget, WET_MAX, WET_MIN } from './hullWetting';

const calm = { hs: 0, rollAmp: 0, heaveAmp: 0, pitchAmp: 0, speed: 0, length: 100, beam: 16 };

describe('wetTarget', () => {
  it('rises with sea state, roll and speed', () => {
    const base = wetTarget({ ...calm, hs: 1 });
    expect(wetTarget({ ...calm, hs: 4 }).side).toBeGreaterThan(base.side);
    expect(wetTarget({ ...calm, hs: 1, rollAmp: 0.2 }).side).toBeGreaterThan(base.side);
    expect(wetTarget({ ...calm, hs: 1, speed: 10 }).bow).toBeGreaterThan(base.bow);
    // Speed lifts only the bow.
    expect(wetTarget({ ...calm, hs: 1, speed: 10 }).side).toBeCloseTo(base.side, 9);
  });

  it('never has the bow below the side, and holds the clamps', () => {
    for (const hs of [0, 1, 4, 12]) {
      const t = wetTarget({ ...calm, hs, speed: 15, rollAmp: 0.3 });
      expect(t.bow).toBeGreaterThanOrEqual(t.side);
    }
    expect(wetTarget(calm).side).toBeCloseTo(0.15, 9);
    expect(wetTarget(calm).side).toBeGreaterThanOrEqual(WET_MIN);
    const huge = wetTarget({ ...calm, hs: 100, rollAmp: 1.5, heaveAmp: 30, speed: 80 });
    expect(huge.side).toBe(WET_MAX);
    expect(huge.bow).toBe(WET_MAX);
  });

  it('caps the speed lift at 0.08 L', () => {
    const fast = wetTarget({ ...calm, speed: 200, length: 50 });
    const slow = wetTarget({ ...calm, length: 50 });
    expect(fast.bow - slow.side).toBeCloseTo(0.08 * 50, 6);
  });
});

describe('stepWetEnvelope', () => {
  const run = (from: number, to: number, seconds: number) => {
    let v = from;
    const dt = 0.05;
    for (let t = 0; t < seconds; t += dt) v = stepWetEnvelope(v, to, dt);
    return v;
  };

  it('rises with a 0.4 s time constant', () => {
    // One time constant covers 1 - 1/e of the gap.
    expect(run(0, 1, 0.4)).toBeCloseTo(1 - Math.exp(-1), 1);
  });

  it('dries with a 25 s time constant', () => {
    expect(run(1, 0, 25)).toBeCloseTo(Math.exp(-1), 1);
  });

  it('is stable for a large step and never overshoots', () => {
    expect(stepWetEnvelope(0, 1, 1000)).toBeLessThanOrEqual(1);
    expect(stepWetEnvelope(1, 0, 1000)).toBeGreaterThanOrEqual(0);
  });
});

describe('HullWetState', () => {
  it('wets quickly in a rough sea and dries slowly after', () => {
    const st = new HullWetState();
    st.step(0, 4, 0, 0, 0, 100, 16);
    let t = 0;
    for (; t < 5; t += 0.1) st.step(t, 4, 0.1 * Math.sin(t), 0, 0, 100, 16);
    const wetted = st.wet.side;
    expect(wetted).toBeGreaterThan(1.2);
    for (; t < 35; t += 0.1) st.step(t, 0, 0, 0, 0, 100, 16);
    expect(st.wet.side).toBeLessThan(wetted);
    expect(st.wet.side).toBeGreaterThan(0.3 * wetted);
  });

  it('keeps the bow at least as wet as the sides and ignores a time jump back', () => {
    const st = new HullWetState();
    for (let t = 0; t < 10; t += 0.1) st.step(t, 2, 0.05, Math.sin(t), 9, 100, 16);
    expect(st.wet.bow).toBeGreaterThanOrEqual(st.wet.side);
    const before = st.wet.side;
    st.step(1, 2, 0.05, 0, 9, 100, 16);
    expect(st.wet.side).toBeCloseTo(before, 3);
  });
});
