/**
 * Scope of the check: this bails silently on the half-float compatibility path, reads back
 * only cascade 0, and compares only the four texels of the combined output. It does NOT
 * cover the slope textures, cascades 1–3, or the regular-wave path.
 *
 * Even that much is a synchronous `readPixels` (a full GPU stall) plus a whole-cascade
 * inverse FFT on the main thread, so it must not run on the interactive frame for visitors.
 *
 * Playwright sets `navigator.webdriver`; local `vite` sets `import.meta.env.DEV`. Either of
 * those, or `?verify-gpu` on the URL, keeps the check so a shader regression still fails tests.
 */
export function gpuVerifyWanted(
  locationSearch = typeof window === 'undefined' ? '' : window.location.search,
  webdriver = typeof navigator !== 'undefined' && Boolean(navigator.webdriver),
  dev = import.meta.env.DEV,
): boolean {
  if (dev || webdriver) return true;
  try {
    return new URLSearchParams(locationSearch).has('verify-gpu');
  } catch {
    return false;
  }
}
