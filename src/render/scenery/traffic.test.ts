import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { islandsNear } from './islands';
import {
  createHostileState,
  evaluateTrafficShip,
  LANE_TURN_RADIUS,
  TRAFFIC_CELL,
  STRUCTURE_CELL,
  type TrafficShipSpec,
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

/** Every ship spec in a block of cells around the origin. */
function allSpecs(radius = 10): { ix: number; iy: number; spec: TrafficShipSpec }[] {
  const out: { ix: number; iy: number; spec: TrafficShipSpec }[] = [];
  for (let iy = -radius; iy <= radius; iy++) {
    for (let ix = -radius; ix <= radius; ix++) {
      for (const spec of trafficInCell(ix, iy)) out.push({ ix, iy, spec });
    }
  }
  return out;
}

describe('traffic route integrity', () => {
  const specs = allSpecs();

  it('has a healthy population to test against', () => {
    expect(specs.length).toBeGreaterThan(40);
  });

  it('keeps every route inside its own cell, clear of the origin zone and islands', () => {
    // Routes are periodic (a lap takes a few hundred seconds), so 16 samples over 1500 s
    // cover the whole loop; violations are counted so one failure names the cause.
    const bad: string[] = [];
    for (const { ix, iy, spec } of specs) {
      const margin = spec.length * 0.5;
      for (let t = 0; t < 1500; t += 97) {
        const p = evaluateTrafficShip(spec, t, 1, 0.5)!;
        const inCell =
          p.x > ix * TRAFFIC_CELL + margin &&
          p.x < (ix + 1) * TRAFFIC_CELL - margin &&
          p.y > iy * TRAFFIC_CELL + margin &&
          p.y < (iy + 1) * TRAFFIC_CELL - margin;
        if (!inCell) bad.push(`${spec.id} leaves its cell at t=${t}`);
        if (Math.hypot(p.x, p.y) <= TRAFFIC_CLEAR_RADIUS) bad.push(`${spec.id} in origin zone`);
        if (islandsNear(p.x, p.y, margin).length > 0) bad.push(`${spec.id} over an island`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps clear of offshore structures', () => {
    const bad: string[] = [];
    for (const { spec } of specs) {
      for (let t = 0; t < 1500; t += 97) {
        const p = evaluateTrafficShip(spec, t, 1, 0.5)!;
        const sx = Math.floor(p.x / STRUCTURE_CELL);
        const sy = Math.floor(p.y / STRUCTURE_CELL);
        for (let iy = sy - 1; iy <= sy + 1; iy++) {
          for (let ix = sx - 1; ix <= sx + 1; ix++) {
            for (const it of structuresInCell(ix, iy)?.items ?? []) {
              if (Math.hypot(it.x - p.x, it.y - p.y) <= spec.length * 0.5 + 20) {
                bad.push(`${spec.id} hits ${it.id}`);
              }
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('never produces NaN poses or headings, in any weather', () => {
    for (const { spec } of specs) {
      for (const calm of [0, 0.1, 0.3, 0.6, 1]) {
        for (const t of [0, 1.5, 900.25, 86_400]) {
          const p = evaluateTrafficShip(spec, t, calm, 7);
          if (!p) continue;
          for (const v of [p.x, p.y, p.heading, p.speed, p.heave, p.pitch, p.roll]) {
            expect(Number.isFinite(v)).toBe(true);
          }
          expect(Math.abs(p.heading)).toBeLessThanOrEqual(Math.PI + 1e-9);
        }
      }
    }
  });

  it('moves continuously: no position or heading jumps as time advances', () => {
    const dt = 0.5;
    let worstStep = 0;
    let worstTurn = 0;
    for (const { spec } of specs) {
      let prev = evaluateTrafficShip(spec, 0, 1, 0.5)!;
      // Orbits turn at speed / radius, lanes at speed / LANE_TURN_RADIUS: never a snap.
      const radius = spec.pattern === 'orbit' ? Math.max(40, spec.span) : LANE_TURN_RADIUS;
      for (let t = dt; t < 1500; t += dt) {
        const p = evaluateTrafficShip(spec, t, 1, 0.5)!;
        worstStep = Math.max(worstStep, Math.hypot(p.x - prev.x, p.y - prev.y) / (spec.speed * dt));
        worstTurn = Math.max(
          worstTurn,
          Math.abs(wrapDelta(p.heading - prev.heading)) / ((spec.speed / radius) * dt),
        );
        prev = p;
      }
    }
    expect(worstStep).toBeLessThanOrEqual(1.01);
    expect(worstTurn).toBeLessThanOrEqual(1.05);
  });

  it('does not teleport when calm changes: weather never rescales time', () => {
    for (const { spec } of specs.slice(0, 60)) {
      const a = evaluateTrafficShip(spec, 7200, 1, 0.5)!;
      const b = evaluateTrafficShip(spec, 7200, 0.7, 0.5);
      if (!b) continue;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
    }
  });

  it('lanes are racetracks: ships follow their lane line and turn on the rounded ends', () => {
    const lanes = specs.filter((s) => s.spec.pattern === 'lane');
    expect(lanes.length).toBeGreaterThan(5);
    for (const { spec } of lanes) {
      const c = Math.cos(spec.heading);
      const s = Math.sin(spec.heading);
      for (let t = 0; t < 3000; t += 11) {
        const p = evaluateTrafficShip(spec, t, 1, 0)!;
        const u = (p.x - spec.cx) * c + (p.y - spec.cy) * s;
        const v = -(p.x - spec.cx) * s + (p.y - spec.cy) * c;
        expect(Math.abs(u)).toBeLessThanOrEqual(spec.span * 0.5 + 1e-6);
        expect(Math.abs(v)).toBeLessThanOrEqual(LANE_TURN_RADIUS + 1e-6);
      }
    }
  });

  it('fishing fleets keep their circle with constant, non-overlapping spacing', () => {
    const fleets = new Map<string, TrafficShipSpec[]>();
    for (const { ix, iy, spec } of specs) {
      if (spec.kind !== 'trawler') continue;
      const k = `${ix}:${iy}`;
      fleets.set(k, [...(fleets.get(k) ?? []), spec]);
    }
    expect(fleets.size).toBeGreaterThan(3);
    for (const ships of fleets.values()) {
      expect(ships.length).toBeGreaterThanOrEqual(2);
      for (let t = 0; t < 6000; t += 53) {
        const poses = ships.map((s) => evaluateTrafficShip(s, t, 1, 0)!);
        for (let i = 0; i < poses.length; i++) {
          const a = poses[i]!;
          const r = Math.hypot(a.x - ships[i]!.cx, a.y - ships[i]!.cy);
          expect(Math.abs(r - ships[i]!.span)).toBeLessThan(1e-6);
          for (let j = i + 1; j < poses.length; j++) {
            const b = poses[j]!;
            const gap = Math.hypot(a.x - b.x, a.y - b.y);
            expect(gap).toBeGreaterThan((a.length + b.length) * 0.5 + 40);
          }
        }
      }
    }
  });

  it('carrier escorts keep station beside the flagship without overlapping it', () => {
    const escorts = specs.filter((s) => s.spec.id.startsWith('escort:'));
    expect(escorts.length).toBeGreaterThan(0);
    for (const { ix, iy, spec } of escorts) {
      const flag = trafficInCell(ix, iy)[0]!;
      for (let t = 0; t < 3000; t += 17) {
        const a = evaluateTrafficShip(flag, t, 1, 0)!;
        const b = evaluateTrafficShip(spec, t, 1, 0)!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.beam * 0.5 + b.beam * 0.5 + 20);
      }
    }
  });

  it('spawns and despawns by cell and view range only: a pose never depends on the camera', () => {
    const t = 321;
    const byId = new Map(specs.map((s) => [s.spec.id, s.spec]));
    let seen = 0;
    for (let x = 3200; x < 9000; x += 130) {
      for (const p of trafficNear(x, 4100, t, 1, 0.5, 'full', 3000)) {
        expect(Math.hypot(p.x - x, p.y - 4100)).toBeLessThanOrEqual(3000);
        const own = evaluateTrafficShip(byId.get(p.id)!, t, 1, 0.5)!;
        expect(own.x).toBe(p.x);
        expect(own.y).toBe(p.y);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it('returns the nearest ships first and only drops the farthest when the budget binds', () => {
    const all = trafficNear(5000, 5000, 90, 1, 0.5, 'full', 9000);
    const lite = trafficNear(5000, 5000, 90, 1, 0.5, 'lite', 9000);
    expect(lite.length).toBe(TRAFFIC_BUDGET.lite);
    expect(lite.map((p) => p.id)).toEqual(all.slice(0, lite.length).map((p) => p.id));
    const d = all.map((p) => Math.hypot(p.x - 5000, p.y - 5000));
    expect([...d].sort((a, b) => a - b)).toEqual(d);
  });

  it('shelters monotonically as calm drops: nets come in first, then the ship is gone', () => {
    for (const { spec } of specs.slice(0, 80)) {
      let gone = false;
      let netsIn = false;
      for (let calm = 1; calm >= 0; calm -= 0.02) {
        const p = evaluateTrafficShip(spec, 100, calm, 3);
        if (!p) gone = true;
        else expect(gone).toBe(false);
        if (p && spec.kind === 'trawler') {
          if (!p.working) netsIn = true;
          else expect(netsIn).toBe(false);
        }
      }
      expect(gone).toBe(true);
      expect(evaluateTrafficShip(spec, 100, 1, 0.5)).not.toBeNull();
    }
  });
});

function wrapDelta(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

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

describe('hostile despawn guarantees', () => {
  it('despawns the moment the setting is switched off or the tier drops to lite', () => {
    for (const off of ['disabled', 'lite'] as const) {
      const st = createHostileState(3);
      const target = { x: 0, y: 0, heading: 0, speed: 3 };
      let live = null;
      for (let i = 0; i < 200 && !live; i++) {
        live = stepHostileEncounter(st, 0.25, true, 'full', target, 1);
      }
      expect(live).not.toBeNull();
      const after = stepHostileEncounter(
        st,
        0.25,
        off !== 'disabled',
        off === 'lite' ? 'lite' : 'full',
        target,
        1,
      );
      expect(after).toBeNull();
      expect(st.stage).toBe('idle');
    }
  });

  it('despawns when a fast vessel outruns it, from every stage', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const st = createHostileState(seed);
      let x = 0;
      let outrun = false;
      for (let i = 0; i < 3000; i++) {
        // The vessel bolts away at 40 m/s after the encounter has started.
        if (st.stage !== 'idle' && i % 400 > 200) x += 40 * 0.25;
        const p = stepHostileEncounter(
          st,
          0.25,
          true,
          'full',
          { x, y: 0, heading: 0, speed: 40 },
          1,
        );
        if (p) {
          expect(Math.hypot(p.x - x, p.y)).toBeLessThanOrEqual(HOSTILE_DESPAWN_RANGE);
        } else if (st.stage === 'idle' && x > 0) {
          outrun = true;
        }
      }
      expect(outrun).toBe(true);
    }
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
