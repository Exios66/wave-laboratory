/** Minimal full-screen pass runner used by the GPU compute passes. */
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  OrthographicCamera,
  Scene,
  type Material,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';

export class FullscreenPass {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new BufferGeometry();
  private readonly mesh: Mesh;

  constructor() {
    // One oversized triangle covers the viewport without a diagonal seam.
    this.geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.mesh = new Mesh(this.geometry);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.scene.matrixWorldAutoUpdate = false;
  }

  render(renderer: WebGLRenderer, material: Material, target: WebGLRenderTarget | null): void {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
