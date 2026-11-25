/**
 * What this GPU/browser can do, reduced to decisions (no three.js here, so it is unit-tested with
 * plain objects). iOS Safari and older Android often lack 32-bit float colour buffers
 * (`EXT_color_buffer_float`) or have a small `MAX_TEXTURE_SIZE`; the lab degrades to half
 * floats and a lower quality ceiling instead of failing.
 */
import { visualGridSize } from '../ocean/cascades';
import type { OceanQuality } from '../schema/experiment';

export interface RawCapabilities {
  floatColorBuffer: boolean;
  halfFloatColorBuffer: boolean;
  maxTextureSize: number;
}

export interface CapabilityDecision {
  /** Texture type for the ocean spectrum targets; `none` means the ocean cannot be drawn. */
  oceanTexture: 'float' | 'half' | 'none';
  /** Highest quality tier the texture limit allows. */
  maxQuality: OceanQuality;
}

/**
 * Headroom over the FFT grid edge (`visualGridSize`) that the texture limit must give: the
 * spectrum textures are grid-sized, and the margin leaves room for packed layouts and the
 * mip chain. A device reporting less than `grid × margin` drops to the next tier down.
 */
export const TEXTURE_MARGIN = 4;

const TIERS_DESCENDING: readonly OceanQuality[] = ['ultra', 'high', 'medium', 'low'];

export function decideCapabilities(raw: RawCapabilities): CapabilityDecision {
  const oceanTexture = raw.floatColorBuffer ? 'float' : raw.halfFloatColorBuffer ? 'half' : 'none';
  const maxQuality =
    TIERS_DESCENDING.find((q) => raw.maxTextureSize >= visualGridSize(q) * TEXTURE_MARGIN) ?? 'low';
  return { oceanTexture, maxQuality };
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
  let maxTextureSize = 0;
  try {
    const v = gl.getParameter(gl.MAX_TEXTURE_SIZE) as unknown;
    if (typeof v === 'number' && Number.isFinite(v)) maxTextureSize = v;
  } catch {
    // A lost context reads as zero: the quality ceiling falls to low.
  }
  return {
    floatColorBuffer: ext('EXT_color_buffer_float'),
    halfFloatColorBuffer: ext('EXT_color_buffer_half_float'),
    maxTextureSize,
  };
}
