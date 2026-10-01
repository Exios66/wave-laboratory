/** Sea-state diagnostics and model-validity warnings shown in the inspector. */
import { micheLimit, ursellNumber, wavenumberOf } from '../ocean/dispersion';
import type { ResolvedSea } from '../ocean/systems';
import type { SeaDiagnostics } from './types';

export function seaDiagnostics(sea: ResolvedSea, representedHs: number): SeaDiagnostics {
  const warnings: string[] = [];
  const disp = sea.dispersion;
  const depth = disp.depth;
  const systems: SeaDiagnostics['systems'] = [];

  for (const s of sea.spectral) {
    const kp = wavenumberOf(s.spectrum.omegaPeak, disp);
    const wavelength = (2 * Math.PI) / kp;
    systems.push({
      id: s.id,
      hs: s.hs,
      tp: s.tp,
      wavelength,
      ...(s.note ? { note: s.note } : {}),
    });
    const steepness = s.hs / wavelength;
    if (steepness > 0.07) {
      warnings.push(
        `${s.id}: very steep sea (Hs/Lp = ${steepness.toFixed(3)}). Many crests exceed the ` +
          'breaking limit; linear theory and the foam model become approximate.',
      );
    }
    checkShallow(s.id, s.hs, wavelength, kp);
  }
  for (const r of sea.regular) {
    const wavelength = (2 * Math.PI) / r.k;
    systems.push({ id: r.id, hs: 2 * r.amplitude, tp: (2 * Math.PI) / r.omega, wavelength });
    const steep = (2 * r.amplitude) / wavelength;
    const limit = micheLimit(r.k, depth);
    if (steep > limit) {
      warnings.push(
        `${r.id}: H/L = ${steep.toFixed(3)} exceeds the Miche breaking limit ` +
          `(${limit.toFixed(3)}). Such a wave cannot exist without breaking.`,
      );
    } else if (steep > 0.5 * limit) {
      warnings.push(
        `${r.id}: steep wave (H/L = ${steep.toFixed(3)}); Stokes-type nonlinear effects ` +
          '(sharper crests, flatter troughs) are only partly captured by the choppy model.',
      );
    }
    checkShallow(r.id, 2 * r.amplitude, wavelength, r.k);
  }

  function checkShallow(id: string, height: number, wavelength: number, k: number): void {
    if (depth >= 1000) return;
    if (height > 0.78 * depth) {
      warnings.push(
        `${id}: wave height exceeds the depth-limited breaking criterion (H > 0.78 h); ` +
          'waves of this size would break in this depth.',
      );
    }
    const ur = ursellNumber(height, wavelength, depth);
    if (k * depth < Math.PI && ur > 26) {
      warnings.push(
        `${id}: Ursell number ${ur.toFixed(0)} > 26 — shallow-water nonlinearity is strong; ` +
          'linear theory under-predicts crest heights (cnoidal/Boussinesq regime).',
      );
    }
  }

  return { hs: representedHs, systems, warnings };
}
