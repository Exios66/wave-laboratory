import { describe, expect, it } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import { DRAUPNER_PEAK_T, draupnerExperiment } from './secretPresets';

describe('Draupner experiment', () => {
  it('is valid and puts its biggest crest at the platform gauge a minute in', () => {
    const exp = draupnerExperiment();
    expect(exp.environment.depth).toBe(70);
    const gauge = exp.probes[0]!;
    const field = new OceanField(exp.waves, exp.environment);
    let crest = -Infinity;
    for (let t = DRAUPNER_PEAK_T - 1; t <= DRAUPNER_PEAK_T + 1; t += 0.05) {
      crest = Math.max(crest, field.surface(gauge.x, gauge.y, t).eta);
    }
    expect(crest).toBeGreaterThan(8);
  }, 60_000);
});
