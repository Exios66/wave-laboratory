/**
 * What this GPU/browser can do, reduced to decisions (no three.js here, so it is unit-tested with
 * plain objects). iOS Safari and older Android often lack 32-bit float colour buffers
 * (`EXT_color_buffer_float`) or have a small `MAX_TEXTURE_SIZE`; the lab degrades to half
 * floats and a lower quality ceiling instead of failing.
 */
import type { OceanQuality } from '../schema/experiment';

export interface RawCapabilities {
  floatColorBuffer: boolean;
  halfFloatColorBuffer: boolean;
  floatLinearFilter: boolean;
  maxTextureSize: number;
  maxSamples: number;
}

export interface CapabilityDecision {
  /** Texture type for the ocean spectrum targets; `none` means the ocean cannot be drawn. */
  oceanTexture: 'float' | 'half' | 'none';
  /** HDR post chain (bloom, TAA) possible. */
  hdrPost: boolean;
  /** Highest quality tier the texture limits allow. */
  maxQuality: OceanQuality;
  /** MSAA sample count to request (0 = none). */
  samples: number;
  /** Why anything was reduced, for the diagnostics readout. */
  notes: string[];
}

/** Ocean FFT grids per quality, in texels per side (see QUALITY in LabRenderer). */
const MIN_TEXTURE_FOR: Record<OceanQuality, number> = {
  low: 1024,
  medium: 2048,
  high: 4096,
  ultra: 4096,
};

export function decideCapabilities(raw: RawCapabilities): CapabilityDecision {
  const notes: string[] = [];
  const oceanTexture = raw.floatColorBuffer ? 'float' : raw.halfFloatColorBuffer ? 'half' : 'none';
  if (oceanTexture === 'half') notes.push('half-float ocean (no 32-bit float colour buffers)');
  if (oceanTexture === 'none') notes.push('no floating-point colour buffers');
  const hdrPost = raw.floatColorBuffer || raw.halfFloatColorBuffer;
  let maxQuality: OceanQuality = 'ultra';
  for (const q of ['ultra', 'high', 'medium', 'low'] as const) {
    if (raw.maxTextureSize >= MIN_TEXTURE_FOR[q]) {
      maxQuality = q;
      break;
    }
    maxQuality = 'low';
  }
  if (maxQuality !== 'ultra') notes.push(`texture limit ${raw.maxTextureSize} caps quality`);
  if (!raw.floatLinearFilter && oceanTexture === 'float') {
    notes.push('nearest-filtered float ocean (no OES_texture_float_linear)');
  }
  const samples = Math.max(0, Math.min(4, Math.floor(raw.maxSamples || 0)));
  return { oceanTexture, hdrPost, maxQuality, samples, notes };
}

/** Read the raw numbers from a WebGL 2 context. Safe on a lost or partial context. */
export function readCapabilities(gl: WebGL2RenderingContext): RawCapabilities {
  const ext = (name: string) => {
    try {
      return gl.getExtension(name) !== null;
    } catch {
      return false;
    }
  };
  const num = (p: number) => {
    try {
      const v = gl.getParameter(p) as unknown;
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  };
  return {
    floatColorBuffer: ext('EXT_color_buffer_float'),
    halfFloatColorBuffer: ext('EXT_color_buffer_half_float'),
    floatLinearFilter: ext('OES_texture_float_linear'),
    maxTextureSize: num(gl.MAX_TEXTURE_SIZE),
    maxSamples: num(gl.MAX_SAMPLES),
  };
}
