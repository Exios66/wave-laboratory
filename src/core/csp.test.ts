import { describe, expect, it } from 'vitest';
import { CSP_DIRECTIVES, cspContent, cspMetaTag } from './csp';

describe('Content-Security-Policy', () => {
  it('allows only this site, plus what the app itself needs', () => {
    expect(cspContent()).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it('renders as a meta tag', () => {
    expect(cspMetaTag()).toMatch(
      /^<meta http-equiv="Content-Security-Policy" content="default-src 'self';[^"]*" \/>$/,
    );
  });

  it('never allows inline or evaluated script', () => {
    expect(CSP_DIRECTIVES['script-src']).not.toContain("'unsafe-inline'");
    expect(CSP_DIRECTIVES['script-src']).not.toContain("'unsafe-eval'");
  });
});
