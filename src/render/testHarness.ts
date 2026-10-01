/**
 * Browser test harness (gpu-test.html). Exposes `window.gpuHarness` for the Playwright specs:
 *  - `fft`: GPU spectral ocean at fixed times, read back for the GPU↔CPU consistency test;
 *  - `sample`: the water vertex shader's displacement function at given labels;
 *  - `startScene` / `step` / …: the full LabRenderer with a fake vessel for smoke tests.
 */
import { WebGLRenderer } from 'three';
import { buildGpuOceanData } from '../ocean/gpuData';
import { OceanField } from '../ocean/oceanField';
import {
  EnvironmentSchema,
  type Environment,
  type OceanQuality,
  type WaveSystem,
} from '../schema/experiment';
import type { CameraMode, OverlayLegend, OverlayMode, PickResult } from './api';
import { LabRenderer } from './LabRenderer';
import { CascadeOutput, OceanSimulationGpu, detectFloatSupport } from './ocean/OceanSimulationGpu';
import { computeOceanStats } from './ocean/oceanStats';
import { bindOceanData, createOceanUniforms, updateOceanUniforms } from './ocean/oceanUniforms';
import { SurfaceSampler } from './ocean/SurfaceSampler';
import { fakeFrame, fakeVessel, TEST_PROBES } from './testScene';

export interface SeaConfig {
  waves: WaveSystem[];
  env?: Partial<Environment>;
  quality: OceanQuality;
}

export interface FftResult {
  floatPath: string;
  n: number;
  sizes: number[];
  /** Per time, per cascade: base64 Float32 RGBA of the displacement and derivative textures. */
  results: { t: number; cascades: { disp: string; deriv: string }[] }[];
}

export interface SceneOptions {
  quality?: OceanQuality;
  forceHalfFloat?: boolean;
  pixelRatio?: number;
  sunElevationDeg?: number;
  sunAzimuthDeg?: number;
}

function toBase64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function environment(cfg: SeaConfig): Environment {
  return EnvironmentSchema.parse({ ...(cfg.env ?? {}) });
}

function offscreenRenderer(): WebGLRenderer {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL 2 unavailable');
  return new WebGLRenderer({ canvas, context: gl });
}

function fft(cfg: SeaConfig & { times: number[]; forceHalfFloat?: boolean }): FftResult {
  const env = environment(cfg);
  const data = buildGpuOceanData(cfg.waves, env, cfg.quality);
  const renderer = offscreenRenderer();
  const support = detectFloatSupport(renderer, cfg.forceHalfFloat ?? false);
  const sim = new OceanSimulationGpu(renderer, data, support);
  const n = sim.n;
  const buf = new Float32Array(4 * n * n);
  const results: FftResult['results'] = [];
  for (const t of cfg.times) {
    sim.update(t);
    const cascades = data.cascades.map((_, i) => ({
      disp: toBase64(sim.readCascade(i, CascadeOutput.Displacement, buf)),
      deriv: toBase64(sim.readCascade(i, CascadeOutput.Derivatives, buf)),
    }));
    results.push({ t, cascades });
  }
  sim.dispose();
  renderer.dispose();
  return { floatPath: support.path, n, sizes: data.cascades.map((c) => c.size), results };
}

function sample(cfg: SeaConfig & { times: number[]; labels: number[] }): {
  floatPath: string;
  values: number[][];
} {
  const env = environment(cfg);
  const data = buildGpuOceanData(cfg.waves, env, cfg.quality);
  const renderer = offscreenRenderer();
  const support = detectFloatSupport(renderer);
  const sim = new OceanSimulationGpu(renderer, data, support);
  const uniforms = createOceanUniforms(data.cascades.length);
  bindOceanData(uniforms, data, computeOceanStats(data));
  const sampler = new SurfaceSampler(renderer, data.cascades.length, uniforms);
  const values: number[][] = [];
  for (const t of cfg.times) {
    sim.update(t);
    updateOceanUniforms(uniforms, sim, data, t);
    values.push(Array.from(sampler.sample(cfg.labels)));
  }
  sampler.dispose();
  sim.dispose();
  renderer.dispose();
  return { floatPath: support.path, values };
}

// ------------------------------------------------------------------ full scene

interface SceneState {
  lab: LabRenderer;
  field: OceanField;
  t: number;
  def: ReturnType<typeof fakeVessel>;
  lost: number;
  restored: number;
  picks: (PickResult | null)[];
}

let scene: SceneState | null = null;
let loseExt: WEBGL_lose_context | null = null;

const DEFAULT_SEA: WaveSystem[] = [
  {
    id: 'swell',
    name: 'Swell',
    kind: 'spectrum',
    enabled: true,
    spectrum: 'jonswap',
    hs: 2.2,
    tp: 10,
    gamma: 3.3,
    directionDeg: 250,
    depthLimited: true,
    spreading: { model: 'mitsuyasu', s: 20 },
    seed: 7,
  },
  {
    id: 'wind',
    name: 'Wind sea',
    kind: 'wind',
    enabled: true,
    windSpeed: 11,
    fetchKm: 60,
    directionDeg: 230,
    spreading: { model: 'mitsuyasu', s: 8 },
    seed: 11,
  },
];

function startScene(opts: SceneOptions = {}): { floatPath: string } {
  scene?.lab.dispose();
  document.getElementById('scene')?.remove();
  const canvas = document.createElement('canvas');
  canvas.id = 'scene';
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block';
  document.body.appendChild(canvas);
  const state: Partial<SceneState> = { lost: 0, restored: 0, picks: [] };
  const lab = new LabRenderer(canvas, {
    onContextLost: () => (state.lost = (state.lost ?? 0) + 1),
    onContextRestored: () => (state.restored = (state.restored ?? 0) + 1),
    forceHalfFloat: opts.forceHalfFloat ?? false,
    preserveDrawingBuffer: true,
  });
  const env = EnvironmentSchema.parse({
    windSpeed: 11,
    windDirectionDeg: 230,
    sunElevationDeg: opts.sunElevationDeg ?? 18,
    sunAzimuthDeg: opts.sunAzimuthDeg ?? 235,
  });
  const quality = opts.quality ?? 'high';
  lab.setEnvironment(env);
  lab.setOcean(buildGpuOceanData(DEFAULT_SEA, env, quality));
  const def = fakeVessel(72);
  lab.setVessels([{ id: 'ship', definition: def }]);
  lab.setProbes(TEST_PROBES);
  lab.resize(window.innerWidth, window.innerHeight, opts.pixelRatio ?? 1);
  lab.enableTapPicking((r) => state.picks!.push(r));
  const field = new OceanField(DEFAULT_SEA, env);
  // Keep the same object: the context callbacks above update `state` in place.
  scene = Object.assign(state, { lab, field, t: 30, def }) as SceneState;
  return { floatPath: lab.floatPath };
}

function requireScene(): SceneState {
  if (!scene) throw new Error('Scene not started');
  return scene;
}

/** Advance `frames` frames of `dt` simulated seconds and render each. */
function step(frames = 1, dt = 1 / 30): void {
  const s = requireScene();
  const surf = (x: number, y: number, t: number) => s.field.surface(x, y, t).eta;
  for (let i = 0; i < frames; i++) {
    s.t += dt;
    s.lab.setFrame(fakeFrame(s.t, s.def, surf));
    s.lab.render();
  }
}

function glError(): number {
  return requireScene().lab.gl.getError();
}

function canvasStats(): { mean: number; std: number } {
  // Read the default framebuffer (preserveDrawingBuffer) to check the image is not blank.
  const gl = requireScene().lab.gl;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(4 * w * h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sum = 0;
  let sum2 = 0;
  const count = w * h;
  for (let i = 0; i < count; i++) {
    const l = (px[4 * i]! + px[4 * i + 1]! + px[4 * i + 2]!) / 3;
    sum += l;
    sum2 += l * l;
  }
  const mean = sum / count;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / count - mean * mean)) };
}

const harness = {
  fft,
  sample,
  startScene,
  step,
  glError,
  canvasStats,
  setOverlay: (m: OverlayMode): OverlayLegend | null => {
    requireScene().lab.setOverlay(m);
    return requireScene().lab.overlayLegend;
  },
  setCamera: (m: CameraMode, id?: string | null) => requireScene().lab.setCamera(m, id),
  setSelection: (id: string | null) => requireScene().lab.setSelection(id),
  nudge: (a: Parameters<LabRenderer['nudgeCamera']>[0]) => requireScene().lab.nudgeCamera(a),
  pick: (x: number, y: number) => requireScene().lab.pick(x, y),
  picks: () => requireScene().picks,
  stats: () => ({ ...requireScene().lab.stats }),
  cameraPose: () => requireScene().lab.cameraPose(),
  /** The LabRenderer instance (debugging from the console). */
  lab: () => requireScene().lab,
  contextEvents: () => ({ lost: requireScene().lost, restored: requireScene().restored }),
  loseContext: () => {
    // getExtension() returns null while the context is lost, so keep the object.
    loseExt = requireScene().lab.gl.getExtension('WEBGL_lose_context');
    loseExt?.loseContext();
  },
  restoreContext: () => loseExt?.restoreContext(),
  resize: (w: number, h: number, pr: number) => requireScene().lab.resize(w, h, pr),
  /** Dispose and report GPU resources that are still alive. */
  disposeScene: () => {
    const s = requireScene();
    s.lab.dispose();
    const info = s.lab.debugInfo();
    scene = null;
    return info;
  },
};

declare global {
  interface Window {
    gpuHarness: typeof harness;
  }
}

window.gpuHarness = harness;
document.body.dataset.ready = 'true';
