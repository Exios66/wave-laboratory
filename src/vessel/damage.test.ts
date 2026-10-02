import { describe, expect, it, vi } from 'vitest';
import {
  collisionDamage,
  DamageModel,
  heelDamageRate,
  K_SLAM,
  sizeFactor,
  slamDamage,
  steeringFactor,
  thrustFactor,
  windDamageRate,
  type DamageInputs,
} from './damage';
import { DT, makeVessel, run } from './testUtil';

// Real vessel dynamics: allow for a loaded machine running the validation suite alongside.
vi.setConfig({ testTimeout: 30_000 });

const G = 9.80665;
const quiet: DamageInputs = {
  dt: DT,
  slamming: false,
  bowAccel: 0,
  greenWaterDepth: 0,
  windSpeed: 10,
  heelDeg: 5,
  capsized: false,
};

describe('damage model', () => {
  it('takes no damage in ordinary moderate conditions', () => {
    const m = new DamageModel(120);
    for (let i = 0; i < 120 * 600; i++) {
      // Moderate sea: 0.3 g at the bow with slams, Bf 7 wind, 15° roll, a little water on deck.
      m.step({
        ...quiet,
        bowAccel: 0.3 * G,
        windSpeed: 15,
        heelDeg: 15,
        slamming: i % 600 < 3,
        greenWaterDepth: i % 600 < 60 ? 0.5 : 0,
      });
    }
    expect(m.health).toBe(1);
    expect(m.cause).toBeNull();
  });

  it('a violent slam damages the hull once per slam', () => {
    const m = new DamageModel(100);
    // One slam lasting several steps with a 2 g peak.
    for (const a of [0.7, 1.2, 2, 1.5]) m.step({ ...quiet, slamming: true, bowAccel: a * G });
    const expected = K_SLAM * (2 - 0.5) ** 2;
    expect(1 - m.health).toBeCloseTo(expected, 9);
    expect(m.cause).toBe('slamming');
    // The slam continues at a lower level: no extra damage.
    m.step({ ...quiet, slamming: true, bowAccel: 1.8 * G });
    expect(1 - m.health).toBeCloseTo(expected, 9);
    // A new slam after the bow acceleration has dropped counts again.
    m.step({ ...quiet, bowAccel: 0.2 * G });
    m.step({ ...quiet, slamming: true, bowAccel: 2 * G });
    expect(1 - m.health).toBeCloseTo(2 * expected, 9);
  });

  it('small craft suffer more than big ships', () => {
    expect(sizeFactor(10)).toBeGreaterThan(sizeFactor(100));
    expect(sizeFactor(100)).toBeCloseTo(1, 12);
    expect(slamDamage(2 * G, 15)).toBeGreaterThan(2 * slamDamage(2 * G, 300));
    expect(windDamageRate(40, 15)).toBeGreaterThan(windDamageRate(40, 300));
    expect(heelDamageRate(40, 15)).toBeGreaterThan(heelDamageRate(40, 300));
    // Collision energy is divided by the vessel's own mass.
    expect(collisionDamage(1e6, 1e4)).toBeGreaterThan(1);
    expect(collisionDamage(1e6, 1e8)).toBeLessThan(1e-3);
  });

  it('storm-force wind and heavy heel add damage over time, with a cause', () => {
    expect(windDamageRate(24, 100)).toBe(0);
    expect(heelDamageRate(20, 100)).toBe(0);
    const m = new DamageModel(30);
    for (let i = 0; i < 120 * 60; i++) m.step({ ...quiet, windSpeed: 40 });
    expect(m.health).toBeLessThan(1);
    expect(m.cause).toBe('weather');
    const h = new DamageModel(30);
    for (let i = 0; i < 120 * 10; i++) h.step({ ...quiet, heelDeg: 40 });
    expect(h.health).toBeLessThan(1);
    expect(h.cause).toBe('heel');
  });

  it('the cause clears a few seconds after damage stops', () => {
    const m = new DamageModel(30);
    m.step({ ...quiet, greenWaterDepth: 2 });
    expect(m.cause).toBe('green-water');
    for (let i = 0; i < 120 * 6; i++) m.step(quiet);
    expect(m.cause).toBeNull();
  });

  it('capsizing ends at health 0 (disabled); repair restores it', () => {
    const m = new DamageModel(30);
    m.step({ ...quiet, capsized: true });
    expect(m.health).toBe(0);
    expect(m.disabled).toBe(true);
    expect(m.cause).toBe('capsize');
    m.repair();
    expect(m.health).toBe(1);
    expect(m.disabled).toBe(false);
  });

  it('does nothing when damage is off', () => {
    const m = new DamageModel(30, false);
    m.step({ ...quiet, capsized: true });
    m.step({ ...quiet, slamming: true, bowAccel: 5 * G, windSpeed: 45 });
    m.damage(0.5, 'collision');
    expect(m.health).toBe(1);
  });

  it('health limits thrust and, below 25 %, steering', () => {
    expect(thrustFactor(1)).toBe(1);
    expect(thrustFactor(0.5)).toBeCloseTo(0.6, 12);
    expect(thrustFactor(0)).toBe(0);
    expect(steeringFactor(0.5)).toBe(1);
    expect(steeringFactor(0.1)).toBeLessThan(1);
    expect(steeringFactor(0)).toBe(0);
  });
});

describe('damaged vessel', () => {
  it('a damaged ship cannot make full speed; a disabled one drifts; repair restores it', () => {
    const intact = makeVessel('patrol-boat', { speedKn: 0, autopilot: false });
    const damaged = makeVessel('patrol-boat', { speedKn: 0, autopilot: false });
    const dead = makeVessel('patrol-boat', { speedKn: 0, autopilot: false });
    for (const v of [intact, damaged, dead]) v.command({ throttle: 1, rudderDeg: 10 });
    damaged.applyDamage(0.6, 'collision');
    dead.applyDamage(1, 'collision');
    for (const v of [intact, damaged, dead]) run(v, 20);
    const ti = intact.telemetry();
    const td = damaged.telemetry();
    const tx = dead.telemetry();
    expect(td.health).toBeCloseTo(0.4, 12);
    expect(td.thrust).toBeLessThan(0.7 * ti.thrust);
    expect(td.speedKn).toBeLessThan(ti.speedKn);
    expect(tx.disabled).toBe(true);
    expect(tx.thrust).toBe(0);
    expect(tx.rudderDeg).toBe(0);
    expect(tx.speedKn).toBeLessThan(0.1);
    dead.command({ repair: true });
    run(dead, 5, undefined, 20);
    const tr = dead.telemetry();
    expect(tr.health).toBe(1);
    expect(tr.disabled).toBe(false);
    expect(tr.thrust).toBeGreaterThan(0);
  });

  it('calm water does no damage', () => {
    const v = makeVessel('cargo-ship', { speedKn: 12, autopilot: true });
    run(v, 30);
    const t = v.telemetry();
    expect(t.health).toBe(1);
    expect(t.damageCause).toBeNull();
  });
});
