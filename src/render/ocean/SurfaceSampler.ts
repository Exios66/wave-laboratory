/**
 * Evaluates the water vertex shader's displacement function (`oceanDisplacement`, all cascades +
 * regular waves) at arbitrary labels on the GPU and reads the result back. Used by the
 * consistency harness so the test checks the exact GLSL that displaces the rendered sea.
 */
import {
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { oceanVertexChunk } from '../materials/oceanChunks';
import { FullscreenPass } from './FullscreenPass';
import type { OceanUniforms } from './oceanUniforms';

export class SurfaceSampler {
  private readonly pass = new FullscreenPass();
  private readonly material: ShaderMaterial;
  private readonly renderer: WebGLRenderer;

  constructor(renderer: WebGLRenderer, cascadeCount: number, uniforms: OceanUniforms) {
    this.renderer = renderer;
    this.material = new ShaderMaterial({
      vertexShader: /* glsl */ `
        void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        ${oceanVertexChunk(cascadeCount)}
        uniform sampler2D uPoints;
        void main() {
          vec2 x0 = texelFetch(uPoints, ivec2(gl_FragCoord.xy), 0).xy;
          // sEff = 0: full resolution, no distance fade.
          gl_FragColor = vec4(oceanDisplacement(x0, 0.0), 1.0);
        }
      `,
      uniforms: { ...uniforms, uPoints: { value: null } },
      depthTest: false,
      depthWrite: false,
    });
  }

  /** Returns (Dₓ, D_y, η) per label, world z-up, as [x0, y0, x1, y1, …] → [dx, dy, eta, …]. */
  sample(labels: readonly number[]): Float32Array {
    const count = labels.length / 2;
    const pts = new Float32Array(4 * count);
    for (let i = 0; i < count; i++) {
      pts[4 * i] = labels[2 * i]!;
      pts[4 * i + 1] = labels[2 * i + 1]!;
    }
    const tex = new DataTexture(pts, count, 1, RGBAFormat, FloatType);
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.needsUpdate = true;
    const target = new WebGLRenderTarget(count, 1, {
      type: FloatType,
      depthBuffer: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
    this.material.uniforms.uPoints!.value = tex;
    const prev = this.renderer.getRenderTarget();
    this.pass.render(this.renderer, this.material, target);
    const out = new Float32Array(4 * count);
    this.renderer.readRenderTargetPixels(target, 0, 0, count, 1, out);
    this.renderer.setRenderTarget(prev);
    tex.dispose();
    target.dispose();
    const res = new Float32Array(3 * count);
    for (let i = 0; i < count; i++) {
      res[3 * i] = out[4 * i]!;
      res[3 * i + 1] = out[4 * i + 1]!;
      res[3 * i + 2] = out[4 * i + 2]!;
    }
    return res;
  }

  dispose(): void {
    this.material.dispose();
    this.pass.dispose();
  }
}
