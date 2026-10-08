import { describe, expect, it, vi } from 'vitest';
import { quatIdentity } from '../core/vec';
import { presetExperiment } from '../schema/presets';
import type { VesselDefinition, VesselTelemetry } from '../vessel/api';
import { Recorder } from './recorder';
import { Simulation, type SimVessel } from './Simulation';

function stubVessel(id: string): SimVessel & { steps: number } {
  const def = { type: 'box-barge', displayName: 'Stub' } as unknown as VesselDefinition;
  return {
    id,
    definition: def,
    steps: 0,
    step() {
      this.steps++;
    },
    command() {},
    telemetry(): VesselTelemetry {
      return {
        id,
        position: { x: 0, y: 0, z: 0 },
        attitude: quatIdentity(),
        velocity: { x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
        rollDeg: 0,
        pitchDeg: 0,
        headingDeg: 0,
        heave: 0,
        speedKn: 0,
        rudderDeg: 0,
        thrust: 0,
        bowAccel: 0,
        bridgeAccel: 0,
        submergence: 1,
        slamming: false,
        greenWater: false,
        capsized: false,
        windSpeed: 0,
        windFromDeg: 0,
        apparentWind: 0,
        apparentWindAngleDeg: 0,
        windForce: 0,
        sailSet: 0,
        braceDeg: 90,
        jibDeg: 0,
        sailAlphaDeg: 0,
        leewayDeg: 0,
        vmgKn: 0,
        health: 1,
        disabled: false,
        damageCause: null,
        flooding: {
          fill: [],
          volume: [],
          breachArea: [],
          totalVolume: 0,
          totalFraction: 0,
          gmIntact: 1,
          gmEffective: 1,
          freeSurfaceLoss: 0,
          pumping: false,
          foundered: false,
        },
        mooring: {
          deployed: false,
          kind: 'anchor',
          available: true,
          chainCapacity: 0,
          lineLength: 0,
          scope: 0,
          tension: 0,
          horizontalTension: 0,
          fairleadAngleDeg: 0,
          suspendedLength: 0,
          groundedLength: 0,
          touchdownDistance: 0,
          holdingLimit: 0,
          loadFraction: 0,
          anchor: { x: 0, y: 0, z: 0 },
          fairlead: { x: 0, y: 0, z: 0 },
          distance: 0,
          dragging: false,
          regime: 'slack',
          profile: [],
        },
      };
    },
  };
}

describe('Simulation', () => {
  const exp = presetExperiment('moderate-sea');

  it('advances in fixed steps and records at a fixed rate', () => {
    const vessels: ReturnType<typeof stubVessel>[] = [];
    const sim = new Simulation(exp, {
      createVessel: (c) => {
        const v = stubVessel(c.id);
        vessels.push(v);
        return v;
      },
    });
    sim.frame(); // flush the t = 0 sample
    const steps = sim.advance(0.5);
    expect(steps).toBe(60);
    expect(vessels[0]!.steps).toBe(60);
    expect(sim.time).toBeCloseTo(0.5, 12);
    const f = sim.frame();
    expect(f.t).toBeCloseTo(0.5, 12);
    expect(f.samples?.rate).toBe(10);
    expect(f.samples?.t0).toBeCloseTo(0.1, 12);
    expect(f.samples?.channels['gauge-1:eta']).toHaveLength(5);
    expect(f.probes[0]!.eta).toBeCloseTo(f.samples!.channels['gauge-1:eta']!.at(-1)!, 9);
    expect(sim.frame().samples).toBeNull();
  });

  it('reports diagnostics with the represented Hs', () => {
    const sim = new Simulation(exp, { createVessel: (c) => stubVessel(c.id) });
    const d = sim.diagnostics();
    expect(d.hs).toBeGreaterThan(2.3);
    expect(d.hs).toBeLessThan(2.6);
    expect(d.systems[0]!.wavelength).toBeGreaterThan(100);
  });
});

describe('Recorder', () => {
  it('back-fills channels that appear mid-block', () => {
    const r = new Recorder(10);
    r.record({ a: 1 });
    r.record({ a: 2, b: 5 });
    const b = r.flush()!;
    expect(b.channels.a).toEqual([1, 2]);
    expect(b.channels.b![0]).toBeNaN();
    expect(b.channels.b![1]).toBe(5);
  });
});

describe('collision damage contact propagation', () => {
  it.each([true, false])(
    'passes the shared world contact only when damage is enabled (%s)',
    (damage) => {
      const exp = presetExperiment();
      exp.damage = damage;
      exp.waves = [];
      exp.probes = [];
      exp.environment.windSpeed = 0;
      exp.vessels = ['a', 'b'].map((id) => ({ ...exp.vessels[0]!, id }));
      const bodies = ['a', 'b'].map((id, i) => ({
        ...stubVessel(id),
        hullFootprint: () => ({
          x: 100,
          y: -50 + 39 * i,
          fx: 0,
          fy: 1,
          halfLength: 20,
          halfBeam: 4,
          mass: 1e6,
          vx: 0,
          vy: i === 0 ? 3 : -3,
        }),
        applyCollision: vi.fn(),
        applyDamage: vi.fn(),
      }));
      const sim = new Simulation(exp, { createVessel: (c) => bodies.find((v) => v.id === c.id)! });
      sim.stepOnce();
      const events = sim.flushCollisions();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ a: 'a', b: 'b', x: 100, y: -30.5 });
      for (const body of bodies) {
        expect(body.applyCollision).toHaveBeenCalledTimes(1);
        if (damage) {
          expect(body.applyDamage).toHaveBeenCalledExactlyOnceWith(
            expect.any(Number),
            'collision',
            expect.objectContaining({ x: 100, y: -30.5 }),
          );
          expect(body.applyDamage.mock.calls[0]![0]).toBeGreaterThan(0);
        } else {
          expect(body.applyDamage).not.toHaveBeenCalled();
        }
      }
      if (damage)
        expect(bodies[0]!.applyDamage.mock.calls[0]![2]).toBe(
          bodies[1]!.applyDamage.mock.calls[0]![2],
        );
    },
  );
});
