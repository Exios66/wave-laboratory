import { describe, expect, it } from 'vitest';
import { visualGridSize } from '../ocean/cascades';
import {
  decideCapabilities,
  readCapabilities,
  TEXTURE_MARGIN,
  type RawCapabilities,
} from './capabilities';

const desktop: RawCapabilities = {
  floatColorBuffer: true,
  halfFloatColorBuffer: true,
  maxTextureSize: 16384,
};

describe('decideCapabilities', () => {
  it('uses full floats and the top tier on a desktop GPU', () => {
    expect(decideCapabilities(desktop)).toEqual({ oceanTexture: 'float', maxQuality: 'ultra' });
  });
  it('falls back to half floats where only half-float colour buffers exist (iOS Safari)', () => {
    const d = decideCapabilities({ ...desktop, floatColorBuffer: false, maxTextureSize: 4096 });
    expect(d.oceanTexture).toBe('half');
    expect(d.maxQuality).toBe('ultra');
  });
  it('reports an unusable ocean when no float colour buffer exists', () => {
    expect(
      decideCapabilities({ ...desktop, floatColorBuffer: false, halfFloatColorBuffer: false })
        .oceanTexture,
    ).toBe('none');
  });
  it('derives the quality ceiling from the real FFT grid sizes with the stated margin', () => {
    // ultra needs 512 × 4 = 2048, high 1024, medium 512, low 256.
    const at = (maxTextureSize: number) =>
      decideCapabilities({ ...desktop, maxTextureSize }).maxQuality;
    expect(at(visualGridSize('ultra') * TEXTURE_MARGIN)).toBe('ultra');
    expect(at(visualGridSize('ultra') * TEXTURE_MARGIN - 1)).toBe('high');
    expect(at(visualGridSize('high') * TEXTURE_MARGIN - 1)).toBe('medium');
    expect(at(visualGridSize('medium') * TEXTURE_MARGIN - 1)).toBe('low');
    expect(at(0)).toBe('low');
    // Every phone in practice (>= 4096) keeps the top tier.
    expect(at(4096)).toBe('ultra');
  });
});

describe('readCapabilities', () => {
  it('survives a context that throws or lacks extensions', () => {
    const gl = {
      MAX_TEXTURE_SIZE: 1,
      getExtension: () => {
        throw new Error('lost');
      },
      getParameter: () => {
        throw new Error('lost');
      },
    } as unknown as WebGL2RenderingContext;
    expect(readCapabilities(gl)).toEqual({
      floatColorBuffer: false,
      halfFloatColorBuffer: false,
      maxTextureSize: 0,
    });
  });
});
