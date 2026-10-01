/**
 * Device capability detection used to choose sensible graphics defaults, so the lab runs well on
 * anything from a phone or a laptop with integrated graphics (or a software renderer) up to a
 * desktop GPU. Physics is unaffected: only visual resolution changes.
 */
import type { OceanQuality } from '../schema/experiment';

export type PerformanceMode = 'auto' | 'saver' | 'quality';

export interface DeviceProfile {
  /** Highest ocean FFT resolution this device should render by default. */
  maxQuality: OceanQuality;
  /** Upper bound for the canvas pixel ratio. */
  maxPixelRatio: number;
  /** Human-readable reason, shown in the UI. */
  description: string;
  gpu: string;
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
  const software = /swiftshader|llvmpipe|softpipe|software|basic render/.test(g);
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const smallScreen = Math.min(window.screen?.width ?? 1920, window.screen?.height ?? 1080) < 820;
  const mobile = coarse && smallScreen;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const integrated = /intel|uhd|iris|mali|adreno|powervr|apple gpu/.test(g) && !/apple m\d/.test(g);

  let profile: DeviceProfile;
  if (gpu === 'none') {
    profile = { maxQuality: 'low', maxPixelRatio: 1, description: 'No WebGL 2', gpu };
  } else if (software) {
    profile = {
      maxQuality: 'low',
      maxPixelRatio: 1,
      description: 'Software rendering detected — using the lightest settings',
      gpu,
    };
  } else if (mobile || memory <= 4 || cores <= 4) {
    profile = {
      maxQuality: 'medium',
      maxPixelRatio: 1.5,
      description: 'Mobile or low-power device — balanced settings',
      gpu,
    };
  } else if (integrated) {
    profile = {
      maxQuality: 'high',
      maxPixelRatio: 1.5,
      description: 'Integrated graphics — high detail, moderate resolution',
      gpu,
    };
  } else {
    profile = { maxQuality: 'ultra', maxPixelRatio: 2, description: 'Dedicated graphics', gpu };
  }
  cached = profile;
  return profile;
}

/** Effective visual quality for a requested experiment quality under a performance mode. */
export function effectiveQuality(
  requested: OceanQuality,
  mode: PerformanceMode,
  profile: DeviceProfile,
): OceanQuality {
  if (mode === 'quality') return requested;
  if (mode === 'saver') return minQuality(requested, minQuality(profile.maxQuality, 'medium'));
  return minQuality(requested, profile.maxQuality);
}

/**
 * Dynamic resolution controller: lowers the render scale when frames take too long and raises it
 * again (slowly) when there is headroom. Hysteresis avoids oscillation.
 */
export class ResolutionGovernor {
  scale = 1;
  private frames = 0;
  private elapsed = 0;
  private goodWindows = 0;

  constructor(
    public minScale = 0.5,
    public maxScale = 1,
    public targetFps = 55,
  ) {}

  /** Feed a frame duration [s]; returns true when the scale changed. */
  frame(dt: number): boolean {
    if (!(dt > 0) || dt > 0.5) return false;
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed < 1 - 1e-6) return false;
    const fps = this.frames / this.elapsed;
    this.frames = 0;
    this.elapsed = 0;
    const before = this.scale;
    if (fps < this.targetFps * 0.85) {
      this.goodWindows = 0;
      this.scale = Math.max(this.minScale, this.scale * 0.85);
    } else if (fps > this.targetFps * 0.98) {
      if (++this.goodWindows >= 3 && this.scale < this.maxScale) {
        this.goodWindows = 0;
        this.scale = Math.min(this.maxScale, this.scale * 1.1);
      }
    } else {
      this.goodWindows = 0;
    }
    return Math.abs(this.scale - before) > 1e-6;
  }
}
