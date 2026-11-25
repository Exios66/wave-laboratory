import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { gfxForcedFull } from './core/gfxOverride';
import { App } from './ui/App';
import { getRuntime } from './ui/runtime';

/**
 * Headless Chromium sometimes reports `en-US@posix`, which `Intl.NumberFormat` rejects.
 * uPlot formats axis ticks with that constructor, so fall back to en-US instead of crashing.
 */
function tolerateInvalidLocales(): void {
  const Native = Intl.NumberFormat;
  function NumberFormat(
    this: Intl.NumberFormat,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions,
  ): Intl.NumberFormat {
    try {
      return new Native(locales, options);
    } catch (err) {
      if (err instanceof RangeError) return new Native('en-US', options);
      throw err;
    }
  }
  NumberFormat.prototype = Native.prototype;
  NumberFormat.supportedLocalesOf = Native.supportedLocalesOf.bind(Native);
  Intl.NumberFormat = NumberFormat as unknown as typeof Intl.NumberFormat;
}

tolerateInvalidLocales();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Diagnostics for the performance tests and for people chasing a slow device: `?gfx=full` or
// `?perf` exposes live renderer and governor readings. Read-only; nothing here steers the lab.
if (gfxForcedFull() || new URLSearchParams(window.location.search).has('perf')) {
  (window as unknown as { __waveLab: unknown }).__waveLab = {
    stats: () => getRuntime().rendererApi?.stats ?? null,
    governor: () => getRuntime().governorState(),
  };
}
