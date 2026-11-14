/**
 * Temporal antialiasing pass. The scene is drawn with a sub-pixel jitter that changes every
 * frame (PostStack sets it on the camera); this pass blends each frame into a running history,
 * so sub-pixel glints and foam on distant water settle instead of shimmering.
 *
 * - Reprojection is camera-only: each pixel's world position comes from the scene depth and
 *   the current (unjittered) camera, then the previous camera says where it was last frame.
 * - The history is clamped to the 3×3 neighbourhood of the current frame in YCoCg, which keeps
 *   moving water and ships from smearing (ghosting).
 * - Luminance weighting (1 / (1 + luma)) keeps HDR highlights from flickering in the blend.
 * - History fades out toward the eye (`historyWeight`), is dropped off-screen, and is dropped
 *   on a cut (`reset()` or `isCameraCut`).
 *
 * It must run straight after the scene pass: it samples the depth of the target it reads
 * (PostStack keeps it off while the underwater pass, which writes elsewhere, is on). It writes a
 * history target of its own and copies that on, so it never samples what it writes.
 */
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import {
  HISTORY_FAR_M,
  HISTORY_MAX,
  HISTORY_NEAR_M,
  isCameraCut,
  unjitterUv,
  type CameraSnapshot,
} from './taa';

const ResolveShader = {
  name: 'TaaResolveShader',
  uniforms: {
    tCurrent: { value: null as THREE.Texture | null },
    tHistory: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uInvViewProj: { value: new THREE.Matrix4() },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uJitterUv: { value: new THREE.Vector2() },
    uTexel: { value: new THREE.Vector2() },
    uReversed: { value: 0 },
    uFresh: { value: 1 },
    uHistory: { value: new THREE.Vector3(HISTORY_NEAR_M, HISTORY_FAR_M, HISTORY_MAX) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tCurrent;
    uniform sampler2D tHistory;
    uniform sampler2D tDepth;
    uniform mat4 uInvViewProj;
    uniform mat4 uPrevViewProj;
    uniform vec3 uCamPos;
    uniform vec2 uJitterUv;
    uniform vec2 uTexel;
    uniform float uReversed;
    uniform float uFresh;
    uniform vec3 uHistory; // near [m], far [m], share of history far away
    varying vec2 vUv;

    vec3 toYCoCg(vec3 c) {
      return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * (c.r - c.b), 0.5 * c.g - 0.25 * (c.r + c.b));
    }
    vec3 fromYCoCg(vec3 c) {
      return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
    }

    void main() {
      vec4 current = texture2D(tCurrent, vUv);
      vec3 cur = toYCoCg(current.rgb);
      vec3 lo = cur;
      vec3 hi = cur;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec3 s = toYCoCg(texture2D(tCurrent, vUv + vec2(float(x), float(y)) * uTexel).rgb);
          lo = min(lo, s);
          hi = max(hi, s);
        }
      }

      // Where this pixel was last frame (mirrors historyUv in taa.ts): the pixel's own world
      // position, from the unjittered camera and the depth where the jittered frame drew it,
      // then the previous camera. A still camera reads its history from the same pixel.
      float d = texture2D(tDepth, vUv - uJitterUv).x;
      vec3 ndc = vec3(vUv * 2.0 - 1.0, uReversed > 0.5 ? d : d * 2.0 - 1.0);
      vec4 world = uInvViewProj * vec4(ndc, 1.0);
      float keep = 0.0;
      vec2 prevUv = vUv;
      if (abs(world.w) > 1e-9) {
        world.xyz /= world.w;
        vec4 prev = uPrevViewProj * vec4(world.xyz, 1.0);
        if (prev.w > 1e-6) {
          prevUv = prev.xy / prev.w * 0.5 + 0.5;
          float t = clamp((length(world.xyz - uCamPos) - uHistory.x) / (uHistory.y - uHistory.x), 0.0, 1.0);
          keep = uHistory.z * t * t * (3.0 - 2.0 * t);
          if (any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) keep = 0.0;
        }
      }
      if (uFresh > 0.5) keep = 0.0;

      // No history (a cut, off-screen, near the eye): the current frame alone, untouched.
      if (keep <= 0.0) {
        gl_FragColor = current;
        return;
      }
      vec3 hist = clamp(toYCoCg(texture2D(tHistory, prevUv).rgb), lo, hi);
      float wc = (1.0 - keep) / (1.0 + max(cur.x, 0.0));
      float wh = keep / (1.0 + max(hist.x, 0.0));
      vec3 blended = (cur * wc + hist * wh) / (wc + wh);
      gl_FragColor = vec4(fromYCoCg(blended), current.a);
    }
  `,
};

function historyTarget(): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
}

export class TaaPass extends Pass {
  /** This frame's jitter [px], as PostStack applied it to the camera. */
  readonly jitter: [number, number] = [0, 0];
  private readonly history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] = [
    historyTarget(),
    historyTarget(),
  ];
  private latest: 0 | 1 = 0;
  private fresh = true;
  private width = 1;
  private height = 1;
  private readonly resolve = new THREE.ShaderMaterial({
    name: ResolveShader.name,
    uniforms: THREE.UniformsUtils.clone(ResolveShader.uniforms),
    vertexShader: ResolveShader.vertexShader,
    fragmentShader: ResolveShader.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  private readonly copy = new THREE.ShaderMaterial({
    name: 'TaaCopy',
    uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
    vertexShader: CopyShader.vertexShader,
    fragmentShader: CopyShader.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  private readonly quad = new FullScreenQuad();
  private readonly viewProj = new THREE.Matrix4();
  private readonly prevViewProj = new THREE.Matrix4();
  private prevSnapshot: CameraSnapshot | null = null;
  private readonly forward = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    super();
    this.needsSwap = true;
  }

  /** Forget the history: the next frame shows only itself (a camera cut). */
  reset(): void {
    this.fresh = true;
  }

  override setSize(width: number, height: number): void {
    // The composer passes width × pixel ratio unrounded; WebGL truncates it (363.8 → 363).
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    for (const t of this.history) t.setSize(this.width, this.height);
    this.fresh = true;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const cam = this.camera;
    // PostStack has removed the jitter by now: these are the plain camera matrices.
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    cam.getWorldDirection(this.forward);
    const snapshot: CameraSnapshot = {
      position: [
        cam.matrixWorld.elements[12]!,
        cam.matrixWorld.elements[13]!,
        cam.matrixWorld.elements[14]!,
      ],
      forward: [this.forward.x, this.forward.y, this.forward.z],
      fov: cam.fov,
    };
    const depth = readBuffer.depthTexture;
    if (!depth || (this.prevSnapshot && isCameraCut(this.prevSnapshot, snapshot))) {
      this.fresh = true;
    }

    const u = this.resolve.uniforms;
    u.tCurrent!.value = readBuffer.texture;
    u.tHistory!.value = this.history[this.latest].texture;
    u.tDepth!.value = depth;
    (u.uInvViewProj!.value as THREE.Matrix4).copy(this.viewProj).invert();
    (u.uPrevViewProj!.value as THREE.Matrix4).copy(this.fresh ? this.viewProj : this.prevViewProj);
    (u.uCamPos!.value as THREE.Vector3).setFromMatrixPosition(cam.matrixWorld);
    const [du, dv] = unjitterUv(this.jitter, this.width, this.height);
    (u.uJitterUv!.value as THREE.Vector2).set(du, dv);
    (u.uTexel!.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    u.uReversed!.value = renderer.state.buffers.depth.getReversed() ? 1 : 0;
    u.uFresh!.value = this.fresh ? 1 : 0;

    const next: 0 | 1 = this.latest === 0 ? 1 : 0;
    this.quad.material = this.resolve;
    renderer.setRenderTarget(this.history[next]);
    this.quad.render(renderer);

    this.copy.uniforms.tDiffuse!.value = this.history[next].texture;
    this.quad.material = this.copy;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);

    this.latest = next;
    this.prevViewProj.copy(this.viewProj);
    this.prevSnapshot = snapshot;
    this.fresh = false;
  }

  override dispose(): void {
    for (const t of this.history) t.dispose();
    this.resolve.dispose();
    this.copy.dispose();
    this.quad.dispose();
  }
}
