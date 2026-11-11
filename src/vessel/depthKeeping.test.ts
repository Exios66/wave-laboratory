import { describe, expect, it } from 'vitest';
import { SEAWATER_DENSITY } from '../core/constants';
import { createVesselDefinition } from './definition';
import {
  DepthKeeper,
  planeForce,
  planeLiftSlope,
  PUMP_TIME,
  REF_ACCEL,
  REF_SPEED_HOVER,
  REF_SPEED_MAX,
  room,
  type PlaneForce,
} from './depthKeeping';

const RHO = SEAWATER_DENSITY;
const sub = createVesselDefinition('submarine').submarine!;
const out: PlaneForce = { fz: 0, fx: 0 };

describe('hydroplane forces', () => {
  it('lift follows ½ρA U² C_Lα δ at small angles and always drags', () => {
    const p = sub.sternPlanes;
    const delta = 0.05;
    const f = planeForce(p, delta, 3, 0, RHO, { ...out });
    expect(f.fz).toBeCloseTo(0.5 * RHO * p.area * 9 * planeLiftSlope(p.aspect) * delta, 3);
    expect(f.fx).toBeLessThan(0);
    // Lift is odd in the angle, drag even.
    const g = planeForce(p, -delta, 3, 0, RHO, { ...out });
    expect(g.fz).toBeCloseTo(-f.fz, 6);
    expect(g.fx).toBeCloseTo(f.fx, 6);
  });

  it('a rising plane is pushed back down (heave damping) and stalls past its limit', () => {
    const p = sub.bowPlanes;
    expect(planeForce(p, 0, 3, 0.5, RHO, { ...out }).fz).toBeLessThan(0);
    const a = planeForce(p, 0.5, 3, 0, RHO, { ...out }).fz;
    const b = planeForce(p, 1.0, 3, 0, RHO, { ...out }).fz;
    expect(b).toBeCloseTo(a, 6);
    expect(planeForce(p, 0.2, 0, 0, RHO, { ...out }).fz).toBe(0);
  });
});

describe('DepthKeeper', () => {
  const keeper = (depth: number): DepthKeeper =>
    new DepthKeeper(sub, RHO, 4.1e6, 1.2e9, depth, 2.5e5);
  const at = (depth: number, speed: number) => ({
    depth,
    rise: 0,
    pitch: 0,
    pitchRate: 0,
    speed,
  });

  it('is idle at the commanded depth', () => {
    const k = keeper(12);
    for (let i = 0; i < 100; i++) k.update(at(12, 3), 0.1);
    expect(k.bow).toBe(0);
    expect(k.stern).toBe(0);
  });

  it('drives both planes down when too shallow and up when too deep', () => {
    const shallow = keeper(12);
    shallow.depthCmd = 14;
    for (let i = 0; i < 300; i++) shallow.update(at(12, 3), 0.1);
    // Net heave force down: negative lift on the planes (the pitch loop is quiet).
    expect(shallow.stern).toBeLessThan(0);
    const deep = keeper(12);
    deep.depthCmd = 10;
    for (let i = 0; i < 300; i++) deep.update(at(12, 3), 0.1);
    expect(deep.stern).toBeGreaterThan(0);
  });

  it('pumps ballast for a persistent depth error, even at rest, up to the tank capacity', () => {
    const k = keeper(12);
    k.depthCmd = 13;
    for (let i = 0; i < 600; i++) k.update(at(12, 0), 0.5);
    expect(k.ballastForce).toBeGreaterThan(0); // too shallow: take on water
    expect(k.ballastForce).toBeLessThanOrEqual(2.5e5);
    k.depthCmd = 5;
    for (let i = 0; i < 4000; i++) k.update(at(12, 0), 0.5);
    expect(k.ballastForce).toBeCloseTo(-2.5e5, 3); // saturated, pumped out
  });

  it('has no authority below the minimum speed and respects the plane limit', () => {
    const k = keeper(12);
    k.depthCmd = 30;
    for (let i = 0; i < 300; i++) k.update(at(12, 0.1), 0.1);
    expect(k.bow).toBe(0);
    expect(k.stern).toBe(0);
    for (let i = 0; i < 600; i++) k.update(at(12, 3), 0.1);
    const max = (sub.maxPlaneDeg * Math.PI) / 180;
    expect(Math.abs(k.stern)).toBeLessThanOrEqual(max + 1e-12);
    expect(Math.abs(k.bow)).toBeLessThanOrEqual(max + 1e-12);
  });

  it('moves the planes no faster than the actuator rate', () => {
    const k = keeper(12);
    k.depthCmd = 30;
    k.update(at(12, 3), 1);
    expect(Math.abs(k.stern)).toBeLessThanOrEqual(((sub.planeRateDeg * Math.PI) / 180) * 1 + 1e-12);
  });

  it('follows an order through a rate-limited reference, never a step', () => {
    const k = keeper(12);
    k.depthCmd = 62;
    let maxRate = 0;
    let maxAccel = 0;
    let prev = 0;
    for (let i = 0; i < 2000; i++) {
      k.update(at(12, 3), 0.5);
      maxRate = Math.max(maxRate, Math.abs(k.refRate));
      maxAccel = Math.max(maxAccel, Math.abs(k.refRate - prev) / 0.5);
      prev = k.refRate;
    }
    expect(maxRate).toBeLessThanOrEqual(REF_SPEED_MAX + 1e-9);
    expect(maxAccel).toBeLessThanOrEqual(REF_ACCEL + 1e-9);
    expect(k.depthRef).toBeCloseTo(62, 1); // arrives in the end
    // Hover is slower than with way on.
    const h = keeper(12);
    h.depthCmd = 62;
    for (let i = 0; i < 200; i++) h.update(at(12, 0), 0.5);
    expect(Math.abs(h.refRate)).toBeLessThanOrEqual(REF_SPEED_HOVER + 1e-9);
  });

  it('slews the ballast pump at a finite rate', () => {
    const k = keeper(12);
    k.depthCmd = 40;
    // Stationary boat far from the order: the whole demand lands on the tank.
    let prev = 0;
    let maxSlew = 0;
    for (let i = 0; i < 600; i++) {
      k.update(at(12, 0), 0.5);
      maxSlew = Math.max(maxSlew, Math.abs(k.ballastForce - prev) / 0.5);
      prev = k.ballastForce;
    }
    expect(maxSlew).toBeLessThanOrEqual(2.5e5 / PUMP_TIME + 1e-6);
    expect(maxSlew).toBeGreaterThan(0);
  });

  it('does not wind up the integral while the boat is moving or far from the order', () => {
    const k = keeper(12);
    k.depthCmd = 90;
    // Sinking at 0.3 m/s (a dive in progress) for a long time: no integral, no trim ballast.
    for (let i = 0; i < 400; i++) k.update({ ...at(12 + 0.15 * i, 3), rise: -0.3 }, 0.5);
    k.reset(12);
    expect(k.ballastForce).toBe(0);
    const j = keeper(12);
    j.depthCmd = 12;
    for (let i = 0; i < 400; i++) j.update(at(12, 0), 0.5);
    expect(j.ballastForce).toBe(0); // on the order and steady: nothing to trim
  });

  it('gives the pitch moment priority when the planes saturate', () => {
    // Both planes at their lift limit: the heave share shrinks to zero, the moment is met.
    expect(room(0.9, 1, 1)).toBeCloseTo(0.1, 12);
    expect(room(-0.9, 1, 1)).toBe(1);
    expect(room(1.2, 1, 1)).toBe(0);
    expect(room(0, 0, 1)).toBe(1);
    const k = keeper(12);
    k.depthCmd = 90;
    for (let i = 0; i < 4000; i++) k.update(at(12, 1.0), 0.5);
    expect(k.planeShare).toBeLessThan(1);
    expect(k.ballastForce).not.toBe(0); // the planes' shortfall goes to the tank
  });
});
