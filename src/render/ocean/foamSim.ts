/**
 * Persistent whitecap foam. Each of the large cascades keeps a foam map in its own texture space
 * (the particle labels the slope textures use), so foam rides the orbital motion of the water
 * and outlives the breaking crest that made it:
 *   foam' = max(foam · e^{−Δt/τ}, inject),
 * where `inject` is set wherever the cascade's surface compresses (Jacobian below a gate taken
 * from the Monahan whitecap fraction) on the upper part of the waves. A second channel keeps
 * the "fresh" foam on a short time constant, so the shader can tell active breaking from the
 * decaying, bubbly residue.
 *
 * The maths here mirrors FOAM_GLSL in shaders.ts; the unit tests check this copy.
 */
import * as THREE from 'three';
import { FOAM_SIM_FRAG, FFT_VERT } from './shaders';

/** Cascades that carry a foam map (the 1024, 256 and 64 m patches). */
export const MAX_FOAM_CASCADES = 3;
/** e-folding time of the residual foam per cascade [s]: big breakers leave long-lived patches. */
export const FOAM_TAU: readonly number[] = [5, 3.5, 2];
/**
 * Extra compression a cascade needs before it breaks, as a fraction of its share (see
 * whitecapGate). One cascade's Jacobian is smooth over a whole crest, so without it the long
 * waves would whiten every crest in a broad sheet; only their steepest groups break.
 */
export const FOAM_MARGIN: readonly number[] = [0.3, 0.16, 0.1];
/** e-folding time of the "fresh" (actively breaking) foam channel [s]. */
export const FOAM_FRESH_TAU = 0.8;

/**
 * Fraction of last step's foam that survives a step of `dt` [s] with time constant `tau` [s].
 * Anything but a forward (or zero) step — time running backwards after a replay jump, NaN on the
 * first step of a new sea — returns 0, which restarts the foam from what is breaking now.
 */
export function foamDecay(dt: number, tau: number): number {
  if (!Number.isFinite(dt) || dt < 0 || !(tau > 0)) return 0;
  return Math.exp(-Math.min(dt / tau, 50));
}

/**
 * Share of the surface compression that one cascade carries, √(mss_i / Σ mss) [-]. The Jacobian
 * of a single cascade varies less than that of the whole sea, so its breaking gate is moved
 * toward 1 by the same factor and every cascade breaks over a comparable fraction of its area.
 */
export function foamShares(slopeVariance: readonly number[]): number[] {
  const total = slopeVariance.reduce((s, v) => s + Math.max(v, 0), 0);
  return slopeVariance.map((v) => (total > 0 ? Math.sqrt(Math.max(v, 0) / total) : 0));
}

/**
 * Jacobian below which a cascade breaks. The whole-sea gate 0.5 + 0.7 √W (+ 0.15 in a squall,
 * W = Monahan whitecap fraction) is the one the instantaneous shader path uses; a cascade with
 * share s of the compression and margin m breaks at 1 − (1 − gate + m) s.
 */
export function whitecapGate(whitecap: number, squall: number, share: number, margin = 0): number {
  const gate = 0.5 + 0.7 * Math.sqrt(Math.max(whitecap, 0)) + 0.15 * squall;
  return 1 - (1 - gate + margin) * share;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Foam made in one step: 1 where the Jacobian is well under the gate, fading over a band of
 * 0.25 s below it, weighted toward the crests (`onCrest` 0 in troughs, 1 on top).
 */
export function foamInject(jacobian: number, gate: number, share: number, onCrest: number): number {
  const width = Math.max(0.25 * share, 1e-3);
  return (1 - smoothstep(gate - width, gate, jacobian)) * (0.35 + 0.65 * onCrest);
}

/** One step of the foam map at a texel. */
export function foamStep(prev: number, inject: number, decay: number): number {
  return Math.max(prev * decay, inject);
}

function foamTarget(n: number): THREE.WebGLRenderTarget {
  // Half floats: 8-bit storage would stall the slow decay (255 · (1 − e^{−Δt/τ}) < ½ a step).
  // RGBA16F is colour-renderable on both the float and the half-float paths and always filters.
  const rt = new THREE.WebGLRenderTarget(n, n, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearMipmapLinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: true,
  });
  rt.texture.generateMipmaps = true;
  rt.texture.anisotropy = 4;
  rt.texture.flipY = false;
  return rt;
}

export interface FoamStepInput {
  /** Sea time [s]. */
  t: number;
  /** Per cascade: slope target (∂η/∂x, ∂η/∂y, ∂Dx/∂x, ∂Dy/∂y), or null when it is quiet. */
  slopes: readonly (THREE.Texture | null)[];
  /** Per cascade: displacement target (η, Dx, Dy). */
  outputs: readonly (THREE.Texture | null)[];
  /** Per cascade: significant height of the cascade alone [m] (crest weighting). */
  hs: readonly number[];
  /** Per cascade: share of the compression (foamShares). */
  shares: readonly number[];
  /** Monahan whitecap fraction W [-]. */
  whitecap: number;
}

/** Ping-pong foam maps for the first `count` cascades. */
export class FoamSim {
  private readonly material: THREE.ShaderMaterial;
  private readonly targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget][] = [];
  /** Which of each pair holds the latest map. */
  private readonly front: number[] = [];
  private readonly lastT: number[] = [];
  private n = 0;
  private count = 0;

  constructor(
    private readonly blit: (
      material: THREE.ShaderMaterial,
      target: THREE.WebGLRenderTarget,
    ) => void,
  ) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null },
        uSlope: { value: null },
        uDisp: { value: null },
        uDecay: { value: 0 },
        uFreshDecay: { value: 0 },
        uWhitecap: { value: 0 },
        uShare: { value: 1 },
        uMargin: { value: 0 },
        uCascadeHs: { value: 1 },
      },
      vertexShader: FFT_VERT,
      fragmentShader: FOAM_SIM_FRAG,
      depthTest: false,
      depthWrite: false,
      precision: 'highp',
    });
  }

  /** Number of cascades with a foam map; 0 switches the shader to instantaneous foam. */
  setCount(count: number): void {
    const c = Math.max(0, Math.min(MAX_FOAM_CASCADES, Math.floor(count)));
    if (c === this.count) return;
    this.count = c;
    if (this.n >= 2) this.allocate(this.n);
  }

  /** (Re)create the maps for grid size n, empty; after a new sea or a restored context. */
  allocate(n: number): void {
    this.disposeTargets();
    this.n = n;
    if (n < 2) return;
    for (let i = 0; i < this.count; i++) {
      this.targets.push([foamTarget(n), foamTarget(n)]);
      this.front.push(0);
      this.lastT.push(Number.NaN);
    }
  }

  /** Forget the foam: the next step starts from what is breaking then. */
  reset(): void {
    for (let i = 0; i < this.lastT.length; i++) this.lastT[i] = Number.NaN;
  }

  /** Advance every cascade that is live this step; quiet ones are reset. */
  step(input: FoamStepInput): void {
    const u = this.material.uniforms;
    u.uWhitecap!.value = input.whitecap;
    for (let i = 0; i < this.targets.length; i++) {
      const pair = this.targets[i]!;
      const slope = input.slopes[i];
      const out = input.outputs[i];
      if (!slope || !out) {
        this.lastT[i] = Number.NaN;
        continue;
      }
      const dt = input.t - this.lastT[i]!;
      this.lastT[i] = input.t;
      const tau = FOAM_TAU[i] ?? FOAM_TAU[FOAM_TAU.length - 1]!;
      const decay = foamDecay(dt, tau);
      const prev = pair[this.front[i]!]!;
      const next = pair[1 - this.front[i]!]!;
      u.uPrev!.value = prev.texture;
      u.uSlope!.value = slope;
      u.uDisp!.value = out;
      u.uDecay!.value = decay;
      u.uFreshDecay!.value = decay > 0 ? foamDecay(dt, FOAM_FRESH_TAU) : 0;
      u.uShare!.value = input.shares[i] ?? 1;
      u.uMargin!.value = FOAM_MARGIN[i] ?? 0;
      u.uCascadeHs!.value = Math.max(input.hs[i] ?? 1, 0.05);
      this.blit(this.material, next);
      this.front[i] = 1 - this.front[i]!;
    }
  }

  /** Latest foam map of a cascade (R = foam, G = fresh foam), or null without one. */
  texture(i: number): THREE.Texture | null {
    const pair = this.targets[i];
    if (!pair || !Number.isFinite(this.lastT[i])) return null;
    return pair[this.front[i]!]!.texture;
  }

  dispose(): void {
    this.disposeTargets();
    this.material.dispose();
  }

  private disposeTargets(): void {
    for (const [a, b] of this.targets) {
      a.dispose();
      b.dispose();
    }
    this.targets.length = 0;
    this.front.length = 0;
    this.lastT.length = 0;
  }
}
