/**
 * Public contract of the renderer (consumed by the UI). The implementation lives in
 * `LabRenderer.ts`; nothing outside `src/render` may import Three.js directly.
 */
import type { GpuOceanData } from '../ocean/gpuData';
import type { Environment, ProbeConfig } from '../schema/experiment';
import type { SimFrame } from '../sim/types';
import type { VesselDefinition } from '../vessel/api';

export type OverlayMode = 'none' | 'height' | 'steepness' | 'foam';
export type CameraMode = 'orbit' | 'follow' | 'bridge' | 'top';

export interface PickResult {
  kind: 'vessel' | 'probe' | 'water';
  id?: string;
  /** World-space hit point (z-up). */
  point: { x: number; y: number; z: number };
}

export interface RendererStats {
  fps: number;
  /** CPU time spent in render() [ms]. */
  frameMs: number;
  drawCalls: number;
  triangles: number;
}

export interface LabRendererApi {
  /** Upload a new spectral sea (called after every experiment load). */
  setOcean(data: GpuOceanData): void;
  setEnvironment(env: Environment): void;
  setVessels(vessels: readonly { id: string; definition: VesselDefinition }[]): void;
  setProbes(probes: readonly ProbeConfig[]): void;
  /** Latest simulation state; the ocean is rendered at frame.t so it matches the physics. */
  setFrame(frame: SimFrame): void;
  /**
   * Time to draw this animation frame. It glides between physics frames so the sea and the
   * ships do not jump when a worker result arrives.
   */
  setVisualTime(t: number): void;
  setOverlay(mode: OverlayMode): void;
  setCamera(mode: CameraMode, targetId?: string | null): void;
  setSelection(id: string | null): void;
  /** Render one frame (call from requestAnimationFrame). */
  render(): void;
  resize(width: number, height: number, pixelRatio: number): void;
  /** Pick at canvas-relative CSS pixel coordinates. */
  pick(x: number, y: number): PickResult | null;
  /** Keyboard camera control (accessible alternative to pointer orbiting). */
  nudgeCamera(action: 'left' | 'right' | 'up' | 'down' | 'in' | 'out' | 'reset'): void;
  readonly stats: RendererStats;
  dispose(): void;
}
