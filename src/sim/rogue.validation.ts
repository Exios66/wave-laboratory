/** The rogue-wave preset delivers its crest at the gauge, on time, and the ship meets it. */
import { describe, expect, it, vi } from 'vitest';

declare const process: { stdout: { write(s: string): void } };
import { presetExperiment } from '../schema/presets';
import { Simulation } from './Simulation';
import { createSimVessel } from './vessels';

vi.setConfig({ testTimeout: 600_000 });

describe('rogue wave preset', () => {
  it('a 17 m crest peaks at the focus gauge near t = 75 s and the ship ships green water', () => {
    const sim = new Simulation(presetExperiment('rogue-wave'), { createVessel: createSimVessel });
    let peak = -Infinity;
    let peakT = 0;
    let green = false;
    let slam = false;
    while (sim.time < 85) {
      sim.step(12);
      const eta = sim.probeReadings()[0]!.eta;
      if (eta > peak) {
        peak = eta;
        peakT = sim.time;
      }
      const tel = sim.vessels[0]!.telemetry();
      green ||= tel.greenWater;
      slam ||= tel.slamming;
    }
    process.stdout.write(
      `\n[rogue] gauge peak ${peak.toFixed(2)} m at t = ${peakT.toFixed(1)} s; green water ${green}, slamming ${slam}`,
    );
    expect(peak).toBeGreaterThan(14);
    expect(Math.abs(peakT - 75)).toBeLessThan(4);
    expect(green || slam).toBe(true);
  });
});
