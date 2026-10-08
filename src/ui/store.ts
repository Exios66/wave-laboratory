/**
 * Application state (Zustand). The experiment document is the single source of truth for the
 * scene; every structural edit goes through `updateExperiment`, which records undo history and
 * schedules a simulation reload.
 */
import { create } from 'zustand';
import {
  DAY_LENGTH_RANGE,
  DEFAULT_AMBIENCE,
  type AmbienceSettings,
  type CameraMode,
  type OverlayMode,
} from '../render/api';
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
import {
  parsePerformanceMode,
  sanitizeDisplay,
  type DisplaySettings,
  type PerformanceMode,
} from './deviceProfile';
import {
  clampLayout,
  defaultLayout,
  isDesktopLayout,
  isViewExpanded,
  readLayout,
  viewportSize,
  writeLayout,
  type LabLayout,
} from './layout';

export type Selection =
  | { kind: 'environment' }
  | { kind: 'weather' }
  | { kind: 'wave'; id: string }
  | { kind: 'vessel'; id: string }
  | { kind: 'probe'; id: string }
  | null;

export type SimStatus = 'loading' | 'ready' | 'error' | 'unsupported';
export type DockTab = 'gauges' | 'motions' | 'spectrum' | 'statistics';
/** Which panel is shown under the 3D view on narrow (mobile) layouts. */
export type MobilePanel = 'scene' | 'inspector' | 'data';
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
  /** The camera to go back to when leaving the plane view (never `plane`). */
  groundCamera: CameraMode;

  theme: ThemePreference;
  performance: PerformanceMode;
  /** Day:night cycle, islands, sea life and sailors (viewer preference, not saved in files). */
  ambience: AmbienceSettings;
  /** Bloom, film grain and vignette (viewer preference, persisted, not saved in files). */
  display: DisplaySettings;
  /** Clock time of the day:night cycle [h], refreshed a few times a second for display. */
  timeOfDay: number;
  /** Current dynamic render scale (1 = full resolution). */
  renderScale: number;
  dockTab: DockTab;
  mobilePanel: MobilePanel;
  dialog: 'help' | 'presets' | 'settings' | null;
  notices: Notice[];
  /** Easter egg: hulls drawn as rubber ducks. Session only, never saved in the experiment. */
  duckMode: boolean;
  /** Desktop chrome sizes and collapsed panels (persisted; not part of the experiment). */
  layout: LabLayout;

  // actions
  /** Apply an edit; returns false (and shows why) when the result fails validation. */
  updateExperiment(recipe: (draft: Experiment) => void, opts?: { reload?: boolean }): boolean;
  loadExperiment(exp: Experiment, message?: string): void;
  undo(): void;
  redo(): void;
  select(sel: Selection): void;
  setPlaying(playing: boolean): void;
  setTimeScale(scale: number): void;
  setOverlay(mode: OverlayMode): void;
  setCamera(mode: CameraMode, target?: string | null): void;
  /** Ride one of the lost flights over the lab, or come back down to the previous view. */
  togglePlaneView(): void;
  setTheme(theme: ThemePreference): void;
  setPerformance(mode: PerformanceMode): void;
  setAmbience(patch: Partial<AmbienceSettings>): void;
  setDisplay(patch: Partial<DisplaySettings>): void;
  setTimeOfDay(hours: number): void;
  setRenderScale(scale: number): void;
  setDockTab(tab: DockTab): void;
  setMobilePanel(panel: MobilePanel): void;
  openDialog(dialog: LabState['dialog']): void;
  notify(tone: Notice['tone'], message: string): void;
  dismissNotice(id: number): void;
  setDuckMode(on: boolean): void;
  patchLayout(patch: Partial<LabLayout>): void;
  toggleExpandedView(): void;
  resetLayout(): void;
  // simulation bridge callbacks
  simLoaded(defs: Record<string, VesselDefinition>, diagnostics: SeaDiagnostics): void;
  simFrame(frame: SimFrame): void;
  simError(message: string): void;
  simUnsupported(message: string): void;
}

const HISTORY_LIMIT = 100;

/** Reloading never hides an "unsupported" (no WebGL 2) state. */
function loadingStatus(status: SimStatus): SimStatus {
  return status === 'unsupported' ? status : 'loading';
}

/**
 * Selection and camera target must name something that exists. After an edit, undo or redo
 * removes an item, drop the dangling id (and fall back to the orbit camera if it was followed).
 */
function dropMissingTargets(
  exp: Experiment,
  s: Pick<LabState, 'selection' | 'cameraTarget' | 'camera'>,
): Partial<LabState> {
  const out: Partial<LabState> = {};
  const sel = s.selection;
  if (sel && 'id' in sel) {
    const list = sel.kind === 'wave' ? exp.waves : sel.kind === 'vessel' ? exp.vessels : exp.probes;
    if (!list.some((x) => x.id === sel.id)) out.selection = null;
  }
  if (s.cameraTarget && !exp.vessels.some((v) => v.id === s.cameraTarget)) {
    out.cameraTarget = null;
    if (s.camera === 'follow' || s.camera === 'bridge') out.camera = 'orbit';
  }
  return out;
}
let noticeId = 0;

function persistLayout(layout: LabLayout): LabLayout {
  writeLayout(layout);
  return layout;
}

function readPerformance(): PerformanceMode {
  try {
    return parsePerformanceMode(localStorage.getItem('wave-lab:performance'));
  } catch {
    return 'auto';
  }
}

function readTheme(): ThemePreference {
  try {
    const t = localStorage.getItem('wave-lab:theme');
    return t === 'dark' || t === 'light' ? t : 'system';
  } catch {
    return 'system';
  }
}

function readAmbience(): AmbienceSettings {
  try {
    const raw = localStorage.getItem('wave-lab:ambience');
    return sanitizeAmbience(raw ? (JSON.parse(raw) as Partial<AmbienceSettings>) : {});
  } catch {
    return { ...DEFAULT_AMBIENCE };
  }
}

export function readDisplay(): DisplaySettings {
  try {
    const raw = localStorage.getItem('wave-lab:display');
    return sanitizeDisplay(raw ? JSON.parse(raw) : {});
  } catch {
    return sanitizeDisplay({});
  }
}

/** Fill in defaults and clamp anything out of range (old or hand-edited storage). */
export function sanitizeAmbience(raw: Partial<AmbienceSettings>): AmbienceSettings {
  const d = DEFAULT_AMBIENCE;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    dayNight: bool(raw.dayNight, d.dayNight),
    dayLengthMin: num(raw.dayLengthMin, d.dayLengthMin, DAY_LENGTH_RANGE.min, DAY_LENGTH_RANGE.max),
    startHour: num(raw.startHour, d.startHour, 0, 24) % 24,
    islands: bool(raw.islands, d.islands),
    wildlife: bool(raw.wildlife, d.wildlife),
    sailors: bool(raw.sailors, d.sailors),
    planes: bool(raw.planes, d.planes),
  };
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
  groundCamera: 'orbit',

  theme: readTheme(),
  performance: readPerformance(),
  ambience: readAmbience(),
  display: readDisplay(),
  timeOfDay: readAmbience().startHour,
  renderScale: 1,
  dockTab: 'gauges',
  mobilePanel: 'data',
  dialog: null,
  notices: [],
  duckMode: false,
  layout: readLayout(),

  updateExperiment(recipe, opts) {
    const prev = get().experiment;
    const draft = structuredClone(prev);
    recipe(draft);
    const parsed = parseExperiment(draft);
    if (!parsed.ok) {
      get().notify('error', `Change rejected: ${parsed.errors[0] ?? 'invalid value'}`);
      return false;
    }
    const reload = opts?.reload ?? true;
    set((s) => ({
      experiment: parsed.experiment,
      past: [...s.past, prev].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
      revision: reload ? s.revision + 1 : s.revision,
      status: reload ? loadingStatus(s.status) : s.status,
      ...dropMissingTargets(parsed.experiment, s),
    }));
    return true;
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
      status: loadingStatus(s.status),
      selection: null,
      cameraTarget: null,
      camera:
        s.camera === 'orbit' || s.camera === 'top' || s.camera === 'plane' ? s.camera : 'orbit',
      groundCamera: s.groundCamera === 'top' ? 'top' : 'orbit',
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
      status: loadingStatus(s.status),
      dirty: true,
      ...dropMissingTargets(prev, s),
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
      status: loadingStatus(s.status),
      dirty: true,
      ...dropMissingTargets(next, s),
    }));
    get().notify('info', 'Redone');
  },

  select(selection) {
    // On phones, selecting something reveals its editor via the panel switcher. On desktop,
    // unhide the inspector so a pick in the 3D view is not lost behind a collapsed panel —
    // but do not persist that unhide from a phone, or a laptop's saved hide is wiped.
    set((s) => {
      const layout =
        selection && s.layout.inspectorCollapsed && isDesktopLayout()
          ? persistLayout({ ...s.layout, inspectorCollapsed: false })
          : s.layout;
      return selection ? { selection, mobilePanel: 'inspector' as const, layout } : { selection };
    });
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
    set((s) => ({
      camera,
      cameraTarget: target === undefined ? s.cameraTarget : target,
      groundCamera: camera === 'plane' ? s.groundCamera : camera,
    }));
  },
  togglePlaneView() {
    const s = get();
    if (s.camera !== 'plane') {
      s.setCamera('plane');
      return;
    }
    const back = s.groundCamera;
    const needsVessel = back === 'follow' || back === 'bridge';
    s.setCamera(needsVessel && !s.cameraTarget ? 'orbit' : back);
  },
  setTheme(theme) {
    try {
      localStorage.setItem('wave-lab:theme', theme);
    } catch {
      /* storage unavailable: preference lasts for this session only */
    }
    set({ theme });
  },
  setPerformance(performance) {
    try {
      localStorage.setItem('wave-lab:performance', performance);
    } catch {
      /* storage unavailable */
    }
    set({ performance });
  },
  setAmbience(patch) {
    const ambience = sanitizeAmbience({ ...get().ambience, ...patch });
    try {
      localStorage.setItem('wave-lab:ambience', JSON.stringify(ambience));
    } catch {
      /* storage unavailable */
    }
    set(patch.startHour !== undefined ? { ambience, timeOfDay: ambience.startHour } : { ambience });
  },
  setDisplay(patch) {
    const display = sanitizeDisplay({ ...get().display, ...patch });
    try {
      localStorage.setItem('wave-lab:display', JSON.stringify(display));
    } catch {
      /* storage unavailable */
    }
    set({ display });
  },
  setTimeOfDay(timeOfDay) {
    set({ timeOfDay: ((timeOfDay % 24) + 24) % 24 });
  },
  setRenderScale(renderScale) {
    set({ renderScale });
  },
  setDockTab(dockTab) {
    set({ dockTab });
  },
  setMobilePanel(mobilePanel) {
    set({ mobilePanel });
  },
  openDialog(dialog) {
    set({ dialog });
  },
  notify(tone, message) {
    const id = ++noticeId;
    set((s) => ({ notices: [...s.notices.slice(-3), { id, tone, message }] }));
  },
  setDuckMode(on) {
    set({ duckMode: on });
  },
  patchLayout(patch) {
    set((s) => {
      const layout = clampLayout({ ...s.layout, ...patch }, viewportSize());
      if (
        layout.sceneWidth === s.layout.sceneWidth &&
        layout.inspectorWidth === s.layout.inspectorWidth &&
        layout.dockHeight === s.layout.dockHeight &&
        layout.sceneCollapsed === s.layout.sceneCollapsed &&
        layout.inspectorCollapsed === s.layout.inspectorCollapsed &&
        layout.dockCollapsed === s.layout.dockCollapsed
      ) {
        return s;
      }
      return { layout: persistLayout(layout) };
    });
  },
  toggleExpandedView() {
    set((s) => {
      const expanded = isViewExpanded(s.layout);
      return {
        layout: persistLayout(
          clampLayout(
            {
              ...s.layout,
              sceneCollapsed: !expanded,
              inspectorCollapsed: !expanded,
              dockCollapsed: !expanded,
            },
            viewportSize(),
          ),
        ),
      };
    });
  },
  resetLayout() {
    const layout = persistLayout(defaultLayout(viewportSize()));
    set({ layout });
  },
  dismissNotice(id) {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  },

  simLoaded(vesselDefinitions, diagnostics) {
    // A missing WebGL 2 renderer stays reported: the simulation alone cannot show anything.
    set((s) =>
      s.status === 'unsupported'
        ? { vesselDefinitions, diagnostics }
        : { vesselDefinitions, diagnostics, status: 'ready', error: null },
    );
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
