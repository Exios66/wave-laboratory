/**
 * Legend text and colour bars of the surface overlays. The ranges come from `overlayScale`, the
 * same helper the renderer sets the shader's colour scale from, so the numbers shown are the
 * numbers drawn. Every legend states quantity, unit and range in words.
 */
import type { OverlayMode } from '../render/api';
import { BREAKING_JACOBIAN, overlayScale } from '../ocean/overlays';

export interface LegendInput {
  /** Significant wave height of the sea [m]. */
  hs: number;
  rho: number;
  g: number;
  /** Depth under the mean surface of the pressure overlay [m]. */
  depth: number;
}

export interface LegendSpec {
  title: string;
  /** CSS gradient of the colour bar. */
  gradient: string;
  /** Low, middle and high end of the scale, with units. */
  ticks: string[];
  /** One line that says what is drawn and how the range was chosen. */
  note: string;
}

const DIVERGING = 'linear-gradient(90deg,#2166ac,#67a9cf,#f7f7f7,#ef8a62,#b2182b)';
const DIVERGING_REVERSED = 'linear-gradient(90deg,#b2182b,#ef8a62,#f7f7f7,#67a9cf,#2166ac)';
const CIVIDIS = 'linear-gradient(90deg,#00204d,#414d6b,#7c7b78,#bcae6c,#ffea46)';
const VIRIDIS = 'linear-gradient(90deg,#440154,#3b528b,#21918c,#5ec962,#fde725)';

/** A depth as typed: whole metres without decimals, otherwise up to two decimals. */
function depthLabel(d: number): string {
  return String(Number(d.toFixed(2)));
}

function num(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

export function legendSpec(mode: Exclude<OverlayMode, 'none'>, input: LegendInput): LegendSpec {
  const sc = overlayScale(input.hs, input.rho, input.g);
  const a = sc.height;
  switch (mode) {
    case 'height':
      return {
        title: 'Surface elevation η',
        gradient: DIVERGING,
        ticks: [`−${a.toFixed(1)} m`, '0', `+${a.toFixed(1)} m`],
        note: `Elevation above the mean level, ±0.75 H_s (at least 0.25 m).`,
      };
    case 'steepness':
      return {
        title: 'Slope |∇η|',
        gradient: 'linear-gradient(90deg,#0d0887,#7e03a8,#cc4778,#f89540,#f0f921)',
        ticks: ['0', '0.15', '0.3+'],
        note: 'Magnitude of the surface slope (dimensionless).',
      };
    case 'foam':
      return {
        title: 'Breaking (Jacobian) & foam',
        gradient: 'linear-gradient(90deg,#08306b,#4292c6,#f7fbff)',
        ticks: ['none', '', 'breaking'],
        note: 'Whitecap foam, or the compression of the surface where there are no foam maps.',
      };
    case 'jacobian':
      return {
        title: 'Jacobian J of the choppy surface',
        gradient: DIVERGING_REVERSED,
        ticks: ['0 folded', '1 undisturbed', '2+ stretched'],
        note: `J = (1 + ∂Dx/∂x)(1 + ∂Dy/∂y), the value the foam uses; it leaves out the cross term ∂Dx/∂y·∂Dy/∂x, so oblique waves read slightly high. Striped = J below ${BREAKING_JACOBIAN.toFixed(2)}: breaking onset (folding is J < 0).`,
      };
    case 'velocity':
      return {
        title: 'Orbital speed at the surface',
        gradient: CIVIDIS,
        ticks: ['0 m/s', `${num(sc.velocity / 2)} m/s`, `${num(sc.velocity)}+ m/s`],
        note: `Speed |u| of the surface water particle (linear theory, finite depth; no second-order Stokes term). Top of the scale ω·0.75 H_s (amplitude at least 0.25 m) with a developed-sea period, from H_s = ${input.hs.toFixed(1)} m.`,
      };
    case 'pressure': {
      const kpa = sc.pressure / 1000;
      return {
        title: `Dynamic pressure at ${depthLabel(input.depth)} m depth`,
        gradient: DIVERGING,
        ticks: [`−${num(kpa)} kPa`, '0', `+${num(kpa)} kPa`],
        note: `ρ g η·cosh k(h−d)/cosh kh at depth d below the mean surface (hydrostatic part removed). Range ±ρ g·0.75 H_s (at least 0.25 m), from H_s = ${input.hs.toFixed(1)} m.`,
      };
    }
    case 'energy': {
      const top = sc.energy;
      const fmt = (v: number) => (v >= 1000 ? `${num(v / 1000)} kJ/m²` : `${num(v)} J/m²`);
      return {
        title: 'Wave energy density',
        gradient: VIRIDIS,
        ticks: ['0 J/m²', fmt(top / 2), `${fmt(top)}+`],
        note: `Instantaneous potential energy density ½ρgη² (not time-averaged). Top of the scale ½ρg(0.75 H_s)² (amplitude at least 0.25 m), from H_s = ${input.hs.toFixed(1)} m.`,
      };
    }
  }
}
