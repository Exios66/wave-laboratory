/**
 * What the water needs to know about the rest of the scene, drawn before the main pass at half
 * resolution with the sea itself hidden:
 *
 *  - refraction: colour and depth of everything as the camera sees it, so the water shader can
 *    show hulls, shores and the seabed through the surface, absorb along the real path through
 *    the water and put foam where the sea meets something;
 *  - reflection: the scene above the mean sea level from the camera mirrored in that plane
 *    (alpha 0 where nothing was drawn), so ships and islands appear in the water over the sky.
 *
 * Both are linear HDR, like the main target.
 */
import * as THREE from 'three';

export interface PrepassOptions {
  /** Objects hidden in both passes: the sea, the sky dome, rain and spray. */
  hide: readonly THREE.Object3D[];
  /** Also draw the mirrored view. */
  reflection: boolean;
}

/** Water surface points up to this far below the mean sea level still reflect what is above. */
const CLIP_BELOW = 0.4;

export class ScenePrepass {
  readonly refraction: THREE.WebGLRenderTarget;
  readonly reflection: THREE.WebGLRenderTarget;
  /** World position → reflection texture coordinates (divide xy by w). */
  readonly reflectionMatrix = new THREE.Matrix4();
  private readonly mirror = new THREE.PerspectiveCamera();
  private readonly clip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), CLIP_BELOW)];
  private readonly clear = new THREE.Color();
  private readonly target = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly visible: boolean[] = [];

  constructor() {
    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    } as const;
    this.refraction = new THREE.WebGLRenderTarget(2, 2, {
      ...opts,
      depthTexture: new THREE.DepthTexture(2, 2, THREE.FloatType),
    });
    this.reflection = new THREE.WebGLRenderTarget(2, 2, opts);
  }

  /** Size of the main target in device pixels; the prepass targets are half of it. */
  setSize(width: number, height: number): void {
    const w = Math.max(2, Math.round(width / 2));
    const h = Math.max(2, Math.round(height / 2));
    this.refraction.setSize(w, h);
    this.reflection.setSize(w, h);
  }

  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    options: PrepassOptions,
  ): void {
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    this.visible.length = 0;
    for (const o of options.hide) {
      this.visible.push(o.visible);
      o.visible = false;
    }
    renderer.autoClear = true;

    renderer.setRenderTarget(this.refraction);
    renderer.render(scene, camera);

    if (options.reflection) {
      this.placeMirror(camera);
      renderer.setClearColor(0x000000, 0);
      renderer.clippingPlanes = this.clip;
      renderer.setRenderTarget(this.reflection);
      renderer.render(scene, this.mirror);
      renderer.clippingPlanes = [];
      renderer.setClearColor(this.clear, prevAlpha);
    }

    options.hide.forEach((o, i) => (o.visible = this.visible[i] ?? true));
    renderer.autoClear = prevAuto;
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.refraction.depthTexture?.dispose();
    this.refraction.dispose();
    this.reflection.dispose();
  }

  /** Put the mirror camera where the main camera's image in the plane y = 0 is. */
  private placeMirror(camera: THREE.PerspectiveCamera): void {
    const m = this.mirror;
    m.fov = camera.fov;
    m.aspect = camera.aspect;
    m.near = camera.near;
    m.far = camera.far;
    m.updateProjectionMatrix();
    camera.getWorldDirection(this.forward);
    m.position.set(camera.position.x, -camera.position.y, camera.position.z);
    this.target.set(
      m.position.x + this.forward.x,
      m.position.y - this.forward.y,
      m.position.z + this.forward.z,
    );
    // The mirror image of the camera's up vector, so the reflected picture is not rolled.
    m.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    m.up.y = -m.up.y;
    m.lookAt(this.target);
    m.updateMatrixWorld();
    this.reflectionMatrix
      .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(m.projectionMatrix)
      .multiply(m.matrixWorldInverse);
  }
}
