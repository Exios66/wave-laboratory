/**
 * Types of `window.gpuHarness` (src/render/testHarness.ts) as seen from the Node-side specs, which
 * compile without the DOM library. Use as `(globalThis as unknown as HarnessGlobal).gpuHarness`
 * inside `page.evaluate` callbacks (types are erased, so nothing is captured).
 */
import type { Page } from '@playwright/test';

export interface FftResult {
  floatPath: string;
  n: number;
  sizes: number[];
  results: { t: number; cascades: { disp: string; deriv: string }[] }[];
}

export interface PickResult {
  kind: 'vessel' | 'probe' | 'water';
  id?: string;
  point: { x: number; y: number; z: number };
}

export interface Legend {
  mode: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  stops: { offset: number; color: string }[];
}

export interface Harness {
  fft(cfg: unknown): FftResult;
  sample(cfg: unknown): { floatPath: string; values: number[][] };
  startScene(opts?: {
    quality?: string;
    forceHalfFloat?: boolean;
    pixelRatio?: number;
    sunElevationDeg?: number;
    sunAzimuthDeg?: number;
  }): { floatPath: string };
  step(frames?: number, dt?: number): void;
  glError(): number;
  canvasStats(): { mean: number; std: number };
  setOverlay(mode: string): Legend | null;
  setCamera(mode: string, id?: string | null): void;
  setSelection(id: string | null): void;
  nudge(action: string): void;
  pick(x: number, y: number): PickResult | null;
  picks(): (PickResult | null)[];
  stats(): { fps: number; frameMs: number; drawCalls: number; triangles: number };
  contextEvents(): { lost: number; restored: number };
  loseContext(): void;
  restoreContext(): void;
  resize(w: number, h: number, pr: number): void;
  disposeScene(): { geometries: number; textures: number; programs: number; floatPath: string };
}

export interface HarnessGlobal {
  gpuHarness: Harness;
}

export async function openHarness(page: Page): Promise<void> {
  await page.goto('/gpu-test.html');
  await page.waitForSelector('body[data-ready="true"]');
}
