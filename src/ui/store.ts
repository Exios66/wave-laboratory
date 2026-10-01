/**
 * Application state (Zustand). The experiment document is the single source of truth for the
 * scene; every structural edit goes through `updateExperiment`, which records undo history and
 * schedules a simulation reload.
 */
import { create } from 'zustand';
import type { CameraMode, OverlayMode } from '../render/api';
import {
  parseExperiment,
  type Experiment,
  type ProbeConfig,
  type VesselConfig,
  type WaveSystem,
} from '../schema/experiment';
import { presetExperiment } from '../schema/presets';
import type { SeaDiagnostics, SimFrame } from '../sim/types';
import type { VesselDefinition } from '../vessel/api';

export type Selection =
  | { kind: 'environment' }
  | { kind: 'wave'; id: string }
  | { kind: 'vessel'; id: string }
  | { kind: 'probe'; id: string }
  | null;

export type SimStatus = 'loading' | 'ready' | 'error' | 'unsupported';
export type DockTab = 'gauges' | 'motions' | 'spectrum' | 'statistics';
export type ThemePreference = 'system' | 'dark' | 'light';

export interface Notice {
  id: number;
  tone: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface LabState {
  experiment: Experiment;
  /** Monotonic revision; the simulation reloads whenever it changes. */
  revision: number;
  past: Experiment[];
  future: Experiment[];
  dirty: boolean;

  selection: Selection;
  playing: boolean;
  timeScale: number;

  status: SimStatus;
  error: string | null;
  frame: SimFrame | null;
  diagnostics: SeaDiagnostics | null;
  vesselDefinitions: Record<string, VesselDefinition>;

  overlay: OverlayMode;
  camera: CameraMode;
  cameraTarget: string | null;

  theme: ThemePreference;
  dockTab: DockTab;
  dialog: 'help' | 'presets' | 'about' | null;
  notices: Notice[];

  // actions
  updateExperiment(recipe: (draft: Experiment) => void, opts?: { reload?: boolean }): void;
  loadExperiment(exp: Experiment, message?: string): void;
  undo(): void;
  redo(): void;
  select(sel: Selection): void;
  setPlaying(playing: boolean): void;
  setTimeScale(scale: number): void;
  setOverlay(mode: OverlayMode): void;
  setCamera(mode: CameraMode, target?: string | null): void;
  setTheme(theme: ThemePreference): void;
  setDockTab(tab: DockTab): void;
  openDialog(dialog: LabState['dialog']): void;
  notify(tone: Notice['tone'], message: string): void;
  dismissNotice(id: number): void;
  // simulation bridge callbacks
  simLoaded(defs: Record<string, VesselDefinition>, diagnostics: SeaDiagnostics): void;
  simFrame(frame: SimFrame): void;
  simError(message: string): void;
  simUnsupported(message: string): void;
}

const HISTORY_LIMIT = 100;
let noticeId = 0;

function readTheme(): ThemePreference {
  try {
    const t = localStorage.getItem('wave-lab:theme');
    return t === 'dark' || t === 'light' ? t : 'system';
  } catch {
    return 'system';
  }
}

export const useLab = create<LabState>()((set, get) => ({
  experiment: presetExperiment(),
  revision: 0,
  past: [],
  future: [],
  dirty: false,

  selection: null,
  playing: true,
  timeScale: 1,

  status: 'loading',
  error: null,
  frame: null,
  diagnostics: null,
  vesselDefinitions: {},

  overlay: 'none',
  camera: 'orbit',
  cameraTarget: null,

  theme: readTheme(),
  dockTab: 'gauges',
  dialog: null,
  notices: [],

  updateExperiment(recipe, opts) {
    const prev = get().experiment;
    const draft = structuredClone(prev);
    recipe(draft);
    const parsed = parseExperiment(draft);
    if (!parsed.ok) {
      get().notify('error', `Change rejected: ${parsed.errors[0] ?? 'invalid value'}`);
      return;
    }
    const reload = opts?.reload ?? true;
    set((s) => ({
      experiment: parsed.experiment,
      past: [...s.past, prev].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
      revision: reload ? s.revision + 1 : s.revision,
      status: reload ? 'loading' : s.status,
    }));
  },

  loadExperiment(exp, message) {
    const parsed = parseExperiment(exp);
    if (!parsed.ok) {
      get().notify('error', `Could not load experiment: ${parsed.errors.slice(0, 3).join('; ')}`);
      return;
    }
    set((s) => ({
      experiment: parsed.experiment,
      past: [...s.past, s.experiment].slice(-HISTORY_LIMIT),
      future: [],
      dirty: false,
      revision: s.revision + 1,
      status: 'loading',
      selection: null,
      cameraTarget: null,
      camera: s.camera === 'orbit' || s.camera === 'top' ? s.camera : 'orbit',
    }));
    if (message) get().notify('success', message);
  },

  undo() {
    const { past, experiment, future } = get();
    const prev = past.at(-1);
    if (!prev) return;
    set((s) => ({
      experiment: prev,
      past: past.slice(0, -1),
      future: [experiment, ...future].slice(0, HISTORY_LIMIT),
      revision: s.revision + 1,
      status: 'loading',
      dirty: true,
    }));
    get().notify('info', 'Undone');
  },

  redo() {
    const { past, experiment, future } = get();
    const next = future[0];
    if (!next) return;
    set((s) => ({
      experiment: next,
      past: [...past, experiment].slice(-HISTORY_LIMIT),
      future: future.slice(1),
      revision: s.revision + 1,
      status: 'loading',
      dirty: true,
    }));
    get().notify('info', 'Redone');
  },

  select(selection) {
    set({ selection });
  },
  setPlaying(playing) {
    set({ playing });
  },
  setTimeScale(timeScale) {
    set({ timeScale: Math.min(8, Math.max(0.05, timeScale)) });
  },
  setOverlay(overlay) {
    set({ overlay });
  },
  setCamera(camera, target) {
    set((s) => ({ camera, cameraTarget: target === undefined ? s.cameraTarget : target }));
  },
  setTheme(theme) {
    try {
      localStorage.setItem('wave-lab:theme', theme);
    } catch {
      /* storage unavailable: preference lasts for this session only */
    }
    set({ theme });
  },
  setDockTab(dockTab) {
    set({ dockTab });
  },
  openDialog(dialog) {
    set({ dialog });
  },
  notify(tone, message) {
    const id = ++noticeId;
    set((s) => ({ notices: [...s.notices.slice(-3), { id, tone, message }] }));
  },
  dismissNotice(id) {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  },

  simLoaded(vesselDefinitions, diagnostics) {
    set({ vesselDefinitions, diagnostics, status: 'ready', error: null });
  },
  simFrame(frame) {
    set({ frame });
  },
  simError(message) {
    set({ status: 'error', error: message, playing: false });
  },
  simUnsupported(message) {
    set({ status: 'unsupported', error: message, playing: false });
  },
}));

// ------------------------------------------------------------------ helpers for editors

export function findWave(exp: Experiment, id: string): WaveSystem | undefined {
  return exp.waves.find((w) => w.id === id);
}
export function findVessel(exp: Experiment, id: string): VesselConfig | undefined {
  return exp.vessels.find((v) => v.id === id);
}
export function findProbe(exp: Experiment, id: string): ProbeConfig | undefined {
  return exp.probes.find((p) => p.id === id);
}
