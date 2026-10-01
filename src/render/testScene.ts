/**
 * Test-only scene content for the renderer harness: a parametric "fake" ship standing in for the
 * vessel module (developed separately) and a kinematic frame generator.
 */
import type { Quat } from '../core/vec';
import type { ProbeConfig } from '../schema/experiment';
import type { SimFrame } from '../sim/types';
import type { TriangleMesh, VesselDefinition, VesselTelemetry, VisualBox } from '../vessel/api';

/** Parametric monohull: fine bow, fuller stern with a transom, slight flare. */
export function fakeHull(length: number, beam: number, depth: number, kg: number): TriangleMesh {
  const nx = 48;
  const nz = 10;
  const zKeel = -kg;
  const zDeck = depth - kg;
  const halfBreadth = (x: number, z: number): number => {
    const xi = (2 * x) / length; // −1 stern … +1 bow
    const fx = xi >= 0 ? 1 - Math.pow(xi, 2.2) : 1 - Math.pow(-xi / 1.04, 6);
    const zeta = Math.min(1, Math.max(0, (z - zKeel) / depth));
    const fz = Math.pow(zeta, 0.3) * (1 + 0.06 * zeta);
    return Math.max(0, (beam / 2) * fx * Math.min(1.05, fz));
  };
  // Section ring: starboard deck edge → down → keel → up port side → port deck edge.
  const ring: [number, number][] = [];
  for (let k = nz; k >= 0; k--) ring.push([-1, k / nz]);
  for (let k = 1; k <= nz; k++) ring.push([1, k / nz]);
  const per = ring.length;
  const positions: number[] = [];
  for (let i = 0; i <= nx; i++) {
    const x = -length / 2 + (length * i) / nx;
    for (const [side, f] of ring) {
      const z = zKeel + f * depth;
      positions.push(x, side * halfBreadth(x, z), z);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < per; j++) {
      const jn = (j + 1) % per; // the last segment closes the ring across the deck
      const a = i * per + j;
      const b = i * per + jn;
      const c = (i + 1) * per + jn;
      const d = (i + 1) * per + j;
      idx.push(a, b, c, a, c, d);
    }
  }
  // Transom cap (fan around the ring centroid).
  const cIdx = positions.length / 3;
  positions.push(-length / 2, 0, (zKeel + zDeck) / 2);
  for (let j = 0; j < per; j++) idx.push(cIdx, (j + 1) % per, j);
  // Make triangles counter-clockwise from outside (positive signed volume).
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const p = (k: number) =>
      [
        positions[3 * idx[t + k]!]!,
        positions[3 * idx[t + k]! + 1]!,
        positions[3 * idx[t + k]! + 2]!,
      ] as const;
    const [a, b, c] = [p(0), p(1), p(2)];
    vol +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (vol < 0) {
    for (let t = 0; t < idx.length; t += 3) {
      const tmp = idx[t + 1]!;
      idx[t + 1] = idx[t + 2]!;
      idx[t + 2] = tmp;
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(idx) };
}

export function fakeVessel(length = 72): VesselDefinition {
  const beam = length * 0.17;
  const depth = length * 0.09;
  const draft = depth * 0.55;
  const kg = depth * 0.6;
  const deck = depth - kg;
  const hull = fakeHull(length, beam, depth, kg);
  const house = { x: -0.3 * length, len: 0.12 * length, h: 0.11 * length };
  const boxes: VisualBox[] = [
    {
      center: { x: house.x, y: 0, z: deck + house.h / 2 },
      size: { x: house.len, y: beam * 0.72, z: house.h },
      material: 'superstructure',
    },
    {
      center: { x: house.x + house.len / 2 + 0.05, y: 0, z: deck + house.h * 0.8 },
      size: { x: 0.12, y: beam * 0.7, z: house.h * 0.18 },
      material: 'glass',
    },
    {
      center: { x: house.x - 0.02 * length, y: 0, z: deck + house.h + 2.2 },
      size: { x: 0.6, y: 0.6, z: 4.4 },
      material: 'accent',
    },
  ];
  const cargoColors = 4;
  for (let i = 0; i < cargoColors; i++) {
    boxes.push({
      center: { x: -0.08 * length + i * 0.12 * length, y: 0, z: deck + 1.3 },
      size: { x: 0.1 * length, y: beam * 0.62, z: 2.6 },
      material: i % 2 === 0 ? 'cargo' : 'deck',
    });
  }
  return {
    type: 'cargo-ship',
    displayName: 'Test freighter',
    description: 'Parametric stand-in hull for renderer tests',
    length,
    beam,
    depth,
    draft,
    mass: 1025 * length * beam * draft * 0.7,
    inertia: { x: 1, y: 1, z: 1 },
    kg,
    gm: 1,
    physicsHull: hull,
    renderHull: hull,
    superstructure: boxes,
    maxSpeed: 8,
  };
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
  };
}
