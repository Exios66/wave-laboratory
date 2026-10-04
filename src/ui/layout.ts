/**
 * Desktop lab chrome: the 3D view sits between a scene list, an inspector and a data dock.
 * Sizes are viewer preferences (localStorage), not part of the experiment document.
 */
export const LAYOUT_KEY = 'wave-lab:layout';

/** Compact strip that keeps play/pause visible when the data charts are hidden [px]. */
export const DOCK_STRIP = 52;

export const LAYOUT_LIMITS = {
  scene: { min: 200, max: 480, fallback: 280 },
  inspector: { min: 260, max: 520, fallback: 320 },
  dock: { min: 140, max: 420, fallback: 200 },
} as const;

const VIEWPORT_MIN_W = 360;
const VIEWPORT_MIN_H = 220;
const HEADER_H = 56;
const SPLIT = 6;

/** Matches the CSS desktop grid (`min-width: 901px`). Phone chrome uses the panel switcher. */
export const DESKTOP_MIN_W = 901;

export function isDesktopLayout(vp = viewportSize()): boolean {
  return vp.w >= DESKTOP_MIN_W;
}

export interface LabLayout {
  sceneWidth: number;
  inspectorWidth: number;
  dockHeight: number;
  sceneCollapsed: boolean;
  inspectorCollapsed: boolean;
  dockCollapsed: boolean;
}

export function viewportSize(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 1440, h: 900 };
  return { w: window.innerWidth, h: window.innerHeight };
}

/** First-visit sizes: a short laptop gets a shallower dock so the ocean is not a thin strip. */
export function defaultLayout(vp = viewportSize()): LabLayout {
  const short = vp.h < 820;
  const narrow = vp.w < 1280;
  return {
    sceneWidth: narrow ? 240 : LAYOUT_LIMITS.scene.fallback,
    inspectorWidth: narrow ? 280 : LAYOUT_LIMITS.inspector.fallback,
    dockHeight: short ? 148 : LAYOUT_LIMITS.dock.fallback,
    sceneCollapsed: false,
    inspectorCollapsed: false,
    dockCollapsed: false,
  };
}

export function isViewExpanded(layout: LabLayout): boolean {
  return layout.sceneCollapsed && layout.inspectorCollapsed && layout.dockCollapsed;
}

export function parseLayout(raw: unknown, vp = viewportSize()): LabLayout {
  const base = defaultLayout(vp);
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;
  return clampLayout(
    {
      sceneWidth: num(o.sceneWidth, base.sceneWidth),
      inspectorWidth: num(o.inspectorWidth, base.inspectorWidth),
      dockHeight: num(o.dockHeight, base.dockHeight),
      sceneCollapsed: bool(o.sceneCollapsed, false),
      inspectorCollapsed: bool(o.inspectorCollapsed, false),
      dockCollapsed: bool(o.dockCollapsed, false),
    },
    vp,
  );
}

export function readLayout(vp = viewportSize()): LabLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return parseLayout(raw ? JSON.parse(raw) : null, vp);
  } catch {
    return defaultLayout(vp);
  }
}

export function writeLayout(layout: LabLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* storage unavailable: preference lasts for this session only */
  }
}

export function clampLayout(layout: LabLayout, vp = viewportSize()): LabLayout {
  let sceneWidth = clamp(layout.sceneWidth, LAYOUT_LIMITS.scene.min, LAYOUT_LIMITS.scene.max);
  let inspectorWidth = clamp(
    layout.inspectorWidth,
    LAYOUT_LIMITS.inspector.min,
    LAYOUT_LIMITS.inspector.max,
  );
  let dockHeight = clamp(layout.dockHeight, LAYOUT_LIMITS.dock.min, LAYOUT_LIMITS.dock.max);

  const sceneW = layout.sceneCollapsed ? 0 : sceneWidth;
  const inspectorW = layout.inspectorCollapsed ? 0 : inspectorWidth;
  const usedW = sceneW + inspectorW + SPLIT * 2;
  const roomW = vp.w - VIEWPORT_MIN_W - usedW;
  if (roomW < 0) {
    const shrink = -roomW;
    const insp = layout.inspectorCollapsed ? 0 : inspectorWidth - LAYOUT_LIMITS.inspector.min;
    const cutI = Math.min(shrink, Math.max(0, insp));
    inspectorWidth -= cutI;
    const rest = shrink - cutI;
    if (rest > 0 && !layout.sceneCollapsed) {
      sceneWidth = Math.max(LAYOUT_LIMITS.scene.min, sceneWidth - rest);
    }
  }

  const dockH = layout.dockCollapsed ? DOCK_STRIP : dockHeight;
  const maxDock = Math.max(LAYOUT_LIMITS.dock.min, vp.h - HEADER_H - VIEWPORT_MIN_H - SPLIT);
  dockHeight = Math.min(dockHeight, maxDock);
  if (!layout.dockCollapsed && dockH > maxDock) dockHeight = maxDock;

  return {
    sceneWidth,
    inspectorWidth,
    dockHeight,
    sceneCollapsed: layout.sceneCollapsed,
    inspectorCollapsed: layout.inspectorCollapsed,
    dockCollapsed: layout.dockCollapsed,
  };
}

/** Pixel size the grid should use for a panel, including the collapsed strip for the dock. */
export function layoutCssVars(layout: LabLayout): {
  scene: number;
  inspector: number;
  dock: number;
} {
  return {
    scene: layout.sceneCollapsed ? 0 : layout.sceneWidth,
    inspector: layout.inspectorCollapsed ? 0 : layout.inspectorWidth,
    dock: layout.dockCollapsed ? DOCK_STRIP : layout.dockHeight,
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
