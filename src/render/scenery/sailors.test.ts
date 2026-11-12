import { describe, expect, it } from 'vitest';
import type { VesselType } from '../../schema/experiment';
import type { VesselDefinition, VisualBox } from '../../vessel/api';
import { createVesselDefinition } from '../../vessel/definition';
import {
  CAPTAIN_VARIANTS,
  OUTFITS,
  PEOPLE,
  SAILOR_MARGIN,
  SAILOR_VARIANTS,
  SHEET_SIZE,
  SKIN_TONES,
  outfitFor,
  personFor,
  sheetCell,
  SailorLayer,
  crewCount,
  deckHeightAt,
  deckSpots,
  deckSurface,
  planCrew,
  standHeightAt,
  walkable,
  type DeckSpot,
} from './sailors';

const TYPES: VesselType[] = [
  'box-barge',
  'wigley',
  'cargo-ship',
  'trawler',
  'patrol-boat',
  'lifeboat',
  'catamaran',
];
const defs = new Map<VesselType, VesselDefinition>(
  TYPES.map((t) => [t, createVesselDefinition(t)]),
);
const def = (t: VesselType): VesselDefinition => defs.get(t)!;

/** The spot lies inside (or under the low overhang of) a box that is not walkable. */
function insideObstacle(spot: DeckSpot, boxes: readonly VisualBox[]): boolean {
  return boxes.some((b) => {
    const inside =
      Math.abs(spot.x - b.center.x) < b.size.x / 2 && Math.abs(spot.y - b.center.y) < b.size.y / 2;
    const bottom = b.center.z - b.size.z / 2;
    const top = b.center.z + b.size.z / 2;
    return inside && bottom < spot.z + 1.8 && top > spot.z + 0.05;
  });
}

describe('deckSurface', () => {
  it('finds the barge deck flat at D − KG', () => {
    const d = def('box-barge');
    const deck = deckSurface(d);
    expect(deck.tris.length).toBeGreaterThan(0);
    expect(deckHeightAt(deck, 0, 0)).toBeCloseTo(d.depth - d.kg, 3);
    expect(deckHeightAt(deck, 10, 4)).toBeCloseTo(d.depth - d.kg, 3);
    // Off the side of the barge.
    expect(deckHeightAt(deck, 0, d.beam / 2 + 0.5)).toBeNaN();
  });

  it('follows the sheer of the cargo ship (deck rises toward the bow)', () => {
    const d = def('cargo-ship');
    const deck = deckSurface(d);
    const mid = deckHeightAt(deck, 0, 0);
    const bow = deckHeightAt(deck, 55, 0);
    expect(mid).toBeCloseTo(d.depth - d.kg, 1);
    expect(bow).toBeGreaterThan(mid + 1);
  });
});

describe('crewCount', () => {
  it('scales with the deck: one or two on a lifeboat, six to eight on a cargo ship', () => {
    expect(crewCount(def('lifeboat'))).toBeGreaterThanOrEqual(1);
    expect(crewCount(def('lifeboat'))).toBeLessThanOrEqual(2);
    expect(crewCount(def('cargo-ship'))).toBeGreaterThanOrEqual(6);
    expect(crewCount(def('cargo-ship'))).toBeLessThanOrEqual(8);
    expect(crewCount(def('trawler'))).toBeGreaterThan(crewCount(def('lifeboat')));
    expect(crewCount(createVesselDefinition('cargo-ship', 0.2))).toBeLessThan(
      crewCount(def('cargo-ship')),
    );
  });
});

describe('deckSpots', () => {
  it.each(TYPES.filter((t) => t !== 'lifeboat'))(
    '%s: spots are on the deck, clear of the superstructure',
    (t) => {
      const d = def(t);
      const deck = deckSurface(d);
      const spots = deckSpots(d, deck);
      expect(spots.length).toBeGreaterThan(crewCount(d));
      for (const s of spots) {
        const floor = deckHeightAt(deck, s.x, s.y);
        expect(floor).not.toBeNaN();
        // On the deck itself, or on a low deck plate.
        expect(s.z).toBeGreaterThanOrEqual(floor - 1e-6);
        expect(s.z).toBeLessThanOrEqual(floor + 0.6);
        expect(insideObstacle(s, d.superstructure)).toBe(false);
        // Within the hull outline with a margin to the edge.
        expect(Math.abs(s.y)).toBeLessThan(d.beam / 2 - SAILOR_MARGIN + 1e-6);
      }
    },
  );

  it('keeps the cargo ship crew out of the container stacks and the accommodation', () => {
    const d = def('cargo-ship');
    const deck = deckSurface(d);
    const house = d.superstructure.find((b) => b.material === 'superstructure')!;
    expect(standHeightAt(deck, house.center.x, house.center.y)).toBeNaN();
    const bay = d.superstructure.find((b) => b.material === 'cargo')!;
    expect(standHeightAt(deck, bay.center.x, bay.center.y)).toBeNaN();
  });

  it('stands on the cargo ship deck plate, not inside it', () => {
    const d = def('cargo-ship');
    const plate = d.superstructure.find((b) => b.material === 'deck')!;
    const spots = deckSpots(d);
    const onPlate = spots.filter(
      (s) =>
        Math.abs(s.x - plate.center.x) < plate.size.x / 2 &&
        Math.abs(s.y - plate.center.y) < plate.size.y / 2,
    );
    // The plate lies under the container bays now that it no longer reaches into the bow, so
    // any spot over it must be on top of it (or of the deck where the sheer rises above it).
    expect(spots.length).toBeGreaterThan(0);
    const deck = deckSurface(d);
    const plateTop = plate.center.z + plate.size.z / 2;
    for (const s of onPlate) {
      expect(s.z).toBeGreaterThanOrEqual(Math.max(plateTop, deckHeightAt(deck, s.x, s.y)) - 1e-5);
    }
  });

  it('falls back to the canopy roof on the enclosed lifeboat', () => {
    const d = def('lifeboat');
    const roof = deckSpots(d, deckSurface(d), { roof: true });
    expect(roof.length).toBeGreaterThan(4);
    const canopy = d.superstructure.find((b) => b.material === 'accent')!;
    for (const s of roof) {
      expect(s.roof).toBe(true);
      expect(s.z).toBeCloseTo(canopy.center.z + canopy.size.z / 2, 5);
    }
  });
});

describe('planCrew', () => {
  it.each(TYPES)('%s: plans a walkable, well spread crew', (t) => {
    const d = def(t);
    const deck = deckSurface(d);
    const crew = planCrew(d, 42);
    expect(crew.length).toBeGreaterThanOrEqual(1);
    expect(crew.length).toBeLessThanOrEqual(crewCount(d));
    for (const m of crew) {
      if (m.home !== m.patrol) expect(walkable(deck, m.home, m.patrol)).toBe(true);
      expect(insideObstacle(m.home, d.superstructure)).toBe(false);
      expect(insideObstacle(m.patrol, d.superstructure)).toBe(false);
      expect(m.variant).toBeGreaterThanOrEqual(0);
      if (m.role === 'sailor') expect(m.variant).toBeLessThan(SAILOR_VARIANTS);
      else expect(m.variant).toBeGreaterThanOrEqual(SAILOR_VARIANTS);
    }
    for (let i = 0; i < crew.length; i++) {
      for (let j = i + 1; j < crew.length; j++) {
        const a = crew[i]!.home;
        const b = crew[j]!.home;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(1);
      }
    }
  });

  it('gives a cargo ship six to eight hands with one captain near the bridge', () => {
    const d = def('cargo-ship');
    const crew = planCrew(d, 3);
    expect(crew.length).toBeGreaterThanOrEqual(6);
    const captains = crew.filter((m) => m.role === 'captain');
    expect(captains).toHaveLength(1);
    const cap = captains[0]!.home;
    const bridge = d.points.bridge;
    const capD = Math.hypot(cap.x - bridge.x, cap.y - bridge.y);
    for (const m of crew) {
      if (m.role === 'captain') continue;
      expect(Math.hypot(m.home.x - bridge.x, m.home.y - bridge.y)).toBeGreaterThan(capD);
    }
    // Spread from stern to bow, not huddled in one place.
    const xs = crew.map((m) => m.home.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(d.length * 0.5);
    // At least some of them get to walk.
    expect(crew.some((m) => m.home !== m.patrol)).toBe(true);
  });

  it('puts the lifeboat crew on top of the canopy', () => {
    const d = def('lifeboat');
    const crew = planCrew(d, 9);
    expect(crew.length).toBeGreaterThanOrEqual(1);
    expect(crew.length).toBeLessThanOrEqual(2);
    for (const m of crew) expect(m.home.z).toBeGreaterThan(d.depth - d.kg);
  });

  it('is deterministic for a seed', () => {
    expect(planCrew(def('trawler'), 5)).toEqual(planCrew(def('trawler'), 5));
  });
});

describe('crew looks', () => {
  it('dresses each vessel type in its own outfit set', () => {
    const kind = (t: VesselType) => OUTFITS[outfitFor(t)];
    expect(kind('patrol-boat')).toBe('navy');
    expect(kind('aircraft-carrier')).toBe('navy');
    expect(kind('cargo-ship')).toBe('merchant');
    expect(kind('oil-tanker')).toBe('merchant');
    expect(kind('trawler')).toBe('fishing');
    expect(kind('lifeboat')).toBe('rescue');
    expect(kind('sloop-yacht')).toBe('yacht');
    expect(kind('catamaran')).toBe('yacht');
    expect(kind('pirate-ship')).toBe('pirate');
    for (const t of TYPES) {
      for (const m of planCrew(def(t), 7)) expect(m.outfit).toBe(outfitFor(t));
    }
  });

  it('gives every crew all six skin tones and crewmates different faces', () => {
    for (let o = 0; o < OUTFITS.length; o++) {
      const crew = Array.from({ length: SAILOR_VARIANTS }, (_, v) => personFor(o, v));
      expect(new Set(crew.map((p) => p.skin)).size).toBe(SKIN_TONES.length);
      expect(new Set(crew).size).toBe(SAILOR_VARIANTS);
    }
    expect(new Set(PEOPLE.map((p) => p.hair)).size).toBeGreaterThanOrEqual(6);
    const crew = planCrew(def('cargo-ship'), 3).filter((m) => m.role === 'sailor');
    expect(crew.length).toBeGreaterThan(1);
    expect(new Set(crew.map((m) => m.variant)).size).toBe(Math.min(crew.length, SAILOR_VARIANTS));
  });

  it('lays every outfit, look and frame on its own cell of a sheet within 2048 px', () => {
    expect(SHEET_SIZE.width).toBeLessThanOrEqual(2048);
    expect(SHEET_SIZE.height).toBeLessThanOrEqual(2048);
    const seen = new Set<string>();
    let cols = 0;
    let rows = 0;
    for (let o = 0; o < OUTFITS.length; o++) {
      for (let v = 0; v < SAILOR_VARIANTS + CAPTAIN_VARIANTS; v++) {
        for (let f = 0; f < 12; f++) {
          const [c, r] = sheetCell(o, v, f);
          seen.add(`${c},${r}`);
          cols = Math.max(cols, c + 1);
          rows = Math.max(rows, r + 1);
        }
      }
    }
    expect(seen.size).toBe(OUTFITS.length * (SAILOR_VARIANTS + CAPTAIN_VARIANTS) * 12);
    expect(cols * 32).toBeLessThanOrEqual(SHEET_SIZE.width);
    expect(rows * 48).toBeLessThanOrEqual(SHEET_SIZE.height);
  });
});

describe('SailorLayer', () => {
  it('runs without a DOM or WebGL (no sprite sheet is created)', async () => {
    const THREE = await import('three');
    const layer = new SailorLayer();
    const group = new THREE.Group();
    layer.setVessels([{ id: 'v', definition: def('trawler'), group }]);
    layer.update({
      t: 0,
      dt: 0.016,
      wallT: 0,
      camera: new THREE.PerspectiveCamera(),
      calm: 1,
      daylight: 1,
      timeOfDay: 12,
      sunDir: new THREE.Vector3(0, 1, 0),
      windSpeed: 5,
      windDirectionDeg: 0,
      hs: 1,
      vessels: [{ id: 'v', speedKn: 0, capsized: false }],
      vesselPositions: [new THREE.Vector3()],
    });
    layer.setVessels([]);
    layer.dispose();
    expect(group.children).toHaveLength(0);
  });
});
