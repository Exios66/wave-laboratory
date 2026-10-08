/**
 * Absorption fog for the whole scene while the camera is under the sea. It reads the HDR target
 * and its depth texture, rebuilds the distance each pixel's ray travelled through the water and
 * applies c · T + inscatter · (1 − T) with T = exp(−K_d · d) per channel (red goes first in
 * clear water, blue in turbid coastal water). Pixels that never hit anything (the sky dome,
 * which writes no depth) sit at the far plane and fade fully to the in-scatter colour.
 *
 * The depth-to-distance maths mirrors `linearizeReversedDepth` / `linearizeDepth`.
 */
import * as THREE from 'three';
import type { WebGLRenderer } from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

const UnderwaterShader = {
  name: 'UnderwaterShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uNear: { value: 0.2 },
    uFar: { value: 40000 },
    uReversed: { value: 1 },
    uTanHalf: { value: new THREE.Vector2(1, 1) },
    uKd: { value: new THREE.Vector3(0.245, 0.052, 0.02) },
    uInscatter: { value: new THREE.Vector3(0.01, 0.05, 0.1) },
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
    uniform sampler2D tDepth;
    uniform float uNear;
    uniform float uFar;
    uniform float uReversed;
    uniform vec2 uTanHalf;
    uniform vec3 uKd;
    uniform vec3 uInscatter;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float z = texture2D(tDepth, vUv).x;
      float viewZ = uReversed > 0.5
        ? (uNear * uFar) / (uNear + z * (uFar - uNear))
        : (2.0 * uNear * uFar) / (uFar + uNear - (2.0 * z - 1.0) * (uFar - uNear));
      // Distance along the ray, not along the view axis.
      vec2 ndc = vUv * 2.0 - 1.0;
      float d = viewZ * length(vec3(ndc * uTanHalf, 1.0));
      vec3 T = exp(-uKd * d);
      gl_FragColor = vec4(c.rgb * T + uInscatter * (1.0 - T), c.a);
    }
  `,
};

export interface UnderwaterParams {
  /** Diffuse attenuation K_d [1/m], red, green, blue. */
  kd: readonly [number, number, number];
  /** Linear RGB the rays fade to. */
  inscatter: readonly [number, number, number];
}

export class UnderwaterPass extends ShaderPass {
  constructor(private readonly camera: THREE.PerspectiveCamera) {
    super(UnderwaterShader);
    this.enabled = false;
  }

  set(params: UnderwaterParams | null): void {
    this.enabled = params !== null;
    if (!params) return;
    (this.uniforms.uKd!.value as THREE.Vector3).fromArray(params.kd);
    (this.uniforms.uInscatter!.value as THREE.Vector3).fromArray(params.inscatter);
  }

  override render(
    renderer: WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    const u = this.uniforms;
    const cam = this.camera;
    u.tDepth!.value = readBuffer.depthTexture;
    u.uNear!.value = cam.near;
    u.uFar!.value = cam.far;
    u.uReversed!.value = renderer.state.buffers.depth.getReversed() ? 1 : 0;
    const tan = Math.tan((cam.fov * Math.PI) / 360);
    (u.uTanHalf!.value as THREE.Vector2).set(tan * cam.aspect, tan);
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}
