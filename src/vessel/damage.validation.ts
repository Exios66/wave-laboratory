/**
 * Damage validation in waves: ordinary seas do no harm; a small fast craft driven hard into
 * steep head seas is damaged by slamming, and more so than a big ship in the same sea.
 */
import { describe, expect, it, vi } from 'vitest';
import { OceanField } from '../ocean/oceanField';
import { env, regular } from '../test/fixtures';
import { makeVessel, report, run } from './testUtil';

vi.setConfig({ testTimeout: 300_000 });

describe('seaway damage', () => {
  it('a container ship in a moderate regular sea takes no damage', () => {
    const field = new OceanField([regular(2, 9, 90)], env(), { physicsGrid: 8 });
    const v = makeVessel('cargo-ship', { speedKn: 12, autopilot: true }, field);
    run(v, 60);
    const tm = v.telemetry();
    report(`cargo ship 12 kn, H 2 m T 9 s head seas: health ${tm.health.toFixed(4)}`);
    expect(tm.health).toBe(1);
  });

  it('a patrol boat at 20 kn in steep head seas is damaged by slamming', () => {
    const field = new OceanField([regular(4, 6, 90)], env(), { physicsGrid: 8 });
    const boat = makeVessel('patrol-boat', { speedKn: 20, autopilot: true }, field);
    const ship = makeVessel('cargo-ship', { speedKn: 20, autopilot: true }, field);
    const causes = new Set<string>();
    let maxA = 0;
    run(boat, 60, () => {
      const tm = boat.telemetry();
      const c = tm.damageCause;
      if (c) causes.add(c);
      if (tm.slamming) maxA = Math.max(maxA, Math.abs(tm.bowAccel));
    });
    run(ship, 60);
    const hb = boat.telemetry().health;
    const hs = ship.telemetry().health;
    report(
      `H 4 m T 6 s head seas, 60 s at 20 kn: patrol boat health ${hb.toFixed(3)} (${[...causes].join(', ')}; peak slam ${(maxA / 9.80665).toFixed(2)} g), cargo ship ${hs.toFixed(3)}`,
    );
    expect(hb).toBeLessThan(0.99);
    expect(causes.has('slamming')).toBe(true);
    expect(hs).toBeGreaterThan(hb);
  });
});
