/**
 * Performance budget of the vessel model (PLAN §9). Kept in its own file so vitest runs it in a
 * fresh worker: JIT state and garbage from the long validation runs would otherwise distort it.
 */
import { expect, it } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import { env, jonswap } from '../test/fixtures';
import { createVesselDefinition } from './definition';
import { Vessel } from './vessel';

declare const process: { stdout: { write(s: string): void } };

it(
  'cargo ship step(1/120) in JONSWAP H_s 3 m costs < 1 ms (fails above 3 ms)',
  { timeout: 120_000 },
  () => {
    const DT = 1 / 120;
    const field = new OceanField([jonswap(3, 9)], env());
    const def = createVesselDefinition('cargo-ship');
    const v = new Vessel(
      'perf',
      def,
      { x: 0, y: 0, headingDeg: 45, speedKn: 12, autopilot: true },
      field,
    );
    // Warm up (JIT, first water patches).
    let t = 0;
    for (let i = 0; i < 600; i++) {
      field.prepare(t);
      v.step(DT, t);
      t += DT;
    }
    const steps = 2400;
    const calls0 = v.diagnostics().waterColumnCalls;
    let spent = 0;
    for (let i = 0; i < steps; i++) {
      field.prepare(t); // shared ocean snapshot cost, excluded from the vessel's budget
      const c0 = performance.now();
      v.step(DT, t);
      spent += performance.now() - c0;
      t += DT;
    }
    const ms = spent / steps;
    const refreshes = steps * DT * (1 / field.snapshotInterval);
    const cols = (v.diagnostics().waterColumnCalls - calls0) / refreshes;
    const tm = v.telemetry();
    process.stdout.write(
      `\n[vessel] cargo ship in JONSWAP Hs 3 m: ${ms.toFixed(3)} ms per step(1/120) ` +
        `(target < 1.0 ms; substeps ${v.substeps}; ${cols.toFixed(0)} water columns per patch; ` +
        `${v.diagnostics().wettedArea.toFixed(0)} m² wetted); roll ${tm.rollDeg.toFixed(2)}°, ` +
        `pitch ${tm.pitchDeg.toFixed(2)}°, heave ${tm.heave.toFixed(2)} m`,
    );
    if (ms > 1) process.stdout.write('\n[vessel] WARNING: above the 1.0 ms soft budget');
    expect(ms).toBeLessThan(3);
    // 280-column patches resolve waves of a few metres on a ship-length hull.
    expect(cols).toBeLessThanOrEqual(320);
    expect(tm.capsized).toBe(false);
  },
);
