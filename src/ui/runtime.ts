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

  constructor() {
    this.client = new SimClient();
    this.client.on('loaded', (msg) => {
      const defs = Object.fromEntries(msg.vessels.map((v) => [v.id, v.definition]));
      useLab.getState().simLoaded(defs, msg.diagnostics);
      this.lastLoaded = msg;
      this.pushSceneToRenderer();
    });
    this.client.on('frame', (frame) => {
      if (frame.samples) telemetry.append(frame.samples);
      useLab.getState().simFrame(frame);
      this.renderer?.setFrame(frame);
    });
    this.client.on('error', (message) => {
      console.error('[simulation]', message);
      useLab.getState().simError(message.split('\n')[0] ?? message);
    });

    this.unsubscribers.push(
      useLab.subscribe((s, prev) => {
        if (s.revision !== this.loadedRevision) this.load();
        if (!this.renderer) return;
        if (s.overlay !== prev.overlay) this.renderer.setOverlay(s.overlay);
        if (s.camera !== prev.camera || s.cameraTarget !== prev.cameraTarget) {
          this.renderer.setCamera(s.camera, s.cameraTarget);
        }
        if (s.selection !== prev.selection) {
          this.renderer.setSelection(selectionId(s.selection));
        }
        if (s.experiment.environment !== prev.experiment.environment) {
          this.renderer.setEnvironment(s.experiment.environment);
        }
      }),
    );
    this.load();
  }

  private load(): void {
    const s = useLab.getState();
    this.loadedRevision = s.revision;
    telemetry.clear();
    this.client.load(s.experiment);
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
    this.renderer.setOverlay(s.overlay);
    this.renderer.setCamera(s.camera, s.cameraTarget);
    this.renderer.setSelection(selectionId(s.selection));
    this.pushSceneToRenderer();
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
  }

  get rendererApi(): LabRendererApi | null {
    return this.renderer;
  }

  private resize(canvas: HTMLCanvasElement): void {
    const parent = canvas.parentElement ?? canvas;
    const rect = parent.getBoundingClientRect();
    this.renderer?.resize(
      Math.max(1, Math.floor(rect.width)),
      Math.max(1, Math.floor(rect.height)),
      Math.min(window.devicePixelRatio || 1, 2),
    );
  }

  private pushSceneToRenderer(): void {
    const r = this.renderer;
    const loaded = this.lastLoaded;
    if (!r || !loaded) return;
    const exp = useLab.getState().experiment;
    r.setOcean(loaded.ocean);
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
    this.renderer?.render();
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
