import { describe, expect, it } from 'vitest';
import {
  CALM_THRESHOLD,
  HIDDEN_TOP,
  WHALE_BLOWHOLE,
  WHALE_BLOW_U,
  WHALE_TAIL_X,
  WildlifeSim,
  airTime,
  animalTop,
  bodyPointY,
  fairWeather,
  focusOnSea,
  leapProfile,
  maxActive,
  spawnPoint,
  speciesWeight,
  whaleProfile,
  type ArcSample,
  type Species,
  type WildlifeInput,
  type WhaleSample,
} from './wildlife';

const SPECIES: Species[] = ['dolphin', 'whale', 'turtle', 'fish'];

function input(o: Partial<WildlifeInput> = {}): WildlifeInput {
  return {
    dt: 1 / 30,
    calm: 1,
    daylight: 1,
    hs: 0.4,
    windSpeed: 4,
    windDirectionDeg: 200,
    camX: 0,
    camY: 40,
    camZ: 180,
    focusX: 0,
    focusZ: 0,
    vessels: [],
    ...o,
  };
}

function run(sim: WildlifeSim, seconds: number, o: Partial<WildlifeInput> = {}): void {
  const inp = input(o);
  const n = Math.round(seconds / inp.dt);
  for (let i = 0; i < n; i++) sim.step(inp);
}

describe('weather rules', () => {
  it('shows nothing below the calm threshold', () => {
    for (const calm of [0, 0.1, 0.2, 0.3, CALM_THRESHOLD]) {
      expect(fairWeather(calm)).toBe(0);
      for (const s of SPECIES) {
        expect(speciesWeight(s, calm, 1)).toBe(0);
        expect(maxActive(s, speciesWeight(s, calm, 1))).toBe(0);
      }
    }
  });

  it('grows with calm', () => {
    let last = -1;
    for (let c = 0; c <= 1; c += 0.05) {
      const w = speciesWeight('dolphin', c, 1);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
    expect(fairWeather(1)).toBe(1);
  });

  it('keeps dolphins at night but makes whales and fish rare', () => {
    expect(speciesWeight('dolphin', 1, 0)).toBeGreaterThan(0.5);
    expect(speciesWeight('whale', 1, 0)).toBeLessThan(0.15);
    expect(speciesWeight('fish', 1, 0)).toBeLessThan(0.2);
    for (const s of SPECIES) {
      expect(speciesWeight(s, 1, 0)).toBeLessThan(speciesWeight(s, 1, 1));
    }
  });
});

describe('leapProfile', () => {
  const out: ArcSample = { y: 0, dydu: 0 };

  for (const shape of [0, 1]) {
    it(`is above water only between exit and entry (shape ${shape})`, () => {
      const airFrac = 0.35;
      for (let i = 0; i <= 1000; i++) {
        const u = i / 1000;
        const { y } = leapProfile(u, airFrac, 1.2, 1.6, shape, out);
        const inAir = u > 0 && u < airFrac;
        if (inAir) expect(y).toBeGreaterThan(0);
        else expect(y).toBeLessThanOrEqual(1e-12);
      }
    });
  }

  it('peaks at the requested height mid-flight and dips to the depth', () => {
    expect(leapProfile(0.2, 0.4, 1.5, 2, 0, out).y).toBeCloseTo(1.5);
    expect(leapProfile(0.7, 0.4, 1.5, 2, 0, out).y).toBeCloseTo(-2);
  });

  it('rises on the way out and falls on the way in', () => {
    expect(leapProfile(0.02, 0.4, 1, 1, 0, out).dydu).toBeGreaterThan(0);
    expect(leapProfile(0.38, 0.4, 1, 1, 0, out).dydu).toBeLessThan(0);
  });

  it('wraps u', () => {
    const a = leapProfile(0.1, 0.3, 1, 1, 0, out).y;
    expect(leapProfile(1.1, 0.3, 1, 1, 0, out).y).toBeCloseTo(a);
  });

  it('times a ballistic leap', () => {
    // h = g t² / 8
    expect(airTime(1)).toBeCloseTo(Math.sqrt(8 / 9.81));
  });
});

describe('whaleProfile', () => {
  const s: WhaleSample = { y: 0, pitch: 0, bend: 0 };
  const tailY = (u: number): number => {
    whaleProfile(u, s);
    return bodyPointY(s.y, s.pitch, s.bend, WHALE_TAIL_X, 0);
  };

  it('is out of sight at the start and end of a surfacing', () => {
    for (const u of [0, 1]) {
      whaleProfile(u, s);
      expect(s.y + 1.9 + 7.6 * Math.abs(Math.sin(s.pitch))).toBeLessThan(0);
    }
  });

  it('clears the blowhole when it blows', () => {
    whaleProfile(WHALE_BLOW_U + 0.01, s);
    expect(bodyPointY(s.y, s.pitch, s.bend, WHALE_BLOWHOLE.x, WHALE_BLOWHOLE.y)).toBeGreaterThan(0);
  });

  it('raises the fluke clear of the water as it dives', () => {
    expect(tailY(0.5)).toBeLessThan(0.5);
    expect(tailY(0.84)).toBeGreaterThan(1);
    expect(tailY(1)).toBeLessThan(0);
  });
});

describe('focusOnSea and spawnPoint', () => {
  it('finds where a downward ray meets the sea, within 5–600 m', () => {
    const out = { x: 0, z: 0 };
    const d = Math.SQRT1_2;
    focusOnSea(0, 100, 0, d, -d, 0, out);
    expect(out.x).toBeCloseTo(100);
    expect(out.z).toBeCloseTo(0);
    focusOnSea(0, 100, 0, 0, 0.2, 1, out);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(300);
    focusOnSea(0, 20, 0, 1, -0.02, 0, out);
    expect(out.x).toBeCloseTo(600);
  });

  it('keeps spawn points inside both rings', () => {
    let seed = 1;
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const out = { x: 0, z: 0 };
    let hits = 0;
    for (let i = 0; i < 500; i++) {
      if (!spawnPoint(rand, 0, 0, 0, 200, 30, 250, 45, 600, out)) continue;
      hits++;
      const r = Math.hypot(out.x, out.z);
      expect(r).toBeGreaterThanOrEqual(30 - 1e-9);
      expect(r).toBeLessThanOrEqual(250 + 1e-9);
      const dc = Math.hypot(out.x, out.z - 200);
      expect(dc).toBeGreaterThanOrEqual(45);
      expect(dc).toBeLessThanOrEqual(600);
    }
    expect(hits).toBeGreaterThan(400);
  });
});

describe('WildlifeSim', () => {
  it('spawns nothing in rough weather', () => {
    const sim = new WildlifeSim(7);
    run(sim, 600, { calm: 0.3 });
    expect(sim.count()).toBe(0);
    expect(sim.particles.some((p) => p.alive)).toBe(false);
  });

  it('fills a calm sea with every species in time', () => {
    const sim = new WildlifeSim(7);
    const seen = new Set<Species>();
    const inp = input();
    for (let i = 0; i < 30 * 240; i++) {
      sim.step(inp);
      for (const a of sim.animals) if (a.alive) seen.add(a.species);
    }
    expect([...seen].sort()).toEqual([...SPECIES].sort());
  });

  it('spawns around the focus, not on top of the camera', () => {
    const sim = new WildlifeSim(3);
    const inp = input({ camX: 1000, camZ: 1000, focusX: 1100, focusZ: 1000 });
    for (let i = 0; i < 30 * 120; i++) {
      sim.step(inp);
      for (const a of sim.animals) {
        if (!a.alive || a.age > 0.05) continue;
        const dc = Math.hypot(a.x - inp.camX, a.z - inp.camZ);
        expect(dc).toBeGreaterThan(14);
        expect(dc).toBeLessThan(620);
      }
    }
    expect(sim.count()).toBeGreaterThan(0);
  });

  it('is deterministic for a seed and varies between seeds', () => {
    const snapshot = (seed: number): string => {
      const sim = new WildlifeSim(seed);
      run(sim, 120);
      return JSON.stringify(
        sim.animals
          .filter((a) => a.alive)
          .map((a) => [a.species, a.x.toFixed(4), a.y.toFixed(4), a.z.toFixed(4)]),
      );
    };
    expect(snapshot(11)).toBe(snapshot(11));
    expect(snapshot(11)).not.toBe(snapshot(12));
  });

  it('lets the animals dive away out of sight when the weather turns', () => {
    const sim = new WildlifeSim(5);
    run(sim, 180);
    expect(sim.count()).toBeGreaterThan(0);
    const inp = input({ calm: 0.2 });
    const wasAlive = sim.animals.map((a) => a.alive);
    for (let i = 0; i < 30 * 120; i++) {
      sim.step(inp);
      sim.animals.forEach((a, j) => {
        if (wasAlive[j] && !a.alive) {
          // Gone only once fully submerged: no popping out of existence.
          expect(animalTop(a)).toBeLessThan(HIDDEN_TOP);
        }
        wasAlive[j] = a.alive;
      });
    }
    expect(sim.count()).toBe(0);
  });

  it('drops animals left far behind by the camera', () => {
    const sim = new WildlifeSim(9);
    run(sim, 120);
    expect(sim.count()).toBeGreaterThan(0);
    run(sim, 1, { camX: 5000, focusX: 5000, calm: 0.2 });
    expect(sim.count()).toBe(0);
  });

  it('only splashes dolphins out of the water between exit and entry', () => {
    const sim = new WildlifeSim(21);
    const inp = input();
    let airborne = 0;
    for (let i = 0; i < 30 * 200; i++) {
      sim.step(inp);
      for (const a of sim.animals) {
        if (!a.alive || a.species !== 'dolphin') continue;
        const u = a.phase / a.cycle;
        if (a.y > 0) {
          airborne++;
          expect(u).toBeLessThan(a.airFrac + 1e-9);
        }
      }
    }
    expect(airborne).toBeGreaterThan(0);
    expect(sim.rings.some((r) => r.alive) || airborne > 0).toBe(true);
  });

  it('bow-rides a moving vessel', () => {
    const sim = new WildlifeSim(4);
    const v = { id: 'ship', x: 0, z: 0, bowX: 1, bowZ: 0, speed: 6, length: 40 };
    const inp = input({ vessels: [v], focusX: 0, focusZ: 0 });
    let riding = false;
    for (let i = 0; i < 30 * 300 && !riding; i++) {
      v.x += v.speed * inp.dt;
      sim.step(inp);
      for (const g of sim.groups) {
        if (!g.alive || g.vesselId !== 'ship') continue;
        if (Math.hypot(g.x - (v.x + 23), g.z - v.z) < 2) riding = true;
      }
    }
    expect(riding).toBe(true);
  });
});
