/**
 * Submarine at periscope depth: hydrostatics of a fully submerged hull, depth keeping in calm
 * water and stability in a moderate sea.
 */
import { describe, expect, it, vi } from 'vitest';
import { SEAWATER_DENSITY } from '../core/constants';
import { quatIdentity } from '../core/vec';
import { OceanField } from '../ocean/oceanField';
import { env, regular } from '../test/fixtures';
import { createVesselDefinition } from './definition';
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

  it('follows a commanded depth change using the planes, without overshooting far', () => {
    const v = makeVessel('submarine', { speedKn: 6, autopilot: true });
    run(v, 20);
    v.command({ depthM: 20 }); // keel 15 → 20 m
    let maxDepth = 0;
    const t = run(
      v,
      900,
      () => {
        maxDepth = Math.max(maxDepth, -v.telemetry().position.z);
      },
      20,
    );
    const d = v.diagnostics();
    report(
      `submarine dive 5 m: depth ${d.depth.toFixed(2)} m (cmd ${d.depthCmd.toFixed(2)}), peak ${maxDepth.toFixed(2)} m at t = ${t} s`,
    );
    expect(Math.abs(d.depth - d.depthCmd)).toBeLessThan(0.5);
    expect(maxDepth - d.depthCmd).toBeLessThan(1.5);
    expect(Math.abs(v.telemetry().pitchDeg)).toBeLessThan(1);
  });

  it('clamps an absurd depth order between the surface and the seabed', () => {
    const v = makeVessel('submarine', { speedKn: 5, autopilot: true });
    v.command({ depthM: 0 });
    expect(v.diagnostics().depthCmd).toBeGreaterThan(4);
    v.command({ depthM: 1e6 });
    expect(v.diagnostics().depthCmd).toBeLessThan(4000);
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
