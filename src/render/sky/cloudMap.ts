/**
 * The cloud deck's coverage noise baked into a world-anchored texture (a "weather map"), so the
 * volumetric march reads one texel per sample instead of evaluating six noise octaves.
 *
 * The map holds the raw fractal noise f (before the cover threshold), over a square
 * `CLOUD_MAP_EXTENT_KM` wide in the deck's drifting frame (world position + drift, km). The cover
 * threshold is applied when sampling, so a change of cloud cover needs no redraw. The map is
 * redrawn only when the eye (in that frame) has moved more than an eighth of the extent from the
 * centre. The new centre snaps to the texel lattice, so the texels land on the same world points
 * and the redraw does not shimmer.
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CLOUD_MAP_FRAG } from '../ocean/shaders';

/** Side of the map [km]: the kept map always reaches past the march's 25 km far fade. */
export const CLOUD_MAP_EXTENT_KM = 72;
/** Texels per side (about 70 m each). */
export const CLOUD_MAP_SIZE = 1024;

/**
 * The map's new centre [km, drifting frame] for an eye at (x, y), or null to keep the current
 * one. `origin` null means there is no map yet.
 */
export function cloudMapOrigin(
  origin: readonly [number, number] | null,
  x: number,
  y: number,
): [number, number] | null {
  const keep = CLOUD_MAP_EXTENT_KM / 8;
  if (origin && Math.abs(x - origin[0]) < keep && Math.abs(y - origin[1]) < keep) return null;
  const texel = CLOUD_MAP_EXTENT_KM / CLOUD_MAP_SIZE;
  return [Math.round(x / texel) * texel, Math.round(y / texel) * texel];
}

export class CloudMap {
  readonly target: THREE.WebGLRenderTarget;
  /** Centre of the map [km, drifting frame] and its width [km], for the shaders. */
  readonly origin = new THREE.Vector3(0, 0, CLOUD_MAP_EXTENT_KM);
  private current: [number, number] | null = null;
  private readonly quad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(CLOUD_MAP_SIZE, CLOUD_MAP_SIZE, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: { uOrigin: { value: this.origin } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: CLOUD_MAP_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /**
   * Keep the map centred near the eye. `eyeKm` is the eye's world (x, z) in km and `drift` the
   * deck's drift [km], as the shaders add it. Returns true when the map was redrawn.
   */
  update(renderer: THREE.WebGLRenderer, eyeX: number, eyeZ: number, drift: THREE.Vector2): boolean {
    const next = cloudMapOrigin(this.current, eyeX + drift.x, eyeZ + drift.y);
    if (!next) return false;
    this.current = next;
    this.origin.set(next[0], next[1], CLOUD_MAP_EXTENT_KM);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
    return true;
  }

  /** Redraw on the next update (context restore). */
  invalidate(): void {
    this.current = null;
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
