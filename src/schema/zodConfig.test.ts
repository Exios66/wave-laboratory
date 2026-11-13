import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseExperiment } from './experiment';

describe('zod under the Content-Security-Policy', () => {
  it('runs jitless, so it never probes eval (a CSP violation even when caught)', () => {
    expect(typeof parseExperiment).toBe('function');
    expect(z.config().jitless).toBe(true);
  });
});
