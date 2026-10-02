/**
 * Test-only scene content for the renderer harness: a real vessel definition driven by a
 * kinematic frame generator (no physics), so rendering tests are fast and deterministic.
 */
import type { Quat } from '../core/vec';
import type { ProbeConfig } from '../schema/experiment';
import type { SimFrame } from '../sim/types';
import { createVesselDefinition } from '../vessel';
import type { VesselDefinition, VesselTelemetry } from '../vessel/api';

/** A real vessel definition (container ship, scaled to roughly `length` metres). */
export function fakeVessel(length = 72): VesselDefinition {
  const base = createVesselDefinition('cargo-ship', 1, 0.6);
  return createVesselDefinition('cargo-ship', length / base.length, 0.6);
}

/** Body→world quaternion from compass heading, pitch (+ bow down) and roll (+ starboard down). */
export function attitude(headingDeg: number, pitchDeg: number, rollDeg: number): Quat {
  const D = Math.PI / 180;
  const yaw = (90 - headingDeg) * D;
  const qz = { w: Math.cos(yaw / 2), x: 0, y: 0, z: Math.sin(yaw / 2) };
  const qy = { w: Math.cos((pitchDeg * D) / 2), x: 0, y: Math.sin((pitchDeg * D) / 2), z: 0 };
  const qx = { w: Math.cos((rollDeg * D) / 2), x: Math.sin((rollDeg * D) / 2), y: 0, z: 0 };
  const mul = (a: Quat, b: Quat): Quat => ({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  });
  return mul(mul(qz, qy), qx);
}

export const TEST_PROBES: ProbeConfig[] = [
  { id: 'probe-a', name: 'Gauge A', kind: 'wave-gauge', x: 38, y: -26 },
  { id: 'probe-b', name: 'Gauge B', kind: 'wave-gauge', x: -46, y: 30 },
];

/** Kinematic frame: the vessel steams at `speed` along `headingDeg` and rolls/pitches gently. */
export function fakeFrame(
  t: number,
  def: VesselDefinition,
  surface: (x: number, y: number, t: number) => number,
  headingDeg = 60,
  speed = 3,
): SimFrame {
  const h = (headingDeg * Math.PI) / 180;
  const x = Math.sin(h) * speed * t;
  const y = Math.cos(h) * speed * t;
  const eta = surface(x, y, t);
  const roll = 4 * Math.sin((2 * Math.PI * t) / 9);
  const pitch = 1.2 * Math.sin((2 * Math.PI * t) / 6.5);
  const v: VesselTelemetry = {
    id: 'ship',
    position: { x, y, z: eta - (def.draft - def.kg) },
    attitude: attitude(headingDeg, pitch, roll),
    velocity: { x: Math.sin(h) * speed, y: Math.cos(h) * speed, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    rollDeg: roll,
    pitchDeg: pitch,
    headingDeg,
    heave: eta,
    speedKn: speed / 0.514444,
    rudderDeg: 0,
    thrust: 0,
    bowAccel: 0,
    bridgeAccel: 0,
    submergence: 1,
    slamming: false,
    greenWater: false,
    capsized: false,
  };
  return {
    t,
    vessels: [v],
    probes: TEST_PROBES.map((p) => ({ id: p.id, eta: surface(p.x, p.y, t) })),
    stepMs: 0,
    lagging: false,
    samples: null,
  };
}
