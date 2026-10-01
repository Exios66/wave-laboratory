import { describe, expect, it } from 'vitest';
import {
  motionSicknessIncidence,
  normalCdf,
  rms,
  spectralParameters,
  welchPsd,
  zeroCrossingStatistics,
} from './analysis';
import { RingBuffer } from './ringBuffer';

describe('RingBuffer', () => {
  it('keeps the newest values in order', () => {
    const r = new RingBuffer(3);
    for (const v of [1, 2, 3, 4, 5]) r.push(v);
    expect(Array.from(r.toArray())).toEqual([3, 4, 5]);
    expect(Array.from(r.toArray(2))).toEqual([4, 5]);
    expect(r.last()).toBe(5);
  });
});

describe('Welch PSD', () => {
  const fs = 4;
  const a = 1.5;
  const f0 = 0.125; // 8 s
  const signal = Float64Array.from(
    { length: 4096 },
    (_, i) => a * Math.sin(2 * Math.PI * f0 * (i / fs)),
  );

  it('satisfies Parseval (∫S df = variance)', () => {
    const psd = welchPsd(signal, fs, 512);
    const sp = spectralParameters(psd);
    expect(sp.hm0 / ((4 * a) / Math.SQRT2)).toBeCloseTo(1, 2);
  });

  it('peaks at the signal frequency', () => {
    const sp = spectralParameters(welchPsd(signal, fs, 512));
    expect(sp.tp).toBeCloseTo(8, 6);
  });
});

describe('zero-crossing statistics', () => {
  it('recovers height and period of a sine', () => {
    const fs = 10;
    const s = Float64Array.from(
      { length: 2000 },
      (_, i) => 0.7 * Math.sin((2 * Math.PI * (i / fs)) / 6.3),
    );
    const st = zeroCrossingStatistics(s, fs);
    expect(st.tz).toBeCloseTo(6.3, 2);
    expect(st.h13).toBeCloseTo(1.4, 2);
    expect(st.hmax).toBeCloseTo(1.4, 2);
    expect(rms(s)).toBeCloseTo(0.7 / Math.SQRT2, 2);
  });
});

describe('motion sickness incidence', () => {
  it('is bounded and increases with acceleration', () => {
    const lo = motionSicknessIncidence(0.2, 0.17);
    const hi = motionSicknessIncidence(2, 0.17);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(100);
    expect(hi).toBeGreaterThan(lo);
  });

  it('uses an accurate normal CDF', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 5);
  });
});
