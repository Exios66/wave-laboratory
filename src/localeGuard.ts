/**
 * Some environments (e.g. headless browsers started without a locale) report a POSIX locale such
 * as "en-US@posix" in navigator.language, which Intl rejects. Libraries that format numbers with
 * the browser locale at import time (uPlot) would then crash the whole app. Normalise it before
 * anything else is imported.
 */
function isValidLocale(tag: string): boolean {
  try {
    new Intl.NumberFormat(tag);
    return true;
  } catch {
    return false;
  }
}

if (typeof navigator !== 'undefined' && !isValidLocale(navigator.language)) {
  const cleaned = navigator.language.split(/[@.]/)[0]?.replace('_', '-') ?? '';
  const fallback = isValidLocale(cleaned) ? cleaned : 'en-US';
  try {
    Object.defineProperty(navigator, 'language', { get: () => fallback, configurable: true });
  } catch {
    /* read-only in this browser: nothing more we can do */
  }
}

export {};
