import { describe, expect, it, vi } from 'vitest';
import { PRESETS, presetExperiment } from '../schema/presets';
import { Simulation } from './Simulation';
import { createSimVessel } from './vessels';

// Each preset steps real vessels for 2 s (~2 s of CPU); leave headroom on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

describe('every preset runs end to end with real vessels', () => {
  for (const p of PRESETS) {
    it(p.id, () => {
      const sim = new Simulation(presetExperiment(p.id), { createVessel: createSimVessel });
      sim.step(240); // advance() is capped per call by design; step() is exact
      const f = sim.frame();
      expect(f.t).toBeCloseTo(2, 9);
      for (const v of f.vessels) {
        for (const value of [v.position.x, v.position.y, v.position.z, v.rollDeg, v.pitchDeg]) {
          expect(Number.isFinite(value)).toBe(true);
        }
        expect(v.capsized).toBe(false);
        expect(Math.abs(v.heave)).toBeLessThan(10);
      }
      const ocean = sim.gpuData('low');
      expect(ocean.cascades).toHaveLength(4);
      expect(ocean.hs).toBeGreaterThanOrEqual(0);
    });
  }
});

describe('at-anchor preset', () => {
  it('starts with the anchor down and answers drop and weigh commands', () => {
    const sim = new Simulation(presetExperiment('at-anchor'), { createVessel: createSimVessel });
    sim.step(120);
    const m = sim.frame().vessels[0]!.mooring;
    expect(m.deployed).toBe(true);
    expect(m.lineLength).toBeCloseTo(5 * 28, 6);
    expect(sim.command('cargo-1', { anchor: 'weigh' })).toBe(true);
    sim.step(10);
    expect(sim.frame().vessels[0]!.mooring.deployed).toBe(false);
    sim.command('cargo-1', { anchor: 'drop', anchorScope: 7 });
    sim.step(10);
    const again = sim.frame().vessels[0]!.mooring;
    expect(again.deployed).toBe(true);
    expect(again.lineLength).toBeCloseTo(7 * 28, 6);
  });
});
