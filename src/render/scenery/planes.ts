/** Lost planes: rare old aircraft crossing the sky, as if from another time. */
import * as THREE from 'three';
import type { SceneryFrame, SceneryLayer } from './types';

export class PlaneLayer implements SceneryLayer {
  readonly object = new THREE.Group();

  constructor() {
    this.object.name = 'planes';
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
  }

  update(_frame: SceneryFrame): void {}

  dispose(): void {}
}
