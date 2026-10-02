/** Gulls, terns and albatrosses, seen in fair weather. */
import * as THREE from 'three';
import type { SceneryFrame, SceneryLayer } from './types';

export class SeabirdLayer implements SceneryLayer {
  readonly object = new THREE.Group();

  constructor() {
    this.object.name = 'birds';
  }

  setEnabled(enabled: boolean): void {
    this.object.visible = enabled;
  }

  update(_frame: SceneryFrame): void {}

  dispose(): void {}
}
