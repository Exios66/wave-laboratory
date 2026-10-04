/**
 * The GPU ocean compares a few texels with the CPU FFT after each new sea. That check is a
 * synchronous `readPixels` (a full GPU stall) plus a whole-cascade inverse FFT on the main
 * thread, so it must not run on the interactive frame for visitors.
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
