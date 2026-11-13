/**
 * Plane view cameras: where the eye sits for each way of riding a flight, worked out from the
 * leader's pose. Pure maths (no WebGL), so it is tested in node; LabRenderer applies the result.
 *
 * - chase: behind and a little above, gazing toward the fleet; rolls by half the bank.
 * - cockpit: the pilot's seat; rolls with the aircraft and looks around within a pilot's reach.
 * - wing: out on the starboard wing, looking forward and in at the fuselage.
 * - flyby: a fixed point ahead on the circuit, below the flight path, that the aircraft passes.
 */
import * as THREE from 'three';
import {
  AIRCRAFT,
  AIRCRAFT_DRAW_SCALE,
  aircraftQuaternion,
  type AircraftKind,
  type PlanePose,
} from './scenery/planes';

import type { RideView } from './rideViews';

export { RIDE_VIEWS, type RideView } from './rideViews';

/** Compass bearing [deg, 0 north, 90 east] of a Three.js heading (atan2(z, x); north is −z). */
export function compassDeg(heading: number): number {
  const d = (Math.atan2(Math.cos(heading), -Math.sin(heading)) * 180) / Math.PI;
  return ((d % 360) + 360) % 360;
}

/** The flight being ridden, as far as the cameras need it. */
export interface RideFlight {
  kind: AircraftKind;
  /** Cruise speed [m/s]. */
  speed: number;
  /** Turn rate [rad/s], positive turning to starboard. */
  turnRate: number;
  /** Centre of the circuit (the fleet) the chase camera gazes toward. */
  centre: { x: number; z: number };
}

/** The viewer's turn and zoom: gaze yaw and dip [rad], chase distance [m]. */
export interface RideLook {
  yaw: number;
  dip: number;
  chase: number;
}

export interface RideCameraOut {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  /** Camera up, rolled with the aircraft as the view asks. */
  up: THREE.Vector3;
  /** How far the view rolls with the aircraft [rad, positive starboard side down]. */
  roll: number;
}

/** What the fly-by camera remembers between frames. */
export interface RideCameraState {
  flyby: THREE.Vector3;
  placed: boolean;
  /** The aircraft has come close; move the camera on once it is past. */
  passing: boolean;
}

export function newRideCameraState(): RideCameraState {
  return { flyby: new THREE.Vector3(), placed: false, passing: false };
}

/**
 * Per-kind seat, in model units (nose +x, up +y, starboard +z, before AIRCRAFT_DRAW_SCALE):
 * the eye, the wing's leading edge and the fuselage radius it sits in, the canopy's top, and
 * where the wing view looks from (`wingX`, `wingY` at 0.8 of the half-span).
 */
export const COCKPIT: Readonly<
  Record<
    AircraftKind,
    {
      eye: readonly [number, number, number];
      radius: number;
      canopyTop: number;
      leadingEdge: number;
      wingX: number;
      wingY: number;
    }
  >
> = {
  avenger: {
    eye: [2.4, 1.2, 0],
    radius: 0.9,
    canopyTop: 1.4,
    leadingEdge: 2.25,
    wingX: 0.9,
    wingY: 0,
  },
  mariner: {
    eye: [7.4, 1.6, 0],
    radius: 1.3,
    canopyTop: 1.825,
    leadingEdge: 3.15,
    wingX: 1.2,
    wingY: 3.2,
  },
  dc3: {
    eye: [7.3, 1.0, 0],
    radius: 1.25,
    canopyTop: 1.2,
    leadingEdge: 2.4,
    wingX: 0.7,
    wingY: 0.45,
  },
  tudor: {
    eye: [9.4, 1.3, 0],
    radius: 1.6,
    canopyTop: 1.525,
    leadingEdge: 2.95,
    wingX: 1,
    wingY: 0.45,
  },
};

/** Seat height above the chase gaze line, per metre of chase. */
const CHASE_LIFT = 0.24;
/** Pilot's look-around limits [rad]. */
const MAX_YAW = (100 * Math.PI) / 180;
const MAX_DIP = (60 * Math.PI) / 180;
/** Fly-by: how far ahead on the circuit, how far below the path, and when it has passed [m]. */
const FLYBY_AHEAD = 400;
const FLYBY_BELOW = 30;
const FLYBY_NEAR = 60;
const FLYBY_PAST = 120;
const FLYBY_MAX = 450;

const Q = new THREE.Quaternion();
const V = new THREE.Vector3();
const W = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Model-space point → world, for an aircraft at `pose` drawn at AIRCRAFT_DRAW_SCALE. */
function toWorld(
  pose: PlanePose,
  q: THREE.Quaternion,
  x: number,
  y: number,
  z: number,
  out: THREE.Vector3,
) {
  return out
    .set(x, y, z)
    .multiplyScalar(AIRCRAFT_DRAW_SCALE)
    .applyQuaternion(q)
    .add(V.set(pose.x, pose.y, pose.z));
}

/**
 * Camera up for a gaze from `pos` to `target`, rolled by `roll` about the gaze (positive turns
 * the starboard side of the picture down, as a right bank does).
 */
export function rolledUp(
  pos: THREE.Vector3,
  target: THREE.Vector3,
  roll: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const f = W.subVectors(target, pos).normalize();
  const right = V.crossVectors(f, WORLD_UP);
  if (right.lengthSq() < 1e-12) right.set(0, 0, 1);
  right.normalize();
  out.crossVectors(right, f);
  if (roll === 0) return out;
  // Rodrigues about f, with out ⟂ f: out cos + (f × out) sin.
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  right.crossVectors(f, out);
  return out.multiplyScalar(c).addScaledVector(right, s);
}

/** Place the fly-by point `FLYBY_AHEAD` metres on along the circuit, below the path. */
function placeFlyby(pose: PlanePose, f: RideFlight, out: THREE.Vector3): void {
  const h = pose.heading;
  const w = f.turnRate;
  if (Math.abs(w) < 1e-7 || f.speed <= 0) {
    out.set(pose.x + Math.cos(h) * FLYBY_AHEAD, pose.y, pose.z + Math.sin(h) * FLYBY_AHEAD);
  } else {
    // On the arc: the turn centre is R to starboard, starboard(h) = (−sin h, 0, cos h).
    const r = f.speed / w;
    const cx = pose.x - Math.sin(h) * r;
    const cz = pose.z + Math.cos(h) * r;
    const h2 = h + FLYBY_AHEAD / r;
    out.set(cx + Math.sin(h2) * r, pose.y, cz - Math.cos(h2) * r);
  }
  out.y -= FLYBY_BELOW;
}

/**
 * Where the eye goes for `view`, riding an aircraft at `pose`. Fills `out` (eye, look-at point,
 * up, roll). `state` carries the fly-by point between frames.
 */
export function rideCameraPose(
  view: RideView,
  pose: PlanePose,
  flight: RideFlight,
  look: RideLook,
  state: RideCameraState,
  out: RideCameraOut,
): void {
  switch (view) {
    case 'chase': {
      // Gaze toward the circuit's centre (the fleet), turned and dipped by the viewer.
      const az = Math.atan2(flight.centre.z - pose.z, flight.centre.x - pose.x) + look.yaw;
      const cd = Math.cos(look.dip);
      const sd = Math.sin(look.dip);
      const gx = cd * Math.cos(az);
      const gy = -sd;
      const gz = cd * Math.sin(az);
      // Screen-up, square to the gaze: the seat is a little above it so the aircraft rides
      // low in the frame and the view past it stays clear.
      const ux = sd * Math.cos(az);
      const uy = cd;
      const uz = sd * Math.sin(az);
      const back = look.chase;
      const lift = back * CHASE_LIFT;
      out.pos.set(
        pose.x - gx * back + ux * lift,
        pose.y - gy * back + uy * lift,
        pose.z - gz * back + uz * lift,
      );
      out.target.set(out.pos.x + gx, out.pos.y + gy, out.pos.z + gz);
      out.roll = 0.5 * pose.bank;
      rolledUp(out.pos, out.target, out.roll, out.up);
      return;
    }
    case 'cockpit': {
      const seat = COCKPIT[flight.kind];
      const q = aircraftQuaternion(pose, Q);
      toWorld(pose, q, seat.eye[0], seat.eye[1], seat.eye[2], out.pos);
      const yaw = THREE.MathUtils.clamp(look.yaw, -MAX_YAW, MAX_YAW);
      const dip = THREE.MathUtils.clamp(look.dip, -MAX_DIP, MAX_DIP);
      const dir = W.set(
        Math.cos(dip) * Math.cos(yaw),
        -Math.sin(dip),
        Math.cos(dip) * Math.sin(yaw),
      );
      out.target.copy(out.pos).addScaledVector(dir.applyQuaternion(q), 10);
      out.up.set(0, 1, 0).applyQuaternion(q);
      out.roll = pose.bank;
      return;
    }
    case 'wing': {
      const seat = COCKPIT[flight.kind];
      const q = aircraftQuaternion(pose, Q);
      const z = 0.8 * (AIRCRAFT[flight.kind].span / 2);
      toWorld(pose, q, seat.wingX - 2, seat.wingY + 1.2, z, out.pos);
      toWorld(pose, q, seat.eye[0], seat.eye[1] - 0.3, 0, out.target);
      out.up.set(0, 1, 0).applyQuaternion(q);
      out.roll = pose.bank;
      return;
    }
    case 'flyby': {
      const at = W.set(pose.x, pose.y, pose.z);
      const d = state.placed ? state.flyby.distanceTo(at) : Infinity;
      if (d < FLYBY_NEAR) state.passing = true;
      if (d > FLYBY_MAX || (state.passing && d > FLYBY_PAST)) {
        placeFlyby(pose, flight, state.flyby);
        state.placed = true;
        state.passing = false;
      }
      out.pos.copy(state.flyby);
      out.target.set(pose.x, pose.y, pose.z);
      out.roll = 0;
      rolledUp(out.pos, out.target, 0, out.up);
      return;
    }
  }
}

/**
 * Ease `current` toward `target` with a half-life of `halfLifeS` seconds: frame-rate
 * independent, so n small steps land where one step of their total would.
 */
export function dampVec(
  current: THREE.Vector3,
  target: THREE.Vector3,
  halfLifeS: number,
  dt: number,
): THREE.Vector3 {
  const k = halfLifeS > 0 ? 1 - Math.pow(2, -Math.max(0, dt) / halfLifeS) : 1;
  return current.lerp(target, k);
}

const GAZE = new THREE.Vector3();
const WANT = new THREE.Vector3();

/**
 * Ease the chase seat: `offset` (the seat relative to the aircraft, carried between frames)
 * moves toward where `out` puts it, and `out` is moved there with its gaze kept. Easing the
 * offset rather than the world position keeps the seat from trailing a 70 m/s aircraft.
 */
export function easeChaseSeat(
  out: RideCameraOut,
  pose: PlanePose,
  offset: THREE.Vector3,
  halfLifeS: number,
  dt: number,
): void {
  GAZE.subVectors(out.target, out.pos);
  WANT.set(out.pos.x - pose.x, out.pos.y - pose.y, out.pos.z - pose.z);
  dampVec(offset, WANT, halfLifeS, dt);
  out.pos.set(pose.x, pose.y, pose.z).add(offset);
  out.target.copy(out.pos).add(GAZE);
}
