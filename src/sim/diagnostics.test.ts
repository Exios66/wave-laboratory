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

describe('nonlinear wave diagnostics', () => {
  const regularWith = (theory: 'stokes5' | 'cnoidal', height: number, period: number) =>
    ({
      id: 'r',
      name: 'R',
      kind: 'regular',
      enabled: true,
      directionDeg: 270,
      height,
      period,
      phaseDeg: 0,
      theory,
    }) as WaveSystem;

  it('lists a Stokes-5 wave with its theory and warns when the height was clamped', () => {
    const e = env({ depth: 300 });
    const d = seaDiagnostics(resolveSea([regularWith('stokes5', 20, 8)], e), 0);
    expect(d.systems[0]!.note).toMatch(/Stokes fifth order/);
    expect(d.systems[0]!.hs).toBeLessThan(20);
    expect(d.warnings.join(' ')).toMatch(/Miche/);
  });
  it('shows the Ursell number and elliptic parameter of a cnoidal wave', () => {
    const e = env({ depth: 3 });
    const d = seaDiagnostics(resolveSea([regularWith('cnoidal', 0.6, 20)], e), 0);
    expect(d.systems[0]!.note).toMatch(/Ursell \d+/);
    expect(d.systems[0]!.note).toMatch(/m = 0\.\d+/);
    expect(d.warnings).toHaveLength(0);
  });
  it('lists a solitary wave and warns about the breaking limit', () => {
    const e = env({ depth: 3 });
    const sol: WaveSystem = {
      id: 's',
      name: 'S',
      kind: 'solitary',
      enabled: true,
      directionDeg: 270,
      height: 3,
      spacing: 0,
      phaseDeg: 0,
    };
    const d = seaDiagnostics(resolveSea([sol], e), 0);
    expect(d.systems[0]!.note).toMatch(/Solitary/);
    expect(d.warnings.join(' ')).toMatch(/0\.78/);
  });
});
