import { describe, expect, it } from 'vitest';
import type { SceneryTier } from '../scenery/types';
import {
  fishPose,
  makeFishPose,
  marineInstanceCap,
  marineMinDepth,
  MARINE_BUDGET,
  MARINE_SPECIES,
  marineSchoolsInCell,
  planMarineLife,
  reefSchoolForSite,
  type ReefSite,
} from './marineLifeModel';
import { seabedDepthAt, underwaterFeaturesInCell } from './scenery';

const TIERS: SceneryTier[] = ['full', 'mid', 'lite'];

function sites(cx: number, cy: number): ReefSite[] {
  const out: ReefSite[] = [];
  const ix = Math.floor(cx / 160);
  const iy = Math.floor(cy / 160);
  for (let j = iy - 2; j <= iy + 2; j++) {
    for (let i = ix - 2; i <= ix + 2; i++) {
      for (const f of underwaterFeaturesInCell(i, j)) {
        if (f.kind !== 'kelp') out.push({ id: f.id, x: f.x, y: f.y, seed: f.seed });
      }
    }
  }
  return out;
}

describe('marine life model', () => {
  it('places schools deterministically', () => {
    expect(marineSchoolsInCell(3, -2)).toEqual(marineSchoolsInCell(3, -2));
    const a = planMarineLife(120, -80, 'full', sites(120, -80));
    const b = planMarineLife(120, -80, 'full', sites(120, -80));
    expect(a).toEqual(b);
    expect(reefSchoolForSite({ id: 'x', x: 1, y: 2, seed: 9 })).toEqual(
      reefSchoolForSite({ id: 'x', x: 1, y: 2, seed: 9 }),
    );
  });

  it('keeps the draw-call and instance budgets per tier', () => {
    expect(marineInstanceCap('full')).toBeLessThanOrEqual(600);
    expect(marineInstanceCap('mid')).toBeLessThanOrEqual(250);
    expect(MARINE_BUDGET.full.drawCalls).toBeLessThanOrEqual(6);
    expect(MARINE_BUDGET.mid.drawCalls).toBeLessThanOrEqual(3);
    expect(MARINE_BUDGET.lite.drawCalls).toBeLessThanOrEqual(1);
    for (const tier of TIERS) {
      const budget = MARINE_BUDGET[tier];
      expect(Object.keys(budget.caps).length).toBeLessThanOrEqual(budget.drawCalls);
      for (let n = 0; n < 40; n++) {
        const x = n * 377 - 4000;
        const y = n * -211 + 900;
        const plan = planMarineLife(x, y, tier, sites(x, y));
        let sum = 0;
        for (const sp of MARINE_SPECIES) {
          const cap = budget.caps[sp] ?? 0;
          expect(plan.totals[sp]).toBeLessThanOrEqual(cap);
          sum += plan.totals[sp];
        }
        expect(sum).toBeLessThanOrEqual(marineInstanceCap(tier));
        const counted = plan.schools.reduce((acc, s) => acc + s.count, 0);
        expect(counted).toBe(sum);
      }
    }
  });

  it('has no fish on the lite tier', () => {
    const plan = planMarineLife(0, 0, 'lite', sites(0, 0));
    expect(plan.totals.baitfish + plan.totals.reef + plan.totals.tuna + plan.totals.ray).toBe(0);
  });

  it('actually populates the full tier near the origin', () => {
    const plan = planMarineLife(0, 0, 'full', sites(0, 0));
    expect(plan.totals.baitfish + plan.totals.reef).toBeGreaterThan(40);
  });

  it('keeps every fish between the surface and the seabed', () => {
    const pose = makeFishPose();
    let bad = 0;
    let samples = 0;
    for (const hs of [0, 1.5, 6]) {
      const top = marineMinDepth(hs);
      for (const tier of ['full', 'mid'] as const) {
        for (const origin of [
          [0, 0],
          [2500, -1800],
          [-910, 4400],
        ] as const) {
          const plan = planMarineLife(origin[0], origin[1], tier, sites(origin[0], origin[1]));
          for (const school of plan.schools) {
            for (let i = 0; i < school.count; i += 3) {
              for (let t = 0; t < 4000; t += 331) {
                fishPose(school, i, t, seabedDepthAt, hs, pose);
                const floor = Math.max(top, seabedDepthAt(pose.x, pose.y) - 0.8);
                samples++;
                if (pose.depth < top || pose.depth > floor + 1e-9 || pose.depth > 60) bad++;
              }
            }
          }
        }
      }
    }
    expect(samples).toBeGreaterThan(1000);
    expect(bad).toBe(0);
  });

  it('stays finite after very long time steps', () => {
    const pose = makeFishPose();
    const plan = planMarineLife(10, 10, 'full', sites(10, 10));
    for (const t of [0, 1e3, 1e5, 1e7, 3.15e8]) {
      for (const school of plan.schools) {
        fishPose(school, school.count - 1, t, seabedDepthAt, 2, pose);
        for (const v of [pose.x, pose.y, pose.depth, pose.yaw, pose.scale]) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });

  it('keeps a truncated school identical to the head of the full one', () => {
    const [school] = marineSchoolsInCell(0, 0).concat(marineSchoolsInCell(1, 0));
    const a = makeFishPose();
    const b = makeFishPose();
    fishPose(school!, 2, 55, seabedDepthAt, 1, a);
    fishPose({ ...school!, count: 3 }, 2, 55, seabedDepthAt, 1, b);
    expect(a).toEqual(b);
  });
});
