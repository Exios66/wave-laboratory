import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createVesselDefinition } from '../../vessel/definition';
import { SailorLayer } from './sailors';

describe('SailorLayer spawn', () => {
  it('attaches sailors above the deck plate on a cargo ship', () => {
    const def = createVesselDefinition('cargo-ship');
    const group = new THREE.Group();
    const layer = new SailorLayer();
    layer.setEnabled(true);
    layer.setVessels([{ id: 'v1', definition: def, group }]);
    const sailors = group.children.filter((c) => c.name === 'sailor');
    expect(sailors.length).toBeGreaterThan(0);
    let deckTop = def.points.bow.z;
    for (const b of def.superstructure) {
      if (b.material === 'deck') deckTop = Math.max(deckTop, b.center.z + b.size.z * 0.5);
    }
    const cargoHalf = Math.max(
      0,
      ...def.superstructure.filter((b) => b.material === 'cargo').map((b) => b.size.y * 0.5),
    );
    for (const s of sailors) {
      expect(s.position.y).toBeGreaterThanOrEqual(deckTop);
      expect(Math.abs(s.position.z)).toBeGreaterThan(cargoHalf);
    }
    layer.dispose();
  });
});
