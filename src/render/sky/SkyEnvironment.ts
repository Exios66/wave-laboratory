/**
 * Image-based lighting from the live sky. The sky dome alone is drawn into a small cube map and
 * prefiltered (PMREM) into `scene.environment`, so every standard material (hulls, superstructures,
 * islands, traffic, rigs) picks up the sky's colour in its ambient light and reflections: blue from
 * above at noon, warm from the sun's side at dusk, grey under overcast.
 *
 * The cube is redrawn only when the sky has visibly changed (the sun moved, cloud, night or the
 * light level shifted), and at most twice a second, so it costs nothing on most frames.
 */
import * as THREE from 'three';

/** Cube face size [px]: the sky is smooth, and PMREM blurs it further. */
const FACE = 64;
/** Shortest time between regenerations [s]. */
const MIN_INTERVAL = 0.5;

export interface SkyEnvironmentKey {
  sunDir: THREE.Vector3;
  cloud: number;
  night: number;
  dusk: number;
  level: number;
}

export class SkyEnvironment {
  private readonly scene = new THREE.Scene();
  private readonly cubeTarget: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private readonly dome: THREE.Mesh;
  private readonly last = {
    sun: new THREE.Vector3(0, -2, 0),
    cloud: -1,
    night: -1,
    dusk: -1,
    level: -1,
  };
  private sinceLast = Infinity;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    skyGeometry: THREE.BufferGeometry,
    private readonly skyMaterial: THREE.ShaderMaterial,
  ) {
    this.cubeTarget = new THREE.WebGLCubeRenderTarget(FACE, { type: THREE.HalfFloatType });
    this.cubeCamera = new THREE.CubeCamera(1, 20000, this.cubeTarget);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.dome = new THREE.Mesh(skyGeometry, skyMaterial);
    this.dome.frustumCulled = false;
    this.scene.add(this.dome);
  }

  /** The prefiltered environment, or null before the first update. */
  get texture(): THREE.Texture | null {
    return this.envTarget?.texture ?? null;
  }

  /**
   * Regenerate the environment if the sky has changed enough since the last time.
   * Returns true when it was redrawn.
   */
  update(dt: number, key: SkyEnvironmentKey): boolean {
    this.sinceLast += dt;
    const l = this.last;
    const changed =
      l.sun.dot(key.sunDir) < Math.cos(0.5 * (Math.PI / 180)) ||
      Math.abs(key.cloud - l.cloud) > 0.03 ||
      Math.abs(key.night - l.night) > 0.02 ||
      Math.abs(key.dusk - l.dusk) > 0.02 ||
      Math.abs(key.level - l.level) > 0.02;
    if (!changed || (this.sinceLast < MIN_INTERVAL && this.envTarget)) return false;
    l.sun.copy(key.sunDir);
    l.cloud = key.cloud;
    l.night = key.night;
    l.dusk = key.dusk;
    l.level = key.level;
    this.sinceLast = 0;
    this.draw();
    return true;
  }

  /** Force a redraw on the next update (after a context restore). */
  invalidate(): void {
    this.last.cloud = -1;
    this.sinceLast = Infinity;
  }

  private draw(): void {
    const r = this.renderer;
    const u = this.skyMaterial.uniforms;
    // Leave the sun disc out: the directional light already gives the sun's highlight, and an
    // HDR disc would be blurred into a hot patch on every reflective surface.
    const hdr = u.uSunHdr!.value as number;
    u.uSunHdr!.value = 0;
    // Lightning is not part of the cached sky: a flash during the capture would stay in it.
    const flash = u.uFlash?.value as number | undefined;
    if (u.uFlash) u.uFlash.value = 0;
    const prevTarget = r.getRenderTarget();
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    this.cubeCamera.update(r, this.scene);
    this.envTarget = this.pmrem.fromCubemap(this.cubeTarget.texture, this.envTarget);
    r.xr.enabled = prevXr;
    r.setRenderTarget(prevTarget);
    u.uSunHdr!.value = hdr;
    if (u.uFlash) u.uFlash.value = flash;
  }

  dispose(): void {
    this.cubeTarget.dispose();
    this.envTarget?.dispose();
    this.envTarget = null;
    this.pmrem.dispose();
  }
}
