/**
 * Main-thread handle to the simulation worker. Guarantees at most one `advance` in flight:
 * elapsed time accumulates while the worker is busy, so a slow machine degrades gracefully
 * (larger steps per message, `lagging` flag) instead of building an unbounded message queue.
 */
import { Emitter } from '../core/emitter';
import type { GpuOceanData } from '../ocean/gpuData';
import type { Experiment, OceanQuality, Weather } from '../schema/experiment';
import type { VesselCommand } from '../vessel/api';
import type { FromWorker, SimFrame, ToWorker } from './types';

type LoadedMessage = Extract<FromWorker, { type: 'loaded' }>;

export interface SimClientEvents extends Record<string, unknown> {
  loaded: LoadedMessage;
  ocean: GpuOceanData;
  frame: SimFrame;
  error: string;
}

export class SimClient extends Emitter<SimClientEvents> {
  private worker: Worker;
  private inFlight = false;
  private pendingDt = 0;
  private loading = false;
  private disposed = false;

  constructor(workerFactory?: () => Worker) {
    super();
    this.worker = workerFactory
      ? workerFactory()
      : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      ev.preventDefault();
      this.inFlight = false;
      this.emit('error', ev.message || 'Simulation worker crashed');
    };
  }

  private send(msg: ToWorker): void {
    if (!this.disposed) this.worker.postMessage(msg);
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'loaded':
        this.loading = false;
        this.emit('loaded', msg);
        break;
      case 'ocean':
        this.emit('ocean', msg.ocean);
        break;
      case 'frame':
        this.inFlight = false;
        this.emit('frame', msg.frame);
        break;
      case 'error':
        this.loading = false;
        this.inFlight = false;
        this.emit('error', msg.message);
        break;
    }
  }

  load(experiment: Experiment, visualQuality?: OceanQuality): void {
    this.loading = true;
    this.pendingDt = 0;
    this.inFlight = true; // the worker answers a load with a frame
    this.send(
      visualQuality ? { type: 'load', experiment, visualQuality } : { type: 'load', experiment },
    );
  }

  /** Change the renderer's ocean resolution without restarting the simulation. */
  setVisualQuality(quality: OceanQuality): void {
    this.send({ type: 'visual', quality });
  }

  /** Request the simulation to advance by `dt` seconds of simulated time. */
  advance(dt: number): void {
    this.pendingDt += dt;
    if (this.inFlight || this.loading || this.pendingDt <= 0) return;
    this.inFlight = true;
    const send = this.pendingDt;
    this.pendingDt = 0;
    this.send({ type: 'advance', dt: send });
  }

  /** Single-step (while paused). */
  step(count = 1): void {
    if (this.loading) return;
    this.inFlight = true;
    this.send({ type: 'step', count });
  }

  /** Update rain, cloud, visibility and lightning in the running simulation. */
  setWeather(weather: Weather): void {
    this.send({ type: 'weather', weather });
  }

  command(vesselId: string, command: VesselCommand): void {
    this.send({ type: 'command', vesselId, command });
  }

  get busy(): boolean {
    return this.inFlight || this.loading;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.worker.terminate();
  }
}
