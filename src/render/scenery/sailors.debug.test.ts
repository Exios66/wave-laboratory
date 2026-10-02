import { describe, it, expect } from 'vitest';
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
    for (const s of sailors) {
      expect(s.position.y).toBeGreaterThanOrEqual(deckTop);
      // Side catwalk: |three.z| ≈ body y lane
      expect(Math.abs(s.position.z)).toBeGreaterThan(def.beam * 0.3);
    }
    console.log('cargo sailors', sailors.length, {
      deckTop,
      sample: sailors.slice(0, 2).map((s) => ({
        x: +s.position.x.toFixed(2),
        y: +s.position.y.toFixed(2),
        z: +s.position.z.toFixed(2),
        scale: +s.scale.x.toFixed(2),
      })),
      bow: def.points.bow,
      beam: def.beam,
      length: def.length,
    });
    layer.dispose();
  });
});
