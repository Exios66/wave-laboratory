/**
 * Sun shafts by screen-space radial blur (Mitchell, GPU Gems 3 ch. 13), in three steps:
 *  1. mask, at quarter resolution: only open sky (the scene depth at the far plane) that is
 *     bright, weighted toward the sun's image. Clouds, masts, islands and hulls are dark;
 *  2. march, at quarter resolution: each pixel sums the mask along the line to the sun with a
 *     decaying weight, which streams the bright gaps out into rays;
 *  3. add the rays to the frame, tinted by the sunlight, at full resolution.
 *
 * Runs after TAA (its jitter never enters the history), so it reads the scene depth that the
 * scene pass left: `PostStack` hands it over with `setDepth`.
 */
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

/** Samples along each ray toward the sun. */
const MARCH_SAMPLES = 40;

export interface ShaftParams {
  /** Sun on screen (uv). */
  x: number;
  y: number;
  /** 0–1 (see `shaftStrength`). */
  strength: number;
  /** Linear sunlight colour. */
  tint: readonly [number, number, number] | readonly number[];
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MASK_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uSun;
uniform float uAspect;
uniform float uReversed;
uniform vec4 uTune;
varying vec2 vUv;
void main() {
  float z = texture2D(tDepth, vUv).x;
  float sky = uReversed > 0.5 ? 1.0 - step(1.0e-6, z) : step(0.999999, z);
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float bright = smoothstep(uTune.x, uTune.y, lum);
  float near = 1.0 - smoothstep(0.0, uTune.z, length((vUv - uSun) * vec2(uAspect, 1.0)));
  gl_FragColor = vec4(vec3(sky * bright * near * near), 1.0);
}
`;

const MARCH_FRAG = /* glsl */ `
uniform sampler2D tMask;
uniform vec2 uSun;
uniform vec4 uTune2;
varying vec2 vUv;
void main() {
  vec2 delta = (vUv - uSun) * (uTune2.x / ${MARCH_SAMPLES}.0);
  // Interleaved gradient noise against banding between the samples.
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec2 p = vUv - delta * jit;
  float w = 1.0;
  float sum = 0.0;
  for (int i = 0; i < ${MARCH_SAMPLES}; i++) {
    sum += texture2D(tMask, clamp(p, 0.0, 1.0)).r * w;
    w *= uTune2.y;
    p -= delta;
  }
  gl_FragColor = vec4(vec3(sum / ${MARCH_SAMPLES}.0), 1.0);
}
`;

const ADD_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tShafts;
uniform vec3 uTint;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  gl_FragColor = vec4(c.rgb + texture2D(tShafts, vUv).r * uTint, c.a);
}
`;

export class SunShaftPass extends Pass {
  private readonly mask: THREE.WebGLRenderTarget;
  private readonly march: THREE.WebGLRenderTarget;
  private readonly maskMat: THREE.ShaderMaterial;
  private readonly marchMat: THREE.ShaderMaterial;
  private readonly addMat: THREE.ShaderMaterial;
  private readonly quad = new FullScreenQuad();
  private depth: THREE.Texture | null = null;

  constructor() {
    super();
    this.needsSwap = true;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false } as const;
    this.mask = new THREE.WebGLRenderTarget(1, 1, opts);
    this.march = new THREE.WebGLRenderTarget(1, 1, opts);
    const common = { vertexShader: VERT, depthTest: false, depthWrite: false };
    this.maskMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: MASK_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uSun: { value: new THREE.Vector2(0.5, 0.5) },
        uAspect: { value: 1 },
        uReversed: { value: 0 },
        uTune: { value: new THREE.Vector4(1, 2.6, 0.5, 0) },
      },
    });
    this.marchMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: MARCH_FRAG,
      uniforms: {
        tMask: { value: this.mask.texture },
        uSun: this.maskMat.uniforms.uSun!,
        uTune2: { value: new THREE.Vector4(0.9, 0.965, 0, 0) },
      },
    });
    this.addMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: ADD_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        tShafts: { value: this.march.texture },
        uTint: { value: new THREE.Vector3() },
      },
    });
  }

  /** The scene pass's depth (sky = far plane). */
  setDepth(depth: THREE.Texture | null): void {
    this.depth = depth;
  }

  set(params: ShaftParams): void {
    (this.maskMat.uniforms.uSun!.value as THREE.Vector2).set(params.x, params.y);
    const tune = (globalThis as unknown as { __shaftTune?: number[] }).__shaftTune;
    if (tune) {
      (this.maskMat.uniforms.uTune!.value as THREE.Vector4).set(tune[0]!, tune[1]!, tune[2]!, 0);
      (this.marchMat.uniforms.uTune2!.value as THREE.Vector4).set(tune[3]!, tune[4]!, 0, 0);
    }
    const k = params.strength * (tune ? tune[5]! : 0.45);
    (this.addMat.uniforms.uTint!.value as THREE.Vector3).set(
      (params.tint[0] ?? 1) * k,
      (params.tint[1] ?? 1) * k,
      (params.tint[2] ?? 1) * k,
    );
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / 4));
    const h = Math.max(1, Math.floor(height / 4));
    this.mask.setSize(w, h);
    this.march.setSize(w, h);
    this.maskMat.uniforms.uAspect!.value = width / Math.max(1, height);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const depth = this.depth ?? readBuffer.depthTexture;
    const out = this.renderToScreen ? null : writeBuffer;
    this.addMat.uniforms.tDiffuse!.value = readBuffer.texture;
    if (depth) {
      const m = this.maskMat.uniforms;
      m.tDiffuse!.value = readBuffer.texture;
      m.tDepth!.value = depth;
      m.uReversed!.value = renderer.state.buffers.depth.getReversed() ? 1 : 0;
      this.quad.material = this.maskMat;
      renderer.setRenderTarget(this.mask);
      this.quad.render(renderer);
      this.quad.material = this.marchMat;
      renderer.setRenderTarget(this.march);
      this.quad.render(renderer);
    } else {
      // No depth to tell sky from scene: draw the frame through unchanged.
      (this.addMat.uniforms.uTint!.value as THREE.Vector3).set(0, 0, 0);
    }
    this.quad.material = this.addMat;
    renderer.setRenderTarget(out);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.mask.dispose();
    this.march.dispose();
    this.maskMat.dispose();
    this.marchMat.dispose();
    this.addMat.dispose();
    this.quad.dispose();
  }
}
