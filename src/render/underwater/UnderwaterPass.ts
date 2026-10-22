/**
 * Absorption fog for the whole scene while the camera is under the sea. It reads the HDR target
 * and its depth texture, rebuilds the distance each pixel's ray travelled through the water and
 * applies c · T + inscatter · (1 − T) with T = exp(−K_d · d) per channel (red goes first in
 * clear water, blue in turbid coastal water). Pixels that never hit anything (the sky dome,
 * which writes no depth) sit at the far plane and fade fully to the in-scatter colour.
 *
 * It also grades the colour with depth (saturation falls, the tint follows the water's own K_d) and,
 * on the full tier, marches the view ray through the water to add volumetric god rays: shafts of
 * sunlight refracted into the sea and focused by the wave facets above (`uRays` > 0).
 *
 * The depth-to-distance maths mirrors `linearizeReversedDepth` / `linearizeDepth`.
 */
import * as THREE from 'three';
import type { WebGLRenderer } from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { depthGrade } from './seafloor';

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
    uTime: { value: 0 },
    uShafts: { value: 0.25 },
    uSat: { value: 1 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uRays: { value: 0 },
    uSunTravel: { value: new THREE.Vector3(0, -1, 0) },
    uCamPos: { value: new THREE.Vector3() },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
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
    uniform float uTime;
    uniform float uShafts;
    uniform float uSat;
    uniform vec3 uTint;
    uniform float uRays;
    uniform vec3 uSunTravel;
    uniform vec3 uCamPos;
    uniform vec3 uCamRight;
    uniform vec3 uCamUp;
    uniform vec3 uCamFwd;
    varying vec2 vUv;
    // Light focused by the wave facets at a point on the surface (0 dark, 1 bright).
    float surfaceLight(vec2 q, float t) {
      float a = sin(q.x * 0.9 + t * 0.8 + sin(q.y * 0.6 - t * 0.5) * 1.4);
      float b = sin(q.y * 1.1 - t * 0.7 + sin(q.x * 0.5 + t * 0.4) * 1.2);
      float c = sin((q.x + q.y) * 0.55 + t * 0.6);
      return smoothstep(0.5, 0.95, (a * b + c * 0.5) * 0.5 + 0.5);
    }
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
      // Screen-space god-ray shafts radiating down from Snell's window overhead.
      float ray1 = 0.5 + 0.5 * sin(ndc.x * 11.0 + ndc.y * 4.0 + uTime * 0.7);
      float ray2 = 0.5 + 0.5 * sin(ndc.x * 19.0 - ndc.y * 5.0 - uTime * 1.1);
      float shaft = pow(ray1 * ray2, 2.5) * smoothstep(-0.3, 0.9, vUv.y) * uShafts * (1.0 - step(0.001, uRays));
      vec3 veil = uInscatter * (1.0 + shaft * 0.85);
      vec3 rays = vec3(0.0);
      if (uRays > 0.001) {
        // Volumetric shafts: march the view ray, lighting each sample by the surface patch the sun
        // reaches it through (refracted travel direction), fading with depth.
        vec3 rd = normalize(uCamFwd + ndc.x * uTanHalf.x * uCamRight + ndc.y * uTanHalf.y * uCamUp);
        float dmax = min(d, 45.0);
        float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        float acc = 0.0;
        for (int i = 0; i < 12; i++) {
          float t = (float(i) + jitter) / 12.0 * dmax;
          vec3 p = uCamPos + rd * t;
          if (p.y < -0.2) {
            vec3 q = p - uSunTravel * (p.y / uSunTravel.y);
            acc += surfaceLight(q.xz, uTime) * exp(-uKd.g * 1.3 * -p.y);
          }
        }
        acc *= dmax / 12.0;
        float towardSun = max(dot(rd, -uSunTravel), 0.0);
        float phase = 0.35 + 0.65 * towardSun * towardSun;
        rays = uInscatter * acc * phase * uRays * 0.25;
      }
      vec3 outc = c.rgb * T + veil * (1.0 - T) + rays;
      float lum = dot(outc, vec3(0.2126, 0.7152, 0.0722));
      outc = mix(vec3(lum), outc, uSat) * uTint;
      gl_FragColor = vec4(outc, c.a);
    }
  `,
};

export interface UnderwaterParams {
  /** Diffuse attenuation K_d [1/m], red, green, blue. */
  kd: readonly [number, number, number];
  /** Linear RGB the rays fade to. */
  inscatter: readonly [number, number, number];
  /** Eye depth below the surface [m]; drives the colour grade. Omitted: no grade. */
  depth?: number;
  /** Volumetric god rays (full tier): refracted sun travel direction (y-up) and strength 0–1. */
  rays?: { dir: readonly [number, number, number]; strength: number } | null;
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
    const grade = depthGrade(params.kd, params.depth ?? 0);
    this.uniforms.uSat!.value = grade.saturation;
    (this.uniforms.uTint!.value as THREE.Vector3).fromArray(grade.tint);
    this.uniforms.uRays!.value = params.rays?.strength ?? 0;
    if (params.rays) (this.uniforms.uSunTravel!.value as THREE.Vector3).fromArray(params.rays.dir);
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
    u.uTime!.value = performance.now() / 1000;
    cam.matrixWorld.extractBasis(
      u.uCamRight!.value as THREE.Vector3,
      u.uCamUp!.value as THREE.Vector3,
      u.uCamFwd!.value as THREE.Vector3,
    );
    (u.uCamFwd!.value as THREE.Vector3).negate();
    (u.uCamPos!.value as THREE.Vector3).setFromMatrixPosition(cam.matrixWorld);
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}
