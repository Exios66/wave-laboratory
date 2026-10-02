/** Scattered paradise islands across the endless sea. */
import * as THREE from 'three';
import type { SceneryFrame, SceneryLayer } from './types';

export class IslandLayer implements SceneryLayer {
  readonly object = new THREE.Group();

  constructor() {
    this.object.name = 'islands';
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
  }

  update(_frame: SceneryFrame): void {}

  dispose(): void {}
}
