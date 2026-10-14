import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createHostileState,
  evaluateTrafficShip,
  HOSTILE_DESPAWN_RANGE,
  stepHostileEncounter,
  STRUCTURE_BUDGET,
  STRUCTURE_CLEAR_RADIUS,
  structureBeaconIntensity,
  structuresInCell,
  structuresNear,
  TRAFFIC_BUDGET,
  TRAFFIC_CLEAR_RADIUS,
  trafficInCell,
  TrafficLayer,
  trafficNear,
} from './traffic';
import type { SceneryFrame } from './types';

function makeFrame(overrides: Partial<SceneryFrame> = {}): SceneryFrame {
  return {
    t: 120,
    dt: 0.05,
    wallT: 120,
    camera: new THREE.PerspectiveCamera(),
    calm: 1,
    daylight: 1,
    timeOfDay: 12,
    sunDir: new THREE.Vector3(0, 1, 0),
    windSpeed: 5,
    windDirectionDeg: 90,
    hs: 0.8,
    vessels: [],
    vesselPositions: [],
    tier: 'full',
    ...overrides,
  };
}

describe('traffic placement & routing', () => {
  it('is deterministic and keeps the origin clear zone open', () => {
    const a = trafficNear(4000, -3000, 100, 1, 0.8, 'full');
    const b = trafficNear(4000, -3000, 100, 1, 0.8, 'full');
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);

    for (let iy = -3; iy <= 3; iy++) {
      for (let ix = -3; ix <= 3; ix++) {
        for (const s of trafficInCell(ix, iy)) {
          expect(Math.hypot(s.cx, s.cy)).toBeGreaterThanOrEqual(TRAFFIC_CLEAR_RADIUS);
        }
      }
    }
  });

  it('enforces the tier hull budgets (full <= 12, mid <= 8, lite <= 4)', () => {
    for (const tier of ['full', 'mid', 'lite'] as const) {
      const list = trafficNear(6000, 6000, 50, 1, 0.5, tier, 15_000);
      expect(list.length).toBeLessThanOrEqual(TRAFFIC_BUDGET[tier]);
      if (tier === 'lite') expect(list.length).toBeLessThanOrEqual(4);
    }
  });

  it('spawns working fleets (trawlers, cargo, patrol) and big tonnage (liner, tanker, carrier)', () => {
    const kinds = new Set<string>();
    for (let iy = -12; iy <= 12; iy++) {
      for (let ix = -12; ix <= 12; ix++) {
        for (const s of trafficInCell(ix, iy)) kinds.add(s.kind);
      }
    }
    for (const k of ['trawler', 'cargo', 'patrol', 'liner', 'tanker', 'carrier']) {
      expect(kinds.has(k)).toBe(true);
    }
  });

  it('hauls nets and shelters fleets when calm drops into a gale', () => {
    let sample = trafficInCell(2, 2)[0];
    for (let i = -8; i <= 8 && !sample; i++) sample = trafficInCell(i, 3)[0];
    expect(sample).toBeDefined();
    const fair = evaluateTrafficShip(sample!, 20, 1, 0.6);
    const storm = evaluateTrafficShip(sample!, 20, 0, 5.0);
    expect(fair).not.toBeNull();
    expect(storm).toBeNull();
  });
});

describe('offshore static structures', () => {
  it('places deterministic oil rigs, wind turbines and buoys outside the clear radius', () => {
    const a = structuresNear(5000, -4000, 'full', 12_000);
    const b = structuresNear(5000, -4000, 'full', 12_000);
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(STRUCTURE_BUDGET.full);
    expect(structuresNear(5000, -4000, 'lite', 12_000)).toEqual([]);

    for (let iy = -4; iy <= 4; iy++) {
      for (let ix = -4; ix <= 4; ix++) {
        const c = structuresInCell(ix, iy);
        if (c) expect(Math.hypot(c.cx, c.cy)).toBeGreaterThanOrEqual(STRUCTURE_CLEAR_RADIUS);
      }
    }
  });

  it('pulses structure beacons harder in storms', () => {
    let maxFair = 0;
    let maxStorm = 0;
    for (let t = 0; t < 10; t += 0.1) {
      maxFair = Math.max(maxFair, structureBeaconIntensity(t, 42, 1));
      maxStorm = Math.max(maxStorm, structureBeaconIntensity(t, 42, 0));
    }
    expect(maxStorm).toBeGreaterThan(maxFair);
  });
});

describe('hostile pirate encounter state machine', () => {
  const TARGET = { x: 0, y: 0, heading: 0, speed: 3 };

  /** Run the encounter forward until it spawns (or gives up), like a real frame loop. */
  function run(
    st: ReturnType<typeof createHostileState>,
    enabled: boolean,
    tier: 'full' | 'mid' | 'lite',
    target = TARGET,
    steps = 200,
  ) {
    let pose = null;
    for (let i = 0; i < steps; i++) pose = stepHostileEncounter(st, 0.25, enabled, tier, target, 1);
    return pose;
  }

  it('stays idle when disabled or on lite tier', () => {
    expect(run(createHostileState(99), false, 'full')).toBeNull();
    expect(run(createHostileState(99), true, 'lite')).toBeNull();
  });

  it('spawns inside 500 m, closes to abeam, then always despawns beyond 500 m', () => {
    const st = createHostileState(99);
    const pose = run(st, true, 'full');
    expect(pose).not.toBeNull();
    expect(pose!.kind).toBe('pirate');
    expect(Math.hypot(pose!.x - TARGET.x, pose!.y - TARGET.y)).toBeLessThanOrEqual(
      HOSTILE_DESPAWN_RANGE,
    );

    // Jumping the target away mid-encounter ends it cleanly on the same step.
    const far = run(st, true, 'full', { x: 2000, y: 2000, heading: 0, speed: 3 }, 1);
    expect(far).toBeNull();
    expect(st.stage).toBe('idle');
  });

  it('closes to abeam and peels away without ever straying past 500 m', () => {
    const st = createHostileState(7);
    const seen = new Set<string>();
    let nearest = Infinity;
    for (let i = 0; i < 1600; i++) {
      const p = stepHostileEncounter(st, 0.25, true, 'full', TARGET, 1);
      if (!p) continue;
      seen.add(st.stage);
      nearest = Math.min(nearest, Math.hypot(p.x - TARGET.x, p.y - TARGET.y));
      expect(Math.hypot(p.x - TARGET.x, p.y - TARGET.y)).toBeLessThanOrEqual(HOSTILE_DESPAWN_RANGE);
    }
    expect(seen).toContain('paralleling');
    expect(seen).toContain('peeling');
    expect(nearest).toBeLessThan(130);
  });
});

describe('TrafficLayer', () => {
  it('updates instanced meshes and exports wake and wildlife tracks', () => {
    const layer = new TrafficLayer();
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(3500, 40, -3500);
    layer.setFlags({ traffic: true, structures: true, hostiles: true });
    layer.update(makeFrame({ camera: cam, daylight: 0.1 }));
    expect(layer.ships.length).toBeGreaterThan(0);
    const wakes: Parameters<TrafficLayer['appendWakeSources']>[0] = [];
    layer.appendWakeSources(wakes);
    expect(wakes.length).toBeGreaterThan(0);
    layer.dispose();
  });
});
