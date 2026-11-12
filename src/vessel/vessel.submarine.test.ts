/**
 * Submarine at periscope depth: hydrostatics of a fully submerged hull, depth keeping in calm
 * water and stability in a moderate sea.
 */
import { describe, expect, it, vi } from 'vitest';
import { SEAWATER_DENSITY } from '../core/constants';
import { quatIdentity } from '../core/vec';
import { OceanField } from '../ocean/oceanField';
import { env, regular } from '../test/fixtures';
import { createVesselDefinition, trimSubmarine } from './definition';
import { BOTTOM_CLEARANCE, keelDepthRange, MIN_KEEL_DEPTH } from './depthKeeping';
import { buildHydroModel, stripImmersion } from './hydroModel';
import { Vessel } from './vessel';
import { effectiveGm } from './flooding';
import { quatToMat3, submergedProperties } from './hydrostatics';
import { meshBounds, meshVolume } from './mesh';
import { makeVessel, report, run } from './testUtil';

vi.setConfig({ testTimeout: 300_000 });

const def = createVesselDefinition('submarine');

describe('submarine particulars', () => {
  it('is a ~70 m boat with its keel 15 m down and only the sail above the surface', () => {
    expect(def.length).toBeCloseTo(70, 1);
    expect(def.beam).toBeCloseTo(6.6, 3);
    expect(def.draft).toBeCloseTo(15, 3);
    const b = meshBounds(def.physicsHull);
    // Body frame origin is the CoG; the waterline is at z = draft − kg.
    const waterline = def.draft - def.kg;
    expect(b.max.z).toBeGreaterThan(waterline);
    expect(b.max.z - waterline).toBeLessThan(2);
    // The hull proper (below the sail) stays under water: its crown is ≥ 8 m below the surface.
    expect(waterline - (def.submarine!.axisZ + def.submarine!.hullDiameter / 2)).toBeGreaterThan(8);
  });

  it('is neutrally buoyant: mass equals the displacement of the design waterline', () => {
    const wholeHull = meshVolume(def.physicsHull).volume * SEAWATER_DENSITY;
    expect(def.mass).toBeLessThan(wholeHull);
    expect(def.mass / wholeHull).toBeGreaterThan(0.99);
    expect(def.hydrostatics.volume * SEAWATER_DENSITY).toBeCloseTo(def.mass, 3);
  });

  it('has a small waterplane (the sail) yet a positive GM = BG and GZ = BG sin φ', () => {
    const h = def.hydrostatics;
    expect(h.waterplaneArea).toBeGreaterThan(0);
    expect(h.waterplaneArea).toBeLessThan(10);
    expect(def.gm).toBeGreaterThan(0.2);
    expect(def.gm).toBeLessThan(1.5);
    expect(h.avsDeg).toBe(180);
    const i90 = h.gzHeelDeg.indexOf(90);
    expect(h.gz[i90]).toBeCloseTo(def.gm, 3);
    expect(Number.isFinite(h.blockCoefficient)).toBe(true);
    expect(def.propulsion.maxThrust).toBeGreaterThan(0);
  });
});

describe('fully submerged hydrostatics (no waterplane)', () => {
  const rot = quatToMat3(quatIdentity());
  const deep = submergedProperties(def.physicsHull, rot, { x: 0, y: 0, z: -60 });

  it('returns finite properties with an empty waterline', () => {
    const whole = meshVolume(def.physicsHull);
    expect(deep.volume).toBeCloseTo(whole.volume, 3);
    expect(deep.waterplaneArea).toBeCloseTo(0, 9);
    for (const v of [deep.wlMinX, deep.wlMaxX, deep.wlMinY, deep.wlMaxY]) expect(v).toBe(0);
    expect(deep.wpCentroidX).toBe(0);
    expect(deep.wpIxx).toBe(0);
    expect(deep.wpIyy).toBe(0);
    expect(deep.centroid.z).toBeCloseTo(whole.centroid.z - 60, 3);
  });

  it('effective GM stays finite for a flooded boat with and without a waterplane', () => {
    const p = {
      mass: def.mass,
      rho: SEAWATER_DENSITY,
      draft: def.draft,
      waterplaneArea: 0,
      kb: def.hydrostatics.kb,
      bm: 0,
      kg: def.kg,
    };
    for (const submerged of [false, true]) {
      const g = effectiveGm({ ...p, submerged }, 5e4, 5e4 * 2, 0);
      expect(Number.isFinite(g.gm)).toBe(true);
      expect(g.sinkage).toBe(0);
    }
    // Floodwater weighs her down: the boat's GM drops as KG rises.
    const dry = effectiveGm({ ...p, submerged: true }, 0, 0, 0);
    const wet = effectiveGm({ ...p, submerged: true }, 5e4, 5e4 * 6, 0);
    expect(wet.gm).toBeLessThan(dry.gm);
  });
});

describe('depth keeping', () => {
  it('holds periscope depth in calm water, at speed and at rest', () => {
    for (const kn of [0, 5]) {
      const v = makeVessel('submarine', { speedKn: kn, autopilot: true });
      let worst = 0;
      let worstPitch = 0;
      run(v, 240, () => {
        const tm = v.telemetry();
        worst = Math.max(worst, Math.abs(tm.heave));
        worstPitch = Math.max(worstPitch, Math.abs(tm.pitchDeg));
      });
      const tm = v.telemetry();
      report(
        `submarine ${kn} kn calm 240 s: max |heave| ${worst.toExponential(2)} m, pitch ${worstPitch.toFixed(3)}°`,
      );
      expect(worst).toBeLessThan(0.05);
      expect(worstPitch).toBeLessThan(0.5);
      expect(Math.abs(tm.rollDeg)).toBeLessThan(0.05);
      expect(tm.capsized).toBe(false);
      expect(tm.health).toBe(1);
    }
  });

  // Calm-water depth orders from periscope depth (keel 15 m): the boat must settle on the order
  // without limit-cycling, with bounded overshoot and pitch, whatever the speed.
  const orders: { kn: number; order: number; seconds: number; overshoot: number }[] = [
    { kn: 5, order: 25, seconds: 1100, overshoot: 2 },
    { kn: 10, order: 25, seconds: 900, overshoot: 3 },
    { kn: 5, order: 40, seconds: 1300, overshoot: 3 },
    { kn: 4, order: 40, seconds: 1500, overshoot: 3 },
    // Hover: no plane authority, the ballast pump alone moves her, slowly.
    { kn: 0, order: 25, seconds: 2000, overshoot: 3 },
    { kn: 0, order: 40, seconds: 2800, overshoot: 4 },
    { kn: 5, order: 100, seconds: 1800, overshoot: 6 },
    { kn: 0, order: 100, seconds: 4200, overshoot: 8 },
  ];
  for (const o of orders) {
    it(`settles on a ${o.order} m keel-depth order at ${o.kn} kn`, () => {
      const v = makeVessel('submarine', { speedKn: o.kn, autopilot: true });
      run(v, 20);
      v.command({ depthM: o.order });
      let peak = 0;
      let maxPitch = 0;
      let lastOutside = 0;
      const kg = def.kg;
      const t = run(
        v,
        o.seconds,
        (time) => {
          const keel = v.diagnostics().depth + kg;
          peak = Math.max(peak, keel);
          maxPitch = Math.max(maxPitch, Math.abs(v.telemetry().pitchDeg));
          if (Math.abs(keel - o.order) > 1) lastOutside = time;
        },
        20,
      );
      const d = v.diagnostics();
      report(
        `submarine ${o.kn} kn, 15 → ${o.order} m: final ${(d.depth + kg).toFixed(2)} m, peak ${peak.toFixed(2)} m,`,
        `last outside ±1 m at ${lastOutside.toFixed(0)} s of ${t.toFixed(0)}, max pitch ${maxPitch.toFixed(2)}°,`,
        `ballast ${d.ballastKg.toFixed(0)} kg`,
      );
      expect(Math.abs(d.depth + kg - o.order)).toBeLessThan(0.5);
      expect(lastOutside).toBeLessThan(t - 150); // settled, not still oscillating
      expect(peak - o.order).toBeLessThan(o.overshoot);
      expect(maxPitch).toBeLessThan(5);
      expect(v.telemetry().capsized).toBe(false);
    });
  }

  it('clamps an absurd depth order between the surface and the seabed', () => {
    const v = makeVessel('submarine', { speedKn: 5, autopilot: true });
    v.command({ depthM: 0 });
    // Never shallower than the minimum keel depth (the order is a keel depth, the CoG sits kg above).
    expect(v.diagnostics().depthCmd + def.kg).toBeCloseTo(MIN_KEEL_DEPTH, 6);
    v.command({ depthM: 1e6 });
    expect(v.diagnostics().depthCmd).toBeLessThan(4000);
  });
});

describe('environment limits', () => {
  const place = (depth: number, waterDensity = SEAWATER_DENSITY) =>
    new Vessel(
      'sub',
      def,
      { x: 0, y: 0, headingDeg: 90, speedKn: 0, autopilot: true },
      new OceanField([], env({ depth, waterDensity }), { physicsGrid: 8 }),
    );

  it('rejects placement where the minimum keel depth and the bottom clearance do not fit', () => {
    expect(keelDepthRange(def.draft, 1)).toBeNull();
    expect(() => place(1)).toThrow(RangeError);
    expect(() => place(MIN_KEEL_DEPTH + BOTTOM_CLEARANCE - 0.5)).toThrow(/too shallow/);
    expect(() => place(MIN_KEEL_DEPTH + BOTTOM_CLEARANCE)).not.toThrow();
  });

  it('samples the water down to the deepest keel it can be ordered to', () => {
    const levels = (v: Vessel) =>
      (v as unknown as { water: { levels: Float64Array } }).water.levels;
    const deep = levels(place(300));
    expect(deep[deep.length - 1]!).toBeLessThanOrEqual(-(300 - BOTTOM_CLEARANCE));
    const shallow = levels(place(MIN_KEEL_DEPTH + BOTTOM_CLEARANCE));
    expect(shallow.length).toBeLessThanOrEqual(deep.length);
  });

  it('without an order in shallow water, holds the clamped design depth the Inspector shows', () => {
    const v = place(MIN_KEEL_DEPTH + BOTTOM_CLEARANCE + 2);
    expect(v.diagnostics().depthCmd + def.kg).toBeCloseTo(MIN_KEEL_DEPTH + 2, 6);
  });

  it('clamps depth orders to the seabed clearance in shallow water', () => {
    const v = place(60);
    v.command({ depthM: 500 });
    expect(v.diagnostics().depthCmd + def.kg).toBeCloseTo(60 - BOTTOM_CLEARANCE, 6);
  });

  it('trims to neutral buoyancy for the water density and holds her depth at rest', () => {
    for (const rho of [900, 1100]) {
      const trimmed = trimSubmarine(def, rho);
      expect(trimmed.mass / rho).toBeCloseTo(def.mass / SEAWATER_DENSITY, 6);
      expect(trimmed.draft).toBe(def.draft);
      const v = place(4000, rho);
      expect(v.definition.mass).toBeCloseTo(trimmed.mass, 3);
      let worst = 0;
      run(v, 120, () => (worst = Math.max(worst, Math.abs(v.telemetry().heave))));
      report(`submarine ρ ${rho} at rest 120 s: max |heave| ${worst.toExponential(2)} m`);
      expect(worst).toBeLessThan(0.05);
    }
    // Surface ships are not trimmed.
    const ship = createVesselDefinition('cargo-ship');
    expect(trimSubmarine(ship, 900)).toBe(ship);
  });

  it('accepts only the neutral loading', () => {
    expect(() => createVesselDefinition('submarine', 1, 0.6, 0.4)).toThrow(/loadFactor must be 1/);
    expect(() => createVesselDefinition('submarine', 1, 0.6, 1.25)).toThrow(RangeError);
  });

  it('keeps strip forces while the hull stays under at a shallow order', () => {
    const hy = buildHydroModel(def, SEAWATER_DENSITY, 9.81);
    expect(hy.submerged).toBe(true);
    const axisZ = def.submarine!.axisZ;
    const waterline = def.draft - def.kg;
    // Keel 10 m down (5 m above the design depth): the axis is still several metres under.
    const axisDepth = waterline - 5 - axisZ;
    expect(axisDepth).toBeGreaterThan(3);
    for (let i = 0; i < hy.stripX.length; i++) {
      expect(stripImmersion(hy, axisZ, hy.stripDraft[i]!, axisDepth)).toBe(1);
    }
    // Broaching: the axis at the surface leaves the sections half immersed, above it none.
    const mid = Math.floor(hy.stripX.length / 2);
    expect(stripImmersion(hy, axisZ, hy.stripDraft[mid]!, 0)).toBeCloseTo(0.5, 6);
    expect(stripImmersion(hy, axisZ, hy.stripDraft[mid]!, -10)).toBe(0);
  });
});

describe('moderate sea', () => {
  it('heaves and pitches with the swell but stays upright and near periscope depth', () => {
    const field = new OceanField([regular(2, 8, 90)], env(), { physicsGrid: 8 });
    const v = makeVessel('submarine', { speedKn: 5, autopilot: true, headingDeg: 90 }, field);
    let minH = Infinity;
    let maxH = -Infinity;
    let maxPitch = 0;
    let maxRoll = 0;
    run(v, 180, (t) => {
      const tm = v.telemetry();
      expect(Number.isFinite(tm.heave)).toBe(true);
      if (t > 60) {
        minH = Math.min(minH, tm.heave);
        maxH = Math.max(maxH, tm.heave);
      }
      maxPitch = Math.max(maxPitch, Math.abs(tm.pitchDeg));
      maxRoll = Math.max(maxRoll, Math.abs(tm.rollDeg));
    });
    report(
      `submarine H 2 m T 8 s: heave [${minH.toFixed(2)}, ${maxH.toFixed(2)}] m, pitch ${maxPitch.toFixed(2)}°, roll ${maxRoll.toFixed(2)}°`,
    );
    const tm = v.telemetry();
    // Moves with the swell (not frozen), but never dives out of control or broaches the hull.
    expect(maxH - minH).toBeGreaterThan(0.02);
    expect(minH).toBeGreaterThan(-3);
    expect(maxH).toBeLessThan(2);
    expect(maxPitch).toBeLessThan(8);
    expect(maxRoll).toBeLessThan(10);
    expect(tm.capsized).toBe(false);
    expect(tm.slamming || tm.greenWater).toBe(false);
    expect(tm.health).toBeGreaterThan(0.99);
  });
});

describe('submarine collision extent', () => {
  it('reaches further up and down when pitched', () => {
    const v = makeVessel('submarine', { speedKn: 0 });
    const level = v.hullFootprint();
    v.applyOffset({ pitchDeg: 20 });
    const pitched = v.hullFootprint();
    expect(pitched.zMin).toBeLessThan(level.zMin! - 1);
    expect(pitched.zMax).toBeGreaterThan(level.zMax! + 1);
  });
});
