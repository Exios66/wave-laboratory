import type { GpuPass } from '../render/gpuTimer';

/** Frame stages in the order a frame runs them. */
const PASS_ORDER: readonly GpuPass[] = ['ocean', 'prepass', 'scene', 'post'];

/** "62 fps · GPU 7.1 ms", or "" before the first frame-rate sample. */
export function renderCostText(fps: number, gpuMs: number | null): string {
  if (!(fps > 0)) return '';
  const gpu = gpuMs === null ? '' : ` · GPU ${gpuMs.toFixed(1)} ms`;
  return `${Math.round(fps)} fps${gpu}`;
}

/** Tooltip with the GPU time of each measured pass. */
export function renderCostTitle(
  passes: Partial<Record<GpuPass, number>> | null,
  taa = false,
  lens = false,
): string {
  const parts = PASS_ORDER.filter((p) => passes?.[p] !== undefined).map(
    (p) => `${p} ${passes![p]!.toFixed(1)} ms`,
  );
  const base =
    parts.length === 0
      ? 'Frames drawn per second and GPU time per frame'
      : `GPU time per pass: ${parts.join(' · ')}`;
  const withTaa = taa ? `${base}. Temporal antialiasing on` : base;
  return lens ? `${withTaa}. Raindrops on the lens` : withTaa;
}
