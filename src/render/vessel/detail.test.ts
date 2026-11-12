import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { VesselTypeSchema } from '../../schema/experiment';
import { createVesselDefinition } from '../../vessel/definition';
import {
  bridgeHouse,
  containerColor,
  CONTAINER_COLORS,
  deckRing,
  detailKit,
  glowData,
  plateNormalData,
  railGeometry,
  railHeight,
  setVesselNight,
  VesselDetail,
  windowLight,
  windowTextureData,
  worldUvs,
} from './detail';

const TYPES = VesselTypeSchema.options;

describe('vessel detail', () => {
  it('the deck ring follows the deck edge inside the beam', () => {
    const def = createVesselDefinition('cargo-ship');
    const ring = deckRing(def, 0.3);
    expect(ring.length).toBeGreaterThan(10);
    const xs = ring.map((q) => q[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(def.length * 0.8);
    for (const q of ring) expect(Math.abs(q[1])).toBeLessThanOrEqual(def.beam / 2 - 0.3 + 1e-6);
    // Starboard first (y ≤ 0), then port (y ≥ 0): one crossing at the bow, one at the stern.
    let crossings = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]![1];
      const b = ring[(i + 1) % ring.length]![1];
      if (Math.sign(a) !== Math.sign(b) && a !== 0 && b !== 0) crossings++;
    }
    expect(crossings).toBeLessThanOrEqual(2);
  });

  it('builds railings of sensible height', () => {
    const def = createVesselDefinition('trawler');
    const geo = railGeometry(deckRing(def, 0.3), railHeight(def.length), 1.6)!;
    expect(geo).not.toBeNull();
    geo.computeBoundingBox();
    const top = Math.max(...deckRing(def, 0.3).map((q) => q[2]));
    expect(geo.boundingBox!.max.y).toBeGreaterThan(top + 0.5);
    expect(geo.boundingBox!.max.y).toBeLessThan(top + 1.3);
    expect(railHeight(8)).toBeGreaterThanOrEqual(0.6);
    expect(railHeight(300)).toBeLessThanOrEqual(1.1);
  });

  it('colours containers deterministically and with variety', () => {
    const c = { x: 10, y: 2.9, z: 12 };
    expect(containerColor('a', c)).toBe(containerColor('a', c));
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) seen.add(containerColor('ship', { x: i * 6.1, y: 0, z: 10 }));
    expect(seen.size).toBeGreaterThan(4);
    for (const s of seen) expect(CONTAINER_COLORS).toContain(s);
  });

  it('maps box UVs in metres and puts roofs on plain wall', () => {
    const geo = new THREE.BoxGeometry(11.2, 5.6, 4);
    worldUvs(geo, 2.8, 2.8, [0.1, 0.2]);
    const uv = geo.getAttribute('uv');
    const nor = geo.getAttribute('normal');
    let maxV = 0;
    for (let i = 0; i < uv.count; i++) {
      if (Math.abs(nor.getY(i)) > 0.9) {
        expect(uv.getX(i)).toBeCloseTo(0.1);
        expect(uv.getY(i)).toBeCloseTo(0.2);
      } else {
        maxV = Math.max(maxV, uv.getY(i));
      }
    }
    expect(maxV).toBeCloseTo(2);
  });

  it('gives each type the kit that suits it, within a few draw calls', () => {
    for (const type of TYPES) {
      const def = createVesselDefinition(type);
      const detail = new VesselDetail(def, `v-${type}`, { rail: 0xffffff });
      let draws = 0;
      detail.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh || (o as THREE.Sprite).isSprite) draws++;
      });
      expect(draws, type).toBeLessThanOrEqual(11);
      const kit = detailKit(type);
      if (!kit.rails && !kit.radar) expect(detail.materials, type).toHaveLength(0);
      detail.update(1);
    }
    expect(detailKit('submarine').rails).toBeNull();
    expect(detailKit('sloop-yacht').rails).toBeNull();
    expect(detailKit('pirate-ship').rails).toBe('wood');
    expect(bridgeHouse(createVesselDefinition('cargo-ship'))).not.toBeNull();
  });

  it('builds tiling textures of the right size, with lit windows only at night', () => {
    const win = windowTextureData(64);
    expect(win.color.length).toBe(64 * 64 * 4);
    let lit = 0;
    for (let i = 0; i < win.glow.length; i += 4) if (win.glow[i]! > 0) lit++;
    expect(lit).toBeGreaterThan(0);
    expect(plateNormalData(32).length).toBe(32 * 32 * 4);
    expect(glowData(16)[(8 * 16 + 8) * 4 + 3]).toBeGreaterThan(200);
    setVesselNight(0, 0);
    expect(windowLight.value).toBe(0);
    setVesselNight(1, 0);
    expect(windowLight.value).toBeGreaterThan(1);
  });
});
