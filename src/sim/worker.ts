/// <reference lib="webworker" />
/**
 * Simulation Web Worker. Keeps the physics (ocean FFTs, vessel dynamics, instruments) off the
 * main thread so the UI and renderer stay responsive.
 */
import { parseExperiment, type OceanQuality } from '../schema/experiment';
import { createSimVessel } from './vessels';
import { Simulation } from './Simulation';
import type { FromWorker, ToWorker } from './types';

declare const self: DedicatedWorkerGlobalScope;

let sim: Simulation | null = null;
let visualQuality: OceanQuality | undefined;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

/** Longest stretch of simulated time one advance message may cover [s]. */
const MAX_ADVANCE = 0.5;

function noSimulation(): void {
  post({ type: 'error', message: 'No experiment is loaded.' });
}

function handle(msg: ToWorker): void {
  switch (msg.type) {
    case 'load': {
      const parsed = parseExperiment(msg.experiment);
      if (!parsed.ok) {
        // Drop the previous simulation too, so nothing keeps running an experiment the UI no
        // longer shows.
        sim = null;
        post({ type: 'error', message: `Invalid experiment: ${parsed.errors.join('; ')}` });
        return;
      }
      if (msg.visualQuality) visualQuality = msg.visualQuality;
      sim = new Simulation(parsed.experiment, { createVessel: createSimVessel });
      const ocean = sim.gpuData(visualQuality);
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
    case 'visual': {
      visualQuality = msg.quality;
      if (!sim) return;
      const ocean = sim.gpuData(visualQuality);
      post(
        { type: 'ocean', ocean },
        ocean.cascades.map((c) => c.h0.buffer as ArrayBuffer),
      );
      return;
    }
    case 'weather': {
      sim?.weather.setAtmosphere(msg.weather);
      return;
    }
    case 'advance': {
      // The client waits for a reply to every advance and step, so never stay silent.
      if (!sim) return noSimulation();
      const dt = Math.max(msg.dt, 0);
      sim.advance(Math.min(dt, MAX_ADVANCE));
      const frame = sim.frame(msg.cameraProbe);
      // Time beyond the cap is dropped: the run is slower than requested, so say so.
      if (dt > MAX_ADVANCE) frame.lagging = true;
      post({ type: 'frame', frame });
      return;
    }
    case 'step': {
      if (!sim) return noSimulation();
      sim.step(Math.max(0, Math.min(msg.count, 10_000)));
      post({ type: 'frame', frame: sim.frame(msg.cameraProbe) });
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
