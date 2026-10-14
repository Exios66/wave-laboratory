import { describe, expect, it, vi } from 'vitest';
import { VesselTypeSchema } from '../schema/experiment';
import { createVesselDefinition } from './definition';
import {
  buildCompartments,
  compartmentCount,
  DISCHARGE_COEFFICIENT,
  effectiveGm,
  FloodingState,
  planeForVolume,
  volumeBelowPlane,
  type Compartment,
  type FloodLoads,
} from './flooding';
import { meshVolume } from './mesh';
import { analyseDecay, calmSea, DT, makeVessel, report, run } from './testUtil';
import { Vessel } from './vessel';

vi.setConfig({ testTimeout: 120_000 });

const RHO = 1025;
const G = 9.80665;

/** A 10 × 10 m, 6 m high box compartment with its floor at z = −3 (body frame). */
const BOX: Compartment = {
  index: 0,
  xFwd: 5,
  xAft: -5,
  xc: 0,
  halfBeam: 5,
  zFloor: -3,
  zRoof: 3,
  capacity: 600,
  inertia: (10 * 10 ** 3) / 12,
};

const loadsOut = (): FloodLoads => ({ fx: 0, fy: 0, fz: 0, mx: 0, my: 0, mz: 0 });

describe('compartments', () => {
  for (const type of VesselTypeSchema.options) {
    it(`${type}: 4–7 contiguous bays holding about the closed hull volume`, () => {
      const def = createVesselDefinition(type);
      const cs = buildCompartments(def);
      expect(cs.length).toBeGreaterThanOrEqual(4);
      expect(cs.length).toBeLessThanOrEqual(7);
      expect(cs.length).toBe(compartmentCount(def.length));
      for (let i = 1; i < cs.length; i++) expect(cs[i]!.xFwd).toBeCloseTo(cs[i - 1]!.xAft, 9);
      const total = cs.reduce((s, c) => s + c.capacity, 0);
      const hull = meshVolume(def.physicsHull).volume;
      report(
        type,
        `${cs.length} bays, capacity ${total.toFixed(0)} m³ vs hull ${hull.toFixed(0)} m³,`,
        `displacement ${(def.mass / RHO).toFixed(0)} m³`,
      );
      expect(total / hull).toBeGreaterThan(0.85);
      expect(total / hull).toBeLessThan(1.15);
      // Flooding every bay outweighs the ship's whole buoyancy: she can founder.
      expect(RHO * total).toBeGreaterThan(def.mass);
    });
  }

  it('a box barge is divided exactly into boxes', () => {
    const def = createVesselDefinition('box-barge');
    const cs = buildCompartments(def, 5);
    for (const c of cs) {
      expect(c.xFwd - c.xAft).toBeCloseTo(8, 6);
      expect(2 * c.halfBeam).toBeCloseTo(12, 3);
      expect(c.zRoof - c.zFloor).toBeCloseTo(6, 2);
      expect(c.capacity).toBeCloseTo(8 * 12 * 6, 0);
    }
    expect(cs[2]!.xc).toBeCloseTo(0, 6);
  });
});

describe('floodwater geometry', () => {
  it('upright: level plane, volume and weight of a part-filled box', () => {
    const v = 10 * 10 * 2; // 2 m deep
    expect(planeForVolume(BOX, 0, 0, 1, v)).toBeCloseTo(-1, 6);
    expect(volumeBelowPlane(BOX, 0, 0, 1, -1)).toBeCloseTo(v, 6);
    const fs = new FloodingState([BOX], RHO, G);
    fs.fill(0, v);
    const l = fs.loads(0, 0, 1, loadsOut());
    expect(l.fz).toBeCloseTo(-RHO * v * G, 3);
    expect(l.mx).toBeCloseTo(0, 3);
    expect(l.my).toBeCloseTo(0, 3);
  });

  it('heeled: the water shifts to the low side by (i / V) tan φ, the free-surface effect', () => {
    const v = 10 * 10 * 2;
    const fs = new FloodingState([BOX], RHO, G);
    fs.fill(0, v);
    const phi = (5 * Math.PI) / 180;
    // World up in the body frame after a heel φ: n = (0, sin φ, cos φ).
    const l = fs.loads(0, Math.sin(phi), Math.cos(phi), loadsOut());
    // Rigid water (centroid fixed at z = −2 on the centre line) would give mx = −z·fy:
    const w = RHO * v * G;
    const rigidMx = -(-2) * (-w * Math.sin(phi));
    const shift = Math.abs(l.mx - rigidMx);
    const wedge = RHO * G * BOX.inertia * Math.tan(phi);
    report(`free-surface moment ${shift.toFixed(0)} N·m vs ρ g i tan φ ${wedge.toFixed(0)} N·m`);
    expect(shift / wedge).toBeGreaterThan(0.93);
    expect(shift / wedge).toBeLessThan(1.07);
  });

  it('stays finite and conserves weight at every heel up to inverted', () => {
    const fs = new FloodingState([BOX], RHO, G);
    fs.fill(0, 150);
    for (const a of [0, 30, 60, 85, 100, 135, 179]) {
      const r = (a * Math.PI) / 180;
      const l = fs.loads(0, Math.sin(r), Math.cos(r), loadsOut());
      expect(Number.isFinite(l.mx + l.my + l.mz + l.fx + l.fy + l.fz)).toBe(true);
      expect(Math.hypot(l.fx, l.fy, l.fz)).toBeCloseTo(RHO * 150 * G, 3);
    }
  });
});

describe('flooding rate', () => {
  /** Ship upright with the origin at the waterline; the sea stands at `eta`. */
  const inputs = (eta = 0) => ({ nx: 0, ny: 0, nz: 1, originZ: 0, outsideLevel: () => eta });

  for (const dt of [1 / 240, DT, 1 / 30]) {
    it(`inside level → outside: monotone, no overshoot, Torricelli decay (dt = ${dt.toFixed(4)} s)`, () => {
      const fs = new FloodingState([BOX], RHO, G);
      const area = 0.4;
      fs.breach(0, area, 5, -2.5);
      const plan = 100;
      fs.fill(0, plan * 1.5); // inside level ζ = −1.5 m
      const eta = 1;
      const dh0 = eta + 1.5;
      const k = (DISCHARGE_COEFFICIENT * area * Math.sqrt(2 * G)) / plan;
      let prev = fs.volume[0]!;
      let t = 0;
      let maxErr = 0;
      for (let i = 0; i < 400 / dt; i++) {
        fs.step(dt, inputs(eta));
        t += dt;
        const v = fs.volume[0]!;
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = v;
        const zeta = -3 + v / plan;
        expect(zeta).toBeLessThanOrEqual(eta + 1e-9);
        // Analytic head: Δh(t) = (√Δh0 − k t / 2)² until the levels meet.
        const root = Math.sqrt(dh0) - (k * t) / 2;
        if (root > 0.3) maxErr = Math.max(maxErr, Math.abs(eta - zeta - root * root) / dh0);
      }
      expect(maxErr).toBeLessThan(0.02);
      expect(-3 + fs.volume[0]! / plan).toBeCloseTo(eta, 6);
    });
  }

  it('drains outwards when the inside is higher, down to the sea level', () => {
    const fs = new FloodingState([BOX], RHO, G);
    fs.breach(0, 0.3, 5, -2);
    fs.fill(0, 100 * 4); // ζ = +1 m
    let prev = fs.volume[0]!;
    for (let i = 0; i < 120 * 600; i++) {
      fs.step(DT, inputs(0));
      expect(fs.volume[0]!).toBeLessThanOrEqual(prev + 1e-12);
      prev = fs.volume[0]!;
    }
    expect(-3 + prev / 100).toBeCloseTo(0, 6);
  });

  it('a breach above the sea lets nothing in until a wave reaches it', () => {
    const fs = new FloodingState([BOX], RHO, G);
    fs.breach(0, 0.3, 5, 1);
    for (let i = 0; i < 600; i++) fs.step(DT, inputs(0));
    expect(fs.totalVolume).toBe(0);
    for (let i = 0; i < 600; i++) fs.step(DT, inputs(1.5));
    expect(fs.totalVolume).toBeGreaterThan(0);
  });

  it('pumps plug the holes and empty the ship, then stop', () => {
    const fs = new FloodingState([BOX], RHO, G);
    fs.breach(0, 0.3, 5, -2);
    fs.fill(0, 300);
    fs.pumping = true;
    for (let i = 0; i < 120 * 300; i++) fs.step(DT, inputs(0));
    expect(fs.totalVolume).toBe(0);
    expect(fs.pumping).toBe(false);
    expect(fs.breached).toBe(false);
  });
});

describe('flooded box barge', () => {
  // 40 × 12 × 6 m barge, T = 2.5 m, five 8 m bays; the middle bay is centred on the CoG.
  const barge = (): Vessel =>
    new Vessel(
      'b',
      createVesselDefinition('box-barge', 1, 0.6),
      { x: 0, y: 0, headingDeg: 90, speedKn: 0, autopilot: false },
      calmSea,
      { compartments: 5 },
    );

  it('sinks by added mass / (ρ A_wp) and loses GM by ρ i / Δ plus the KB, BM, KG shifts', () => {
    const v = barge();
    const def = v.definition;
    const depth = 1; // 1 m of water in the middle bay
    const volume = 8 * 12 * depth;
    v.flooding.fill(2, volume);
    run(v, 90);
    const t = v.telemetry();
    const awp = def.hydrostatics.waterplaneArea;
    const sinkage = (RHO * volume) / (RHO * awp);
    report(
      `barge: sinkage expected ${sinkage.toFixed(4)} m, measured ${(-t.heave).toFixed(4)} m;`,
      `roll ${t.rollDeg.toFixed(3)}° pitch ${t.pitchDeg.toFixed(3)}°`,
    );
    expect(-t.heave / sinkage).toBeGreaterThan(0.98);
    expect(-t.heave / sinkage).toBeLessThan(1.02);
    expect(Math.abs(t.rollDeg)).toBeLessThan(0.01);
    expect(Math.abs(t.pitchDeg)).toBeLessThan(0.01);

    // GM by hand for the box: KB = T'/2, BM = B²/(12 T'), KG' by moments, FSC = ρ i / Δ'
    // with i = l b³ / 12.
    const m = RHO * volume;
    const delta = def.mass + m;
    const T = def.draft + sinkage;
    const kg = (def.mass * def.kg + m * (depth / 2)) / delta;
    const fsc = (RHO * ((8 * 12 ** 3) / 12)) / delta;
    const gm = T / 2 + 12 ** 2 / (12 * T) - kg - fsc;
    expect(t.flooding.freeSurfaceLoss).toBeCloseTo(fsc, 4);
    expect(t.flooding.gmEffective).toBeCloseTo(gm, 2);
    expect(t.flooding.gmIntact - t.flooding.gmEffective).toBeGreaterThan(fsc);
    expect(t.flooding.fill[2]).toBeCloseTo(volume / (8 * 12 * 6), 3);
    expect(t.flooding.totalFraction).toBeCloseTo(volume / (5 * 8 * 12 * 6), 4);
    report(
      `barge GM: intact ${def.gm.toFixed(3)} m, flooded ${gm.toFixed(3)} m (FSC ${fsc.toFixed(3)} m)`,
    );
  });

  it("the free surface lowers the roll stiffness: the roll period follows Δ' g GM_eff", () => {
    const v = barge();
    const h = v.hydro;
    v.flooding.fill(2, 8 * 12 * 1.5);
    run(v, 60);
    const gm = v.telemetry().flooding.gmEffective;
    const delta = v.definition.mass + v.flooding.totalMass;
    // The floodwater adds weight but no inertia in this model.
    const inertia = h.ixx + h.addedMass[21]!;
    const expected = 2 * Math.PI * Math.sqrt(inertia / (delta * h.g * gm));
    v.applyOffset({ rollDeg: 3 });
    const ts: number[] = [];
    const xs: number[] = [];
    run(
      v,
      6 * expected,
      (t) => {
        ts.push(t);
        xs.push(v.telemetry().rollDeg);
      },
      60,
    );
    const d = analyseDecay(ts, xs, 3);
    const err = d.naturalPeriod / expected - 1;
    report(
      `flooded barge roll: expected ${expected.toFixed(3)} s (GM_eff ${gm.toFixed(3)} m), measured`,
      `${d.naturalPeriod.toFixed(3)} s (${(100 * err).toFixed(1)} %)`,
    );
    expect(Math.abs(err)).toBeLessThan(0.06);
    // Without the free surface the period would be much shorter.
    const noFs =
      2 *
      Math.PI *
      Math.sqrt(inertia / (delta * h.g * (gm + v.telemetry().flooding.freeSurfaceLoss)));
    expect(d.naturalPeriod).toBeGreaterThan(1.1 * noFs);
  });

  it('an end bay trims the ship by the bow', () => {
    const v = barge();
    v.flooding.fill(0, 8 * 12 * 2);
    run(v, 90);
    const t = v.telemetry();
    report(`bow bay flooded: pitch ${t.pitchDeg.toFixed(2)}°, heave ${t.heave.toFixed(3)} m`);
    expect(t.pitchDeg).toBeGreaterThan(0.5); // bow down is positive
    expect(Math.abs(t.rollDeg)).toBeLessThan(0.05);
  });

  it('a breach floods monotonically, bounded; pumping restores the ship', () => {
    const v = barge();
    v.command({ flood: { compartment: 2 } });
    let prev = 0;
    run(v, 120, () => {
      const total = v.flooding.totalVolume;
      // The level inside follows the sea; the hull's own heave moves it by millimetres.
      expect(total).toBeGreaterThanOrEqual(prev - 0.05);
      prev = Math.max(prev, total);
    });
    const t = v.telemetry();
    report(`barge middle bay holed: filled ${(100 * t.flooding.fill[2]!).toFixed(0)} %`);
    expect(t.flooding.fill[2]!).toBeGreaterThan(0.1);
    expect(Number.isFinite(t.heave)).toBe(true);
    v.command({ pump: true });
    run(v, 400, undefined, 120);
    expect(v.flooding.totalVolume).toBe(0);
    expect(Math.abs(v.telemetry().heave)).toBeLessThan(0.01);
  });
});

describe('effective GM formula', () => {
  it('reduces to the intact GM with no water', () => {
    const def = createVesselDefinition('cargo-ship');
    const h = def.hydrostatics;
    const e = effectiveGm(
      {
        mass: def.mass,
        rho: RHO,
        draft: def.draft,
        waterplaneArea: h.waterplaneArea,
        kb: h.kb,
        bm: h.bm,
        kg: def.kg,
      },
      0,
      0,
      0,
    );
    expect(e.gm).toBeCloseTo(def.gm, 6);
    expect(e.freeSurface).toBe(0);
  });
});

describe('foundering', () => {
  it('a ship flooded beyond its reserve buoyancy founders (health 0) and settles bounded', () => {
    const v = makeVessel('patrol-boat');
    for (let i = 0; i < v.flooding.compartments.length; i++)
      v.flooding.fill(i, v.flooding.compartments[i]!.capacity);
    let minZ = Infinity;
    let maxSpeed = 0;
    run(v, 240, () => {
      const k = v.kinematics;
      minZ = Math.min(minZ, k.position.z);
      maxSpeed = Math.max(maxSpeed, Math.abs(k.velocity.z));
      expect(Number.isFinite(k.position.z)).toBe(true);
    });
    const t = v.telemetry();
    report(
      `patrol boat flooded: foundered ${t.flooding.foundered}, health ${t.health},`,
      `lowest z ${minZ.toFixed(1)} m, max sink rate ${maxSpeed.toFixed(1)} m/s`,
    );
    expect(t.flooding.foundered).toBe(true);
    expect(t.health).toBe(0);
    expect(t.damageCause === 'flooding' || t.disabled).toBe(true);
    expect(maxSpeed).toBeLessThan(30);

    v.command({ pump: true });
    run(v, 1, undefined, 240);
    expect(v.flooding.hasWater).toBe(true);
    expect(v.telemetry().flooding.foundered).toBe(true);
    run(v, 240, undefined, 241);
    expect(v.flooding.hasWater).toBe(false);
    expect(v.telemetry().flooding.foundered).toBe(false);
  });
});

describe('breach triggers', () => {
  it('a hard collision holes the compartment nearest the impact, on the side hit', () => {
    const v = makeVessel('cargo-ship');
    const fp = v.hullFootprint();
    const length = 2 * fp.halfLength;
    // Starboard bow: 30 % of the length forward of amidships, at the starboard side.
    const sx = fp.fy; // starboard = forward rotated by −90°
    const sy = -fp.fx;
    const at = {
      x: fp.x + 0.3 * length * fp.fx + fp.halfBeam * sx,
      y: fp.y + 0.3 * length * fp.fy + fp.halfBeam * sy,
    };
    v.applyDamage(0.3, 'collision', at);
    const fl = v.flooding;
    const hit = fl.breachArea.findIndex((a) => a > 0);
    expect(hit).toBeGreaterThanOrEqual(0);
    expect(fl.breachArea.filter((a) => a > 0).length).toBe(1);
    expect(fl.compartments[hit]!.xc).toBeGreaterThan(0);
    expect(fl.breachY[hit]!).toBeLessThan(0); // body +y is port, so starboard is −y
    const d = v.definition;
    expect(fl.breachArea[hit]!).toBeCloseTo(0.1 * d.beam * d.depth * 0.3, 6);
    run(v, 30);
    expect(v.flooding.volume[hit]!).toBeGreaterThan(0);
    // The bay spans the beam, so it floods level: the bow goes down, no list.
    expect(v.telemetry().pitchDeg).toBeGreaterThan(0);
    expect(Math.abs(v.telemetry().rollDeg)).toBeLessThan(0.1);
  });

  it('a glancing blow, damage off, no contact point or another cause opens no breach', () => {
    const at = { x: 0, y: 0 };
    const light = makeVessel('cargo-ship');
    light.applyDamage(0.01, 'collision', at);
    expect(light.flooding.breached).toBe(false);
    const noPoint = makeVessel('cargo-ship');
    noPoint.applyDamage(0.5, 'collision');
    expect(noPoint.flooding.breached).toBe(false);
    const off = new Vessel(
      'x',
      createVesselDefinition('cargo-ship'),
      { x: 0, y: 0, headingDeg: 90, speedKn: 0, autopilot: false },
      calmSea,
      { damage: false },
    );
    off.applyDamage(0.5, 'collision', at);
    expect(off.flooding.breached).toBe(false);
    const heel = makeVessel('cargo-ship');
    heel.applyDamage(0.5, 'heel', at);
    expect(heel.flooding.breached).toBe(false);
  });

  it('repair plugs the holes and pumps out', () => {
    const v = makeVessel('patrol-boat');
    v.command({ flood: { compartment: 1 } });
    run(v, 30);
    expect(v.flooding.totalVolume).toBeGreaterThan(0);
    v.command({ repair: true });
    expect(v.flooding.breached).toBe(false);
    expect(v.flooding.pumping).toBe(true);
    run(v, 300, undefined, 30);
    expect(v.flooding.totalVolume).toBe(0);
  });
});
