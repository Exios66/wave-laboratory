/** Types shared by the simulation worker, its client and the UI. */
import type { GpuOceanData } from '../ocean/gpuData';
import type { SampleBlock } from './recorder';
import type { Experiment, OceanQuality } from '../schema/experiment';
import type { VesselCommand, VesselDefinition, VesselTelemetry } from '../vessel/api';

export interface ProbeReading {
  id: string;
  eta: number;
}

export interface SimFrame {
  /** Simulation time of this state [s]. */
  t: number;
  vessels: VesselTelemetry[];
  probes: ProbeReading[];
  /** Physics wall-clock cost of the last advance [ms]. */
  stepMs: number;
  /** True when the simulation cannot keep up with the requested time scale. */
  lagging: boolean;
  /** Fixed-rate recordings since the previous frame (channel names: `<id>:<quantity>`). */
  samples: SampleBlock | null;
}

export type { SampleBlock };

export interface SeaDiagnostics {
  /** Expected H_s of everything represented (all cascades + regular waves) [m]. */
  hs: number;
  /** H_s actually present on the discrete spectral grid (differs from `hs` by ~1 %) [m]. */
  representedHs: number;
  /** Per-system details for the inspector. */
  systems: { id: string; hs: number; tp: number; wavelength: number; note?: string }[];
  /** Validity warnings (e.g. steepness beyond the breaking limit). */
  warnings: string[];
}

/** Messages main thread → worker. */
export type ToWorker =
  | { type: 'load'; experiment: Experiment; visualQuality?: OceanQuality }
  | { type: 'visual'; quality: OceanQuality }
  | { type: 'advance'; dt: number }
  | { type: 'step'; count: number }
  | { type: 'reset' }
  | { type: 'command'; vesselId: string; command: VesselCommand };

/** Messages worker → main thread. */
export type FromWorker =
  | {
      type: 'loaded';
      ocean: GpuOceanData;
      vessels: { id: string; definition: VesselDefinition }[];
      diagnostics: SeaDiagnostics;
    }
  | { type: 'ocean'; ocean: GpuOceanData }
  | { type: 'frame'; frame: SimFrame }
  | { type: 'error'; message: string };
