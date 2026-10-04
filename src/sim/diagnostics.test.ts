import { describe, expect, it } from 'vitest';
import { micheLimit } from '../ocean/dispersion';
import { resolveSea } from '../ocean/systems';
import type { WaveSystem } from '../schema/experiment';
import { presetExperiment } from '../schema/presets';
import { env } from '../test/fixtures';
import { seaDiagnostics } from './diagnostics';

const focused = (crestHeight: number, tp: number): WaveSystem => ({
  id: 'rogue',
  name: 'Rogue',
  kind: 'focused',
  enabled: true,
  directionDeg: 0,
  crestHeight,
  tp,
  focusX: 0,
  focusY: 0,
  focusTime: 60,
  seed: 1,
});

const spectrum = (hs: number, tp: number): WaveSystem => ({
  id: 'sea',
  name: 'Sea',
  kind: 'spectrum',
  enabled: true,
  spectrum: 'jonswap',
  hs,
  tp,
  gamma: 3.3,
  directionDeg: 0,
  depthLimited: true,
  spreading: { model: 'mitsuyasu', s: 10 },
  seed: 1,
});

describe('focused-group model validity', () => {
  it('the rogue-wave preset is below the Miche limit with a Draupner-like crest/Hs', () => {
    const exp = presetExperiment('rogue-wave');
    const storm = exp.waves.find((w) => w.kind === 'spectrum');
    const group = exp.waves.find((w) => w.kind === 'focused');
    expect(storm?.kind === 'spectrum' && storm.hs).toBe(8);
    expect(group?.kind === 'focused' && group.crestHeight).toBe(12);
    expect(exp.environment.depth).toBe(70);

    const sea = resolveSea(exp.waves, exp.environment);
    const d = seaDiagnostics(sea, 8);
    expect(d.warnings).toEqual([]);
    const f = sea.focused[0]!;
    const kp = (2 * Math.PI) / f.wavelength;
    expect((2 * f.crestHeight) / f.wavelength).toBeLessThan(micheLimit(kp, sea.dispersion.depth));
    expect(f.crestHeight / 8).toBeCloseTo(1.5, 5);
  });

  it('warns when a focused crest exceeds the Miche breaking limit', () => {
    const sea = resolveSea([focused(17, 12)], env());
    const d = seaDiagnostics(sea, 0);
    expect(d.warnings.some((w) => /Miche|breaking/.test(w))).toBe(true);
  });

  it('does not treat a valid Draupner-ratio group as unphysical', () => {
    const sea = resolveSea([spectrum(8, 13), focused(12, 13)], env({ depth: 70 }));
    const d = seaDiagnostics(sea, 8);
    expect(d.warnings).toEqual([]);
  });

  it('warns when the focused crest is many Hs of the background sea', () => {
    // 17 m at Tp = 15 s is below Miche in deep water, but 17/6 Hs is not a likely sea.
    const sea = resolveSea([spectrum(6, 15), focused(17, 15)], env());
    const d = seaDiagnostics(sea, 6);
    expect(d.warnings.some((w) => /Hs/.test(w))).toBe(true);
    expect(d.warnings.some((w) => /Miche|breaking/.test(w))).toBe(false);
  });
});
