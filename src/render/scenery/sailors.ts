/** Little sailors walking the decks. */
import * as THREE from 'three';
import type { SceneryFrame, SceneryLayer } from './types';

export class SailorLayer implements SceneryLayer {
  readonly object = new THREE.Group();

  constructor() {
    this.object.name = 'sailors';
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
  }

  update(_frame: SceneryFrame): void {}

  dispose(): void {}
}
