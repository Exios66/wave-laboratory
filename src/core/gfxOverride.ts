/**
 * `?gfx=full` on the URL treats the device as a dedicated GPU even when it reports a software
 * or phone renderer. It exists so the full graphics path (MSAA, HDR post, every quality level)
 * can be exercised under Playwright's SwiftShader and when diagnosing a misdetected GPU.
 */
export function gfxForcedFull(
  locationSearch = typeof window === 'undefined' ? '' : window.location.search,
): boolean {
  try {
    return new URLSearchParams(locationSearch).get('gfx') === 'full';
  } catch {
    return false;
  }
}
