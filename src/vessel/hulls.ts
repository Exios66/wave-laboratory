/**
 * Built-in parametric hull library. Every design is defined at full scale in the lofting
 * ("keel") frame — x forward from roughly amidships, y to port, z up from the keel — and is
 * scaled uniformly by the vessel's `scale`.
 *
 * Proportions follow real ship types:
 *  - box barge 40 × 12 m, T 2.5 m — analytic validation target;
 *  - Wigley hull y = (B/2)(1 − (2x/L)²)(1 − (z/T)²) with Wigley-I proportions (L/B = 10,
 *    B/T = 1.6; Journée 1992) at L = 60 m, wall-sided freeboard above the waterline;
 *  - ~118 m feeder container ship (C_B ≈ 0.7, raked flared stem, transom stern, accommodation
 *    aft);
 *  - 25 m stern trawler (round bilge, strong sheer and flare forward, wheelhouse forward);
 *  - 30 m patrol boat (deep-V with deadrise increasing from 14° at the transom to ~44°
 *    forward, hard chine, immersed transom);
 *  - 8.5 m enclosed SOLAS lifeboat (full round sections, small transom, canopy);
 *  - 330 m VLCC crude-oil tanker (C_B ≈ 0.82, long parallel middle body, accommodation aft);
 *  - 333 m Nimitz-class aircraft carrier (fine hull with strong flare, 77 m wide flight deck
 *    with an angled landing area and a starboard island);
 *  - 31 m square-rigged pirate ship in the style of an early-18th-century frigate (Queen
 *    Anne's Revenge proportions): tumblehome, high sterncastle, three masts, no engine.
 */
import type { Vec3 } from '../core/vec';
import type { VesselType } from '../schema/experiment';
import type { HullPaint, VisualBox, VisualMaterial } from './api';
import type { HullShape, LoftOptions } from './mesh';

export interface HullDesign {
  displayName: string;
  description: string;
  /** Moulded beam, depth amidships and design draft [m] at scale 1. */
  beam: number;
  depth: number;
  draft: number;
  shape: HullShape;
  physicsLoft: LoftOptions;
  renderLoft: LoftOptions;
  maxSpeedKn: number;
  /** Keel-frame boxes. */
  superstructure: VisualBox[];
  bridge: Vec3;
  propeller: { x: number; z: number; diameter: number; wake: number; timeConstant: number };
  /**
   * Rudder centre, movable area, aspect ratio and steering-gear rate. Ships use the SOLAS
   * II-1/29 minimum (35° to 30° on the other side in 28 s ≈ 2.3°/s); the small craft
   * (trawler, patrol boat, lifeboat) have the faster hydraulic gear usual on such vessels.
   * Rudder areas are 1.5–2 % of L·T for the ships and 3–5 % for the small craft (fishing
   * vessels and boats carry relatively large rudders to control their short, full hulls).
   */
  rudder: { x: number; z: number; area: number; aspect: number; rateDeg: number };
  paint?: HullPaint;
  palette?: Partial<Record<VisualMaterial, number>>;
  /** Deadwood fin (area as a fraction of L·T, centre as a fraction of L from amidships). */
  keelFin?: { areaFraction: number; xFraction: number };
  /** Square rig in the keel frame (sailing ships have no engine). */
  rig?: {
    minBraceDeg: number;
    masts: {
      x: number;
      zFoot: number;
      zTop: number;
      sails: { zYard: number; halfSpan: number; drop: number }[];
    }[];
    bowsprit: Vec3;
  };
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Half-width factor of a midship section with a flat bottom and circular bilge radius r. */
function bilgeSection(z: number, halfBeam: number, r: number): number {
  if (z >= r) return 1;
  const dz = r - z;
  return (halfBeam - r + Math.sqrt(Math.max(0, r * r - dz * dz))) / halfBeam;
}

/**
 * Plan-form factor for conventional ships: a parallel middle body between `ua` and `uf`, a run
 * aft that blends into a transom of relative width `wT`, and an entrance forward with exponent
 * `pe` (larger = fuller waterlines; letting it grow with height produces bow flare).
 */
function planForm(u: number, ua: number, uf: number, wT: number, pr: number, pe: number): number {
  if (u < ua) {
    const t = Math.min(1, (ua - u) / ua);
    return wT + (1 - wT) * (1 - t ** pr);
  }
  if (u > uf) {
    const t = Math.min(1, (u - uf) / (1 - uf));
    return 1 - t ** pe;
  }
  return 1;
}

const box = (
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  material: VisualBox['material'],
): VisualBox => ({ center: { x, y, z }, size: { x: sx, y: sy, z: sz }, material });

// ---------------------------------------------------------------------------- box barge

function boxBarge(): HullDesign {
  const L = 40;
  const B = 12;
  const D = 6;
  const T = 2.5;
  const containers: VisualBox[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = -1; j <= 1; j++) {
      containers.push(box(-8 + i * 7, j * 2.9, D + 1.3, 6.06, 2.44, 2.59, 'cargo'));
    }
  }
  return {
    displayName: 'Box barge',
    description:
      '40 × 12 m flat-deck barge with analytic hydrostatics; the first validation target. ' +
      'Fitted with a stern pusher unit for self-propulsion.',
    beam: B,
    depth: D,
    draft: T,
    shape: {
      xAft: () => -L / 2,
      xFwd: () => L / 2,
      deckHeight: () => D,
      halfBreadth: () => B / 2,
      flatBottom: true,
      draft: T,
    },
    physicsLoft: { stations: 21, levelsBelow: 5, levelsAbove: 6 },
    renderLoft: { stations: 21, levelsBelow: 5, levelsAbove: 6 },
    maxSpeedKn: 6,
    superstructure: [
      ...containers,
      box(-17, 0, D + 1.5, 4, 6, 3, 'superstructure'),
      box(-15.9, 0, D + 2.3, 0.2, 5, 0.9, 'glass'),
    ],
    bridge: { x: -16, y: 0, z: D + 3 },
    propeller: { x: -20.6, z: 1.0, diameter: 1.6, wake: 0.1, timeConstant: 3 },
    rudder: { x: -21.6, z: 1.0, area: 2.5, aspect: 1.4, rateDeg: 2.3 },
  };
}

// ---------------------------------------------------------------------------- Wigley

function wigley(): HullDesign {
  const L = 60;
  const B = 6; // L/B = 10
  const T = 3.75; // B/T = 1.6
  // Wall-sided freeboard of 0.75 m: the Wigley form has a low metacentre (KM = 5T/8 + BM ≈
  // 3.17 m), so the depth is chosen such that the default loading KG = 0.6 D gives a positive
  // GM (0.47 m). (In the Journée experiments roll was restrained.)
  const D = 4.5;
  return {
    displayName: 'Wigley hull',
    description:
      'Mathematical Wigley-I hull (L/B = 10, B/T = 1.6) scaled to 60 m: the classic seakeeping ' +
      'benchmark with published heave/pitch RAOs (Journée 1992).',
    beam: B,
    depth: D,
    draft: T,
    shape: {
      xAft: () => -L / 2,
      xFwd: () => L / 2,
      deckHeight: () => D,
      halfBreadth: (u, z) => {
        const xi = 2 * u - 1;
        const zeta = z < T ? (T - z) / T : 0;
        return (B / 2) * (1 - xi * xi) * (1 - zeta * zeta);
      },
      flatBottom: false,
      draft: T,
    },
    physicsLoft: { stations: 37, levelsBelow: 10, levelsAbove: 3 },
    renderLoft: { stations: 110, levelsBelow: 22, levelsAbove: 8 },
    maxSpeedKn: 14,
    superstructure: [
      box(-4, 0, D + 1, 8, 2.6, 2, 'superstructure'),
      box(-0.05, 0, D + 1.4, 0.1, 2.4, 0.7, 'glass'),
      box(-6, 0, D + 3.5, 0.25, 0.25, 3, 'accent'),
    ],
    bridge: { x: -1, y: 0, z: D + 2 },
    propeller: { x: -28.8, z: 1.4, diameter: 2.2, wake: 0.15, timeConstant: 3 },
    rudder: { x: -30.6, z: 1.7, area: 3.75, aspect: 1.6, rateDeg: 2.3 },
  };
}

// ---------------------------------------------------------------------------- cargo ship

function cargoShip(): HullDesign {
  const B = 20;
  const D = 10.5;
  const T = 7;
  const r = 2.4;
  const deck = (u: number): number =>
    D + 1.8 * smoothstep(0.8, 1, u) + 0.4 * smoothstep(0.15, 0, u);
  const bays: VisualBox[] = [];
  for (let k = 0; k < 6; k++) {
    const x = -34.5 + 12.8 * k;
    bays.push(box(x, 0, D + 3.9, 12.2, 17.1, 7.8, 'cargo'));
    if (k % 2 === 0) bays.push(box(x, 0, D + 3.9 + 7.8, 11.4, 15.6, 5.4, 'cargo'));
  }
  bays.push(box(42.3, 0, D + 2.6, 9, 12.2, 5.2, 'cargo'));
  return {
    displayName: 'Feeder container ship',
    description:
      '118 m feeder container ship (C_B ≈ 0.7) with a raked, flared stem, transom stern and ' +
      'accommodation aft. Service speed 15 kn.',
    beam: B,
    depth: D,
    draft: T,
    shape: {
      xAft: (z) => -56.5 - 0.12 * z,
      xFwd: (z) => (z < T ? 58 - 5.5 * (1 - z / T) ** 2 : 58 + 0.35 * (z - T)),
      deckHeight: deck,
      halfBreadth: (u, z) => {
        const wT = 0.75 * smoothstep(0.82 * T, 1.05 * T, z);
        const pr = 1.7 + 1.0 * Math.min(z / T, 1.4);
        const pe = 1.8 + 1.4 * Math.min(z / D, 1.2);
        return (B / 2) * planForm(u, 0.3, 0.62, wT, pr, pe) * bilgeSection(z, B / 2, r);
      },
      flatBottom: true,
      draft: T,
    },
    physicsLoft: { stations: 38, levelsBelow: 9, levelsAbove: 4 },
    renderLoft: { stations: 140, levelsBelow: 24, levelsAbove: 12 },
    maxSpeedKn: 15,
    superstructure: [
      ...bays,
      box(-46, 0, D + 6.5, 10, 16, 13, 'superstructure'),
      box(-44, 0, D + 12.2, 5, 20, 1.8, 'superstructure'),
      box(-41.45, 0, D + 12.4, 0.1, 15, 1.1, 'glass'),
      box(-50.5, 0, D + 15, 3.5, 3.5, 5, 'accent'),
      box(-48, 0, D + 18.2, 1.2, 1.2, 2.2, 'accent'),
      box(-46, 7.2, D + 7.2, 8, 1.2, 2.4, 'superstructure'),
      box(-46, -7.2, D + 7.2, 8, 1.2, 2.4, 'superstructure'),
      box(53, 0, D + 4.5, 0.4, 0.4, 6, 'accent'),
      box(20, 0, D + 0.35, 70, 18.5, 0.15, 'deck'),
    ],
    bridge: { x: -42, y: 0, z: D + 12.5 },
    propeller: { x: -54.2, z: 2.45, diameter: 4.3, wake: 0.25, timeConstant: 6 },
    rudder: { x: -56.6, z: 3.0, area: 13.5, aspect: 1.6, rateDeg: 2.3 },
  };
}

// ---------------------------------------------------------------------------- trawler

function trawler(): HullDesign {
  const B = 7.2;
  const D = 3.8;
  const T = 2.9;
  const deck = (u: number): number =>
    D + 1.3 * smoothstep(0.55, 1, u) ** 1.5 + 0.25 * smoothstep(0.15, 0, u);
  return {
    displayName: 'Stern trawler',
    description:
      '25 m stern trawler: round bilge, pronounced sheer and flare forward, wheelhouse forward ' +
      'of amidships and a stern gantry. Prone to parametric roll in following seas.',
    beam: B,
    depth: D,
    draft: T,
    shape: {
      xAft: (z) => -11.8 - 0.05 * z,
      xFwd: (z) => (z < T ? 12 - 1.8 * (1 - z / T) ** 2 : 12 + 0.45 * (z - T)),
      deckHeight: deck,
      halfBreadth: (u, z) => {
        const wT = 0.78 * smoothstep(0.75 * T, T, z);
        const pr = 1.5 + 0.9 * Math.min(z / T, 1.4);
        const pe = 1.4 + 1.6 * Math.min(z / D, 1.3);
        return (B / 2) * planForm(u, 0.34, 0.52, wT, pr, pe) * bilgeSection(z, B / 2, 1.9);
      },
      flatBottom: true,
      draft: T,
    },
    physicsLoft: { stations: 32, levelsBelow: 8, levelsAbove: 4 },
    renderLoft: { stations: 100, levelsBelow: 18, levelsAbove: 10 },
    maxSpeedKn: 11,
    superstructure: [
      box(1.5, 0, 4.0 + 1.15, 7, 5.4, 2.3, 'superstructure'),
      box(2.5, 0, 4.0 + 2.3 + 1.1, 4.2, 4.8, 2.2, 'superstructure'),
      box(4.62, 0, 4.0 + 2.3 + 1.5, 0.1, 4.4, 0.8, 'glass'),
      box(2.5, 0, 10.3, 0.25, 0.25, 3, 'accent'),
      box(-10.5, 3.0, D + 2.6, 0.4, 0.4, 5.2, 'accent'),
      box(-10.5, -3.0, D + 2.6, 0.4, 0.4, 5.2, 'accent'),
      box(-10.5, 0, D + 5.2, 0.5, 6.4, 0.5, 'accent'),
    ],
    bridge: { x: 3.5, y: 0, z: 7.6 },
    propeller: { x: -10.7, z: 1.0, diameter: 1.7, wake: 0.25, timeConstant: 3 },
    rudder: { x: -11.7, z: 1.2, area: 3.5, aspect: 1.4, rateDeg: 4 },
  };
}

// ---------------------------------------------------------------------------- patrol boat

function patrolBoat(): HullDesign {
  const B = 6.4;
  const D = 3.6;
  const T = 1.6;
  const DEG = Math.PI / 180;
  const plan = (u: number): number => {
    if (u < 0.15) return 0.94 + 0.06 * (u / 0.15);
    if (u > 0.42) return Math.max(0, 1 - Math.min(1, (u - 0.42) / 0.58) ** 1.7);
    return 1;
  };
  return {
    displayName: 'Patrol boat',
    description:
      '30 m deep-V patrol boat: hard chine, deadrise rising from 14° at the immersed transom ' +
      'to ~44° forward. Fast and lively; the slamming demonstrator.',
    beam: B,
    depth: D,
    draft: T,
    shape: {
      xAft: () => -14.5,
      xFwd: (z) => (z < T ? 14.5 - 4.5 * (1 - z / T) ** 1.6 : 14.5 + 0.75 * (z - T)),
      deckHeight: (u) => D + 0.8 * smoothstep(0.5, 1, u),
      halfBreadth: (u, z) => {
        const w = plan(u);
        const yc = (B / 2) * 0.9 * w;
        const beta = (14 + 30 * smoothstep(0.35, 1, u)) * DEG;
        const zc = yc * Math.tan(beta);
        if (z <= zc) return z / Math.tan(beta);
        return Math.min(yc + (z - zc) * 0.14 * Math.sqrt(w), (B / 2) * w);
      },
      flatBottom: false,
      draft: T,
    },
    physicsLoft: { stations: 34, levelsBelow: 8, levelsAbove: 4 },
    renderLoft: { stations: 110, levelsBelow: 18, levelsAbove: 10 },
    maxSpeedKn: 24,
    superstructure: [
      box(0, 0, D + 1.2, 10, 5.2, 2.4, 'superstructure'),
      box(2.5, 0, D + 3.2, 4, 4.6, 1.6, 'superstructure'),
      box(4.52, 0, D + 3.3, 0.1, 4.2, 0.9, 'glass'),
      box(0.5, 0, D + 5.5, 0.3, 0.3, 3, 'accent'),
      box(8.5, 0, D + 1.1, 1.6, 1.6, 1, 'accent'),
    ],
    bridge: { x: 3.5, y: 0, z: D + 3.3 },
    // Twin screws below the hull, represented by one equivalent unit on the centre line.
    propeller: { x: -12.5, z: -0.15, diameter: 1.1, wake: 0.05, timeConstant: 2 },
    rudder: { x: -13.8, z: -0.3, area: 1.9, aspect: 1.3, rateDeg: 5 },
  };
}

// ---------------------------------------------------------------------------- lifeboat

function lifeboat(): HullDesign {
  const B = 3.0;
  const D = 1.3;
  const T = 0.75;
  return {
    displayName: 'Enclosed lifeboat',
    description:
      '8.5 m totally enclosed SOLAS lifeboat with full round sections and a small transom. ' +
      'The survival-conditions demonstrator.',
    beam: B,
    depth: D,
    draft: T,
    shape: {
      xAft: (z) => -4.1 - 0.15 * z,
      xFwd: (z) => (z < T ? 4.25 - 0.7 * (1 - z / T) ** 2 : 4.25 + 0.35 * (z - T)),
      deckHeight: (u) => D + 0.25 * smoothstep(0.6, 1, u) + 0.15 * smoothstep(0.3, 0, u),
      halfBreadth: (u, z) => {
        const wT = 0.5 * smoothstep(0.4 * T, 0.9 * T, z);
        const pr = 1.5 + 0.8 * Math.min(z / T, 1.6);
        const pe = 1.5 + 1.0 * Math.min(z / D, 1.2);
        return (B / 2) * planForm(u, 0.38, 0.55, wT, pr, pe) * bilgeSection(z, B / 2, 0.85);
      },
      flatBottom: true,
      draft: T,
    },
    physicsLoft: { stations: 30, levelsBelow: 7, levelsAbove: 3 },
    renderLoft: { stations: 90, levelsBelow: 16, levelsAbove: 8 },
    maxSpeedKn: 6.5,
    superstructure: [
      box(0, 0, D + 0.55, 7, 2.7, 1.1, 'accent'),
      box(-2.2, 0, D + 1.35, 1, 0.9, 0.5, 'glass'),
    ],
    bridge: { x: -2.2, y: 0, z: D + 1.4 },
    propeller: { x: -3.85, z: 0.3, diameter: 0.5, wake: 0.2, timeConstant: 1.5 },
    rudder: { x: -4.2, z: 0.35, area: 0.35, aspect: 1.2, rateDeg: 5 },
  };
}

// ---------------------------------------------------------------------------- oil tanker

function oilTanker(): HullDesign {
  const B = 60;
  const D = 31;
  const T = 21;
  const deck = (u: number): number =>
    D + 2.2 * smoothstep(0.88, 1, u) + 0.6 * smoothstep(0.08, 0, u);
  const pipes: VisualBox[] = [];
  for (let k = -1; k <= 1; k++) pipes.push(box(10, k * 2.2, D + 1.4, 250, 0.9, 0.9, 'accent'));
  const frames: VisualBox[] = [];
  for (let i = 0; i < 12; i++) frames.push(box(-110 + i * 22, 0, D + 0.9, 0.6, 9, 1.8, 'accent'));
  return {
    displayName: 'VLCC oil tanker',
    description:
      '330 m very large crude carrier (≈ 320 000 t deadweight, C_B ≈ 0.82): a very full hull ' +
      'with a long parallel middle body and accommodation aft. Slow to respond, heavily damped ' +
      'and prone to green water on its low forward deck.',
    beam: B,
    depth: D,
    draft: T,
    shape: {
      xAft: (z) => -160 - 0.06 * z,
      xFwd: (z) => (z < T ? 166 - 7 * (1 - z / T) ** 2 : 166 + 0.28 * (z - T)),
      deckHeight: deck,
      halfBreadth: (u, z) => {
        const wT = 0.72 * smoothstep(0.85 * T, 1.08 * T, z);
        const pr = 1.5 + 1.0 * Math.min(z / T, 1.4);
        const pe = 2.4 + 1.2 * Math.min(z / D, 1.2);
        return (B / 2) * planForm(u, 0.2, 0.78, wT, pr, pe) * bilgeSection(z, B / 2, 3.6);
      },
      flatBottom: true,
      draft: T,
    },
    physicsLoft: { stations: 40, levelsBelow: 9, levelsAbove: 4 },
    renderLoft: { stations: 160, levelsBelow: 24, levelsAbove: 12 },
    maxSpeedKn: 15.5,
    superstructure: [
      ...pipes,
      ...frames,
      box(-138, 0, D + 11, 20, 40, 22, 'superstructure'),
      box(-131, 0, D + 22.6, 7, 58, 1.6, 'superstructure'),
      box(-127.9, 0, D + 21, 0.2, 38, 1.6, 'glass'),
      box(-153, 0, D + 19, 8, 9, 18, 'accent'),
      box(-153, 0, D + 28.6, 8.4, 9.4, 1.2, 'superstructure'),
      box(0, 0, D + 4, 1.2, 1.2, 8, 'accent'),
      box(0, 0, D + 8, 14, 0.6, 0.6, 'accent'),
      box(150, 0, D + 9, 1, 1, 12, 'accent'),
      box(30, 0, D + 0.25, 280, B - 4, 0.3, 'deck'),
    ],
    bridge: { x: -129, y: 0, z: D + 21.5 },
    propeller: { x: -155, z: 6.2, diameter: 10, wake: 0.4, timeConstant: 12 },
    rudder: { x: -161, z: 7, area: 110, aspect: 1.6, rateDeg: 2.3 },
    paint: { bottom: 0x8b1d1d, boot: 0x16161a, topside: 0x22262e },
    palette: { deck: 0x7b2d26, accent: 0x3a3f47, superstructure: 0xf2f2ee },
  };
}

// ---------------------------------------------------------------------------- aircraft carrier

function aircraftCarrier(): HullDesign {
  const B = 40.8;
  const D = 26;
  const T = 11.3;
  const DECK = D + 3.2;
  const jets: VisualBox[] = [];
  const jet = (x: number, y: number, yaw: number) => {
    jets.push({ ...box(x, y, DECK + 1.4, 17, 2.6, 2.4, 'accent'), yawDeg: yaw });
    jets.push({ ...box(x - 2, y, DECK + 1.2, 6, 12, 0.5, 'accent'), yawDeg: yaw });
    jets.push({ ...box(x - 7.5, y, DECK + 3.2, 3, 0.4, 3.2, 'accent'), yawDeg: yaw });
  };
  for (let i = 0; i < 5; i++) jet(120 - i * 15, -22, 35);
  for (let i = 0; i < 4; i++) jet(-70 - i * 16, -27, -60);
  jet(140, 8, 0);
  jet(115, 10, 0);
  return {
    displayName: 'Aircraft carrier',
    description:
      '333 m Nimitz-class aircraft carrier (≈ 95 000 t): a fine, strongly flared hull under a ' +
      '77 m wide flight deck with an angled landing area and a starboard island. Fast (30 kn), ' +
      'with a huge wind profile that the autopilot must hold against.',
    beam: B,
    depth: D,
    draft: T,
    shape: {
      xAft: (z) => -156 - 0.12 * z,
      xFwd: (z) => (z < T ? 161 - 9 * (1 - z / T) ** 1.6 : 161 + 0.42 * (z - T)),
      deckHeight: () => D,
      halfBreadth: (u, z) => {
        const wT = 0.86 * smoothstep(0.95 * T, 1.15 * T, z);
        const pr = 1.6 + 0.8 * Math.min(z / T, 1.4);
        const pe = 1.25 + 1.0 * Math.min(z / D, 1.2);
        const flare = 1 + 0.22 * smoothstep(T, D, z) * smoothstep(0.35, 0.9, u);
        return (B / 2) * planForm(u, 0.32, 0.5, wT, pr, pe) * bilgeSection(z, B / 2, 4.2) * flare;
      },
      flatBottom: true,
      draft: T,
    },
    physicsLoft: { stations: 38, levelsBelow: 9, levelsAbove: 5 },
    renderLoft: { stations: 160, levelsBelow: 24, levelsAbove: 14 },
    maxSpeedKn: 31,
    superstructure: [
      box(8, -4, DECK - 1.1, 318, 56, 2.2, 'flightdeck'),
      { ...box(-34, 14, DECK - 1.05, 236, 28, 2.1, 'flightdeck'), yawDeg: 9 },
      box(-150, 0, D - 0.8, 14, 34, 4, 'superstructure'),
      box(-12, -33.5, DECK + 9, 34, 9.5, 18, 'superstructure'),
      box(-6, -33.5, DECK + 19.5, 16, 9, 4, 'superstructure'),
      box(2.1, -33.5, DECK + 19.4, 0.2, 8, 1.6, 'glass'),
      box(-9, -33.5, DECK + 28, 2.4, 2.4, 13, 'accent'),
      box(-9, -33.5, DECK + 31, 0.5, 12, 0.5, 'accent'),
      box(-15, -33.5, DECK + 23.5, 5, 6, 5, 'accent'),
      ...jets,
    ],
    bridge: { x: 2, y: -33.5, z: DECK + 19.5 },
    // Four shafts, represented by one equivalent screw of the same total disc area.
    propeller: { x: -142, z: 4.6, diameter: 12.8, wake: 0.08, timeConstant: 8 },
    rudder: { x: -151, z: 5.5, area: 100, aspect: 1.5, rateDeg: 2.5 },
    paint: { bottom: 0x7f1d1d, boot: 0x111318, topside: 0x6e7680 },
    palette: {
      superstructure: 0x7a828c,
      flightdeck: 0x3b4047,
      deck: 0x3b4047,
      accent: 0x8f98a2,
    },
  };
}

// ---------------------------------------------------------------------------- pirate ship

function pirateShip(): HullDesign {
  const B = 9;
  const D = 5;
  const T = 3.6;
  const deck = (u: number): number =>
    D + 2.6 * smoothstep(0.26, 0.02, u) + 1.4 * smoothstep(0.76, 1, u);
  const ports: VisualBox[] = [];
  for (let i = 0; i < 6; i++) {
    const x = -7 + i * 2.6;
    ports.push(box(x, 4.02, D - 0.75, 0.75, 0.3, 0.65, 'accent'));
    ports.push(box(x, -4.02, D - 0.75, 0.75, 0.3, 0.65, 'accent'));
  }
  const mast = (x: number, top: number) => box(x, 0, (D + top) / 2, 0.55, 0.55, top - D, 'wood');
  return {
    displayName: 'Pirate ship',
    description:
      '31 m square-rigged ship in the style of an early-18th-century frigate (Queen Anne’s ' +
      'Revenge proportions): tumblehome topsides, a high sterncastle and three masts. She has ' +
      'no engine — the sails drive her, so she cannot sail closer than ~60° to the wind, and ' +
      'the crew reefs as the wind rises. Turn the autopilot off to set full sail yourself.',
    beam: B,
    depth: D,
    draft: T,
    shape: {
      xAft: (z) => -14.2 - 0.32 * z,
      xFwd: (z) => (z < T ? 14.6 - 3.6 * (1 - z / T) ** 1.5 : 14.6 + 0.85 * (z - T)),
      deckHeight: deck,
      halfBreadth: (u, z) => {
        const wT = 0.62 * smoothstep(0.45 * T, 1.15 * T, z);
        const pr = 1.4 + 0.8 * Math.min(z / T, 1.5);
        const pe = 1.5 + 1.1 * Math.min(z / D, 1.3);
        const tumble = 1 - 0.15 * smoothstep(T + 0.3, D + 2.6, z);
        return (B / 2) * planForm(u, 0.32, 0.55, wT, pr, pe) * bilgeSection(z, B / 2, 2.3) * tumble;
      },
      flatBottom: true,
      draft: T,
    },
    physicsLoft: { stations: 32, levelsBelow: 8, levelsAbove: 5 },
    renderLoft: { stations: 110, levelsBelow: 18, levelsAbove: 14 },
    maxSpeedKn: 10,
    superstructure: [
      box(-11.4, 0, D + 3.4, 5.2, 5.6, 1.6, 'wood'),
      box(-15.1, 0, D + 3.2, 0.25, 4.4, 1.0, 'glass'),
      box(-15.3, 1.9, D + 5.0, 0.5, 0.5, 0.8, 'gold'),
      box(-15.3, -1.9, D + 5.0, 0.5, 0.5, 0.8, 'gold'),
      box(-15.25, 0, D + 1.7, 0.3, 5.0, 0.35, 'gold'),
      box(0, 0, D + 0.45, 18, 6.2, 0.5, 'deck'),
      box(17.6, 0, D + 2.9, 7.5, 0.45, 0.45, 'wood'),
      mast(8.6, D + 22),
      mast(0, D + 26),
      mast(-8.2, D + 18),
      box(0, 0, D + 26.9, 0.05, 2.4, 1.6, 'flag'),
      ...ports,
    ],
    bridge: { x: -10.5, y: 0, z: D + 4.6 },
    propeller: { x: -13.5, z: 1.2, diameter: 1, wake: 0.25, timeConstant: 2 },
    rudder: { x: -14.6, z: 1.8, area: 4.6, aspect: 1.1, rateDeg: 3 },
    paint: { bottom: 0x2d2117, boot: 0xb8912a, topside: 0x3a271a },
    palette: {
      wood: 0x5a3b22,
      deck: 0x8a6a45,
      gold: 0xd4a72c,
      accent: 0x111111,
      sail: 0xe6dcc3,
      flag: 0x0b0b0b,
    },
    keelFin: { areaFraction: 0.25, xFraction: -0.38 },
    rig: {
      minBraceDeg: 32,
      bowsprit: { x: 21.2, y: 0, z: D + 4.6 },
      masts: [
        {
          x: 8.6,
          zFoot: D + 1.4,
          zTop: D + 22,
          sails: [
            { zYard: D + 9.5, halfSpan: 7.2, drop: 6.2 },
            { zYard: D + 16, halfSpan: 5.4, drop: 5.6 },
            { zYard: D + 21, halfSpan: 3.6, drop: 4.2 },
          ],
        },
        {
          x: 0,
          zFoot: D + 0.9,
          zTop: D + 26,
          sails: [
            { zYard: D + 10.5, halfSpan: 8.2, drop: 7.2 },
            { zYard: D + 18, halfSpan: 6.2, drop: 6.6 },
            { zYard: D + 24.4, halfSpan: 4.2, drop: 5.4 },
          ],
        },
        {
          x: -8.2,
          zFoot: D + 3.6,
          zTop: D + 18,
          sails: [
            { zYard: D + 11, halfSpan: 5.2, drop: 5.6 },
            { zYard: D + 16.4, halfSpan: 3.6, drop: 4.6 },
          ],
        },
      ],
    },
  };
}

const BUILDERS: Record<VesselType, () => HullDesign> = {
  'box-barge': boxBarge,
  wigley,
  'cargo-ship': cargoShip,
  trawler,
  'patrol-boat': patrolBoat,
  lifeboat,
  'oil-tanker': oilTanker,
  'aircraft-carrier': aircraftCarrier,
  'pirate-ship': pirateShip,
};

/** Full-scale (scale = 1) design of a built-in vessel type. */
export function hullDesign(type: VesselType): HullDesign {
  return BUILDERS[type]();
}
