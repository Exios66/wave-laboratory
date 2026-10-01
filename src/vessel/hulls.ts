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
 *  - 8.5 m enclosed SOLAS lifeboat (full round sections, small transom, canopy).
 */
import type { Vec3 } from '../core/vec';
import type { VesselType } from '../schema/experiment';
import type { VisualBox } from './api';
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
    renderLoft: { stations: 73, levelsBelow: 16, levelsAbove: 4 },
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
  for (let k = 0; k < 6; k++)
    bays.push(box(-34.5 + 12.8 * k, 0, D + 3.9, 12.2, 17.1, 7.8, 'cargo'));
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
    renderLoft: { stations: 90, levelsBelow: 16, levelsAbove: 8 },
    maxSpeedKn: 15,
    superstructure: [
      ...bays,
      box(-46, 0, D + 6.5, 10, 16, 13, 'superstructure'),
      box(-44, 0, D + 12.2, 5, 20, 1.8, 'superstructure'),
      box(-41.45, 0, D + 12.4, 0.1, 15, 1.1, 'glass'),
      box(-50.5, 0, D + 15, 3.5, 3.5, 5, 'accent'),
      box(53, 0, D + 4.5, 0.4, 0.4, 6, 'accent'),
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
    renderLoft: { stations: 72, levelsBelow: 14, levelsAbove: 8 },
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
    renderLoft: { stations: 80, levelsBelow: 14, levelsAbove: 8 },
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
    renderLoft: { stations: 64, levelsBelow: 12, levelsAbove: 6 },
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

const BUILDERS: Record<VesselType, () => HullDesign> = {
  'box-barge': boxBarge,
  wigley,
  'cargo-ship': cargoShip,
  trawler,
  'patrol-boat': patrolBoat,
  lifeboat,
};

/** Full-scale (scale = 1) design of a built-in vessel type. */
export function hullDesign(type: VesselType): HullDesign {
  return BUILDERS[type]();
}
