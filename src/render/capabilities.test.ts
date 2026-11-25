import { describe, expect, it } from 'vitest';
import { decideCapabilities, readCapabilities, type RawCapabilities } from './capabilities';

const desktop: RawCapabilities = {
  floatColorBuffer: true,
  halfFloatColorBuffer: true,
  floatLinearFilter: true,
  maxTextureSize: 16384,
  maxSamples: 8,
};

describe('decideCapabilities', () => {
  it('uses full floats and the top tier on a desktop GPU', () => {
    const d = decideCapabilities(desktop);
    expect(d.oceanTexture).toBe('float');
    expect(d.hdrPost).toBe(true);
    expect(d.maxQuality).toBe('ultra');
    expect(d.samples).toBe(4);
    expect(d.notes).toEqual([]);
  });
  it('falls back to half floats where only half-float colour buffers exist (iOS Safari)', () => {
    const d = decideCapabilities({
      ...desktop,
      floatColorBuffer: false,
      floatLinearFilter: false,
      maxTextureSize: 4096,
    });
    expect(d.oceanTexture).toBe('half');
    expect(d.hdrPost).toBe(true);
    expect(d.maxQuality).toBe('ultra');
    expect(d.notes.join(' ')).toMatch(/half-float/);
  });
  it('reports an unusable ocean when no float colour buffer exists', () => {
    const d = decideCapabilities({
      ...desktop,
      floatColorBuffer: false,
      halfFloatColorBuffer: false,
    });
    expect(d.oceanTexture).toBe('none');
    expect(d.hdrPost).toBe(false);
  });
  it('caps the quality tier by the maximum texture size', () => {
    expect(decideCapabilities({ ...desktop, maxTextureSize: 2048 }).maxQuality).toBe('medium');
    expect(decideCapabilities({ ...desktop, maxTextureSize: 1024 }).maxQuality).toBe('low');
    expect(decideCapabilities({ ...desktop, maxTextureSize: 0 }).maxQuality).toBe('low');
  });
  it('notes nearest-filtered 32-bit floats and clamps MSAA samples', () => {
    const d = decideCapabilities({ ...desktop, floatLinearFilter: false, maxSamples: 0 });
    expect(d.notes.join(' ')).toMatch(/nearest/);
    expect(d.samples).toBe(0);
  });
});

describe('readCapabilities', () => {
  it('survives a context that throws or lacks extensions', () => {
    const gl = {
      MAX_TEXTURE_SIZE: 1,
      MAX_SAMPLES: 2,
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
      floatLinearFilter: false,
      maxTextureSize: 0,
      maxSamples: 0,
    });
  });
});
