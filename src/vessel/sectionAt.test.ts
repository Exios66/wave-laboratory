/**
 * `sectionAt` on analytic closed meshes: single and multi-interval sections (area, waterline
 * width, draft) at several waterline levels, independent of the mesh orientation.
 */
import { describe, expect, it } from 'vitest';
import type { TriangleMesh } from './api';
import { flipOrientation } from './mesh';
import { sectionAt } from './hydrostatics';

/** Closed, outward-oriented axis-aligned box. */
function boxParts(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): { p: number[]; i: number[] } {
  const p: number[] = [];
  for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) p.push(x, y, z);
  // Vertex index = ix + 2·iy + 4·iz.
  const quad = (a: number, b: number, c: number, d: number): number[] => [a, b, c, a, c, d];
  const i = [
    ...quad(0, 2, 3, 1), // bottom (−z)
    ...quad(4, 5, 7, 6), // top (+z)
    ...quad(0, 1, 5, 4), // −y
    ...quad(2, 6, 7, 3), // +y
    ...quad(0, 4, 6, 2), // −x
    ...quad(1, 3, 7, 5), // +x
  ];
  return { p, i };
}

function merge(...boxes: ReturnType<typeof boxParts>[]): TriangleMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const b of boxes) {
    const base = pos.length / 3;
    pos.push(...b.p);
    idx.push(...b.i.map((k) => k + base));
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

describe('sectionAt on analytic meshes', () => {
  // Two 2 m long, 1 m wide, 1 m tall boxes at y ∈ [1, 2] and y ∈ [−2, −1].
  const twin = (): TriangleMesh =>
    merge(boxParts(-1, 1, 1, 2, 0, 1), boxParts(-1, 1, -2, -1, 0, 1));

  for (const flip of [false, true]) {
    const label = flip ? 'reversed' : 'outward';
    it(`two separate boxes (${label} orientation): area and waterline width add up`, () => {
      const mesh = twin();
      if (flip) flipOrientation(mesh);
      const half = sectionAt(mesh, 0.3, 0.5);
      expect(half.area).toBeCloseTo(2 * 0.5, 5);
      expect(half.beam).toBeCloseTo(2, 4);
      expect(half.draft).toBeCloseTo(0.5, 5);
      const low = sectionAt(mesh, -0.4, 0.2);
      expect(low.area).toBeCloseTo(2 * 0.2, 5);
      expect(low.beam).toBeCloseTo(2, 4);
      expect(low.draft).toBeCloseTo(0.2, 5);
      // Exactly at the top: full area, and a waterline that no longer cuts the hulls.
      const full = sectionAt(mesh, 0, 1);
      expect(full.area).toBeCloseTo(2, 5);
      expect(full.draft).toBeCloseTo(1, 5);
      // Fully submerged: full area, no waterline crossing.
      const deep = sectionAt(mesh, 0, 3);
      expect(deep.area).toBeCloseTo(2, 5);
      expect(deep.beam).toBe(0);
      expect(deep.draft).toBeCloseTo(3, 5);
      // Dry: nothing.
      const dry = sectionAt(mesh, 0, -0.5);
      expect(dry).toEqual({ beam: 0, draft: 0, area: 0 });
    });
  }

  it('a section outside the mesh is empty', () => {
    const s = sectionAt(twin(), 5, 0.5);
    expect(s).toEqual({ beam: 0, draft: 0, area: 0 });
  });

  it('a single box off the centre line (monohull closed form)', () => {
    const mesh = merge(boxParts(-3, 3, 0.5, 4.5, 0, 2));
    for (const [zWl, area, beam] of [
      [0.5, 4 * 0.5, 4],
      [1.25, 4 * 1.25, 4],
      [2, 8, 4],
      [3, 8, 0],
      [-1, 0, 0],
    ] as const) {
      const s = sectionAt(mesh, 0.1, zWl);
      expect(s.area).toBeCloseTo(area, 5);
      expect(s.beam).toBeCloseTo(beam, 4);
    }
  });

  it('a tapered prism (trapezoid section) matches the closed form', () => {
    // Section: bottom width 2 at z = 0, top width 4 at z = 2 (half-width 1 + z/2).
    const p = [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0, -1, -2, 2, 1, -2, 2, -1, 2, 2, 1, 2, 2];
    // Same vertex layout as the box (ix + 2 iy + 4 iz), with y widened on the top.
    const quad = (a: number, b: number, c: number, d: number): number[] => [a, b, c, a, c, d];
    const i = [
      ...quad(0, 2, 3, 1),
      ...quad(4, 5, 7, 6),
      ...quad(0, 1, 5, 4),
      ...quad(2, 6, 7, 3),
      ...quad(0, 4, 6, 2),
      ...quad(1, 3, 7, 5),
    ];
    const mesh = merge({ p, i });
    for (const zWl of [0.5, 1, 1.5]) {
      const s = sectionAt(mesh, 0, zWl);
      const width = 2 + zWl; // 2·(1 + z/2)
      expect(s.beam).toBeCloseTo(width, 3);
      expect(s.area).toBeCloseTo(2 * zWl + (zWl * zWl) / 2, 4);
    }
  });
});
