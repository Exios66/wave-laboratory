/**
 * Catamaran: one closed mesh for two demihulls and a bridge deck, a multi-interval waterline
 * section, and the multihull character of its stability (very high initial GM, righting arm
 * that peaks at small heel) compared with a monohull of similar size.
 */
import { describe, expect, it } from 'vitest';
import { quatIdentity } from '../core/vec';
import { createVesselDefinition, designWindage } from './definition';
import { lewisAddedMass } from './coefficients';
import { buildHydroModel } from './hydroModel';
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
    // Section amidships against the hull definition: two demihulls, each with the lofted
    // half-breadth (the stations are on the same parameter grid, so agree to ~2 %).
    const s = sectionAt(def.physicsHull, 0, zWl);
    const shp = hull.shape;
    const u = (0 - shp.xAft(hull.draft)) / (shp.xFwd(hull.draft) - shp.xAft(hull.draft));
    expect(s.beam).toBeCloseTo(4 * shp.halfBreadth(u, hull.draft), 1);
    let exact = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      const z = ((i + 0.5) / n) * hull.draft;
      const uz = (0 - shp.xAft(z)) / (shp.xFwd(z) - shp.xAft(z));
      exact += 4 * shp.halfBreadth(uz, z) * (hull.draft / n);
    }
    expect(s.area / exact).toBeGreaterThan(0.97);
    expect(s.area / exact).toBeLessThan(1.03);
    expect(s.draft).toBeCloseTo(hull.draft, 4);
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
  });
});

describe('catamaran windage and hydrodynamic strips', () => {
  it('frontal wind area follows the split section (two demihulls below the bridge deck)', () => {
    const hull = hullDesign('catamaran');
    const w = designWindage(hull);
    const T = hull.draft;
    const half = hull.multihull!.separation / 2;
    const shp = hull.shape;
    // Independent union-of-intervals integration of the frontal silhouette above the waterline.
    let zMax = T;
    for (const b of hull.superstructure) zMax = Math.max(zMax, b.center.z + b.size.z / 2);
    let area = 0;
    const dz = 0.005;
    for (let z = T + dz / 2; z < zMax; z += dz) {
      const iv: [number, number][] = [];
      let hullHw = 0;
      let blockHw = 0;
      for (let i = 0; i <= 400; i++) {
        const u = i / 400;
        if (z > shp.deckHeight(u)) continue;
        const hb = shp.halfBreadth(u, z);
        if (z <= hull.multihull!.tunnelRoof(u)) hullHw = Math.max(hullHw, hb);
        else blockHw = Math.max(blockHw, hb + half);
      }
      if (hullHw > 0) iv.push([half - hullHw, half + hullHw], [-half - hullHw, -half + hullHw]);
      if (blockHw > 0) iv.push([-blockHw, blockHw]);
      for (const b of hull.superstructure) {
        if (Math.abs(z - b.center.z) < b.size.z / 2) {
          iv.push([b.center.y - b.size.y / 2, b.center.y + b.size.y / 2]);
        }
      }
      iv.sort((p, q) => p[0] - q[0]);
      let end = -Infinity;
      for (const [lo, hi] of iv) {
        area += (hi - Math.max(lo, end)) * (hi > end ? dz : 0);
        end = Math.max(end, hi);
      }
    }
    expect(w.frontalArea / area).toBeGreaterThan(0.95);
    expect(w.frontalArea / area).toBeLessThan(1.05);
    // A single-box silhouette over the full beam would be much larger.
    expect(w.frontalArea).toBeLessThan(hull.beam * (zMax - T));
  });

  it('strip heave added mass is the sum of two demihull Lewis sections', () => {
    const rho = 1025;
    const hm = buildHydroModel(def, rho, 9.80665);
    const props = submergedProperties(def.physicsHull, quatToMat3(quatIdentity()), {
      x: 0,
      y: 0,
      z: -hm.waterlineZ,
    });
    const lwl = props.wlMaxX - props.wlMinX;
    const bHull = props.wlMaxY - props.wlMinY - def.multihull!.separation;
    const dx = lwl / hm.stripX.length;
    const J = 1 / (1 + (0.6 * bHull) / lwl);
    let checked = 0;
    for (let i = 0; i < hm.stripX.length; i++) {
      const x = hm.stripX[i]!;
      if (Math.abs(x) > 3) continue;
      const sec = sectionAt(def.physicsHull, x, hm.waterlineZ);
      const one = lewisAddedMass(sec.beam / 2, sec.draft, sec.area / 2, rho).a33;
      expect(hm.stripA33[i]! / (2 * J * one * dx)).toBeCloseTo(1, 6);
      // A single section as wide as both hulls together would give a much larger figure.
      const merged = lewisAddedMass(sec.beam, sec.draft, sec.area, rho).a33;
      expect(hm.stripA33[i]!).toBeLessThan(0.75 * J * merged * dx);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
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
