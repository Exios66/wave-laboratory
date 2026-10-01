/// <reference lib="webworker" />
/**
 * Simulation Web Worker. Keeps the physics (ocean FFTs, vessel dynamics, instruments) off the
 * main thread so the UI and renderer stay responsive.
 */
import { parseExperiment } from '../schema/experiment';
import { createSimVessel } from './vessels';
import { Simulation } from './Simulation';
import type { FromWorker, ToWorker } from './types';

declare const self: DedicatedWorkerGlobalScope;

let sim: Simulation | null = null;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function handle(msg: ToWorker): void {
  switch (msg.type) {
    case 'load': {
      const parsed = parseExperiment(msg.experiment);
      if (!parsed.ok) {
        post({ type: 'error', message: `Invalid experiment: ${parsed.errors.join('; ')}` });
        return;
      }
      sim = new Simulation(parsed.experiment, { createVessel: createSimVessel });
      const ocean = sim.gpuData();
      post(
        {
          type: 'loaded',
          ocean,
          vessels: sim.vessels.map((v) => ({ id: v.id, definition: v.definition })),
          diagnostics: sim.diagnostics(),
        },
        ocean.cascades.map((c) => c.h0.buffer as ArrayBuffer),
      );
      post({ type: 'frame', frame: sim.frame() });
      return;
    }
    case 'reset': {
      if (!sim) return;
      handle({ type: 'load', experiment: sim.experiment });
      return;
    }
    case 'advance': {
      if (!sim) return;
      sim.advance(Math.min(Math.max(msg.dt, 0), 0.5));
      post({ type: 'frame', frame: sim.frame() });
      return;
    }
    case 'step': {
      if (!sim) return;
      sim.step(Math.max(0, Math.min(msg.count, 10_000)));
      post({ type: 'frame', frame: sim.frame() });
      return;
    }
    case 'command': {
      if (!sim) return;
      sim.command(msg.vesselId, msg.command);
      return;
    }
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  try {
    handle(ev.data);
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    post({ type: 'error', message });
  }
};
