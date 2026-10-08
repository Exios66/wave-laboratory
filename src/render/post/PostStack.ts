/**
 * HDR post chain: the scene is drawn into a half-float target (so the sun glint, the sun disc
 * and lightning can exceed 1.0), bloom lifts only those genuinely bright values, an optional
 * grade pass adds vignette and film grain, and a final output pass applies the renderer's
 * exposure, ACES filmic tone mapping and the sRGB transfer exactly once.
 *
 * With every effect off (or half-float colour buffers missing) the stack is inactive and the
 * renderer draws straight to the canvas, exactly as before.
 *
 * Passes are an ordered list, so later stages (for example a depth-based underwater fog that
 * reads the target's depth texture) can slot in before the grade pass.
 *
 * Antialiasing: the canvas MSAA does not carry into off-screen targets, so on the 'full' tier
 * the HDR target is itself multisampled (up to 4x). The 'light' tier (phones, software GPUs)
 * has no MSAA on the canvas either, so nothing is lost there.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { PostSettings } from '../api';

/** Luminance (linear, before exposure) above which pixels bloom. Ordinary surfaces stay below. */
export const BLOOM_THRESHOLD = 1.2;
const BLOOM_STRENGTH = 0.35;
const BLOOM_RADIUS = 0.55;

/** True when the context can render into half-float colour buffers. */
export function supportsHdrTarget(gl: WebGL2RenderingContext): boolean {
  return (
    gl.getExtension('EXT_color_buffer_float') !== null ||
    gl.getExtension('EXT_color_buffer_half_float') !== null
  );
}

const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0 },
    uGrain: { value: 0 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uTime;
    varying vec2 vUv;
    float hash(vec2 p) {
      vec3 q = fract(vec3(p.xyx) * 0.1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
    }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.82, 0.18, length(d * vec2(1.0, 0.9)));
      c.rgb *= mix(1.0, v, uVignette);
      // Grain is multiplicative so it follows the image and stays in the linear HDR range.
      float n = hash(gl_FragCoord.xy + fract(uTime * 0.37) * 1000.0) - 0.5;
      c.rgb *= 1.0 + n * 0.16 * uGrain;
      gl_FragColor = c;
    }
  `,
};

export class PostStack {
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  private settings: PostSettings = { bloom: false, grain: false, vignette: false };
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private readonly supported: boolean;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly tier: 'light' | 'full',
  ) {
    this.supported = supportsHdrTarget(renderer.getContext() as WebGL2RenderingContext);
  }

  /** Whether the HDR chain should draw this frame. */
  get active(): boolean {
    const s = this.settings;
    return this.supported && (s.bloom || s.grain || s.vignette);
  }

  /** Whether the sun glint and lightning should be boosted above 1.0 for the bloom pass. */
  get bloomOn(): boolean {
    return this.supported && this.settings.bloom;
  }

  setSettings(settings: PostSettings): void {
    this.settings = { ...settings };
    this.applySettings();
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = pixelRatio;
    if (this.composer) {
      this.composer.setPixelRatio(pixelRatio);
      this.composer.setSize(this.width, this.height);
    }
  }

  /** Draw one frame to the canvas. Grain animates on wall-clock time, even while paused. */
  render(): void {
    if (!this.active) return;
    this.composer ??= this.build();
    if (this.grade) this.grade.uniforms.uTime!.value = performance.now() / 1000;
    this.composer.render();
  }

  /** Rebuild the targets after a WebGL context restore. */
  restore(): void {
    this.disposeComposer();
  }

  dispose(): void {
    this.disposeComposer();
  }

  private build(): EffectComposer {
    const w = Math.round(this.width * this.pixelRatio);
    const h = Math.round(this.height * this.pixelRatio);
    const maxSamples = this.renderer.capabilities.maxSamples;
    const target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: this.tier === 'full' ? Math.min(4, maxSamples) : 0,
      // The depth texture is kept for later passes (underwater fog reads scene depth).
      depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType),
    });
    const composer = new EffectComposer(this.renderer, target);
    composer.setPixelRatio(this.pixelRatio);
    composer.setSize(this.width, this.height);

    const bloom = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    const grade = new ShaderPass(GradeShader);
    const passes: Pass[] = [
      new RenderPass(this.scene, this.camera),
      bloom,
      grade,
      new OutputPass(),
    ];
    for (const pass of passes) composer.addPass(pass);
    this.bloom = bloom;
    this.grade = grade;
    this.composer = composer;
    this.applySettings();
    return composer;
  }

  private applySettings(): void {
    if (this.bloom) this.bloom.enabled = this.settings.bloom;
    if (this.grade) {
      const { grain, vignette } = this.settings;
      this.grade.enabled = grain || vignette;
      this.grade.uniforms.uGrain!.value = grain ? 1 : 0;
      this.grade.uniforms.uVignette!.value = vignette ? 1 : 0;
    }
  }

  private disposeComposer(): void {
    for (const pass of this.composer?.passes ?? []) pass.dispose();
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    this.grade = null;
  }
}
