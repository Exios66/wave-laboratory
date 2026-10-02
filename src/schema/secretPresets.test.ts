import { describe, expect, it } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import { DRAUPNER_PEAK_T, draupnerExperiment } from './secretPresets';

describe('Draupner experiment', () => {
  it('rebuilds the 18.5 m crest at the platform gauge a minute in', () => {
    const exp = draupnerExperiment();
    expect(exp.environment.depth).toBe(70);
    const gauge = exp.probes[0]!;
    const field = new OceanField(exp.waves, exp.environment);
    let crest = -Infinity;
    for (let t = DRAUPNER_PEAK_T - 1; t <= DRAUPNER_PEAK_T + 1; t += 0.05) {
      crest = Math.max(crest, field.surface(gauge.x, gauge.y, t).eta);
    }
    expect(crest).toBeGreaterThan(17.5);
    expect(crest).toBeLessThan(19.5);
  }, 60_000);
});
