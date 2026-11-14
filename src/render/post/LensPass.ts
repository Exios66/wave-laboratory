/**
 * Rain and spray drops on the camera lens: each drop refracts the picture behind it, outward
 * toward its rim like a small bulging lens, and fades out over its life. The drop's look is
 * painted once on the CPU (`paintDroplet`); positions and ages come from `stepDroplets`.
 */
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { DROPLET_CAP, paintDroplet, type Droplet } from '../sky/rainCurtains';

const DROP_TEXTURE_SIZE = 64;

const LensShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDrop: { value: null as THREE.Texture | null },
    uDrops: { value: Array.from({ length: DROPLET_CAP }, () => new THREE.Vector4()) },
    uCount: { value: 0 },
    uAspect: { value: 1 },
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
    uniform sampler2D tDrop;
    uniform vec4 uDrops[${DROPLET_CAP}];
    uniform int uCount;
    uniform float uAspect;
    varying vec2 vUv;
    void main() {
      vec2 offset = vec2(0.0);
      float cover = 0.0;
      float glint = 0.0;
      for (int i = 0; i < ${DROPLET_CAP}; i++) {
        if (i >= uCount) break;
        vec4 d = uDrops[i];
        // Drop space: the drop is round on screen whatever the aspect ratio.
        vec2 q = (vUv - d.xy) * vec2(uAspect, 1.0) / d.z;
        if (dot(q, q) >= 1.0) continue;
        vec4 t = texture2D(tDrop, q * 0.5 + 0.5);
        float a = t.a * d.w;
        offset += (t.rg * 2.0 - 1.0) * d.z * 0.9 * a;
        cover = max(cover, a);
        glint = max(glint, t.b * d.w);
      }
      vec4 base = texture2D(tDiffuse, vUv);
      if (cover <= 0.0) { gl_FragColor = base; return; }
      vec4 bent = texture2D(tDiffuse, clamp(vUv - offset, 0.0, 1.0));
      vec3 col = mix(base.rgb, bent.rgb * 0.92 + 0.04, cover) + glint * 0.6;
      gl_FragColor = vec4(col, base.a);
    }
  `,
};

export class LensPass extends Pass {
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly dropTexture: THREE.DataTexture;

  constructor() {
    super();
    this.needsSwap = true;
    this.dropTexture = new THREE.DataTexture(
      paintDroplet(DROP_TEXTURE_SIZE),
      DROP_TEXTURE_SIZE,
      DROP_TEXTURE_SIZE,
      THREE.RGBAFormat,
    );
    this.dropTexture.magFilter = THREE.LinearFilter;
    this.dropTexture.minFilter = THREE.LinearFilter;
    this.dropTexture.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(LensShader.uniforms),
      vertexShader: LensShader.vertexShader,
      fragmentShader: LensShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.material.uniforms.tDrop!.value = this.dropTexture;
    this.quad = new FullScreenQuad(this.material);
  }

  /** The drops to draw this frame (fading out over the last third of their life). */
  setDrops(drops: readonly Droplet[]): void {
    const u = this.material.uniforms;
    const slots = u.uDrops!.value as THREE.Vector4[];
    const n = Math.min(DROPLET_CAP, drops.length);
    for (let i = 0; i < n; i++) {
      const d = drops[i]!;
      const fade = Math.min(1, Math.max(0, (d.life - d.age) / (d.life / 3)));
      slots[i]!.set(d.x, d.y, d.r, fade);
    }
    u.uCount!.value = n;
  }

  override setSize(width: number, height: number): void {
    this.material.uniforms.uAspect!.value = width / Math.max(1, height);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.material.uniforms.tDiffuse!.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.dropTexture.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
