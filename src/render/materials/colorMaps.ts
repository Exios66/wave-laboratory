/**
 * Colour maps of the scientific overlays. The same stop lists generate the GLSL and the legend the
 * UI draws, so the legend is exact: the shader interpolates in sRGB between the stops (as a CSS
 * linear-gradient does), converts to linear, and the overlay material skips tone mapping.
 */

export interface ColorStop {
  /** Position along the scale, 0…1. */
  offset: number;
  /** sRGB hex colour. */
  color: string;
}

/** Diverging blue–white–orange (colour-blind safe pair) for signed quantities such as η. */
export const DIVERGING_BLUE_ORANGE: readonly ColorStop[] = [
  { offset: 0, color: '#0b3c73' },
  { offset: 0.25, color: '#4d8fc6' },
  { offset: 0.5, color: '#f5f5f5' },
  { offset: 0.75, color: '#f0a04b' },
  { offset: 1, color: '#8a3b00' },
];

/** Viridis (perceptually uniform, colour-blind safe) for magnitudes such as slope. */
export const SEQUENTIAL_VIRIDIS: readonly ColorStop[] = [
  { offset: 0, color: '#440154' },
  { offset: 1 / 7, color: '#46327e' },
  { offset: 2 / 7, color: '#365c8d' },
  { offset: 3 / 7, color: '#277f8e' },
  { offset: 4 / 7, color: '#1fa187' },
  { offset: 5 / 7, color: '#4ac16d' },
  { offset: 6 / 7, color: '#a0da39' },
  { offset: 1, color: '#fde725' },
];

/** Cividis (optimised for colour-vision deficiency) for foam coverage. */
export const SEQUENTIAL_CIVIDIS: readonly ColorStop[] = [
  { offset: 0, color: '#00204d' },
  { offset: 0.2, color: '#31446b' },
  { offset: 0.4, color: '#666970' },
  { offset: 0.6, color: '#958f78' },
  { offset: 0.8, color: '#cbba69' },
  { offset: 1, color: '#ffea46' },
];

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const f = (x: number) => x.toFixed(5);

/** GLSL function `vec3 name(float t)` returning the LINEAR colour at t ∈ [0, 1]. */
export function colorMapGlsl(name: string, stops: readonly ColorStop[]): string {
  let body = '';
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    const ca = hexToRgb(a.color);
    const cb = hexToRgb(b.color);
    body += `  if (t <= ${f(b.offset)}) return srgbToLinear(mix(vec3(${ca.map(f).join(', ')}), vec3(${cb
      .map(f)
      .join(', ')}), (t - ${f(a.offset)}) / ${f(b.offset - a.offset)}));\n`;
  }
  const last = hexToRgb(stops[stops.length - 1]!.color);
  return `vec3 ${name}(float t) {
  t = clamp(t, 0.0, 1.0);
${body}  return srgbToLinear(vec3(${last.map(f).join(', ')}));
}
`;
}

export const SRGB_TO_LINEAR_GLSL = /* glsl */ `
// Exact sRGB electro-optical transfer function.
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
`;
