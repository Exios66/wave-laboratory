import { describe, expect, it } from 'vitest';
import { CLOUD_PATH_CAP_KM, cloudDeck, cloudPhase, hgPhase, powderSun, slabSpan } from './clouds';

describe('cloudDeck', () => {
  it('keeps the base below the top at every cover', () => {
    for (let c = 0; c <= 1.0001; c += 0.05) {
      const d = cloudDeck(c);
      expect(d.baseKm).toBeLessThan(d.topKm);
      expect(d.baseKm).toBeGreaterThan(0);
    }
  });

  it('thickens and lowers as the cover rises', () => {
    let prev = cloudDeck(0);
    for (let c = 0.05; c <= 1.0001; c += 0.05) {
      const d = cloudDeck(c);
      expect(d.topKm - d.baseKm).toBeGreaterThanOrEqual(prev.topKm - prev.baseKm - 1e-9);
      expect(d.baseKm).toBeLessThanOrEqual(prev.baseKm + 1e-9);
      prev = d;
    }
  });

  it('matches the design at fair-weather and storm covers', () => {
    const fair = cloudDeck(0.1);
    expect(fair.baseKm).toBeCloseTo(1.2, 2);
    expect(fair.topKm - fair.baseKm).toBeCloseTo(0.35, 2);
    const storm = cloudDeck(1);
    expect(storm.baseKm).toBeCloseTo(0.6, 2);
    expect(storm.topKm - storm.baseKm).toBeCloseTo(2.4, 2);
  });
});

describe('hgPhase', () => {
  it('integrates to about 1 over the sphere', () => {
    for (const g of [-0.25, 0, 0.6]) {
      // ∫ p dΩ = 2π ∫ p(μ) dμ over μ ∈ [−1, 1].
      const n = 4000;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += hgPhase(-1 + (2 * (i + 0.5)) / n, g) * (2 / n);
      expect(sum * 2 * Math.PI).toBeCloseTo(1, 2);
    }
  });

  it('scatters forward for g > 0 and has a back lobe in the two-lobe blend', () => {
    expect(hgPhase(1, 0.6)).toBeGreaterThan(hgPhase(-1, 0.6));
    expect(cloudPhase(1)).toBeGreaterThan(cloudPhase(0));
    expect(cloudPhase(-1)).toBeGreaterThan(cloudPhase(0));
  });
});

describe('powderSun', () => {
  it('is half lit at a thin edge, peaks just inside, then decays', () => {
    expect(powderSun(0)).toBeCloseTo(0.5, 6);
    const peakTau = 0.5 * Math.log(1.5);
    expect(powderSun(peakTau)).toBeGreaterThan(powderSun(0));
    expect(powderSun(peakTau)).toBeGreaterThan(powderSun(peakTau + 0.3));
    expect(powderSun(10)).toBeLessThan(1e-4);
  });
});

describe('slabSpan', () => {
  const base = 1.2;
  const top = 1.6;

  it('enters at the base and leaves at the top looking up from the sea', () => {
    const s = slabSpan(0.002, 0.5, base, top, 100)!;
    expect(s[0]).toBeCloseTo((base - 0.002) / 0.5, 9);
    expect(s[1]).toBeCloseTo((top - 0.002) / 0.5, 9);
  });

  it('starts at the eye inside the deck', () => {
    const up = slabSpan(1.4, 0.3, base, top, 100)!;
    expect(up[0]).toBe(0);
    expect(up[1]).toBeCloseTo(0.2 / 0.3, 9);
    const down = slabSpan(1.4, -0.3, base, top, 100)!;
    expect(down[0]).toBe(0);
    expect(down[1]).toBeCloseTo(0.2 / 0.3, 9);
  });

  it('sees the top of the deck from above and nothing looking away', () => {
    const s = slabSpan(2, -0.4, base, top, 100)!;
    expect(s[0]).toBeCloseTo(0.4 / 0.4, 9);
    expect(s[1]).toBeCloseTo(0.8 / 0.4, 9);
    expect(slabSpan(2, 0.4, base, top, 100)).toBeNull();
    expect(slabSpan(0.002, -0.1, base, top, 100)).toBeNull();
  });

  it('caps long grazing paths and handles horizontal rays', () => {
    const s = slabSpan(0.002, 0.01, base, top, CLOUD_PATH_CAP_KM)!;
    expect(s[1] - s[0]).toBeLessThanOrEqual(CLOUD_PATH_CAP_KM + 1e-9);
    expect(slabSpan(0.002, 0, base, top, 100)).toBeNull();
    const inside = slabSpan(1.4, 0, base, top, 8)!;
    expect(inside).toEqual([0, 8]);
  });
});
