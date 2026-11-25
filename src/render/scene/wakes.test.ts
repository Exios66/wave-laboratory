import { describe, expect, it } from 'vitest';
import {
  collarWidth,
  foamDecay,
  hullHalfWidth,
  KELVIN_TAN,
  WAKE_POINTS,
  WAKE_VESSELS,
  WakeField,
  wakeHalfWidth,
  wakeLifetime,
  WakeTrail,
} from './wakes';

describe('ship wake trails', () => {
  it('uses the deep-water Kelvin angle and a slowly widening turbulent wake', () => {
    expect((Math.atan(KELVIN_TAN) * 180) / Math.PI).toBeCloseTo(19.47, 2);
    const B = 30;
    expect(wakeHalfWidth(B, 0)).toBeCloseTo(0.85 * 15, 6);
    // x^(1/3): eight times further astern, only twice the growth.
    const g1 = wakeHalfWidth(B, 300) - wakeHalfWidth(B, 0);
    const g8 = wakeHalfWidth(B, 2400) - wakeHalfWidth(B, 0);
    expect(g8 / g1).toBeCloseTo(2, 6);
    expect(foamDecay(333)).toBeGreaterThan(foamDecay(30));
  });

  it('follows the path through a turn instead of a straight line astern', () => {
    const trail = new WakeTrail();
    const L = 60;
    const R = 400;
    const U = 8;
    for (let t = 0; t <= 120; t += 0.1) {
      const a = (U * t) / R;
      trail.update(t, R * Math.sin(a), R * (1 - Math.cos(a)), U, L, WAKE_POINTS);
    }
    expect(trail.points.length).toBeGreaterThan(10);
    expect(trail.points.length).toBeLessThanOrEqual(WAKE_POINTS - 2);
    // Every recorded point lies on the turning circle the stern actually sailed.
    for (const p of trail.points) expect(Math.hypot(p.x, p.y - R)).toBeCloseTo(R, 6);
    // Newest first, and the odometer measures the distance sailed.
    for (let i = 1; i < trail.points.length; i++)
      expect(trail.points[i - 1]!.t).toBeGreaterThan(trail.points[i]!.t);
    expect(trail.odo).toBeCloseTo(U * 120, 0);
    // Expired points are dropped.
    const oldest = trail.points[trail.points.length - 1]!;
    expect(120 - oldest.t).toBeLessThanOrEqual(wakeLifetime(L) + 1e-9);
  });

  it('lays the wake of a ship already under way at the start', () => {
    const trail = new WakeTrail();
    trail.update(0, 0, 0, 5, 50, WAKE_POINTS, { x: 0, y: 1 });
    expect(trail.points.length).toBeGreaterThan(20);
    const last = trail.points[trail.points.length - 1]!;
    expect(last.y).toBeCloseTo(-5 * wakeLifetime(50), 6);
    expect(last.x).toBeCloseTo(0, 9);
    // A ship at rest has no past track, only where it is now.
    const still = new WakeTrail();
    still.update(0, 0, 0, 0, 50, WAKE_POINTS, { x: 0, y: 1 });
    expect(still.points.length).toBe(1);
  });

  it('starts over when time runs backwards (a reload)', () => {
    const trail = new WakeTrail();
    for (let t = 0; t < 30; t += 0.5) trail.update(t, t * 4, 0, 4, 40, WAKE_POINTS);
    trail.update(1, 4, 0, 4, 40, WAKE_POINTS);
    expect(trail.points.length).toBe(1);
    expect(trail.odo).toBe(0);
  });

  it('packs bow, stern and history into the texture rows in the water frame', () => {
    const field = new WakeField();
    const drift = { x: 10, y: -5 };
    field.update(
      2,
      [
        {
          id: 'a',
          length: 100,
          beam: 16,
          bow: { x: 150, y: 0 },
          stern: { x: 50, y: 0 },
          speed: 6,
        },
      ],
      drift,
    );
    expect(field.count).toBe(1);
    const d = field.texture.image.data as Float32Array;
    expect(field.texture.image.width).toBe(WAKE_POINTS);
    expect(field.texture.image.height).toBe(2 * WAKE_VESSELS);
    // Bow then stern, minus the drift; bow odometer = stern odometer + L.
    expect([d[0], d[1], d[2]]).toEqual([140, 5, 2]);
    expect([d[4], d[5]]).toEqual([40, 5]);
    expect(d[3]! - d[7]!).toBeCloseTo(100, 9);
    expect(field.ship[0]!.x).toBe(100);
    expect(field.info[0]!.y).toBe(0);
    // The box covers the hull and the history behind it.
    const box = field.box[0]!;
    expect(box.x).toBeLessThan(40);
    expect(box.z).toBeGreaterThan(140);
    field.update(3, [], drift);
    expect(field.count).toBe(0);
    field.dispose();
  });

  it('has a hull half-width of 0 at the stem, B/2 amidships and less at the transom', () => {
    const L = 100;
    const B = 16;
    expect(hullHalfWidth(0, L, B)).toBeCloseTo(0, 9);
    expect(hullHalfWidth(0.5 * L, L, B)).toBeCloseTo(B / 2, 9);
    expect(hullHalfWidth(L, L, B)).toBeLessThan(B / 2);
    expect(hullHalfWidth(L, L, B)).toBeGreaterThan(0.6 * (B / 2));
    expect(hullHalfWidth(-5, L, B)).toBe(0);
  });

  it('writes the contact strength into ship.z (default 1) and grows the box by the collar', () => {
    // An absurd sea state, so that the collar (not the Kelvin arm at the stern) sets the box.
    const src = {
      id: 'a',
      length: 100,
      beam: 2,
      bow: { x: 150, y: 0 },
      stern: { x: 50, y: 0 },
      speed: 0,
    };
    const field = new WakeField();
    field.update(2, [src], { x: 0, y: 0 }, 0);
    expect(field.ship[0]!.z).toBe(1);
    const calm = field.box[0]!.clone();
    field.update(2, [src], { x: 0, y: 0 }, 300);
    const rough = field.box[0]!;
    expect(rough.w - rough.y).toBeGreaterThan(calm.w - calm.y);
    // The live hull is covered out to the collar on both sides.
    expect(rough.w).toBeGreaterThanOrEqual(1 + collarWidth(2, 0, 300));
    field.update(3, [{ ...src, contact: 0 }], { x: 0, y: 0 }, 300);
    expect(field.ship[0]!.z).toBe(0);
    expect(collarWidth(16, 0, 0)).toBeGreaterThan(0.35);
    expect(collarWidth(16, 9, 2)).toBeGreaterThan(collarWidth(16, 0, 0));
    field.dispose();
  });
});
