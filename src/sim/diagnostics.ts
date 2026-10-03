/** Sea-state diagnostics and model-validity warnings shown in the inspector. */
import { groupVelocity, micheLimit, ursellNumber, wavenumberOf } from '../ocean/dispersion';
import type { ResolvedSea } from '../ocean/systems';
import type { SeaDiagnostics } from './types';

export function seaDiagnostics(
  sea: ResolvedSea,
  representedHs: number,
  current: { x: number; y: number } = { x: 0, y: 0 },
): SeaDiagnostics {
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
    checkCurrent(s.id, kp, Math.cos(s.theta0), Math.sin(s.theta0));
  }
  for (const f of sea.focused) {
    systems.push({
      id: f.id,
      hs: f.crestHeight,
      tp: f.tp,
      wavelength: f.wavelength,
      note: `Focused crest of ${f.crestHeight.toFixed(1)} m at t = ${f.focusTime.toFixed(0)} s`,
    });
    // Crest steepness as the H/L of a sinusoid with the same crest elevation A. Miche's
    // limit is the regular-wave breaking steepness; a NewWave crest past it would break
    // even if the group's troughs are shallower than −A.
    const kp = (2 * Math.PI) / f.wavelength;
    const steep = (2 * f.crestHeight) / f.wavelength;
    const limit = micheLimit(kp, depth);
    if (steep > limit) {
      warnings.push(
        `${f.id}: the focused crest is past breaking (2A/λp = ${steep.toFixed(3)}, Miche limit ` +
          `${limit.toFixed(3)}). A real group would break before reaching it, and linear ` +
          'NewWave under-predicts the crest.',
      );
    } else if (steep > 0.85 * limit) {
      warnings.push(
        `${f.id}: steep focused crest (2A/λp = ${steep.toFixed(3)}; Miche limit ` +
          `${limit.toFixed(3)}). Linear theory is approximate this close to breaking.`,
      );
    }
    if (representedHs > 0.05) {
      const ratio = f.crestHeight / representedHs;
      if (ratio > 1.8) {
        warnings.push(
          `${f.id}: focused crest is ${ratio.toFixed(1)} Hs of the background sea. Recorded ` +
            'rogue crests are typically 1.2–1.6 Hs (Draupner 1.55 Hs); this amplitude is a ' +
            'design wave, not a likely sea.',
        );
      }
    }
    checkShallow(f.id, 2 * f.crestHeight, f.wavelength, kp);
  }
  for (const r of sea.regular) {
    if (r.group) continue;
    const wavelength = (2 * Math.PI) / r.k;
    systems.push({ id: r.id, hs: 2 * r.amplitude, tp: (2 * Math.PI) / r.omega, wavelength });
    const steep = (2 * r.amplitude) / wavelength;
    const limit = micheLimit(r.k, depth);
    if (steep > limit) {
      warnings.push(
        `${r.id}: H/L = ${steep.toFixed(3)} exceeds the Miche breaking limit ` +
          `(${limit.toFixed(3)}). Such a wave cannot exist without breaking.`,
      );
    } else if (steep > 0.85 * limit) {
      warnings.push(
        `${r.id}: steep wave (H/L = ${steep.toFixed(3)}). A second-order Stokes correction ` +
          'sharpens the crests, but the wave is close to breaking and higher-order effects remain.',
      );
    }
    checkShallow(r.id, 2 * r.amplitude, wavelength, r.k);
  }

  /**
   * Wave–current interaction. The lab advects the sea with a uniform current, which is exact for
   * the Doppler shift, but against a strong opposing current real waves shorten and steepen,
   * and once the current matches their group velocity they are blocked and break.
   */
  function checkCurrent(id: string, k: number, dirX: number, dirY: number): void {
    const opposing = -(current.x * dirX + current.y * dirY);
    if (opposing <= 0) return;
    const cg = groupVelocity(k, disp);
    if (opposing >= cg) {
      warnings.push(
        `${id}: the current opposes these waves faster than their group velocity ` +
          `(${opposing.toFixed(2)} ≥ ${cg.toFixed(2)} m/s). Real waves would be blocked and break; ` +
          'here they are only drifted, so treat the result with care.',
      );
    } else if (opposing >= 0.5 * cg) {
      warnings.push(
        `${id}: strong opposing current (${opposing.toFixed(2)} m/s, half the group velocity). ` +
          'Real waves would shorten and steepen against it; this uniform-current model only ' +
          'Doppler shifts them.',
      );
    }
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
