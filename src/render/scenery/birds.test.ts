import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  bankAngle,
  birdCounts,
  createBirdSlots,
  departureOffset,
  divePosition,
  flockPosition,
  seaClearance,
  seabirdFraction,
  shipPosition,
  slotWanted,
  soarPosition,
  ternCycle,
  ternDiveProfile,
  wingPose,
  type DiveState,
  type FlightContext,
  type ShipTrack,
  type WingPose,
} from './birds';

const slots = createBirdSlots(42);

function ctx(windSpeed = 6, hs = 1): FlightContext {
  return { anchorX: 10, anchorZ: -20, downwindX: 0.6, downwindZ: 0.8, windSpeed, hs };
}

describe('population', () => {
  it('is full in fair weather by day', () => {
    expect(seabirdFraction(1, 1)).toBe(1);
    const c = birdCounts(slots, 1, 1, 2);
    expect(c.gull).toBeGreaterThanOrEqual(15);
    expect(c.tern).toBeGreaterThanOrEqual(5);
    expect(c.albatross).toBeGreaterThanOrEqual(1);
    expect(c.albatross).toBeLessThanOrEqual(2);
    expect(c.ship).toBeGreaterThan(0);
  });

  it('falls to zero in a storm and when calm drops below 0.4', () => {
    expect(birdCounts(slots, 0, 1, 2).total).toBe(0);
    expect(birdCounts(slots, 0.38, 1, 2).total).toBe(0);
  });

  it('falls to zero at night', () => {
    expect(birdCounts(slots, 1, 0, 2).total).toBe(0);
  });

  it('leaves a lone bird in the calm dusk', () => {
    const c = birdCounts(slots, 1, 0.08, 2);
    expect(c.total).toBe(1);
    expect(birdCounts(slots, 0.3, 0.08, 2).total).toBe(0);
  });

  it('scales up monotonically with calm', () => {
    let last = -1;
    for (let calm = 0; calm <= 1.0001; calm += 0.05) {
      const n = birdCounts(slots, calm, 1, 1).total;
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });

  it('has no ship gulls without vessels', () => {
    expect(birdCounts(slots, 1, 1, 0).ship).toBe(0);
    const shipSlot = slots.find((s) => s.mode === 'ship')!;
    expect(slotWanted(shipSlot, 1, 1, false)).toBe(false);
  });
});

describe('determinism', () => {
  it('builds the same roster from the same seed', () => {
    expect(createBirdSlots(7)).toEqual(createBirdSlots(7));
    expect(createBirdSlots(7)).not.toEqual(createBirdSlots(8));
  });

  it('puts a bird in the same place for the same time', () => {
    const c = ctx();
    for (const s of slots.filter((x) => x.mode !== 'ship')) {
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const f =
        s.mode === 'flock' ? flockPosition : s.mode === 'soar' ? soarPosition : divePosition;
      f(s, 123.4, c, a);
      f(s, 123.4, c, b);
      expect(a.equals(b)).toBe(true);
    }
  });
});

describe('flight paths', () => {
  const p = new THREE.Vector3();

  it('keeps flocking gulls and albatrosses above the sea, even in a big swell', () => {
    for (const hs of [0, 1, 3]) {
      const c = ctx(8, hs);
      let minY = Infinity;
      let finite = true;
      for (const s of slots) {
        if (s.mode !== 'flock' && s.mode !== 'soar') continue;
        for (let t = 0; t < 600; t += 0.37) {
          (s.mode === 'flock' ? flockPosition : soarPosition)(s, t, c, p);
          minY = Math.min(minY, p.y);
          finite &&= Number.isFinite(p.x) && Number.isFinite(p.z);
        }
      }
      expect(minY).toBeGreaterThan(seaClearance(hs));
      expect(finite).toBe(true);
    }
  });

  it('keeps albatrosses low', () => {
    const alb = slots.filter((s) => s.mode === 'soar');
    let max = 0;
    for (const s of alb)
      for (let t = 0; t < 600; t += 0.5) max = Math.max(max, soarPosition(s, t, ctx(), p).y);
    expect(max).toBeLessThan(20);
  });

  it('keeps wheeling gulls near the anchor', () => {
    const c = ctx();
    for (const s of slots.filter((x) => x.mode === 'flock')) {
      for (let t = 0; t < 300; t += 1.3) {
        flockPosition(s, t, c, p);
        expect(Math.hypot(p.x - c.anchorX, p.z - c.anchorZ)).toBeLessThan(330);
      }
    }
  });

  it('only takes terns below the sea surface during a dive', () => {
    const c = ctx(5, 1.5);
    const dive: DiveState = { y: 0, stage: 'cruise', fold: 0 };
    let dives = 0;
    for (const s of slots.filter((x) => x.mode === 'dive')) {
      let wasUnder = false;
      for (let t = 0; t < 300; t += 0.05) {
        divePosition(s, t, c, p, dive);
        const under = p.y < 0;
        if (under) expect(['plunge', 'under', 'emerge']).toContain(dive.stage);
        if (dive.stage === 'cruise') expect(p.y).toBeGreaterThan(seaClearance(1.5));
        if (under && !wasUnder) dives++;
        wasUnder = under;
      }
    }
    // Each tern dives roughly every 16–30 s.
    expect(dives).toBeGreaterThan(50);
  });

  it('dive profile is continuous across the cycle', () => {
    const d: DiveState = { y: 0, stage: 'cruise', fold: 0 };
    let last = ternDiveProfile(0, 12, d).y;
    for (let u = 0.001; u < 1; u += 0.001) {
      const y = ternDiveProfile(u, 12, d).y;
      expect(Math.abs(y - last)).toBeLessThan(1);
      last = y;
    }
    expect(Math.abs(ternDiveProfile(0.99999, 12, d).y - ternDiveProfile(0, 12, d).y)).toBeLessThan(
      0.01,
    );
  });

  it('slows the horizontal circle during a dive without jumping', () => {
    const s = slots.find((x) => x.mode === 'dive')!;
    let last = ternCycle(s, 0).pathT;
    for (let t = 0.01; t < 200; t += 0.01) {
      const { pathT } = ternCycle(s, t);
      const d = pathT - last;
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(0.0101);
      last = pathT;
    }
  });

  it('trails gulls behind a moving ship and circles a stopped one', () => {
    const s = slots.find((x) => x.mode === 'ship')!;
    const moving: ShipTrack = {
      x: 0,
      z: 0,
      vx: 6,
      vz: 0,
      fx: 1,
      fz: 0,
      length: 120,
      height: 18,
      t0: 50,
    };
    for (let t = 50; t < 80; t += 0.5) {
      shipPosition(s, t, moving, p);
      const shipX = 6 * (t - 50);
      expect(p.x).toBeLessThan(shipX - 60); // behind the stern
      expect(p.y).toBeGreaterThan(18);
    }
    const stopped: ShipTrack = { ...moving, vx: 0, length: 20, height: 3 };
    for (let t = 0; t < 60; t += 0.5) {
      shipPosition(s, t, stopped, p);
      const r = Math.hypot(p.x, p.z);
      expect(r).toBeGreaterThan(20);
      expect(r).toBeLessThan(50);
      expect(p.y).toBeGreaterThan(3);
    }
  });
});

describe('leaving', () => {
  it('climbs away downwind and never descends', () => {
    const s = slots[0]!;
    const o = new THREE.Vector3();
    expect(departureOffset(s, 1, ctx(), o).length()).toBe(0);
    let lastY = 0;
    for (let p = 1; p >= 0; p -= 0.05) {
      departureOffset(s, p, ctx(), o);
      expect(o.y).toBeGreaterThanOrEqual(lastY);
      lastY = o.y;
    }
    departureOffset(s, 0, ctx(), o);
    const c = ctx();
    const along = (o.x * c.downwindX + o.z * c.downwindZ) / Math.hypot(o.x, o.z);
    expect(along).toBeGreaterThan(0.9);
    expect(Math.hypot(o.x, o.z)).toBeGreaterThan(500);
  });
});

describe('flight dynamics', () => {
  it('banks into the turn', () => {
    const vel = new THREE.Vector3(10, 0, 0);
    // Right of +x heading (y up) is +z.
    expect(bankAngle(vel, new THREE.Vector3(0, 0, 5))).toBeGreaterThan(0.3);
    expect(bankAngle(vel, new THREE.Vector3(0, 0, -5))).toBeLessThan(-0.3);
    expect(bankAngle(vel, new THREE.Vector3(0, 0, 500))).toBeLessThanOrEqual(1.05);
    expect(bankAngle(new THREE.Vector3(), new THREE.Vector3(0, 0, 5))).toBe(0);
  });

  it('flaps gulls more than albatrosses, with bounded wing angles', () => {
    const pose: WingPose = { inner: 0, outer: 0, flap: 0 };
    const flapping = (role: 'gull' | 'tern' | 'albatross') => {
      let n = 0;
      let total = 0;
      for (let t = 0; t < 300; t += 0.05) {
        wingPose(role, t, 0.4, 0, 0, pose);
        expect(Math.abs(pose.inner)).toBeLessThan(1.0);
        expect(Math.abs(pose.outer)).toBeLessThan(1.0);
        if (pose.flap > 0.5) n++;
        total++;
      }
      return n / total;
    };
    const alb = flapping('albatross');
    const gull = flapping('gull');
    const tern = flapping('tern');
    expect(alb).toBeGreaterThan(0);
    expect(alb).toBeLessThan(0.12);
    expect(gull).toBeGreaterThan(alb * 2);
    expect(tern).toBeGreaterThan(gull);
  });

  it('folds the wings for a dive', () => {
    const pose: WingPose = { inner: 0, outer: 0, flap: 0 };
    wingPose('tern', 3, 0.2, 0, 1, pose);
    expect(pose.inner).toBeGreaterThan(1.2);
    expect(pose.flap).toBe(0);
  });
});
