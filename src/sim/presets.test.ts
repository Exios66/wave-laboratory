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
