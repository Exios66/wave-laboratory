import { describe, expect, it } from 'vitest';
import { STANDARD_GRAVITY } from '../core/constants';
import { quatFromEuler, quatIdentity } from '../core/vec';
import { VesselTypeSchema } from '../schema/experiment';
import { createVesselDefinition } from './definition';
import { gzCurve, quatToMat3, sectionAt, solveFloating, submergedProperties } from './hydrostatics';
import { checkWatertight, meshArea, meshVolume } from './mesh';

declare const process: { stdout: { write(s: string): void } };

const TYPES = VesselTypeSchema.options;

describe('hull geometry', () => {
  for (const type of TYPES) {
    it(`${type}: physics and render hulls are watertight and outward oriented`, () => {
      const def = createVesselDefinition(type);
      for (const mesh of [def.physicsHull, def.renderHull]) {
        const report = checkWatertight(mesh);
        expect(report).toMatchObject({
          ok: true,
          boundaryEdges: 0,
          nonManifoldEdges: 0,
          misorientedEdges: 0,
        });
        expect(meshVolume(mesh).volume).toBeGreaterThan(0);
      }
      const tris = def.physicsHull.indices.length / 3;
      expect(tris).toBeGreaterThanOrEqual(800);
      expect(tris).toBeLessThanOrEqual(2500);
      expect(def.renderHull.indices.length / 3).toBeGreaterThanOrEqual(tris);
      expect(def.superstructure.length).toBeGreaterThan(0);
      // The CoG is the body origin: the hull must straddle it and the keel lie at −KG.
      expect(Math.min(...def.physicsHull.positions.filter((_, i) => i % 3 === 2))).toBeCloseTo(
        -def.kg,
        4,
      );
    });
  }

  it('detects holes and inconsistent winding', () => {
    const def = createVesselDefinition('box-barge');
    const holed = {
      positions: def.physicsHull.positions,
      indices: def.physicsHull.indices.slice(3),
    };
    expect(checkWatertight(holed).ok).toBe(false);
    const flipped = {
      positions: def.physicsHull.positions,
      indices: def.physicsHull.indices.slice(),
    };
    [flipped.indices[1], flipped.indices[2]] = [flipped.indices[2]!, flipped.indices[1]!];
    expect(checkWatertight(flipped).misorientedEdges).toBeGreaterThan(0);
  });

  it('scales uniformly with config.scale', () => {
    const a = createVesselDefinition('trawler', 1);
    const b = createVesselDefinition('trawler', 2);
    expect(b.length / a.length).toBeCloseTo(2, 6);
    expect(b.mass / a.mass).toBeCloseTo(8, 4);
    expect(b.gm / a.gm).toBeCloseTo(2, 4);
    expect(b.inertia.x / a.inertia.x).toBeCloseTo(32, 3);
  });

  it('Wigley hull matches its analytic volume (C_B = 4/9) and waterplane', () => {
    const def = createVesselDefinition('wigley');
    const h = def.hydrostatics;
    expect(h.volume / ((4 / 9) * 60 * 6 * 3.75)).toBeCloseTo(1, 2);
    expect(h.waterplaneArea / ((2 / 3) * 60 * 6)).toBeCloseTo(1, 2);
    // KB = 5T/8 for parabolic sections.
    expect(h.kb / ((5 / 8) * 3.75)).toBeCloseTo(1, 2);
  });
});

describe('box barge hydrostatics vs analytic (V9)', () => {
  const L = 40;
  const B = 12;
  const T = 2.5;
  const D = 6;
  const def = createVesselDefinition('box-barge', 1, 0.6);
  const KG = 0.6 * D;
  const rel = (a: number, b: number) => Math.abs(a / b - 1);

  it('volume, draft, KB, BM, GM within 0.5 %', () => {
    const h = def.hydrostatics;
    expect(rel(h.volume, L * B * T)).toBeLessThan(0.005);
    expect(rel(def.draft, T)).toBeLessThan(0.005);
    expect(rel(h.kb, T / 2)).toBeLessThan(0.005);
    expect(rel(h.bm, (B * B) / (12 * T))).toBeLessThan(0.005);
    const gm = T / 2 + (B * B) / (12 * T) - KG;
    expect(rel(def.gm, gm)).toBeLessThan(0.005);
    expect(rel(h.waterplaneArea, L * B)).toBeLessThan(0.005);
    expect(rel(h.bmL, (L * L) / (12 * T))).toBeLessThan(0.005);
    expect(rel(h.wettedArea, L * B + 2 * (L + B) * T)).toBeLessThan(0.005);
    expect(rel(def.mass, 1025 * L * B * T)).toBeLessThan(0.005);
  });

  it('solves the floating position from the displacement alone', () => {
    const f = solveFloating(def.physicsHull, L * B * T * 1.1, 0, { length: L });
    // 10 % more displacement → draft 2.75 m: CoG height above water KG − T.
    expect(f.z).toBeCloseTo(KG - 1.1 * T, 6);
    expect(Math.abs(f.trim)).toBeLessThan(1e-9);
  });

  it('GZ ≈ GM sin φ at small heel and follows the wall-sided formula', () => {
    const gm = def.gm;
    const bm = (B * B) / (12 * T);
    const heels = [1, 2, 5, 10, 20];
    const gz = gzCurve(def.physicsHull, L * B * T, heels, L);
    for (let i = 0; i < heels.length; i++) {
      const phi = (heels[i]! * Math.PI) / 180;
      // Wall-sided formula, exact for a box until the deck edge or bilge emerges (~22°).
      const wallSided = Math.sin(phi) * (gm + 0.5 * bm * Math.tan(phi) ** 2);
      expect(rel(gz[i]!, wallSided)).toBeLessThan(0.005);
      if (heels[i]! <= 2) expect(rel(gz[i]!, gm * Math.sin(phi))).toBeLessThan(0.005);
    }
  });

  it('section properties of the box are exact', () => {
    const zWl = T - KG;
    const s = sectionAt(def.physicsHull, 3.3, zWl);
    expect(s.beam).toBeCloseTo(B, 4);
    expect(s.draft).toBeCloseTo(T, 4);
    expect(s.area).toBeCloseTo(B * T, 3);
  });

  it('heeled submerged volume is conserved by the clipping (closed surface)', () => {
    const rot = quatToMat3(quatFromEuler(0.3, 0.05, 0));
    const p = submergedProperties(def.physicsHull, rot, { x: 0, y: 0, z: 0.4 });
    // Compare with an independent estimate: the clipped volume can never exceed the hull.
    expect(p.volume).toBeGreaterThan(0);
    expect(p.volume).toBeLessThan(meshVolume(def.physicsHull).volume);
    const full = submergedProperties(def.physicsHull, quatToMat3(quatIdentity()), {
      x: 0,
      y: 0,
      z: -100,
    });
    expect(full.volume).toBeCloseTo(meshVolume(def.physicsHull).volume, 6);
    expect(full.wettedArea).toBeCloseTo(meshArea(def.physicsHull), 3);
    expect(full.waterplaneArea).toBeCloseTo(0, 6);
  });

  it('stores a GZ curve with a positive angle of vanishing stability', () => {
    const h = def.hydrostatics;
    expect(h.gz[0]).toBeCloseTo(0, 6);
    expect(h.avsDeg).toBeGreaterThan(40);
    expect(h.avsDeg).toBeLessThan(180);
    expect(STANDARD_GRAVITY).toBeGreaterThan(9);
  });
});

describe('design particulars', () => {
  for (const type of TYPES) {
    it(`${type}: plausible particulars, stable at the default loading`, () => {
      const d = createVesselDefinition(type);
      const h = d.hydrostatics;
      process.stdout.write(
        `\n[vessel] ${type}: LOA ${d.length.toFixed(1)} m, L_wl ${h.waterlineLength.toFixed(1)} m, ` +
          `B ${h.waterlineBeam.toFixed(2)} m, T ${d.draft} m, Δ ${(d.mass / 1000).toFixed(1)} t, ` +
          `C_B ${h.blockCoefficient.toFixed(3)}, KB ${h.kb.toFixed(2)}, BM ${h.bm.toFixed(2)}, ` +
          `KG ${d.kg.toFixed(2)}, GM ${d.gm.toFixed(3)} m, S ${h.wettedArea.toFixed(0)} m², ` +
          `AVS ${h.avsDeg.toFixed(1)}°, V_max ${(d.maxSpeed / 0.514444).toFixed(1)} kn, ` +
          `T_max ${(d.propulsion.maxThrust / 1000).toFixed(1)} kN, ` +
          `${d.physicsHull.indices.length / 3} / ${d.renderHull.indices.length / 3} triangles`,
      );
      expect(h.blockCoefficient).toBeGreaterThan(0.4);
      expect(h.blockCoefficient).toBeLessThanOrEqual(1 + 1e-9);
      expect(d.gm).toBeGreaterThan(0);
      expect(h.avsDeg).toBeGreaterThan(60);
      // Sailing ships have no engine; the sails drive them.
      if (d.sails) expect(d.propulsion.maxThrust).toBe(0);
      else expect(d.propulsion.maxThrust).toBeGreaterThan(0);
      expect(d.maxSpeed).toBeGreaterThan(0);
      // The GZ curve starts with slope GM.
      expect(h.gz[1]! / Math.sin((5 * Math.PI) / 180) / d.gm).toBeGreaterThan(0.9);
      // Reference points lie within (or just behind) the hull.
      for (const p of Object.values(d.points)) {
        expect(Math.abs(p.x)).toBeLessThan(0.6 * d.length + 2);
      }
    });
  }
});
