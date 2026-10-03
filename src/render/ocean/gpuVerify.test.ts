import { describe, expect, it } from 'vitest';
import { gpuVerifyWanted } from './gpuVerify';

describe('gpuVerifyWanted', () => {
  it('runs in automated browsers and when asked, not for ordinary visitors', () => {
    expect(gpuVerifyWanted('', false, false)).toBe(false);
    expect(gpuVerifyWanted('', true, false)).toBe(true);
    expect(gpuVerifyWanted('', false, true)).toBe(true);
    expect(gpuVerifyWanted('?verify-gpu', false, false)).toBe(true);
    expect(gpuVerifyWanted('?foo=1', false, false)).toBe(false);
  });
});
