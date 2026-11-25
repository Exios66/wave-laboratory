/**
 * Device capability detection used to choose sensible graphics defaults, so the lab runs well on
 * anything from a phone or a laptop with integrated graphics (or a software renderer) up to a
 * desktop GPU. Physics is unaffected: only visual resolution changes.
 */
import { gfxForcedFull } from '../core/gfxOverride';
import type { PostSettings } from '../render/api';
import type { OceanQuality } from '../schema/experiment';

/** Graphics setting: automatic for this device, or an explicit level. */
export type PerformanceMode = 'auto' | OceanQuality;

export const PERFORMANCE_MODES: readonly PerformanceMode[] = [
  'auto',
  'low',
  'medium',
  'high',
  'ultra',
];

export const PERFORMANCE_LABELS: Record<PerformanceMode, string> = {
  auto: 'Auto (this device)',
  low: 'Low — fastest',
  medium: 'Medium',
  high: 'High',
  ultra: 'Ultra — best looking',
};

/** Accept settings saved by earlier versions ('saver', 'quality'). */
export function parsePerformanceMode(v: string | null): PerformanceMode {
  if (v === 'saver') return 'low';
  if (v === 'quality') return 'ultra';
  return (PERFORMANCE_MODES as readonly string[]).includes(v ?? '')
    ? (v as PerformanceMode)
    : 'auto';
}

export interface DeviceProfile {
  /** Highest ocean FFT resolution this device should render by default. */
  maxQuality: OceanQuality;
  /** Upper bound for the canvas pixel ratio. */
  maxPixelRatio: number;
  /** Human-readable reason, shown in the UI. */
  description: string;
  gpu: string;
  /** Software renderer (SwiftShader, llvmpipe, …). */
  software: boolean;
  /** Phone-sized touch device. */
  mobile: boolean;
}

const ORDER: OceanQuality[] = ['low', 'medium', 'high', 'ultra'];

export function minQuality(a: OceanQuality, b: OceanQuality): OceanQuality {
  return ORDER[Math.min(ORDER.indexOf(a), ORDER.indexOf(b))]!;
}

function gpuName(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return 'unknown';
  }
}

let cached: DeviceProfile | null = null;

export function detectDeviceProfile(): DeviceProfile {
  if (cached) return cached;
  const gpu = gpuName();
  const g = gpu.toLowerCase();
  const forced = gfxForcedFull();
  const software = !forced && /swiftshader|llvmpipe|softpipe|software|basic render/.test(g);
  const coarse = !forced && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
  const smallScreen = Math.min(window.screen?.width ?? 1920, window.screen?.height ?? 1080) < 820;
  const mobile = coarse && smallScreen;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const integrated = /intel|uhd|iris|mali|adreno|powervr|apple gpu/.test(g) && !/apple m\d/.test(g);

  let profile: DeviceProfile;
  if (gpu === 'none') {
    profile = {
      maxQuality: 'low',
      maxPixelRatio: 1,
      description: 'No WebGL 2',
      gpu,
      software: false,
      mobile,
    };
  } else if (software) {
    profile = {
      maxQuality: 'low',
      maxPixelRatio: 1,
      description: 'Software rendering detected — using the lightest settings',
      gpu,
      software: true,
      mobile,
    };
  } else if (!forced && (mobile || memory <= 4 || cores <= 4)) {
    profile = {
      maxQuality: 'medium',
      maxPixelRatio: 1.5,
      description: 'Mobile or low-power device — balanced settings',
      gpu,
      software: false,
      mobile,
    };
  } else if (!forced && integrated) {
    profile = {
      maxQuality: 'high',
      maxPixelRatio: 1.5,
      description: 'Integrated graphics — high detail, moderate resolution',
      gpu,
      software: false,
      mobile,
    };
  } else {
    profile = {
      maxQuality: 'ultra',
      maxPixelRatio: 2,
      description: 'Dedicated graphics',
      gpu,
      software: false,
      mobile,
    };
  }
  cached = profile;
  return profile;
}

/**
 * Effective visual quality: in auto mode the experiment's request capped by what the device
 * handles; an explicit level is used as chosen.
 */
export function effectiveQuality(
  requested: OceanQuality,
  mode: PerformanceMode,
  profile: DeviceProfile,
): OceanQuality {
  if (mode === 'auto') return minQuality(requested, profile.maxQuality);
  return mode;
}

export interface GraphicsBudget {
  /** Cap on the canvas pixel ratio. */
  maxPixelRatio: number;
  /** Dynamic-resolution floor and frame-rate target. */
  minScale: number;
  targetFps: number;
}

/** Resolution budget of a graphics mode. */
export function graphicsBudget(mode: PerformanceMode, profile: DeviceProfile): GraphicsBudget {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  switch (mode) {
    case 'low':
      return { maxPixelRatio: 1, minScale: 0.5, targetFps: 30 };
    case 'medium':
      return { maxPixelRatio: 1.25, minScale: 0.5, targetFps: 55 };
    case 'high':
      return { maxPixelRatio: Math.min(dpr, 1.75), minScale: 0.65, targetFps: 55 };
    case 'ultra':
      return { maxPixelRatio: Math.min(dpr, 2.5), minScale: 0.85, targetFps: 50 };
    default:
      return { maxPixelRatio: profile.maxPixelRatio, minScale: 0.5, targetFps: 55 };
  }
}

/** One quality level lower per step, never below `low`. */
export function lowerQuality(q: OceanQuality, steps: number): OceanQuality {
  return ORDER[Math.max(0, ORDER.indexOf(q) - Math.max(0, Math.floor(steps)))]!;
}

/**
 * Dynamic resolution controller: lowers the render scale when frames take too long and raises it
 * again (slowly) when there is headroom. Hysteresis avoids oscillation.
 *
 * With `tierEnabled` (graphics setting "auto" only) it also steps the quality tier down when the
 * scale is already at its floor and frames are still too slow, and back up after a long run of
 * good frames at full scale. Each step up that is followed by a step down within a short time
 * doubles the wait before the next step up, so a device that sits between two tiers settles on
 * the lower one instead of flipping between them.
 */
export class ResolutionGovernor {
  scale = 1;
  /** How many quality levels below the requested one we are running (0 = as requested). */
  tierSteps = 0;
  /** Set when the last `frame()` call changed `tierSteps`. */
  tierChanged = false;
  /** Most steps allowed (levels above `low` at the requested quality). */
  maxTierSteps = 0;
  tierEnabled = false;
  private frames = 0;
  private elapsed = 0;
  private goodWindows = 0;
  /** Consecutive windows at 90 % of the target or better (a looser bar for stepping the tier up). */
  private upWindows = 0;
  private badAtFloor = 0;
  private windows = 0;
  private lastUpWindow = Number.NEGATIVE_INFINITY;
  private upWait = 20;
  static readonly UP_WAIT = 20;
  static readonly UP_WAIT_MAX = 160;
  /** A down-step this soon after an up-step counts as flapping. */
  static readonly FLAP_WINDOWS = 25;

  constructor(
    public minScale = 0.5,
    public maxScale = 1,
    public targetFps = 55,
  ) {}

  /** Forget tier history (a new experiment or a changed setting). */
  resetTier(): void {
    this.tierSteps = 0;
    this.badAtFloor = 0;
    this.upWindows = 0;
    this.upWait = ResolutionGovernor.UP_WAIT;
    this.lastUpWindow = Number.NEGATIVE_INFINITY;
  }

  /** Feed a frame duration [s]; returns true when the scale or the tier changed. */
  frame(dt: number): boolean {
    this.tierChanged = false;
    if (!(dt > 0) || dt > 0.5) return false;
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed < 1 - 1e-6) return false;
    const fps = this.frames / this.elapsed;
    this.frames = 0;
    this.elapsed = 0;
    this.windows++;
    this.upWindows = fps >= this.targetFps * 0.9 ? this.upWindows + 1 : 0;
    const before = this.scale;
    if (fps < this.targetFps * 0.85) this.slowWindow();
    else if (fps > this.targetFps * 0.98) this.fastWindow();
    else {
      this.goodWindows = 0;
      this.badAtFloor = 0;
    }
    this.maybeStepTierUp();
    return this.tierChanged || Math.abs(this.scale - before) > 1e-6;
  }

  /** A slow second: lower the resolution, and at the floor cut detail. */
  private slowWindow(): void {
    this.goodWindows = 0;
    if (this.scale > this.minScale + 1e-6) {
      this.badAtFloor = 0;
      this.scale = Math.max(this.minScale, this.scale * 0.85);
      return;
    }
    if (!this.tierEnabled || this.tierSteps >= this.maxTierSteps) return;
    // Resolution cannot go lower: two bad seconds in a row at the floor, then cut detail.
    if (++this.badAtFloor < 2) return;
    this.badAtFloor = 0;
    this.tierSteps++;
    this.tierChanged = true;
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, 0.85));
    if (this.windows - this.lastUpWindow < ResolutionGovernor.FLAP_WINDOWS) {
      this.upWait = Math.min(ResolutionGovernor.UP_WAIT_MAX, this.upWait * 2);
    }
  }

  /** A fast second: after three in a row, raise the resolution a step. */
  private fastWindow(): void {
    this.badAtFloor = 0;
    this.goodWindows++;
    if (this.scale < this.maxScale && this.goodWindows >= 3) {
      this.goodWindows = 0;
      this.scale = Math.min(this.maxScale, this.scale * 1.1);
    }
  }

  /**
   * Tier step up: a long run of windows at 90 % of the target or better. Looser than the
   * scale-up bar (98 %) so a capped stream that drops an odd frame still recovers.
   */
  private maybeStepTierUp(): void {
    if (!this.tierEnabled || this.tierSteps <= 0 || this.upWindows < this.upWait) return;
    this.goodWindows = 0;
    this.upWindows = 0;
    this.tierSteps--;
    this.tierChanged = true;
    this.lastUpWindow = this.windows;
    this.scale = Math.max(this.minScale, 0.9);
  }
}

/** Display preferences for the post chain (viewer preference, not experiment data). */
export type BloomPreference = 'auto' | 'on' | 'off';

export interface DisplaySettings {
  /** `auto` blooms on medium+ quality, but not on phones, software GPUs or low quality. */
  bloom: BloomPreference;
  grain: boolean;
  vignette: boolean;
  /** Temporal antialiasing of distant water; `auto` follows the same rule as bloom. */
  taa: BloomPreference;
  /** Rain and spray drops on the camera lens in storms. */
  lensDroplets: boolean;
  /** Sun shafts through broken cloud; `auto` follows the same rule as bloom. */
  sunShafts: BloomPreference;
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  bloom: 'auto',
  grain: false,
  vignette: false,
  taa: 'auto',
  lensDroplets: true,
  sunShafts: 'auto',
};

function preference(v: unknown, fallback: BloomPreference): BloomPreference {
  return v === 'on' || v === 'off' || v === 'auto' ? v : fallback;
}

/** Fill in defaults for missing or invalid saved values. */
export function sanitizeDisplay(raw: unknown): DisplaySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_DISPLAY;
  return {
    bloom: preference(r.bloom, d.bloom),
    grain: typeof r.grain === 'boolean' ? r.grain : d.grain,
    vignette: typeof r.vignette === 'boolean' ? r.vignette : d.vignette,
    // Settings saved before TAA existed have no key: they read as auto.
    taa: preference(r.taa, d.taa),
    // Settings saved before the wet lens existed have no key: they read as on.
    lensDroplets: typeof r.lensDroplets === 'boolean' ? r.lensDroplets : d.lensDroplets,
    // Settings saved before sun shafts existed have no key: they read as auto.
    sunShafts: preference(r.sunShafts, d.sunShafts),
  };
}

/** What the renderer should draw: resolves bloom and TAA `auto` against the device and quality. */
export function resolvePostSettings(
  display: DisplaySettings,
  quality: OceanQuality,
  profile: Pick<DeviceProfile, 'software' | 'mobile'>,
): PostSettings {
  // Both cost a full-screen pass or two: worth it on a real desktop GPU at medium quality and up.
  const capable =
    (quality === 'medium' || quality === 'high' || quality === 'ultra') &&
    !profile.software &&
    !profile.mobile;
  const resolve = (p: BloomPreference) => (p === 'auto' ? capable : p === 'on');
  return {
    bloom: resolve(display.bloom),
    grain: display.grain,
    vignette: display.vignette,
    taa: resolve(display.taa),
    lens: display.lensDroplets,
    shafts: resolve(display.sunShafts),
  };
}
