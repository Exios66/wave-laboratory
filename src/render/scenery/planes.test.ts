import { describe, expect, it } from 'vitest';
import { Pcg32 } from '../../core/rng';
import {
  AIRCRAFT,
  CrossingScheduler,
  PLANE_SCHEDULE,
  crossingInterval,
  crossingPose,
  memberOpacity,
  meanCrossingInterval,
  planCrossing,
  shimmerAmount,
  type Crossing,
  type PlanePose,
  type PlaneView,
} from './planes';

const VIEW: PlaneView = { camX: 30, camY: 104, camZ: 120, forwardX: -0.5, forwardZ: -0.7 };

function pose(): PlanePose {
  return { x: 0, y: 0, z: 0, heading: 0, bank: 0 };
}

/** Run a scheduler for `hours` of wall time at 10 Hz; return every crossing it started. */
function simulate(seed: number, hours: number, calm = 1, view = VIEW) {
  const s = new CrossingScheduler(seed);
  const started: Crossing[] = [];
  let maxActive = 0;
  const seen = new Set<number>();
  for (let t = 0; t < hours * 3600; t += 0.1) {
    s.update(t, view, calm);
    maxActive = Math.max(maxActive, s.active.length);
    for (const c of s.active) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        started.push(c);
      }
    }
  }
  return { started, maxActive };
}

describe('crossing schedule', () => {
  it('comes round about once a minute, so the flights are seen without waiting long', () => {
    const { started } = simulate(7, 8);
    const gaps = started.slice(1).map((c, i) => c.startT - started[i]!.startT);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThan(45);
    expect(mean).toBeLessThan(75);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(PLANE_SCHEDULE.minIntervalS - 1e-9);
  });

  it('draws intervals with the configured mean, a bit shorter in a storm', () => {
    const rng = new Pcg32(3);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += crossingInterval(rng, 1);
    expect(sum / n).toBeCloseTo(PLANE_SCHEDULE.meanIntervalS, -1);
    expect(meanCrossingInterval(0)).toBeLessThan(meanCrossingInterval(1));
  });

  it('never has more than the allowed number of crossings at once', () => {
    for (const calm of [0, 1]) {
      const { maxActive } = simulate(11, 6, calm);
      expect(maxActive).toBeLessThanOrEqual(PLANE_SCHEDULE.maxConcurrent);
      expect(maxActive).toBeGreaterThanOrEqual(1);
    }
  });

  it('waits a while before the first crossing and after a reset', () => {
    const s = new CrossingScheduler(5);
    expect(s.nextCrossingAt).toBeGreaterThanOrEqual(PLANE_SCHEDULE.firstDelayS[0]);
    expect(s.nextCrossingAt).toBeLessThanOrEqual(PLANE_SCHEDULE.firstDelayS[1]);
    s.reset(1000);
    expect(s.active).toHaveLength(0);
    expect(s.nextCrossingAt).toBeGreaterThanOrEqual(1000 + PLANE_SCHEDULE.firstDelayS[0]);
  });

  it('is deterministic for a seed and differs between seeds', () => {
    const a = simulate(42, 1).started;
    const b = simulate(42, 1).started;
    const c = simulate(43, 1).started;
    expect(b).toEqual(a);
    expect(c.map((x) => x.startT)).not.toEqual(a.map((x) => x.startT));
  });

  it('shows every kind of lost aircraft, Flight 19 more often in storms', () => {
    const count = (calm: number) => {
      const rng = new Pcg32(9);
      const n: Record<string, number> = {};
      for (let i = 0; i < 4000; i++) {
        const k = planCrossing(rng, VIEW, 0, calm).kind;
        n[k] = (n[k] ?? 0) + 1;
      }
      return n;
    };
    const fair = count(1);
    const storm = count(0);
    for (const k of Object.keys(AIRCRAFT)) expect(fair[k]).toBeGreaterThan(200);
    expect(storm.avenger!).toBeGreaterThan(fair.avenger! * 1.2);
  });
});

describe('flight paths', () => {
  const rng = new Pcg32(2024);
  const crossings = Array.from({ length: 400 }, (_, i) => planCrossing(rng, VIEW, 0, 0.5, i));

  it('keep every aircraft above the minimum altitude and within the band', () => {
    const p = pose();
    for (const c of crossings) {
      expect(c.duration).toBeGreaterThanOrEqual(PLANE_SCHEDULE.minDurationS);
      expect(c.duration).toBeLessThanOrEqual(PLANE_SCHEDULE.maxDurationS);
      for (let m = 0; m < c.members.length; m++) {
        for (let tau = 0; tau <= c.duration; tau += 2) {
          crossingPose(c, m, tau, p);
          expect(p.y).toBeGreaterThan(PLANE_SCHEDULE.minAltitude - 10);
          expect(p.y).toBeLessThan(PLANE_SCHEDULE.maxAltitude + 10);
        }
      }
    }
  });

  it('pass within sight of the camera, usually crossing its view low over the horizon', () => {
    const p = pose();
    const f = Math.hypot(VIEW.forwardX, VIEW.forwardZ);
    let inView = 0;
    let appearInView = 0;
    for (const c of crossings) {
      let nearest = Infinity;
      let seenInView = 0;
      let first = true;
      let firstInView = false;
      for (let tau = 0; tau <= c.duration; tau += 1) {
        crossingPose(c, 0, tau, p);
        const dx = p.x - VIEW.camX;
        const dz = p.z - VIEW.camZ;
        const h = Math.hypot(dx, dz);
        nearest = Math.min(nearest, h);
        const elev = (Math.atan2(p.y - VIEW.camY, h) * 180) / Math.PI;
        expect(elev).toBeGreaterThan(0);
        const cosOff = (dx * VIEW.forwardX + dz * VIEW.forwardZ) / (h * f);
        // Within ±30° of the view direction and 3–20° up: where a sea-level camera looks.
        const visible = cosOff > Math.cos(Math.PI / 6) && elev > 3 && elev < 20;
        if (memberOpacity(c, 0, tau) > 0.05) {
          if (visible) seenInView++;
          if (first) firstInView = visible;
          first = false;
        }
      }
      expect(nearest).toBeLessThan(PLANE_SCHEDULE.maxRange + 400); // gentle turns drift a little
      if (seenInView >= 8) inView++;
      if (firstInView) appearInView++;
    }
    expect(inView / crossings.length).toBeGreaterThan(0.5);
    // Some materialise right in front of the viewer rather than off-screen.
    expect(appearInView / crossings.length).toBeGreaterThan(0.2);
  });

  it('fly at the aircraft speed and turn only gently', () => {
    const p = pose();
    for (const c of crossings.slice(0, 50)) {
      crossingPose(c, 0, 10, p);
      const x1 = p.x;
      const z1 = p.z;
      const h1 = p.heading;
      crossingPose(c, 0, 11, p);
      // The leader's wander adds a little, but the ground speed stays near cruise.
      const v = Math.hypot(p.x - x1, p.z - z1);
      expect(v).toBeGreaterThan(c.speed * 0.9);
      expect(v).toBeLessThan(c.speed * 1.1);
      expect(Math.abs(p.heading - h1)).toBeLessThanOrEqual(PLANE_SCHEDULE.maxTurnRate + 1e-9);
      expect(Math.abs(p.bank)).toBeLessThan(0.15);
    }
  });

  it('keeps a five-ship formation loose but together', () => {
    const c = crossings.find((x) => x.kind === 'avenger' && x.laggard < 0)!;
    const a = pose();
    const b = pose();
    crossingPose(c, 0, c.duration / 2, a);
    for (let m = 1; m < c.members.length; m++) {
      crossingPose(c, m, c.duration / 2, b);
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      expect(d).toBeGreaterThan(15);
      expect(d).toBeLessThan(220);
    }
  });
});

describe('apparition', () => {
  const c = planCrossing(new Pcg32(1), VIEW, 0, 1);

  it('fades in out of a shimmer and dissolves before the end, mid-sky', () => {
    expect(memberOpacity(c, 0, 0)).toBe(0);
    expect(memberOpacity(c, 0, c.duration)).toBe(0);
    expect(shimmerAmount(c, 0, c.fadeIn / 2)).toBeGreaterThan(0.3);
    expect(shimmerAmount(c, 0, c.duration - c.fadeOut / 2)).toBeGreaterThan(0.3);
    if (c.flicker === 0) expect(memberOpacity(c, 0, c.duration / 2)).toBeCloseTo(1);
  });

  it('lets a laggard fall behind and vanish while the others fly on', () => {
    const rng = new Pcg32(77);
    let c2: Crossing | undefined;
    for (let i = 0; i < 500 && !c2; i++) {
      const x = planCrossing(rng, VIEW, 0, 0);
      if (x.laggard > 0 && x.flicker === 0) c2 = x;
    }
    expect(c2).toBeDefined();
    const lc = c2!;
    const gone = lc.duration * lc.laggardGoneAt + 0.5;
    expect(memberOpacity(lc, lc.laggard, gone)).toBe(0);
    expect(memberOpacity(lc, 0, gone)).toBeGreaterThan(0.5);
    const lead = pose();
    const lag = pose();
    crossingPose(lc, 0, gone, lead);
    crossingPose(lc, lc.laggard, gone, lag);
    const early = pose();
    const earlyLead = pose();
    crossingPose(lc, 0, 2, earlyLead);
    crossingPose(lc, lc.laggard, 2, early);
    const d0 = Math.hypot(early.x - earlyLead.x, early.z - earlyLead.z);
    const d1 = Math.hypot(lag.x - lead.x, lag.z - lead.z);
    expect(d1).toBeGreaterThan(d0 + 50);
  });

  it('keeps opacity within [0, 1] with flicker', () => {
    const rng = new Pcg32(5);
    for (let i = 0; i < 200; i++) {
      const x = planCrossing(rng, VIEW, 0, 0.3);
      for (let tau = -1; tau < x.duration + 1; tau += 0.7) {
        for (let m = 0; m < x.members.length; m++) {
          const o = memberOpacity(x, m, tau);
          expect(o).toBeGreaterThanOrEqual(0);
          expect(o).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
