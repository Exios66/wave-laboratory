import { describe, expect, it } from 'vitest';
import { createVesselDefinition } from './definition';
import { AIR_DENSITY, emptyLoad, reefedSet, sailLoad, WINDAGE_CY, windageLoad } from './windLoads';

describe('windage', () => {
  const def = createVesselDefinition('cargo-ship');
  const L = def.hydrostatics.waterlineLength;

  it('beam wind from port pushes to starboard and heels to starboard', () => {
    // Air flows toward −y (starboard) at 20 m/s.
    const out = windageLoad(def.windage, L, 0, -20, emptyLoad());
    expect(out.fy).toBeCloseTo(-0.5 * AIR_DENSITY * WINDAGE_CY * def.windage.lateralArea * 400, 6);
    expect(out.fx).toBeCloseTo(0, 9);
    // Positive mx = starboard side down (the telemetry roll sign).
    expect(out.mx).toBeGreaterThan(0);
  });

  it('head wind pushes the ship astern', () => {
    const out = windageLoad(def.windage, L, -15, 0, emptyLoad());
    expect(out.fx).toBeLessThan(0);
    expect(Math.abs(out.fy)).toBeLessThan(1e-9);
  });

  it('projected areas are plausible', () => {
    // 115 m container ship with a full deck load: ~1400 m² side, ~340 m² front.
    expect(def.windage.lateralArea).toBeGreaterThan(1000);
    expect(def.windage.lateralArea).toBeLessThan(2000);
    expect(def.windage.frontalArea).toBeGreaterThan(200);
    expect(def.windage.frontalArea).toBeLessThan(500);
    const carrier = createVesselDefinition('aircraft-carrier');
    expect(carrier.windage.lateralArea).toBeGreaterThan(4 * def.windage.lateralArea);
  });
});

describe('square rig', () => {
  const def = createVesselDefinition('pirate-ship');
  const plan = def.sails!;
  /** Body-frame air velocity for true wind speed V from angle β off the bow (+ = port). */
  const air = (v: number, betaDeg: number) => {
    const b = (betaDeg * Math.PI) / 180;
    return { x: -v * Math.cos(b), y: -v * Math.sin(b) };
  };

  it('has a sail plan and no engine', () => {
    expect(plan.area).toBeGreaterThan(400);
    expect(def.propulsion.maxThrust).toBe(0);
    expect(plan.masts).toHaveLength(3);
  });

  it('cannot sail close to the wind, but drives on a reach and a run', () => {
    const drive = (beta: number) => {
      const a = air(10, beta);
      return sailLoad(plan, a.x, a.y, 1, 1, emptyLoad()).fx;
    };
    expect(drive(40)).toBeLessThan(0);
    expect(drive(90)).toBeGreaterThan(0);
    expect(drive(135)).toBeGreaterThan(drive(90) * 0.8);
    expect(drive(180)).toBeGreaterThan(0);
    // Close-hauled limit of a square rigger: drive turns positive between 55° and 75°.
    expect(drive(75)).toBeGreaterThan(0);
  });

  it('is symmetric port/starboard and heels to leeward', () => {
    const p = air(12, 100);
    const s = air(12, -100);
    const lp = sailLoad(plan, p.x, p.y, 1, 1, emptyLoad());
    const ls = sailLoad(plan, s.x, s.y, 1, 1, emptyLoad());
    expect(lp.fx).toBeCloseTo(ls.fx, 6);
    expect(lp.fy).toBeCloseTo(-ls.fy, 6);
    expect(lp.fy).toBeLessThan(0); // wind from port → pushed to starboard
    expect(lp.mx).toBeGreaterThan(0); // starboard down
    expect(lp.braceDeg).toBeGreaterThan(0);
    expect(ls.braceDeg).toBeLessThan(0);
  });

  it('reefs above Beaufort 6 so the force stops growing', () => {
    expect(reefedSet(8)).toBe(1);
    const force = (v: number) => {
      const a = air(v, 120);
      return sailLoad(plan, a.x, a.y, reefedSet(v), 1, emptyLoad()).fx;
    };
    expect(force(30)).toBeCloseTo(force(15), 6);
  });
});
