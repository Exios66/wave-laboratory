/**
 * Tessendorf ocean on the GPU: upload the CPU's h₀, evolve it, inverse-FFT each cascade,
 * and expose displacement textures the water shader samples. One shot per new sea compares
 * a texel against the CPU FFT so a shader regression fails loudly.
 */
import * as THREE from 'three';
import { FFT } from '../../ocean/fft';
import type { GpuOceanData } from '../../ocean/gpuData';
import { evolveSpectra } from './evolve';
import { COMBINE_FRAG, FFT_FRAG, FFT_VERT, SPECTRUM_FRAG } from './shaders';

const MAX_CASCADES = 4;
const MAX_REGULAR = 8;

function srgbChannel(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function floatTarget(
  n: number,
  filter: THREE.MagnificationTextureFilter,
  wrap: THREE.Wrapping,
  type: THREE.TextureDataType,
): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(n, n, {
    type,
    format: THREE.RGBAFormat,
    magFilter: filter,
    minFilter: filter,
    wrapS: wrap,
    wrapT: wrap,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: false,
  });
  rt.texture.generateMipmaps = false;
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.flipY = false;
  return rt;
}

function blackTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export class GpuOcean {
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fftMat: THREE.ShaderMaterial;
  private readonly spectrumMat: THREE.ShaderMaterial;
  private readonly combineMat: THREE.ShaderMaterial;
  private readonly black = blackTexture();
  private readonly sampleFilter: THREE.MagnificationTextureFilter;
  private readonly texType: THREE.TextureDataType;
  private scratchA: THREE.WebGLRenderTarget | null = null;
  private scratchB: THREE.WebGLRenderTarget | null = null;
  private spec: THREE.WebGLRenderTarget | null = null;
  private complexH: THREE.WebGLRenderTarget | null = null;
  private complexD: THREE.WebGLRenderTarget | null = null;
  private readonly outputs: THREE.WebGLRenderTarget[] = [];
  private readonly sources: THREE.DataTexture[] = [];
  private data: GpuOceanData | null = null;
  private n = 0;
  private lambda = 1;
  private depth = 1000;
  private dirty = true;
  private lastT = Number.NaN;
  private verified = false;

  constructor(renderer: THREE.WebGLRenderer, texType: THREE.TextureDataType = THREE.FloatType) {
    this.renderer = renderer;
    this.texType = texType;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const linear =
      texType === THREE.HalfFloatType
        ? gl.getExtension('OES_texture_half_float_linear')
        : gl.getExtension('OES_texture_float_linear');
    this.sampleFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;

    const regA = Array.from({ length: MAX_REGULAR }, () => new THREE.Vector4());
    const regB = Array.from({ length: MAX_REGULAR }, () => new THREE.Vector4(1, 0, 1, 0));
    this.uniforms = {
      uC0: { value: this.black },
      uC1: { value: this.black },
      uC2: { value: this.black },
      uC3: { value: this.black },
      uSize0: { value: 1 },
      uSize1: { value: 1 },
      uSize2: { value: 1 },
      uSize3: { value: 1 },
      uCount: { value: 0 },
      uN: { value: 1 },
      uTime: { value: 0 },
      uLambda: { value: 1 },
      uEps: { value: 1.25 },
      uRegularCount: { value: 0 },
      uRegA: { value: regA },
      uRegB: { value: regB },
      uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.2).normalize() },
      uWind: { value: 8 },
      uHs: { value: 1 },
      uOverlay: { value: 0 },
      uFogColor: {
        value: new THREE.Color().setRGB(srgbChannel(0.78), srgbChannel(0.84), srgbChannel(0.9)),
      },
      uFogDensity: { value: 1.4e-6 },
    };

    const geo = new THREE.PlaneGeometry(2, 2);
    this.fftMat = this.passMaterial(FFT_FRAG, {
      uSrc: { value: this.black },
      uMode: { value: 0 },
      uBits: { value: 1 },
      uLen: { value: 2 },
      uSign: { value: 1 },
    });
    this.spectrumMat = this.passMaterial(SPECTRUM_FRAG, {
      uH0: { value: this.black },
      uN: { value: 2 },
      uSize: { value: 1 },
      uTime: { value: 0 },
      uDepth: { value: 1000 },
      uLambda: { value: 1 },
      uField: { value: 0 },
    });
    this.combineMat = this.passMaterial(COMBINE_FRAG, {
      uHeight: { value: this.black },
      uDisp: { value: this.black },
    });
    this.quad = new THREE.Mesh(geo, this.fftMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setData(data: GpuOceanData): void {
    this.disposeSources();
    this.data = data;
    this.lambda = data.choppiness;
    this.depth = data.depth;
    const n = data.cascades[0]?.n ?? 0;
    if (n !== this.n) this.allocate(n);
    data.cascades.slice(0, MAX_CASCADES).forEach((c, i) => {
      const tex = new THREE.DataTexture(c.h0, c.n, c.n, THREE.RGBAFormat, THREE.FloatType);
      tex.colorSpace = THREE.NoColorSpace;
      tex.flipY = false;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      this.sources[i] = tex;
    });
    const count = Math.min(data.cascades.length, MAX_CASCADES);
    this.uniforms.uCount!.value = count;
    this.uniforms.uN!.value = n;
    this.uniforms.uLambda!.value = data.choppiness;
    this.uniforms.uHs!.value = Math.max(data.hs, 0.05);
    const sizes = [
      this.uniforms.uSize0,
      this.uniforms.uSize1,
      this.uniforms.uSize2,
      this.uniforms.uSize3,
    ];
    for (let i = 0; i < MAX_CASCADES; i++) sizes[i]!.value = data.cascades[i]?.size ?? 1;
    const regA = this.uniforms.uRegA!.value as THREE.Vector4[];
    const regB = this.uniforms.uRegB!.value as THREE.Vector4[];
    for (let i = 0; i < MAX_REGULAR; i++) {
      const r = data.regular[i];
      regA[i]!.set(r?.amplitude ?? 0, r?.omega ?? 0, r?.k ?? 0, r?.phase ?? 0);
      regB[i]!.set(r?.dirX ?? 1, r?.dirY ?? 0, r?.cothKh ?? 1, 0);
    }
    this.uniforms.uRegularCount!.value = Math.min(data.regular.length, MAX_REGULAR);
    this.dirty = true;
    this.verified = false;
    this.lastT = Number.NaN;
  }

  /** Choppiness or depth edited before the worker republishes h₀. */
  setWaveParams(lambda: number, depth: number): void {
    if (lambda === this.lambda && depth === this.depth) return;
    this.lambda = lambda;
    this.depth = depth;
    this.uniforms.uLambda!.value = lambda;
    this.dirty = true;
  }

  /** Rebuild GPU buffers after the browser restores a lost context (a phone tab in the background). */
  restore(): void {
    const n = this.n;
    if (n >= 2) this.allocate(n);
    for (const tex of this.sources) tex.needsUpdate = true;
    this.dirty = true;
    this.lastT = Number.NaN;
  }

  update(t: number): void {
    if (!this.data || this.n < 2) return;
    if (!this.dirty && Math.abs(t - this.lastT) < 1e-6) return;
    this.dirty = false;
    this.lastT = t;
    this.uniforms.uTime!.value = t;
    const cascades = this.data.cascades;
    for (let i = 0; i < MAX_CASCADES; i++) {
      const c = cascades[i];
      const out = this.outputs[i];
      if (!c || !out || !this.sources[i] || c.variance < 1e-10) {
        if (out) this.clear(out);
        continue;
      }
      this.synthesize(this.sources[i]!, c.size, t, out);
    }
    const slots = [this.uniforms.uC0, this.uniforms.uC1, this.uniforms.uC2, this.uniforms.uC3];
    for (let i = 0; i < MAX_CASCADES; i++) {
      slots[i]!.value = this.outputs[i]?.texture ?? this.black;
    }
    if (!this.verified) this.verify(t);
  }

  dispose(): void {
    this.disposeSources();
    this.disposeTargets();
    this.black.dispose();
    this.fftMat.dispose();
    this.spectrumMat.dispose();
    this.combineMat.dispose();
    this.quad.geometry.dispose();
  }

  private synthesize(
    h0: THREE.Texture,
    size: number,
    t: number,
    out: THREE.WebGLRenderTarget,
  ): void {
    const spec = this.spec!;
    const complexH = this.complexH!;
    const complexD = this.complexD!;
    this.spectrumMat.uniforms.uH0!.value = h0;
    this.spectrumMat.uniforms.uN!.value = this.n;
    this.spectrumMat.uniforms.uSize!.value = size;
    this.spectrumMat.uniforms.uTime!.value = t;
    this.spectrumMat.uniforms.uDepth!.value = this.depth;
    this.spectrumMat.uniforms.uLambda!.value = this.lambda;
    this.spectrumMat.uniforms.uField!.value = 0;
    this.blit(this.spectrumMat, spec);
    this.ifft(spec, complexH);
    this.spectrumMat.uniforms.uField!.value = 1;
    this.blit(this.spectrumMat, spec);
    this.ifft(spec, complexD);
    this.combineMat.uniforms.uHeight!.value = complexH.texture;
    this.combineMat.uniforms.uDisp!.value = complexD.texture;
    this.blit(this.combineMat, out);
  }

  /** Inverse FFT, unnormalised, positive exponent. Result lands in `dst`. */
  private ifft(src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget): void {
    const n = this.n;
    const bits = Math.round(Math.log2(n));
    const A = this.scratchA!;
    const B = this.scratchB!;
    this.fft(src, A, 0, bits, 2);
    let curr = A;
    let next = B;
    for (let len = 2; len <= n; len <<= 1) {
      this.fft(curr, next, 1, bits, len);
      const swap = curr;
      curr = next;
      next = swap;
    }
    this.fft(curr, next, 2, bits, 2);
    curr = next;
    next = curr === A ? B : A;
    const stages = Math.round(Math.log2(n));
    for (let s = 0; s < stages; s++) {
      const len = 2 << s;
      const dest = s === stages - 1 ? dst : next;
      this.fft(curr, dest, 3, bits, len);
      if (s !== stages - 1) {
        const swap = curr;
        curr = next;
        next = swap;
      }
    }
  }

  private fft(
    src: THREE.WebGLRenderTarget,
    dst: THREE.WebGLRenderTarget,
    mode: number,
    bits: number,
    len: number,
  ): void {
    this.fftMat.uniforms.uSrc!.value = src.texture;
    this.fftMat.uniforms.uMode!.value = mode;
    this.fftMat.uniforms.uBits!.value = bits;
    this.fftMat.uniforms.uLen!.value = len;
    this.fftMat.uniforms.uSign!.value = 1;
    this.blit(this.fftMat, dst);
  }

  private blit(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
    this.renderer.setRenderTarget(null);
  }

  private readonly clearColor = new THREE.Color();

  private clear(target: THREE.WebGLRenderTarget): void {
    this.renderer.getClearColor(this.clearColor);
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.clearColor, alpha);
  }

  private allocate(n: number): void {
    this.disposeTargets();
    this.n = n;
    if (n < 2) return;
    const nearest = THREE.NearestFilter;
    const clamp = THREE.ClampToEdgeWrapping;
    this.scratchA = floatTarget(n, nearest, clamp, this.texType);
    this.scratchB = floatTarget(n, nearest, clamp, this.texType);
    this.spec = floatTarget(n, nearest, clamp, this.texType);
    this.complexH = floatTarget(n, nearest, clamp, this.texType);
    this.complexD = floatTarget(n, nearest, clamp, this.texType);
    for (let i = 0; i < MAX_CASCADES; i++) {
      this.outputs[i] = floatTarget(n, this.sampleFilter, THREE.RepeatWrapping, this.texType);
    }
  }

  private verify(t: number): void {
    this.verified = true;
    // Half-float targets are a compatibility path; readback of them is not reliable.
    if (this.texType !== THREE.FloatType) return;
    const data = this.data;
    const out = this.outputs[0];
    const cascade = data?.cascades[0];
    if (!data || !out || !cascade || cascade.variance < 1e-8 || cascade.n !== this.n) return;
    const evolved = evolveSpectra(cascade.h0, this.n, cascade.size, t, this.depth, this.lambda);
    const fft = new FFT(this.n);
    fft.inverse2D(evolved.height);
    fft.inverse2D(evolved.packedDisp);
    const buf = new Float32Array(4);
    const points = [
      [1, 0],
      [0, 1],
      [this.n >> 2, this.n >> 3],
      [3, 5],
    ];
    let worst = 0;
    let detail = '';
    for (const [ix, iy] of points) {
      if (ix! >= this.n || iy! >= this.n) continue;
      this.renderer.readRenderTargetPixels(out, ix!, iy!, 1, 1, buf);
      const cell = 2 * (iy! * this.n + ix!);
      const dEta = Math.abs(buf[0]! - evolved.height[cell]!);
      const dDx = Math.abs(buf[1]! - evolved.packedDisp[cell]!);
      const dDy = Math.abs(buf[2]! - evolved.packedDisp[cell + 1]!);
      const err = Math.max(dEta, dDx, dDy);
      if (err > worst) {
        worst = err;
        detail = `(${ix},${iy}) gpu η,Dx,Dy=${buf[0]!.toFixed(4)},${buf[1]!.toFixed(4)},${buf[2]!.toFixed(4)} cpu=${evolved.height[cell]!.toFixed(4)},${evolved.packedDisp[cell]!.toFixed(4)},${evolved.packedDisp[cell + 1]!.toFixed(4)}`;
      }
    }
    // Float32 FFT roundoff stays far below a centimetre; anything larger is a real mismatch.
    if (worst > 0.02) {
      console.error(
        `GPU ocean does not match the CPU FFT (${worst.toExponential(2)} m): ${detail}`,
      );
    }
  }

  private passMaterial(
    fragmentShader: string,
    uniforms: Record<string, THREE.IUniform>,
  ): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FFT_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      precision: 'highp',
    });
  }

  private disposeSources(): void {
    for (const tex of this.sources) tex.dispose();
    this.sources.length = 0;
  }

  private disposeTargets(): void {
    for (const rt of [
      this.scratchA,
      this.scratchB,
      this.spec,
      this.complexH,
      this.complexD,
      ...this.outputs,
    ]) {
      rt?.dispose();
    }
    this.scratchA = this.scratchB = this.spec = this.complexH = this.complexD = null;
    this.outputs.length = 0;
    this.n = 0;
  }
}
