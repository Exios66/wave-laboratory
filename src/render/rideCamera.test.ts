import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Pcg32 } from '../core/rng';
import {
  AIRCRAFT,
  AIRCRAFT_DRAW_SCALE,
  aircraftQuaternion,
  crossingPose,
  planRide,
  type AircraftKind,
  type PlanePose,
} from './scenery/planes';
import {
  COCKPIT,
  RIDE_VIEWS,
  dampVec,
  newRideCameraState,
  rideCameraPose,
  rolledUp,
  type RideFlight,
  type RideLook,
  type RideView,
} from './rideCamera';

const KINDS: AircraftKind[] = ['avenger', 'mariner', 'dc3', 'tudor'];
const LOOK: RideLook = { yaw: 0, dip: 0, chase: 110 };

function out() {
  return {
    pos: new THREE.Vector3(),
    target: new THREE.Vector3(),
    up: new THREE.Vector3(),
    roll: 0,
  };
}

/** The eye in the aircraft's own frame (model units, before the draw scale). */
function toModel(pose: PlanePose, world: THREE.Vector3): THREE.Vector3 {
  const q = aircraftQuaternion(pose, new THREE.Quaternion()).invert();
  return world
    .clone()
    .sub(new THREE.Vector3(pose.x, pose.y, pose.z))
    .applyQuaternion(q)
    .divideScalar(AIRCRAFT_DRAW_SCALE);
}

function flight(kind: AircraftKind, turnRate = 0.08): RideFlight {
  return { kind, speed: AIRCRAFT[kind].speed, turnRate, centre: { x: 0, z: 0 } };
}

describe('aircraft orientation', () => {
  it('banks about the nose, whatever the heading', () => {
    const p: PlanePose = { x: 0, y: 300, z: 0, heading: Math.PI / 2, bank: 0.5 };
    const q = aircraftQuaternion(p, new THREE.Quaternion());
    const nose = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const starboard = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    // Heading π/2 points the nose along +z (Three.js atan2(z, x)).
    expect(nose.z).toBeGreaterThan(0.99);
    // A positive bank drops the starboard wing (a right turn), not the nose.
    expect(starboard.y).toBeCloseTo(-Math.sin(0.5), 2);
    expect(Math.abs(nose.y)).toBeLessThan(0.05);
  });
});

describe('ride cameras', () => {
  it('lists the views in order', () => {
    expect(RIDE_VIEWS).toEqual(['chase', 'cockpit', 'wing', 'flyby']);
  });

  it('seats the cockpit eye in the canopy, ahead of the wing', () => {
    for (const kind of KINDS) {
      const pose: PlanePose = { x: 100, y: 300, z: -50, heading: 1.1, bank: 0.3 };
      const o = out();
      rideCameraPose('cockpit', pose, flight(kind), LOOK, newRideCameraState(), o);
      const m = toModel(pose, o.pos);
      const seat = COCKPIT[kind];
      expect(Math.abs(m.z)).toBeLessThan(0.6 * seat.radius);
      expect(m.y).toBeGreaterThan(0);
      expect(m.y).toBeLessThanOrEqual(seat.canopyTop);
      expect(m.x).toBeGreaterThan(seat.leadingEdge);
    }
  });

  it('puts the wing eye out on the starboard wing', () => {
    for (const kind of KINDS) {
      const pose: PlanePose = { x: 0, y: 300, z: 0, heading: -0.7, bank: 0.25 };
      const o = out();
      rideCameraPose('wing', pose, flight(kind), LOOK, newRideCameraState(), o);
      const m = toModel(pose, o.pos);
      const half = (AIRCRAFT[kind].span / 2) * AIRCRAFT_DRAW_SCALE;
      expect(m.z * AIRCRAFT_DRAW_SCALE).toBeGreaterThan(0.8 * half - 0.5);
      expect(m.z * AIRCRAFT_DRAW_SCALE).toBeLessThan(0.8 * half + 0.5);
      // Looking forward and inboard.
      const look = toModel(pose, o.target).sub(m);
      expect(look.x).toBeGreaterThan(0);
      expect(look.z).toBeLessThan(0);
    }
  });

  it('rolls with the bank: fully aboard, half in chase, level for the fly-by', () => {
    const pose: PlanePose = { x: 0, y: 300, z: 800, heading: 0, bank: 0.4 };
    const expected: Record<RideView, number> = { chase: 0.2, cockpit: 0.4, wing: 0.4, flyby: 0 };
    for (const view of RIDE_VIEWS) {
      const o = out();
      rideCameraPose(view, pose, flight('dc3'), LOOK, newRideCameraState(), o);
      expect(o.roll).toBeCloseTo(expected[view], 6);
    }
  });

  it('keeps the fly-by camera near the circuit, moving it on as the aircraft passes', () => {
    const c = planRide(new Pcg32(7), { x: 0, z: 0 }, 0, 1, 0.4, 0, 'tudor');
    const f: RideFlight = {
      kind: c.kind,
      speed: c.speed,
      turnRate: c.turnRate,
      centre: { x: 0, z: 0 },
    };
    const state = newRideCameraState();
    const p: PlanePose = { x: 0, y: 0, z: 0, heading: 0, bank: 0 };
    const o = out();
    let moves = 0;
    let last: THREE.Vector3 | null = null;
    for (let t = 0; t <= 60; t += 0.1) {
      crossingPose(c, 0, t, p);
      rideCameraPose('flyby', p, f, LOOK, state, o);
      expect(o.pos.distanceTo(new THREE.Vector3(p.x, p.y, p.z))).toBeLessThanOrEqual(450);
      // It looks at the aircraft and sits below its path.
      expect(o.target.distanceTo(new THREE.Vector3(p.x, p.y, p.z))).toBeLessThan(1e-6);
      if (last && !last.equals(o.pos)) moves++;
      last = o.pos.clone();
    }
    expect(moves).toBeGreaterThanOrEqual(1);
  });

  it('turns a roll into the camera up vector, starboard side down for a right bank', () => {
    const up = rolledUp(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 0, 0),
      0.3,
      new THREE.Vector3(),
    );
    expect(up.y).toBeCloseTo(Math.cos(0.3), 6);
    expect(up.z).toBeCloseTo(Math.sin(0.3), 6);
    expect(
      rolledUp(new THREE.Vector3(), new THREE.Vector3(5, 0, 0), 0, new THREE.Vector3()).y,
    ).toBe(1);
  });
});

describe('dampVec', () => {
  it('moves halfway in one half-life, however the time is split', () => {
    const a = new THREE.Vector3(0, 0, 0);
    dampVec(a, new THREE.Vector3(10, -4, 2), 0.25, 0.25);
    expect(a.x).toBeCloseTo(5, 6);
    expect(a.y).toBeCloseTo(-2, 6);
    const b = new THREE.Vector3(0, 0, 0);
    for (let i = 0; i < 4; i++) dampVec(b, new THREE.Vector3(10, -4, 2), 0.25, 0.0625);
    expect(b.distanceTo(a)).toBeLessThan(1e-6);
  });
});

describe('planRide kind', () => {
  it('flies the aircraft asked for', () => {
    for (const kind of KINDS) {
      expect(planRide(new Pcg32(3), { x: 0, z: 0 }, 0, 1, 0, 0, kind).kind).toBe(kind);
    }
  });
});
