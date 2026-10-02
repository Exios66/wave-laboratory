import { describe, expect, it } from 'vitest';
import { WeatherSchema } from '../schema/experiment';
import {
  buildGustModes,
  rainVisibilityKm,
  WeatherField,
  whitecapFraction,
  type WindSample,
} from './weather';

const sample = (): WindSample => ({ u: 0, v: 0, speed: 0, squall: 0 });

describe('weather', () => {
  it('gust modes carry exactly the requested turbulence intensity', () => {
    for (const intensity of [0.05, 0.12, 0.3]) {
      const modes = buildGustModes(intensity, 15, 3);
      const variance = modes.reduce((a, m) => a + (m.au * m.au) / 2, 0);
      expect(Math.sqrt(variance)).toBeCloseTo(intensity, 10);
    }
    expect(buildGustModes(0, 15, 3)).toEqual([]);
  });

  it('time series at a point has the requested mean and standard deviation', () => {
    const wf = new WeatherField(WeatherSchema.parse({ gustiness: 0.12 }), {
      windSpeed: 15,
      windDirectionDeg: 270,
    });
    const s = sample();
    let sum = 0;
    let sum2 = 0;
    const n = 36000;
    for (let i = 0; i < n; i++) {
      wf.windAt(0, 0, i * 0.5, s); // 5 h record
      sum += s.speed;
      sum2 += s.speed * s.speed;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sum2 / n - mean * mean);
    expect(mean).toBeGreaterThan(14.5);
    expect(mean).toBeLessThan(15.6);
    // Speed std ≈ σ_u (lateral gusts add little to the magnitude).
    expect(sd / 15).toBeGreaterThan(0.09);
    expect(sd / 15).toBeLessThan(0.15);
  });

  it('wind blows from the environment bearing and is deterministic', () => {
    const w = WeatherSchema.parse({ gustiness: 0 });
    const wf = new WeatherField(w, { windSpeed: 10, windDirectionDeg: 270 });
    const s = wf.windAt(100, -50, 33, sample());
    // From the west → air moves east (+x).
    expect(s.u).toBeCloseTo(10, 9);
    expect(s.v).toBeCloseTo(0, 9);
    const a = new WeatherField(WeatherSchema.parse({}), { windSpeed: 12, windDirectionDeg: 40 });
    const b = new WeatherField(WeatherSchema.parse({}), { windSpeed: 12, windDirectionDeg: 40 });
    expect(a.windAt(5, 7, 91, sample())).toEqual(b.windAt(5, 7, 91, sample()));
  });

  it('gusts are frozen turbulence advected downwind', () => {
    const wf = new WeatherField(WeatherSchema.parse({ gustiness: 0.15 }), {
      windSpeed: 10,
      windDirectionDeg: 270,
    });
    const g1 = { u: 0, v: 0 };
    const g2 = { u: 0, v: 0 };
    wf.gust(0, 0, 50, g1);
    wf.gust(100, 0, 60, g2); // 100 m downwind, 10 s later at 10 m/s
    expect(g2.u).toBeCloseTo(g1.u, 9);
  });

  it('squall fronts raise and veer the wind and bring rain', () => {
    const wf = new WeatherField(
      WeatherSchema.parse({
        gustiness: 0,
        squalls: { enabled: true, intervalMin: 10, durationMin: 4, strength: 1.8, veerDeg: 40 },
      }),
      { windSpeed: 10, windDirectionDeg: 270 },
    );
    let peak = 0;
    let peakRain = 0;
    let calm = Infinity;
    const s = sample();
    for (let t = 0; t < 3600; t += 2) {
      wf.windAt(0, 0, t, s);
      peak = Math.max(peak, s.speed);
      calm = Math.min(calm, s.speed);
      peakRain = Math.max(peakRain, wf.rainAt(0, 0, t));
    }
    expect(peak).toBeGreaterThan(17.5);
    expect(peak).toBeLessThanOrEqual(18 + 1e-9);
    expect(calm).toBeCloseTo(10, 6);
    expect(peakRain).toBeGreaterThan(20);
  });

  it('lightning only flashes when enabled', () => {
    const off = new WeatherField(WeatherSchema.parse({}), { windSpeed: 20, windDirectionDeg: 0 });
    const on = new WeatherField(WeatherSchema.parse({ lightning: true, rainMmH: 40 }), {
      windSpeed: 20,
      windDirectionDeg: 0,
    });
    let flashes = 0;
    for (let t = 0; t < 600; t += 0.05) {
      expect(off.lightning(t)).toBe(0);
      if (on.lightning(t) > 0.5) flashes++;
    }
    expect(flashes).toBeGreaterThan(5);
  });

  it('whitecap coverage and rain visibility follow the empirical laws', () => {
    expect(whitecapFraction(10)).toBeCloseTo(3.84e-6 * 10 ** 3.41, 12);
    expect(whitecapFraction(0)).toBe(0);
    expect(whitecapFraction(60)).toBe(1);
    expect(rainVisibilityKm(40, 0)).toBeCloseTo(40, 9);
    const heavy = rainVisibilityKm(40, 50);
    expect(heavy).toBeGreaterThan(1);
    expect(heavy).toBeLessThan(3);
  });
});
