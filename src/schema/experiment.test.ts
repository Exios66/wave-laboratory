import { describe, expect, it } from 'vitest';
import { decodeExperiment, encodeExperiment, parseExperiment } from './experiment';
import { PRESETS, presetExperiment } from './presets';

describe('experiment schema', () => {
  it('accepts every preset', () => {
    for (const p of PRESETS) {
      const r = parseExperiment(p.experiment);
      expect(r.ok, `${p.id}: ${r.ok ? '' : r.errors.join('; ')}`).toBe(true);
    }
  });

  it('round-trips through the URL encoding', () => {
    const exp = presetExperiment('swell-and-wind-sea');
    const r = decodeExperiment(encodeExperiment(exp));
    expect(r.ok && r.experiment).toEqual(exp);
  });

  it('reports readable errors', () => {
    const exp = presetExperiment();
    const bad = { ...exp, waves: [{ ...exp.waves[0], hs: -3 }] };
    const r = parseExperiment(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/waves\.0\.hs/);
  });

  it('rejects duplicate ids', () => {
    const exp = presetExperiment();
    const r = parseExperiment({ ...exp, probes: [{ ...exp.probes[0]!, id: exp.vessels[0]!.id }] });
    expect(r.ok).toBe(false);
  });

  it('rejects garbage gracefully', () => {
    expect(decodeExperiment('not base64 !!').ok).toBe(false);
    expect(parseExperiment(null).ok).toBe(false);
  });

  it('presetExperiment returns independent copies', () => {
    const a = presetExperiment();
    a.name = 'changed';
    expect(presetExperiment().name).not.toBe('changed');
  });
});
