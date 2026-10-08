import { describe, expect, it } from 'vitest';
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
        health: 1,
        disabled: false,
        damageCause: null,
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

  it('reports the sea surface under the camera probe, matching the ocean field', () => {
    const sim = new Simulation(exp, { createVessel: (c) => stubVessel(c.id) });
    expect(sim.frame().cameraSurface).toBeUndefined();
    sim.advance(1.5);
    const probe = { x: 37.5, y: -12.25 };
    const f = sim.frame(probe);
    const s = sim.field.surface(probe.x, probe.y, sim.time);
    expect(f.cameraSurface).toEqual({ eta: s.eta, etaT: s.etaT });
    expect(Math.abs(f.cameraSurface!.eta)).toBeGreaterThan(0);
    expect(sim.frame({ x: Number.NaN, y: 0 }).cameraSurface).toBeUndefined();
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
