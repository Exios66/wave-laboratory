import { describe, expect, it } from 'vitest';
import type { ForeAftRig, ForeAftSail } from './api';
import {
  apparentWind,
  autoTrim,
  emptyForeAftLoad,
  foreAftCoefficients,
  foreAftLoad,
  jibShadow,
  sailAero,
  sailForce,
  type ApparentWind,
  type SailItem,
} from './sails';
import { AIR_DENSITY } from './windLoads';

const DEG = Math.PI / 180;
const main: ForeAftSail = {
  kind: 'main',
  area: 30,
  aspect: 3,
  tack: { x: 0, y: 0, z: 1 },
  head: { x: 0, y: 0, z: 10 },
  foot: 5,
};
const rig: ForeAftRig = {
  mast: { x: 0, zFoot: 1, zTop: 10 },
  sails: [main, { ...main, kind: 'jib', area: 20, tack: { x: 4, y: 0, z: 1 } }],
  rigDragArea: 2,
};
const aeros = rig.sails.map((s) => sailAero(s.kind, s.aspect));
const item = (): SailItem => ({ fx: 0, fy: 0, px: 0, py: 0, pz: 0, alpha: 0 });
const wind = (degrees: number, speed = 10): ApparentWind => ({
  beta: degrees * DEG,
  speed,
  x: -speed * Math.cos(degrees * DEG),
  y: -speed * Math.sin(degrees * DEG),
});

describe('apparent wind', () => {
  it('subtracts boat velocity and rotates into a normalized heading frame', () => {
    const out = wind(0);
    expect(apparentWind(4, -8, 1, 2, 0, 5, out)).toBe(out);
    expect(out.x).toBeCloseTo(-10, 12);
    expect(out.y).toBeCloseTo(-3, 12);
    expect(out.speed).toBeCloseTo(Math.sqrt(109), 12);
    expect(out.beta).toBeCloseTo(Math.atan2(3, 10), 12);
  });

  it('clears the wind angle when the boat moves with the air', () => {
    const out = apparentWind(4, -8, 4, -8, 1, 0, wind(90));
    expect(out.speed).toBe(0);
    expect(out.beta).toBe(0);
  });
});

describe('fore-and-aft sail coefficients', () => {
  it.each(['main', 'jib'] as const)(
    '%s luffs, develops cambered lift, and stalls smoothly',
    (kind) => {
      const aero = sailAero(kind, 3);
      for (const alpha of [-0.2, 0])
        expect(foreAftCoefficients(alpha, aero)).toEqual({ cl: 0, cd: aero.cd0 });
      const attached = foreAftCoefficients(10 * DEG, aero);
      expect(attached.cl).toBeCloseTo(aero.slope * (10 * DEG + aero.alpha0), 12);
      expect(attached.cd).toBeCloseTo(aero.cd0 + attached.cl ** 2 / (Math.PI * 3), 12);
      for (const boundary of [0, 5 * DEG, aero.stall, aero.stall + 10 * DEG]) {
        const a = foreAftCoefficients(boundary - 1e-8, aero);
        const b = foreAftCoefficients(boundary + 1e-8, aero);
        expect(a.cl).toBeCloseTo(b.cl, 6);
        expect(a.cd).toBeCloseTo(b.cd, 6);
      }
      const broadside = foreAftCoefficients(Math.PI / 2, aero);
      expect(broadside.cl).toBeCloseTo(0, 12);
      expect(broadside.cd).toBeCloseTo(aero.cd0 + 1.25, 12);
    },
  );

  it('shadows the jib progressively when running', () => {
    expect(jibShadow(90 * DEG)).toBe(1);
    expect(jibShadow(135 * DEG)).toBe(1);
    expect(jibShadow(150 * DEG)).toBeCloseTo(0.6, 12);
    expect(jibShadow(165 * DEG)).toBeCloseTo(0.2, 12);
    expect(jibShadow(180 * DEG)).toBeCloseTo(0.2, 12);
  });
});

describe('sail forces and rig loads', () => {
  it('mirrors force and centre of effort between tacks', () => {
    const a = sailForce(main, aeros[0]!, wind(60), 40 * DEG, 1, item());
    const b = sailForce(main, aeros[0]!, wind(-60), -40 * DEG, 1, item());
    expect(a.fx).toBeGreaterThan(0);
    expect(a.fy).toBeLessThan(0);
    expect(b.fx).toBeCloseTo(a.fx, 10);
    expect(b.fy).toBeCloseTo(-a.fy, 10);
    expect(b.py).toBeCloseTo(-a.py, 12);
    expect(b.px).toBeCloseTo(a.px, 12);
    expect(a.pz).toBe(4);
    expect(a.alpha).toBeCloseTo(20 * DEG, 12);
    expect(b.alpha).toBeCloseTo(a.alpha, 12);
  });

  it('updates the centre of effort and clears old forces when furled or becalmed', () => {
    const out = sailForce(main, aeros[0]!, wind(60), 40 * DEG, 1, item());
    for (const [speed, area] of [
      [0, 1],
      [10, 0],
      [10, -1],
    ]) {
      out.fx = out.fy = 123;
      expect(sailForce(main, aeros[0]!, wind(90, speed), Math.PI / 2, area!, out)).toBe(out);
      expect(out.fx).toBe(0);
      expect(out.fy).toBe(0);
      expect(out.px).toBeCloseTo(0, 12);
      expect(out.py).toBeCloseTo(-5 / 3, 12);
    }
  });

  it('scales sail force with exposed area and the square of wind speed', () => {
    const a = sailForce(main, aeros[0]!, wind(60), 40 * DEG, 1, item());
    const b = sailForce(main, aeros[0]!, wind(60, 20), 40 * DEG, 0.5, item());
    expect(b.fx).toBeCloseTo(2 * a.fx, 9);
    expect(b.fy).toBeCloseTo(2 * a.fy, 9);
  });

  it('applies the running shadow only to the jib', () => {
    const a = sailForce(main, aeros[0]!, wind(170), 90 * DEG, 1, item());
    const b = sailForce({ ...main, kind: 'jib' }, aeros[0]!, wind(170), 90 * DEG, 1, item());
    expect(b.fx).toBeCloseTo(0.2 * a.fx, 9);
    expect(b.fy).toBeCloseTo(0.2 * a.fy, 9);
  });

  it('sums independent sail loads and leaves bare-rig drag when sails are furled', () => {
    const out = emptyForeAftLoad(rig);
    expect(out.items[0]).not.toBe(out.items[1]);
    const w = wind(90);
    expect(foreAftLoad(rig, aeros, w, [70 * DEG, 70 * DEG], 1, 1, out)).toBe(out);
    expect(out.fx).toBeCloseTo(
      out.items.reduce((s, i) => s + i.fx, out.rig.fx),
      9,
    );
    expect(out.fy).toBeCloseTo(
      out.items.reduce((s, i) => s + i.fy, out.rig.fy),
      9,
    );
    foreAftLoad(rig, aeros, w, [0, 0], 0, 1, out);
    for (const i of out.items) expect([i.fx, i.fy]).toEqual([0, 0]);
    expect(out.fx).toBeCloseTo(0, 9);
    expect(out.fy).toBeCloseTo(-0.5 * AIR_DENSITY * 100 * rig.rigDragArea * 0.4, 9);
    expect(out.rig.pz).toBe(5.5);
  });

  it('clamps sail set and suppresses canvas loads for nonpositive heel exposure', () => {
    for (const [set, heel, expected] of [
      [2, 1, 1],
      [-1, 1, 0],
      [1, -1, 0],
      [1, 0, 0],
    ]) {
      const out = foreAftLoad(
        rig,
        aeros,
        wind(60),
        [40 * DEG, 40 * DEG],
        set!,
        heel!,
        emptyForeAftLoad(rig),
      );
      const reference = sailForce(main, aeros[0]!, wind(60), 40 * DEG, expected!, item());
      expect(out.items[0]!.fx).toBeCloseTo(reference.fx, 9);
      expect(out.items[0]!.fy).toBeCloseTo(reference.fy, 9);
    }
  });
});

describe('automatic sheet trim', () => {
  const trim = (w: ApparentWind, limit = Infinity) =>
    autoTrim(rig, aeros, w, 1, 1, -1, limit, new Float64Array(2));

  it('finds positive drive on a reach, mirrors tacks, and cannot drive directly into the wind', () => {
    const port = trim(wind(60));
    const starboard = trim(wind(-60));
    for (let i = 0; i < port.length; i++) {
      expect(port[i]!).toBeGreaterThanOrEqual(3 * DEG);
      expect(port[i]!).toBeLessThanOrEqual(100 * DEG);
      expect(starboard[i]!).toBeCloseTo(-port[i]!, 12);
      // Compare with a plausible manual sheet setting, rather than copying the search grid.
      const best = sailForce(rig.sails[i]!, aeros[i]!, wind(60), port[i]!, 1, item());
      const manual = sailForce(rig.sails[i]!, aeros[i]!, wind(60), 40 * DEG, 1, item());
      expect(best.fx).toBeGreaterThan(0);
      expect(best.fx).toBeGreaterThanOrEqual(manual.fx);
    }
    const headwind = foreAftLoad(rig, aeros, wind(0), trim(wind(0)), 1, 1, emptyForeAftLoad(rig));
    expect(headwind.fx).toBeLessThanOrEqual(0);
  });

  it('eases sheets until the allowed heeling moment is met', () => {
    const w = wind(60, 20);
    const free = trim(w);
    const moment = (sheets: Float64Array) => {
      const load = foreAftLoad(rig, aeros, w, sheets, 1, 1, emptyForeAftLoad(rig));
      return load.items.reduce((sum, i) => sum + Math.abs(i.fy) * (i.pz + 1), 0);
    };
    const limit = moment(free) / 2;
    const eased = trim(w, limit);
    expect(moment(eased)).toBeLessThanOrEqual(limit);
    expect(eased[0]!).toBeGreaterThan(free[0]!);
    expect(eased[1]!).toBeGreaterThan(free[1]!);
  });
});
