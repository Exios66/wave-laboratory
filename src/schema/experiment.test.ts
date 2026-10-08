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

  it('older files without the damage setting parse with damage on', () => {
    const { damage, ...old } = presetExperiment();
    expect(damage).toBe(true);
    const r = parseExperiment(old);
    expect(r.ok && r.experiment.damage).toBe(true);
    const off = parseExperiment({ ...old, damage: false });
    expect(off.ok && off.experiment.damage).toBe(false);
  });

  it('older files without a mooring load unmoored; a mooring gets its defaults', () => {
    const exp = presetExperiment();
    const old = {
      ...exp,
      vessels: exp.vessels.map(({ mooring: _m, ...v }) => v),
    };
    const r = parseExperiment(old);
    expect(r.ok && r.experiment.vessels.every((v) => v.mooring === undefined)).toBe(true);
    // a share link of such a file decodes unchanged
    const back = decodeExperiment(encodeExperiment(old as typeof exp));
    expect(back.ok && back.experiment.vessels[0]!.mooring).toBeUndefined();
    const moored = parseExperiment({
      ...old,
      vessels: [{ ...old.vessels[0], mooring: {} }],
    });
    expect(moored.ok && moored.experiment.vessels[0]!.mooring).toEqual({
      kind: 'anchor',
      scope: 5,
    });
    expect(
      parseExperiment({ ...old, vessels: [{ ...old.vessels[0], mooring: { scope: 0.5 } }] }).ok,
    ).toBe(false);
  });

  it('older files without a Jerlov water type load as open-ocean IB', () => {
    const exp = presetExperiment();
    expect(exp.environment.waterType).toBe('oceanic-ib');
    const { waterType: _w, ...env } = exp.environment;
    const r = parseExperiment({ ...exp, environment: env });
    expect(r.ok && r.experiment.environment.waterType).toBe('oceanic-ib');
  });

  it('gives Agulhas tropical blue water and the harbour a coastal type', () => {
    expect(presetExperiment('agulhas-current').environment.waterType).toBe('oceanic-i');
    expect(presetExperiment('calm-harbour').environment.waterType).toBe('coastal-5');
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

describe('hostile input', () => {
  it('rejects ids that could break CSV headers and far-away positions', () => {
    const exp = structuredClone(presetExperiment('moderate-sea'));
    exp.vessels[0]!.id = '=HYPERLINK("x"),a';
    expect(parseExperiment(exp).ok).toBe(false);
    const far = structuredClone(presetExperiment('moderate-sea'));
    far.vessels[0]!.x = 1e300;
    expect(parseExperiment(far).ok).toBe(false);
    expect(decodeExperiment('A'.repeat(300_000)).ok).toBe(false);
    expect(decodeExperiment(encodeExperiment(presetExperiment('moderate-sea'))).ok).toBe(true);
  });
});
