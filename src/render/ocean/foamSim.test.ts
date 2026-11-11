import { describe, expect, it } from 'vitest';
import { FOAM_TAU, foamDecay, foamInject, foamShares, foamStep, whitecapGate } from './foamSim';

describe('foam decay', () => {
  it('is e^{−Δt/τ} for forward steps and 1 for a paused sea', () => {
    expect(foamDecay(0, 4)).toBe(1);
    expect(foamDecay(1, 4)).toBeCloseTo(Math.exp(-0.25), 12);
    expect(foamDecay(1 / 60, 7)).toBeCloseTo(Math.exp(-1 / 420), 12);
  });

  it('resets on a backward jump, the first step of a sea, or a bad time constant', () => {
    expect(foamDecay(-0.5, 4)).toBe(0);
    expect(foamDecay(Number.NaN, 4)).toBe(0);
    expect(foamDecay(Infinity, 4)).toBe(0);
    expect(foamDecay(1, 0)).toBe(0);
  });

  it('forgets a long jump forward without underflow trouble', () => {
    expect(foamDecay(1e6, 4)).toBeGreaterThanOrEqual(0);
    expect(foamDecay(1e6, 4)).toBeLessThan(1e-20);
  });

  it('halves in τ ln 2 regardless of how the time is stepped', () => {
    const tau = FOAM_TAU[0]!;
    const half = tau * Math.LN2;
    let fine = 1;
    for (let i = 0; i < 600; i++) fine = foamStep(fine, 0, foamDecay(half / 600, tau));
    const coarse = foamStep(1, 0, foamDecay(half, tau));
    expect(fine).toBeCloseTo(0.5, 9);
    expect(coarse).toBeCloseTo(0.5, 9);
  });
});

describe('foam step', () => {
  it('keeps the larger of the decayed foam and what breaks now', () => {
    expect(foamStep(0.8, 0.3, 0.5)).toBeCloseTo(0.4, 12);
    expect(foamStep(0.8, 0.9, 0.5)).toBeCloseTo(0.9, 12);
    expect(foamStep(0.8, 0.2, 0)).toBeCloseTo(0.2, 12);
  });

  it('leaves a trail that fades after the crest has passed', () => {
    const tau = 4;
    const dt = 1 / 60;
    let foam = 0;
    const history: number[] = [];
    for (let i = 0; i < 600; i++) {
      // Breaking for the first half second only.
      const inject = i < 30 ? 1 : 0;
      foam = foamStep(foam, inject, foamDecay(dt, tau));
      history.push(foam);
    }
    expect(history[29]).toBe(1);
    expect(history[29 + 240]).toBeCloseTo(Math.exp(-1), 6);
    expect(history.at(-1)!).toBeLessThan(0.15);
    expect(history.at(-1)!).toBeGreaterThan(0);
  });
});

describe('breaking gate', () => {
  it('reduces to the whole-sea Monahan gate for share 1', () => {
    expect(whitecapGate(0, 0, 1)).toBeCloseTo(0.5, 12);
    expect(whitecapGate(0.04, 0, 1)).toBeCloseTo(0.5 + 0.7 * 0.2, 12);
    expect(whitecapGate(0.04, 1, 1)).toBeCloseTo(0.5 + 0.7 * 0.2 + 0.15, 12);
  });

  it('moves toward 1 for a cascade that carries little of the compression', () => {
    const whole = whitecapGate(0.1, 0, 1);
    const part = whitecapGate(0.1, 0, 0.3);
    expect(part).toBeGreaterThan(whole);
    expect(1 - part).toBeCloseTo((1 - whole) * 0.3, 12);
    expect(whitecapGate(0.1, 0, 0)).toBe(1);
  });

  it('asks a cascade with a margin for deeper compression', () => {
    const plain = whitecapGate(0.1, 0, 0.5);
    const strict = whitecapGate(0.1, 0, 0.5, 0.3);
    expect(plain - strict).toBeCloseTo(0.15, 12);
  });

  it('injects foam only where the surface is compressed past the gate', () => {
    const gate = whitecapGate(0.05, 0, 1);
    expect(foamInject(1, gate, 1, 1)).toBe(0);
    expect(foamInject(gate, gate, 1, 1)).toBe(0);
    expect(foamInject(gate - 0.3, gate, 1, 1)).toBe(1);
    // Troughs make a third as much as crests.
    expect(foamInject(gate - 0.3, gate, 1, 0)).toBeCloseTo(0.35, 12);
  });
});

describe('cascade shares', () => {
  it('are √(mss_i / Σ mss) and handle a flat sea', () => {
    const s = foamShares([0.01, 0.03, 0, 0]);
    expect(s[0]).toBeCloseTo(0.5, 12);
    expect(s[1]).toBeCloseTo(Math.sqrt(0.75), 12);
    expect(s[2]).toBe(0);
    expect(foamShares([0, 0])).toEqual([0, 0]);
  });
});
