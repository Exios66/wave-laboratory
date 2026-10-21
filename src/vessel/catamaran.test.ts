/**
 * Catamaran: one closed mesh for two demihulls and a bridge deck, a multi-interval waterline
 * section, and the multihull character of its stability (very high initial GM, righting arm
 * that peaks at small heel and vanishes early) compared with a monohull of similar size.
 */
import { describe, expect, it } from 'vitest';
import { quatIdentity } from '../core/vec';
import { createVesselDefinition } from './definition';
import { hullDesign, loftDesignHull } from './hulls';
import { quatToMat3, sectionAt, submergedProperties } from './hydrostatics';
import { checkWatertight, meshVolume } from './mesh';
import { makeVessel, report, run } from './testUtil';

const def = createVesselDefinition('catamaran');
const trawler = createVesselDefinition('trawler');

describe('catamaran hull', () => {
  it('is a single watertight, outward-oriented surface at both resolutions', () => {
    const d = hullDesign('catamaran');
    for (const loft of [d.physicsLoft, d.renderLoft]) {
      const { mesh } = loftDesignHull(d, loft);
      const w = checkWatertight(mesh);
      expect(w.ok).toBe(true);
      expect(meshVolume(mesh).volume).toBeGreaterThan(0);
    }
    expect(def.multihull).toEqual({ count: 2, separation: 4.6 });
  });

  it('floats at its design draft with the tunnel clear of the water', () => {
    const rot = quatToMat3(quatIdentity());
    const zWl = def.draft - def.kg;
    const p = submergedProperties(def.physicsHull, rot, { x: 0, y: 0, z: -zWl });
    expect(def.draft).toBeCloseTo(0.85, 9);
    expect(p.volume * 1025).toBeCloseTo(def.mass, 0);
    // Two separate waterplane patches: Awp ≈ 2 · L · b_wl · C_wp and Iyy dominated by the spacing.
    const hull = hullDesign('catamaran');
    expect(p.wlMaxY - p.wlMinY).toBeGreaterThan(hull.multihull!.separation);
    expect(def.gm).toBeGreaterThan(3);
    // Section amidships: two hulls' worth of area and width, not one box spanning both.
    const s = sectionAt(def.physicsHull, 0, zWl);
    const hullBeam = s.beam / 2;
    expect(hullBeam).toBeGreaterThan(0.8);
    expect(hullBeam).toBeLessThan(1.4);
    expect(s.area).toBeLessThan(0.5 * s.beam * s.draft * 2);
    expect(s.area).toBeGreaterThan(0.6 * s.beam * s.draft);
  });

  it('keeps the bridge-deck underside above the waterline at the design draft', () => {
    const hull = hullDesign('catamaran');
    for (let i = 0; i <= 20; i++) {
      expect(hull.multihull!.tunnelRoof(i / 20)).toBeGreaterThan(hull.draft + 0.05);
    }
  });
});

describe('catamaran stability (GZ curve)', () => {
  const h = def.hydrostatics;
  const gzAt = (deg: number): number => h.gz[Math.round(deg / 5)]!;
  const peak = h.gz.reduce((best, g, i) => (g > h.gz[best]! ? i : best), 0);
  const peakDeg = h.gzHeelDeg[peak]!;
  const tPeak = trawler.hydrostatics.gz.reduce((best, g, i, a) => (g > a[best]! ? i : best), 0);

  it('has a very high initial GM relative to its beam and to a monohull', () => {
    report(
      'catamaran GM',
      def.gm.toFixed(2),
      'm (GM/B',
      (def.gm / def.beam).toFixed(2),
      '), trawler GM',
      trawler.gm.toFixed(2),
      'm (GM/B',
      (trawler.gm / trawler.beam).toFixed(2),
      ')',
    );
    expect(def.gm).toBeGreaterThan(5);
    expect(def.gm / def.beam).toBeGreaterThan(1);
    expect(def.gm / def.beam).toBeGreaterThan(2 * (trawler.gm / trawler.beam));
    // The curve starts with slope GM.
    expect(gzAt(5) / Math.sin((5 * Math.PI) / 180) / def.gm).toBeGreaterThan(0.9);
  });

  it('peaks at a small heel angle and loses its righting arm early', () => {
    report(
      'catamaran GZ peak',
      gzAt(peakDeg).toFixed(2),
      'm at',
      peakDeg,
      '°, AVS',
      h.avsDeg.toFixed(1),
      '° (trawler peak at',
      trawler.hydrostatics.gzHeelDeg[tPeak],
      '°, AVS',
      trawler.hydrostatics.avsDeg.toFixed(1),
      '°)',
    );
    expect(peakDeg).toBeLessThanOrEqual(25);
    expect(peakDeg).toBeLessThan(trawler.hydrostatics.gzHeelDeg[tPeak]!);
    expect(gzAt(peakDeg)).toBeGreaterThan(1);
    // Past the peak the arm falls monotonically towards the vanishing angle.
    for (let i = peak + 1; i < h.gz.length && h.gzHeelDeg[i]! < h.avsDeg; i++) {
      expect(h.gz[i]!).toBeLessThan(h.gz[i - 1]! + 1e-6);
    }
    expect(h.avsDeg).toBeGreaterThan(40);
    // Righting arm gone before the craft is on its beam ends (the weather hull is long out).
    expect(h.avsDeg).toBeLessThan(90);
  });
});

describe('catamaran in the time domain', () => {
  it('rolls back upright from 5° quickly (high GM) and settles', () => {
    const v = makeVessel('catamaran');
    v.applyOffset({ rollDeg: 5 });
    let maxRoll = 0;
    run(v, 40, (t) => {
      if (t > 20) maxRoll = Math.max(maxRoll, Math.abs(v.telemetry().rollDeg));
    });
    const tm = v.telemetry();
    report('catamaran roll after 20 s: max', maxRoll.toExponential(2), '°');
    expect(maxRoll).toBeLessThan(0.5);
    expect(tm.capsized).toBe(false);
  });
});
