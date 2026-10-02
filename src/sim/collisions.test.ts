import { describe, expect, it, vi } from 'vitest';
import { ExperimentSchema, SCHEMA_VERSION, type VesselConfig } from '../schema/experiment';
import { env } from '../test/fixtures';
import type { HullFootprint } from '../vessel/api';
import { footprintContact, resolveContact } from './collisions';
import { Simulation } from './Simulation';
import { createSimVessel } from './vessels';

// Real vessel dynamics: allow for a loaded machine running the validation suite alongside.
vi.setConfig({ testTimeout: 30_000 });

const hull = (o: Partial<HullFootprint>): HullFootprint => ({
  x: 0,
  y: 0,
  fx: 0,
  fy: 1,
  halfLength: 20,
  halfBeam: 4,
  mass: 1e6,
  vx: 0,
  vy: 0,
  ...o,
});

describe('hull footprint contact', () => {
  it('finds no contact between separate hulls, even when the bounding circles overlap', () => {
    expect(footprintContact(hull({}), hull({ y: 50 }))).toBeNull();
    // Side by side, 9 m apart (beams 8 m): circles overlap, rectangles do not.
    expect(footprintContact(hull({}), hull({ x: 9 }))).toBeNull();
  });

  it('gives the normal from a to b and the penetration depth', () => {
    const c = footprintContact(hull({}), hull({ y: 39 }))!;
    expect(c).not.toBeNull();
    expect(c.nx).toBeCloseTo(0, 12);
    expect(c.ny).toBeCloseTo(1, 12);
    expect(c.depth).toBeCloseTo(1, 9);
    expect(c.y).toBeGreaterThan(18);
    expect(c.y).toBeLessThan(21);
    // A rotated hull (heading east) hit amidships.
    const t = footprintContact(hull({ fx: 1, fy: 0 }), hull({ x: 0, y: 23 }))!;
    expect(t.ny).toBeCloseTo(1, 12);
    expect(t.depth).toBeCloseTo(1, 9);
  });

  it('conserves momentum, dissipates energy and separates the hulls', () => {
    const a = hull({ mass: 2e6, vy: 3 });
    const b = hull({ y: 39, mass: 5e5, vy: -2 });
    const c = footprintContact(a, b)!;
    const r = resolveContact(a, b, c);
    const pBefore = a.mass * a.vy + b.mass * b.vy;
    const vaY = a.vy - r.jy / a.mass;
    const vbY = b.vy + r.jy / b.mass;
    expect(a.mass * vaY + b.mass * vbY).toBeCloseTo(pBefore, 6);
    expect(vbY - vaY).toBeGreaterThan(0); // separating afterwards
    expect(r.energy).toBeGreaterThan(0);
    expect(r.closingSpeed).toBeCloseTo(5, 12);
    // The light hull moves further.
    expect(r.pushB.y).toBeGreaterThan(Math.abs(r.pushA.y));
    expect(r.pushB.y - r.pushA.y).toBeCloseTo(c.depth, 9);
  });

  it('separating hulls get no impulse', () => {
    const a = hull({ vy: -1 });
    const b = hull({ y: 39, vy: 1 });
    const r = resolveContact(a, b, footprintContact(a, b)!);
    expect(r.jx).toBe(0);
    expect(r.jy).toBe(0);
    expect(r.energy).toBeCloseTo(0, 6);
  });
});

function vessel(id: string, type: VesselConfig['type'], o: Partial<VesselConfig>): VesselConfig {
  return {
    id,
    name: id,
    type,
    scale: 1,
    x: 0,
    y: 0,
    headingDeg: 0,
    speedKn: 0,
    autopilot: true,
    kgFactor: 0.6,
    loadFactor: 1,
    ...o,
  };
}

function calmSim(vessels: VesselConfig[], damage = true): Simulation {
  const exp = ExperimentSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    name: 'Collision test',
    environment: env({ windSpeed: 0 }),
    waves: [],
    vessels,
    probes: [],
    damage,
  });
  return new Simulation(exp, { createVessel: createSimVessel });
}

describe('vessel collisions in the simulation', () => {
  it('head-on vessels bounce apart instead of passing through, conserving momentum', () => {
    const sim = calmSim([
      vessel('a', 'patrol-boat', { y: -40, headingDeg: 0, speedKn: 12 }),
      vessel('b', 'patrol-boat', { y: 40, headingDeg: 180, speedKn: 12 }),
    ]);
    const [a, b] = sim.vessels;
    const mass = a!.definition.mass;
    let collided = false;
    let momentumError = 0;
    for (let i = 0; i < 120 * 10; i++) {
      const pa = a!.telemetry().velocity.y;
      const pb = b!.telemetry().velocity.y;
      sim.stepOnce();
      const events = sim.flushCollisions();
      if (events.length > 0 && !collided) {
        collided = true;
        const before = mass * (pa + pb);
        const after = mass * (a!.telemetry().velocity.y + b!.telemetry().velocity.y);
        // Momentum exchanged by the impulse; the closing speed was ~12 m/s, so compare with
        // the momentum each vessel carried.
        momentumError = Math.abs(after - before) / (mass * Math.abs(pa));
        expect(events[0]!.a).toBe('a');
        expect(events[0]!.b).toBe('b');
        expect(events[0]!.severity).toBeGreaterThan(0.1);
        expect(Math.abs(events[0]!.y)).toBeLessThan(5);
      }
      // Never pass through each other.
      expect(a!.telemetry().position.y).toBeLessThan(b!.telemetry().position.y);
    }
    expect(collided).toBe(true);
    expect(momentumError).toBeLessThan(0.05);
    const ha = a!.telemetry().health;
    const hb = b!.telemetry().health;
    expect(ha).toBeLessThan(0.9);
    expect(Math.abs(ha - hb)).toBeLessThan(0.05); // identical vessels, symmetric impact
    expect(a!.telemetry().damageCause === 'collision' || a!.telemetry().disabled).toBe(true);
  });

  it('damage is asymmetric by mass: a carrier wrecks a lifeboat and is barely scratched', () => {
    const sim = calmSim([
      vessel('cvn', 'aircraft-carrier', { y: -200, headingDeg: 0, speedKn: 15 }),
      vessel('boat', 'lifeboat', { y: 0, headingDeg: 90, speedKn: 0, autopilot: false }),
    ]);
    let events = 0;
    for (let i = 0; i < 120 * 30; i++) {
      sim.stepOnce();
      events += sim.flushCollisions().length;
    }
    const [cvn, boat] = sim.frame().vessels;
    expect(events).toBeGreaterThan(0);
    expect(boat!.health).toBeLessThan(0.2);
    expect(cvn!.health).toBeGreaterThan(0.999);
  });

  it('with damage off, hulls still separate but keep full health', () => {
    const sim = calmSim(
      [
        vessel('a', 'patrol-boat', { y: -40, headingDeg: 0, speedKn: 12 }),
        vessel('b', 'patrol-boat', { y: 40, headingDeg: 180, speedKn: 12 }),
      ],
      false,
    );
    let events = 0;
    for (let i = 0; i < 120 * 6; i++) {
      sim.stepOnce();
      events += sim.frame().collisions.length;
      const [a, b] = sim.vessels.map((v) => v.telemetry());
      expect(a!.position.y).toBeLessThan(b!.position.y);
    }
    expect(events).toBeGreaterThan(0);
    for (const v of sim.frame().vessels) expect(v.health).toBe(1);
  });
});
