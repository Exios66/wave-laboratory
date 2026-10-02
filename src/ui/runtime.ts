/**
 * Runtime glue between the store, the simulation worker and the renderer. One instance per page.
 *
 * Data flow:  store.experiment ──load──▶ worker ──loaded/frame──▶ store + renderer
 *             requestAnimationFrame ──advance(dt × timeScale)──▶ worker
 * The renderer always draws the ocean at the time of the latest physics frame, so the vessels
 * and the waves you see are the same state.
 */
import type { LabRendererApi } from '../render/api';
import { SimClient } from '../sim/SimClient';
import type { FromWorker } from '../sim/types';
import type { VesselCommand } from '../vessel/api';
import {
  detectDeviceProfile,
  effectiveQuality,
  graphicsBudget,
  ResolutionGovernor,
} from './deviceProfile';
import { useLab } from './store';
import { telemetry } from './telemetry';

export class LabRuntime {
  readonly client: SimClient;
  private renderer: LabRendererApi | null = null;
  private raf = 0;
  private lastTime = 0;
  private loadedRevision = -1;
  private unsubscribers: (() => void)[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private lastLoaded: Extract<FromWorker, { type: 'loaded' }> | null = null;
  private readonly governor = new ResolutionGovernor();
  private canvas: HTMLCanvasElement | null = null;
  private visualQuality: string | null = null;
  /** Smoothed time the picture is drawn at. Physics frames arrive in bursts; this glides. */
  private displayT = 0;
  private simT = 0;
  private uiStamp = 0;

  constructor() {
    this.client = new SimClient();
    this.client.on('loaded', (msg) => {
      const defs = Object.fromEntries(msg.vessels.map((v) => [v.id, v.definition]));
      useLab.getState().simLoaded(defs, msg.diagnostics);
      this.lastLoaded = msg;
      this.pushSceneToRenderer();
    });
    this.client.on('ocean', (ocean) => {
      if (this.lastLoaded) this.lastLoaded = { ...this.lastLoaded, ocean };
      this.renderer?.setOcean(ocean);
    });
    this.client.on('frame', (frame) => {
      if (frame.samples) telemetry.append(frame.samples);
      this.simT = frame.t;
      if (frame.t + 1e-4 < this.displayT) this.displayT = frame.t;
      this.renderer?.setFrame(frame);
      const now = performance.now();
      const playing = useLab.getState().playing;
      if (!playing || now - this.uiStamp > 80) {
        this.uiStamp = now;
        useLab.getState().simFrame(frame);
      }
    });
    this.client.on('error', (message) => {
      console.error('[simulation]', message);
      useLab.getState().simError(message.split('\n')[0] ?? message);
    });

    this.unsubscribers.push(
      useLab.subscribe((s, prev) => {
        if (s.revision !== this.loadedRevision) this.load();
        else if (s.performance !== prev.performance) this.applyPerformanceMode();
        if (!this.renderer) return;
        if (s.overlay !== prev.overlay) this.renderer.setOverlay(s.overlay);
        if (s.camera !== prev.camera || s.cameraTarget !== prev.cameraTarget) {
          this.renderer.setCamera(s.camera, s.cameraTarget);
        }
        if (s.selection !== prev.selection) {
          this.renderer.setSelection(selectionId(s.selection));
        }
        if (s.experiment.weather !== prev.experiment.weather) {
          this.renderer.setWeather(s.experiment.weather);
        }
        if (s.experiment.environment !== prev.experiment.environment) {
          this.renderer.setEnvironment(s.experiment.environment);
        }
      }),
    );
    this.load();
  }

  private targetQuality() {
    const s = useLab.getState();
    return effectiveQuality(s.experiment.quality, s.performance, detectDeviceProfile());
  }

  private load(): void {
    const s = useLab.getState();
    this.loadedRevision = s.revision;
    telemetry.clear();
    const quality = this.targetQuality();
    this.visualQuality = quality;
    this.renderer?.setQuality(quality);
    this.client.load(s.experiment, quality);
  }

  /** Re-derive graphics settings after the performance mode changed (no simulation restart). */
  private applyPerformanceMode(): void {
    const quality = this.targetQuality();
    if (quality !== this.visualQuality) {
      this.visualQuality = quality;
      this.client.setVisualQuality(quality);
    }
    this.renderer?.setQuality(quality);
    this.configureGovernor();
    if (this.canvas) this.resize(this.canvas);
  }

  private configureGovernor(): void {
    const budget = graphicsBudget(useLab.getState().performance, detectDeviceProfile());
    const g = this.governor;
    g.maxScale = 1;
    g.minScale = budget.minScale;
    g.targetFps = budget.targetFps;
    g.scale = Math.min(Math.max(g.scale, g.minScale), g.maxScale);
    useLab.getState().setRenderScale(g.scale);
  }

  /** Attach the 3D view. `createRenderer` may throw if WebGL 2 is unavailable. */
  attach(
    canvas: HTMLCanvasElement,
    createRenderer: (c: HTMLCanvasElement) => LabRendererApi,
  ): void {
    this.detach();
    try {
      this.renderer = createRenderer(canvas);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useLab.getState().simUnsupported(message);
      return;
    }
    const s = useLab.getState();
    this.renderer.setQuality(this.targetQuality());
    this.renderer.setOverlay(s.overlay);
    this.renderer.setCamera(s.camera, s.cameraTarget);
    this.renderer.setSelection(selectionId(s.selection));
    this.pushSceneToRenderer();
    this.canvas = canvas;
    this.configureGovernor();
    const parent = canvas.parentElement ?? canvas;
    this.resizeObserver = new ResizeObserver(() => this.resize(canvas));
    this.resizeObserver.observe(parent);
    this.resize(canvas);
    this.lastTime = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  detach(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas = null;
  }

  get rendererApi(): LabRendererApi | null {
    return this.renderer;
  }

  private resize(canvas: HTMLCanvasElement): void {
    const parent = canvas.parentElement ?? canvas;
    const rect = parent.getBoundingClientRect();
    const s = useLab.getState();
    const cap = graphicsBudget(s.performance, detectDeviceProfile()).maxPixelRatio;
    const ratio = Math.min(window.devicePixelRatio || 1, cap) * this.governor.scale;
    this.renderer?.resize(
      Math.max(1, Math.floor(rect.width)),
      Math.max(1, Math.floor(rect.height)),
      Math.max(0.35, ratio),
    );
  }

  private pushSceneToRenderer(): void {
    const r = this.renderer;
    const loaded = this.lastLoaded;
    if (!r || !loaded) return;
    const exp = useLab.getState().experiment;
    r.setOcean(loaded.ocean);
    r.setWeather(exp.weather);
    r.setEnvironment(exp.environment);
    r.setVessels(loaded.vessels);
    r.setProbes(exp.probes);
    const frame = useLab.getState().frame;
    if (frame) r.setFrame(frame);
  }

  private tick(now: number): void {
    // Clamp long gaps (tab in background, debugger) so the simulation never jumps.
    const wall = Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    const s = useLab.getState();
    if (s.playing && s.status === 'ready') this.client.advance(wall * s.timeScale);
    this.advanceDisplayClock(wall, s.playing && s.status === 'ready', s.timeScale);
    this.renderer?.setVisualTime(this.displayT);
    if (this.renderer && !document.hidden && this.governor.frame(wall) && this.canvas) {
      this.resize(this.canvas);
      s.setRenderScale(this.governor.scale);
    }
    this.renderer?.render();
  }

  private advanceDisplayClock(wall: number, playing: boolean, timeScale: number): void {
    const target = this.simT;
    const lag = target - this.displayT;
    if (!playing || lag < -1e-3 || lag > 0.45) {
      this.displayT = target;
      return;
    }
    this.displayT += Math.min(lag, wall * timeScale);
  }

  stepOnce(): void {
    const s = useLab.getState();
    this.client.step(Math.max(1, Math.round(0.1 / s.experiment.timestep)));
  }

  command(vesselId: string, cmd: VesselCommand): void {
    this.client.command(vesselId, cmd);
  }

  restart(): void {
    telemetry.clear();
    this.client.reset();
  }

  dispose(): void {
    this.detach();
    for (const u of this.unsubscribers) u();
    this.client.dispose();
  }
}

function selectionId(sel: ReturnType<typeof useLab.getState>['selection']): string | null {
  return sel && 'id' in sel ? sel.id : null;
}

let instance: LabRuntime | null = null;

export function getRuntime(): LabRuntime {
  instance ??= new LabRuntime();
  return instance;
}
