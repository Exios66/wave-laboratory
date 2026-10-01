/**
 * GPU spectral ocean: per cascade, time-evolves h₀ into the derived spectra and runs an inverse
 * 2D FFT (Stockham, ping-pong render targets, log₂N passes per axis) every time the simulation
 * time changes. Results are unpacked into mip-mapped, repeat-wrapped, anisotropically filtered
 * sampling textures (displacement, derivatives, persistent foam). See fftShaders.ts for maths.
 */
import {
  DataTexture,
  DataUtils,
  FloatType,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  RawShaderMaterial,
  RepeatWrapping,
  RGBAFormat,
  WebGLRenderTarget,
  type Texture,
  type TextureDataType,
  type WebGLRenderer,
} from 'three';
import type { GpuOceanData } from '../../ocean/gpuData';
import {
  ASSEMBLE_FRAGMENT,
  FFT_PASS_FRAGMENT,
  FULLSCREEN_VERTEX,
  SPECTRUM_FRAGMENT,
} from './fftShaders';
import { FullscreenPass } from './FullscreenPass';

export type FloatPath = 'float32' | 'float16' | 'none';

export interface FloatSupport {
  /**
   * 'float32': RGBA32F everywhere; 'float16': RGBA16F sampling textures (e.g. iOS Safari, which
   * lacks OES_texture_float_linear) with RGBA32F FFT targets when renderable; 'none': no float
   * render targets at all — the spectral ocean is disabled (flat sea + analytic regular waves)
   * instead of failing.
   */
  path: FloatPath;
  fftType: TextureDataType;
  outputType: TextureDataType;
  colorBufferFloat: boolean;
  colorBufferHalfFloat: boolean;
  floatLinear: boolean;
  maxAnisotropy: number;
}

/**
 * Choose render-target precision. RGBA32F is renderable with EXT_color_buffer_float and
 * filterable (needed for linear/anisotropic sampling and mipmap generation) with
 * OES_texture_float_linear. Without the latter, the FFT still runs in RGBA32F (exact) but its
 * results are written to RGBA16F textures, which WebGL2 always filters; without any float
 * renderability everything that needs it is switched off rather than throwing.
 */
export function detectFloatSupport(renderer: WebGLRenderer, forceHalfFloat = false): FloatSupport {
  const ext = renderer.extensions;
  const colorBufferFloat = ext.has('EXT_color_buffer_float');
  const colorBufferHalfFloat = ext.has('EXT_color_buffer_half_float');
  const floatLinear = ext.has('OES_texture_float_linear');
  const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const base = { colorBufferFloat, colorBufferHalfFloat, floatLinear, maxAnisotropy };
  if (!colorBufferFloat && !colorBufferHalfFloat) {
    return { ...base, path: 'none', fftType: HalfFloatType, outputType: HalfFloatType };
  }
  const full = colorBufferFloat && floatLinear && !forceHalfFloat;
  return {
    ...base,
    path: full ? 'float32' : 'float16',
    fftType: colorBufferFloat && !forceHalfFloat ? FloatType : HalfFloatType,
    outputType: full ? FloatType : HalfFloatType,
  };
}

/** Output attachment indices of a cascade render target. */
export const CascadeOutput = { Displacement: 0, Derivatives: 1, Foam: 2 } as const;
export type CascadeOutput = (typeof CascadeOutput)[keyof typeof CascadeOutput];

export interface CascadeTextures {
  size: number;
  n: number;
  displacement: Texture;
  derivatives: Texture;
  foam: Texture;
}

interface CascadeGpu {
  size: number;
  n: number;
  h0: DataTexture;
  outputs: [WebGLRenderTarget, WebGLRenderTarget];
  /** Index of the output target holding the latest result. */
  current: number;
  textures: CascadeTextures;
}

interface FftResources {
  n: number;
  log2n: number;
  ping: WebGLRenderTarget;
  pong: WebGLRenderTarget;
  twiddle: DataTexture;
}

/** e-folding time of foam [s]. */
const FOAM_TAU = 3.5;
/** Foam injection rate at full strength [1/s]. */
const FOAM_RATE = 3;
/** Larger time jumps (seek/reset) clear the foam. */
const MAX_FOAM_DT = 2;

export class OceanSimulationGpu {
  readonly support: FloatSupport;
  readonly data: GpuOceanData;
  private readonly renderer: WebGLRenderer;
  private readonly pass = new FullscreenPass();
  private readonly fft: FftResources;
  private readonly cascades: CascadeGpu[];
  private readonly spectrumMat: RawShaderMaterial;
  private readonly fftMat: RawShaderMaterial;
  private readonly assembleMat: RawShaderMaterial;
  private lastT = Number.NaN;
  private foamThreshold = 0.6;
  private computed = false;

  constructor(renderer: WebGLRenderer, data: GpuOceanData, support: FloatSupport) {
    this.renderer = renderer;
    this.data = data;
    this.support = support;
    if (support.path === 'none') throw new Error('Float render targets are not available');
    const n = data.cascades[0]?.n ?? 64;
    if (!data.cascades.every((c) => c.n === n) || (n & (n - 1)) !== 0 || n < 4) {
      throw new Error('All cascades must share one power-of-two grid size');
    }
    this.fft = this.createFftResources(n);
    this.cascades = data.cascades.map((c) => this.createCascade(c.size, c.n, c.h0));

    this.spectrumMat = rawMaterial(SPECTRUM_FRAGMENT, {
      uH0: { value: null },
      uN: { value: n },
      uSize: { value: 1 },
      uTime: { value: 0 },
      uLambda: { value: data.choppiness },
      uDepth: { value: data.depth },
    });
    this.fftMat = rawMaterial(FFT_PASS_FRAGMENT, {
      uInA: { value: null },
      uInB: { value: null },
      uTwiddle: { value: this.fft.twiddle },
      uN: { value: n },
      uNs: { value: 1 },
      uAxis: { value: 0 },
    });
    this.assembleMat = rawMaterial(ASSEMBLE_FRAGMENT, {
      uInA: { value: null },
      uInB: { value: null },
      uFoamPrev: { value: null },
      uDt: { value: 0 },
      uFoamDecay: { value: 1 },
      uFoamThreshold: { value: 0.6 },
      uFoamRate: { value: FOAM_RATE },
      uFoamEnabled: { value: 1 },
    });
  }

  get n(): number {
    return this.fft.n;
  }

  get cascadeCount(): number {
    return this.cascades.length;
  }

  /** Current sampling textures of cascade `i` (the objects change after every update). */
  textures(i: number): CascadeTextures | undefined {
    return this.cascades[i]?.textures;
  }

  /**
   * Wind-driven whitecap coverage W = 3.84·10⁻⁶ U^3.41 (Monahan & O'Muircheartaigh 1980) raises
   * the Jacobian threshold below which foam forms.
   */
  setWind(windSpeed: number): void {
    const w = Math.min(1, 3.84e-6 * Math.pow(Math.max(0, windSpeed), 3.41));
    this.foamThreshold = Math.min(0.95, 0.6 + 0.6 * Math.sqrt(w));
  }

  /** Evolve every cascade to time t. Returns false when nothing had to be recomputed. */
  update(t: number): boolean {
    if (this.computed && t === this.lastT) return false;
    let dt = Number.isNaN(this.lastT) ? 0 : t - this.lastT;
    let decay = Math.exp(-Math.max(0, dt) / FOAM_TAU);
    if (dt < 0 || dt > MAX_FOAM_DT) {
      dt = 0;
      decay = 0; // time jumped (reset/seek): start without foam
    }
    dt = Math.min(dt, 0.25);
    this.lastT = t;
    this.computed = true;

    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    const su = this.spectrumMat.uniforms;
    const fu = this.fftMat.uniforms;
    const au = this.assembleMat.uniforms;
    su.uTime!.value = t;
    au.uDt!.value = dt;
    au.uFoamDecay!.value = decay;
    au.uFoamThreshold!.value = this.foamThreshold;

    for (const c of this.cascades) {
      // 1. time evolution + derived spectra → ping
      su.uH0!.value = c.h0;
      su.uSize!.value = c.size;
      this.pass.render(renderer, this.spectrumMat, this.fft.ping);
      // 2. inverse FFT, rows (x) then columns (y)
      let src = this.fft.ping;
      let dst = this.fft.pong;
      for (let axis = 0; axis < 2; axis++) {
        fu.uAxis!.value = axis;
        for (let s = 0; s < this.fft.log2n; s++) {
          fu.uNs!.value = 1 << s;
          fu.uInA!.value = src.textures[0];
          fu.uInB!.value = src.textures[1];
          this.pass.render(renderer, this.fftMat, dst);
          const tmp = src;
          src = dst;
          dst = tmp;
        }
      }
      // 3. unpack + foam → the other output target (ping-pong for the foam history)
      const prev = c.outputs[c.current]!;
      const next = c.outputs[1 - c.current]!;
      au.uInA!.value = src.textures[0];
      au.uInB!.value = src.textures[1];
      au.uFoamPrev!.value = prev.textures[CascadeOutput.Foam];
      this.pass.render(renderer, this.assembleMat, next); // also regenerates the mipmaps
      c.current = 1 - c.current;
      c.textures.displacement = next.textures[CascadeOutput.Displacement]!;
      c.textures.derivatives = next.textures[CascadeOutput.Derivatives]!;
      c.textures.foam = next.textures[CascadeOutput.Foam]!;
    }

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    return true;
  }

  /**
   * Read back one output attachment of a cascade (RGBA per texel, row-major, row ↔ y) — used by
   * the GPU↔CPU consistency harness.
   */
  readCascade(index: number, output: CascadeOutput, out: Float32Array): Float32Array {
    const c = this.cascades[index];
    if (!c) throw new RangeError(`No cascade ${index}`);
    const rt = c.outputs[c.current]!;
    const n = c.n;
    if (out.length !== 4 * n * n) throw new RangeError('Readback buffer has the wrong size');
    if (this.support.outputType === FloatType) {
      this.renderer.readRenderTargetPixels(rt, 0, 0, n, n, out, undefined, output);
    } else {
      const half = new Uint16Array(4 * n * n);
      this.renderer.readRenderTargetPixels(rt, 0, 0, n, n, half, undefined, output);
      for (let i = 0; i < half.length; i++) out[i] = DataUtils.fromHalfFloat(half[i]!);
    }
    return out;
  }

  dispose(): void {
    this.pass.dispose();
    this.spectrumMat.dispose();
    this.fftMat.dispose();
    this.assembleMat.dispose();
    this.fft.ping.dispose();
    this.fft.pong.dispose();
    this.fft.twiddle.dispose();
    for (const c of this.cascades) {
      c.h0.dispose();
      c.outputs[0].dispose();
      c.outputs[1].dispose();
    }
  }

  // ------------------------------------------------------------------ resources

  private createFftResources(n: number): FftResources {
    const opts = {
      count: 2,
      type: this.support.fftType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    } as const;
    // Twiddle table e^{+2πi t/N}, t ∈ [0, N/2), in double precision.
    const half = n / 2;
    const tw = new Float32Array(4 * half);
    for (let t = 0; t < half; t++) {
      const a = (2 * Math.PI * t) / n;
      tw[4 * t] = Math.cos(a);
      tw[4 * t + 1] = Math.sin(a);
    }
    const twiddle = new DataTexture(tw, half, 1, RGBAFormat, FloatType);
    twiddle.minFilter = NearestFilter;
    twiddle.magFilter = NearestFilter;
    twiddle.generateMipmaps = false;
    twiddle.needsUpdate = true;
    return {
      n,
      log2n: Math.round(Math.log2(n)),
      ping: new WebGLRenderTarget(n, n, opts),
      pong: new WebGLRenderTarget(n, n, opts),
      twiddle,
    };
  }

  private createCascade(size: number, n: number, data: Float32Array): CascadeGpu {
    const h0 = new DataTexture(data, n, n, RGBAFormat, FloatType);
    h0.minFilter = NearestFilter;
    h0.magFilter = NearestFilter;
    h0.generateMipmaps = false;
    h0.needsUpdate = true;
    const make = () =>
      new WebGLRenderTarget(n, n, {
        count: 3,
        type: this.support.outputType,
        format: RGBAFormat,
        minFilter: LinearMipmapLinearFilter,
        magFilter: LinearFilter,
        wrapS: RepeatWrapping,
        wrapT: RepeatWrapping,
        generateMipmaps: true,
        anisotropy: this.support.maxAnisotropy,
        depthBuffer: false,
        stencilBuffer: false,
      });
    const outputs: [WebGLRenderTarget, WebGLRenderTarget] = [make(), make()];
    return {
      size,
      n,
      h0,
      outputs,
      current: 0,
      textures: {
        size,
        n,
        displacement: outputs[0].textures[CascadeOutput.Displacement]!,
        derivatives: outputs[0].textures[CascadeOutput.Derivatives]!,
        foam: outputs[0].textures[CascadeOutput.Foam]!,
      },
    };
  }
}

function rawMaterial(
  fragmentShader: string,
  uniforms: Record<string, { value: unknown }>,
): RawShaderMaterial {
  return new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}
