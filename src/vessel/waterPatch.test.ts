import { describe, expect, it } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import { presetExperiment } from '../schema/presets';
import { LocalWater } from './waterPatch';

describe('local water patch', () => {
  it('reports a diverged vessel instead of hanging', () => {
    const exp = presetExperiment('wave-tank-wigley');
    const water = new LocalWater(new OceanField(exp.waves, exp.environment), [0, -1, -3]);
    const ok = { minX: -10, maxX: 10, minY: -2, maxY: 2 };
    expect(() => water.update(0.2, () => ok)).not.toThrow();
    const bad = { minX: Number.NaN, maxX: 10, minY: -2, maxY: 2 };
    expect(() => water.update(5, () => bad)).toThrow(RangeError);
  });
});
