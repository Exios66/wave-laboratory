import { describe, expect, it } from 'vitest';
import { errorText, isChunkLoadError } from './errorText';

describe('errorText', () => {
  it('recognises failed lazy-chunk loads from each browser', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: x'))).toBe(
      true,
    );
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module: y'))).toBe(true);
    expect(isChunkLoadError('Failed to fetch dynamically imported module: z')).toBe(true);
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it('turns any thrown value into readable text', () => {
    expect(errorText('str')).toBe('str');
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText(42)).toBe('42');
    expect(errorText(new TypeError('Failed to fetch dynamically imported module: x'))).toBe(
      'A newer version of Wave Laboratory was published. Reload to continue.',
    );
  });
});
