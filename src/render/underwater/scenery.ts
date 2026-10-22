/**
 * Underwater world scenery & atmosphere.
 *
 * Kills the underwater void while keeping zero surfaced cost:
 *  - Seafloor that follows the experiment's still-water depth (`seafloor.ts`): on a shelf
 *    (≤ 60 m) a world-snapped vertex-coloured grid sits at `env.depth` with sand ripples, silt
 *    troughs and rocky rises, and the Underwater camera is clamped above it; in deep water there is
 *    no floor ("blue water"): a depth gradient with drifting marine snow instead;
 *  - Flora: dense kelp forests and seagrass meadows (one instanced mesh whose blades sway in the
 *    vertex shader), coral / rock heads (a second instanced mesh), and hash-grid shipwrecks with the
 *    signature sunken TBM Avenger torpedo bomber (pairing Flight 19 overhead with a seafloor story);
 *  - Light: animated world-space caustics (fragment shader, shared by every material, fading with
 *    depth by the Jerlov K_d), and — through the absorption pass — volumetric god rays and a depth
 *    colour grade;
 *  - Marine snow & night bioluminescent plankton: one world-wrapped `Points` draw.
 *
 * Draw calls per tier when submerged (`UNDERWATER_BUDGET`, picked by `underwaterDraws`):
 *  - `lite`: ≤ 1 (seabed; or particles in blue water);
 *  - `mid`:  ≤ 3 (seabed, plants, coral/rock heads; particles in blue water);
 *  - `full`: ≤ 6 (seabed, plants, coral/rock heads, wrecks, particles; no floor layers in blue water).
 * Above the surface (`!frame.underwater`), `object.visible = false` → 0 draw calls and no updates.
 */
import * as THREE from 'three';
import { smoothstep } from '../../core/mathUtil';
import { mulberry32 } from '../../core/rng';
import { waterOptics } from '../../ocean/waterTypes';
import type { WaterType } from '../../schema/experiment';
import { islandsNear } from '../scenery/islands';
import type { SceneryFrame, SceneryLayer } from '../scenery/types';
import {
  floorDepthAt,
  floorModeAt,
  HOME_REEF,
  REEF_INFLUENCE,
  type ReefSource,
  SHELF_MAX_DEPTH,
  reliefNoise,
  UNDERWATER_BUDGET,
  underwaterDraws,
} from './seafloor';
import {
  buildHardGeometry,
  buildPlantGeometry,
  buildSeabedGeometry,
  buildWreckGeometry,
  SEABED_STEP,
} from './uwGeometry';
import { createUwUniforms, patchUnderwaterMaterial } from './uwMaterials';
import { MarineParticles } from './uwParticles';

export { UNDERWATER_BUDGET };

export const UW_CELL = 48;
export const UW_VIEW_RANGE = 130;
/** Flora and rocks are only instanced this close [m]: the water hides anything farther. */
export const UW_FLORA_RANGE = 110;
const UW_SALT = 0x4b1d902e;
/** Floor depth [m] the features assume when no experiment depth is given (a typical dive site). */
const DEFAULT_SHELF_DEPTH = 20;

/** Fixed coordinates of the signature sunken TBM Avenger easter egg near the origin [m]. */
export const SUNKEN_AVENGER_SITE = { x: 85, y: -65 } as const;

export type UnderwaterFeatureKind =
  'kelp' | 'grass' | 'coral' | 'rock' | 'wreck-trawler' | 'wreck-avenger';

export interface UnderwaterFeatureSpec {
  id: string;
  kind: UnderwaterFeatureKind;
  /** World coordinates [m]. */
  x: number;
  y: number;
  /** Seafloor depth below mean sea level [m, positive downward]. */
  depth: number;
  yaw: number;
  scale: number;
  count: number;
  /** Radius [m] the `count` items are scattered over. */
  spread: number;
  seed: number;
}

function hash2(ix: number, iy: number, salt: number): number {
  let h = Math.imul((salt ^ ix) | 0, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h ^ (iy | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Seafloor depth [m below the surface, positive] at world `(x, y)` for a still-water depth
 * (default: a 20 m dive site) and the island reefs around. Where there is no floor (blue water)
 * the nominal depth is returned, capped at 120 m (the water hides it); see {@link floorDepthAt}
 * for the `null`-returning form.
 */
export function seabedDepthAt(
  x: number,
  y: number,
  envDepth = DEFAULT_SHELF_DEPTH,
  reefs: readonly ReefSource[] = [],
): number {
  return floorDepthAt(x, y, envDepth, reefs) ?? Math.min(envDepth, 120);
}

/**
 * Reefs near world `(x, y)` that can shape the floor in view: the islands' shelves (`islands`) and
 * the submerged home reef under the default start (`home`, on whenever the underwater scenery is).
 */
export function reefsNear(
  x: number,
  y: number,
  opts: { islands?: boolean; home?: boolean } = {},
): ReefSource[] {
  const { islands = true, home = true } = opts;
  const out: ReefSource[] = [];
  if (islands) {
    for (const i of islandsNear(x, y, REEF_INFLUENCE + 200)) {
      out.push({ x: i.x, y: i.y, radius: i.radius });
    }
  }
  if (
    home &&
    Math.hypot(x - HOME_REEF.x, y - HOME_REEF.y) < HOME_REEF.radius + REEF_INFLUENCE + 250
  ) {
    out.push(HOME_REEF);
  }
  return out;
}

/** Tip sway amplitude [rad] of a kelp blade for a significant wave height `hs`. */
export function kelpSwayAmplitude(hs: number): number {
  return 0.12 + 0.14 * Math.min(hs, 4);
}

/** Sway angle [rad] of a kelp blade at time `t` and wave height `hs`. */
export function kelpSwayAngle(t: number, hs: number, seed: number): number {
  return kelpSwayAmplitude(hs) * Math.sin(t * 1.4 + (seed & 0xff) * 0.09);
}

/** Smooth value noise in [0, 1] for biome patches (kelp forests, meadows, reefs). */
export function biomeNoise(x: number, y: number): number {
  const gx = Math.floor(x);
  const gy = Math.floor(y);
  const fx = x - gx;
  const fy = y - gy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number) => hash2(gx + i, gy + j, UW_SALT ^ 0x6b) / 4294967295;
  const top = h(0, 0) + (h(1, 0) - h(0, 0)) * sx;
  const bot = h(0, 1) + (h(1, 1) - h(0, 1)) * sx;
  return top + (bot - top) * sy;
}

/**
 * Deterministic underwater features in cell `(ix, iy)` (`UW_CELL` metres square). Every cell has a
 * seagrass meadow; a low-frequency biome noise grows kelp forests in some regions and coral reefs
 * in others, with rocks scattered throughout. Wrecks are rare. None in blue water (no floor).
 */
export function underwaterFeaturesInCell(
  ix: number,
  iy: number,
  envDepth = DEFAULT_SHELF_DEPTH,
  reefs: readonly ReefSource[] = [],
): UnderwaterFeatureSpec[] {
  const out: UnderwaterFeatureSpec[] = [];
  // Features stand on floor that is in reach: none in blue water away from every reef.
  const floorAt = (x: number, y: number) => floorDepthAt(x, y, envDepth, reefs);
  const cellFloor = floorAt((ix + 0.5) * UW_CELL, (iy + 0.5) * UW_CELL);
  if (cellFloor === null || cellFloor > SHELF_MAX_DEPTH + 25) return out;

  // Signature easter egg: Flight 19's sunken TBM Avenger.
  if (
    ix === Math.floor(SUNKEN_AVENGER_SITE.x / UW_CELL) &&
    iy === Math.floor(SUNKEN_AVENGER_SITE.y / UW_CELL) &&
    floorAt(SUNKEN_AVENGER_SITE.x, SUNKEN_AVENGER_SITE.y) !== null
  ) {
    out.push({
      id: 'wreck:avenger:flight19',
      kind: 'wreck-avenger',
      x: SUNKEN_AVENGER_SITE.x,
      y: SUNKEN_AVENGER_SITE.y,
      depth: floorAt(SUNKEN_AVENGER_SITE.x, SUNKEN_AVENGER_SITE.y)!,
      yaw: 0.72,
      scale: 1,
      count: 1,
      spread: 0,
      seed: 0x19451205,
    });
  }

  const seed = hash2(ix, iy, UW_SALT);
  const rnd = mulberry32(seed);
  const cx = (ix + 0.5) * UW_CELL;
  const cy = (iy + 0.5) * UW_CELL;
  // Shallow reef flats favour coral over kelp.
  const biome = biomeNoise(cx / 200, cy / 200) - (cellFloor < 6 ? 0.3 : 0);
  const push = (
    kind: UnderwaterFeatureKind,
    tag: string,
    x: number,
    y: number,
    count: number,
    spread: number,
    scale: number,
    s: number,
  ) => {
    const yaw = rnd() * Math.PI * 2; // drawn first so skipping a feature never shifts the others
    const depth = floorAt(x, y);
    if (depth === null || depth > SHELF_MAX_DEPTH) return;
    out.push({ id: `${tag}:${ix}:${iy}`, kind, x, y, depth, yaw, scale, count, spread, seed: s });
  };
  const jitter = () => (rnd() - 0.5) * UW_CELL * 0.5;

  // Seagrass: everywhere.
  push(
    'grass',
    'grass',
    cx,
    cy,
    (cellFloor < 18 ? 20 : 12) + Math.floor(rnd() * 10),
    UW_CELL * 0.5,
    0.8 + 0.5 * rnd(),
    seed ^ 0x2d,
  );
  // Kelp: dense forests where the biome is high, a few stragglers elsewhere.
  if (biome > 0.45) {
    const density = Math.min(1, (biome - 0.35) * 2.2);
    push(
      'kelp',
      'kelp',
      cx + jitter(),
      cy + jitter(),
      8 + Math.floor(density * 22 * (0.7 + 0.3 * rnd())),
      UW_CELL * 0.35,
      0.9 + 0.45 * rnd(),
      seed,
    );
  } else if (rnd() < (cellFloor < 18 ? 0.7 : 0.3)) {
    push(
      'kelp',
      'kelp',
      cx + jitter(),
      cy + jitter(),
      3 + Math.floor(rnd() * 4),
      8,
      0.8 + 0.3 * rnd(),
      seed,
    );
  }
  // Rocks.
  if (rnd() < (cellFloor < 18 ? 0.95 : 0.55)) {
    push(
      'rock',
      'rock',
      cx + jitter(),
      cy + jitter(),
      1 + Math.floor(rnd() * 3),
      16,
      0.8 + 0.6 * rnd(),
      seed ^ 0x4f,
    );
  }
  // Coral: reefs where the biome is low, the odd head elsewhere.
  if (rnd() < (biome < 0.4 ? (cellFloor < 10 ? 0.85 : 0.55) : cellFloor < 18 ? 0.5 : 0.12)) {
    push(
      'coral',
      'coral',
      cx + jitter(),
      cy + jitter(),
      5 + Math.floor(rnd() * 5),
      9,
      0.85 + 0.4 * rnd(),
      seed ^ 0x33,
    );
  }
  // Rare sunken wrecks.
  if (rnd() < 0.02) {
    push(
      rnd() < 0.25 ? 'wreck-avenger' : 'wreck-trawler',
      'wreck',
      cx + jitter(),
      cy + jitter(),
      1,
      0,
      0.9 + 0.2 * rnd(),
      seed ^ 0x77,
    );
  }
  return out;
}

/** All underwater features within `radius` [m] of world `(x, y)`, nearest first. */
export function underwaterFeaturesNear(
  x: number,
  y: number,
  radius = UW_VIEW_RANGE,
  envDepth = DEFAULT_SHELF_DEPTH,
  reefs: readonly ReefSource[] = [],
): UnderwaterFeatureSpec[] {
  const reach = radius + UW_CELL;
  const ix0 = Math.floor((x - reach) / UW_CELL);
  const ix1 = Math.floor((x + reach) / UW_CELL);
  const iy0 = Math.floor((y - reach) / UW_CELL);
  const iy1 = Math.floor((y + reach) / UW_CELL);
  const found: { spec: UnderwaterFeatureSpec; d: number }[] = [];
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      for (const spec of underwaterFeaturesInCell(ix, iy, envDepth, reefs)) {
        const d = Math.hypot(spec.x - x, spec.y - y);
        if (d <= radius) found.push({ spec, d });
      }
    }
  }
  found.sort((a, b) => a.d - b.d);
  return found.map((f) => f.spec);
}

/** Caustic and bioluminescent intensities for the given water type and daylight [0–1]. */
export function underwaterAtmosphere(
  waterType: WaterType,
  daylight: number,
  depth: number,
): { causticStrength: number; bioStrength: number; snowTint: [number, number, number] } {
  const optics = waterOptics(waterType);
  const kdMean = (optics.attenuation[0] + optics.attenuation[1] + optics.attenuation[2]) / 3;
  const clarity = Math.exp(-kdMean * Math.max(0, depth) * 0.45);
  const causticStrength = Math.max(0, Math.min(1, daylight * clarity * 1.15));
  const night = 1 - Math.min(1, Math.max(0, daylight));
  // Bioluminescent plankton glows brighter at night and in nutrient-rich water.
  const bioStrength = night * (0.35 + 0.65 * Math.min(1, kdMean * 4));
  const snowTint: [number, number, number] =
    bioStrength > 0.25
      ? [0.18, 0.85, 0.95]
      : [0.45 + optics.scatter[0] * 2, 0.55 + optics.scatter[1] * 2, 0.62 + optics.scatter[2] * 2];
  return { causticStrength, bioStrength, snowTint };
}

/** Particle pool in use per tier, by floor mode: blue water is mostly particulate, so it gets more. */
export function particleCount(tier: 'full' | 'mid' | 'lite', blue: boolean): number {
  const table = blue ? { full: 1500, mid: 800, lite: 400 } : { full: 600, mid: 0, lite: 0 };
  return table[tier];
}

/** Sea-floor colour [linear RGB] from the relief value `n` (−1 high … 1 deep) and a per-vertex hash. */
export function seabedColor(n: number, noise: number, out: [number, number, number]): void {
  const rocky = smoothstep(-0.35, -0.85, n);
  const silt = smoothstep(0.15, 0.95, n);
  const patch = 0.85 + 0.3 * noise;
  const sand: [number, number, number] = [0.6, 0.53, 0.38];
  const siltC: [number, number, number] = [0.36, 0.34, 0.28];
  const rockC: [number, number, number] = [0.34, 0.33, 0.35];
  for (let c = 0; c < 3; c++) {
    const base = sand[c]! + (siltC[c]! - sand[c]!) * silt;
    out[c] = (base + (rockC[c]! - base) * rocky) * patch;
  }
}

function vertexHash(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

const MAX_PLANTS = 1400;
const MAX_HARD = 260;
const MAX_WRECKS = 16;
const MAX_PARTICLES = 1500;

export class UnderwaterSceneryLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private enabled = true;

  private readonly uniforms = createUwUniforms();
  private readonly seabedMesh: THREE.Mesh;
  private readonly seabedMat: THREE.MeshStandardMaterial;
  private readonly plantMat: THREE.MeshStandardMaterial;
  private readonly hardMat: THREE.MeshStandardMaterial;
  private readonly plantMesh: THREE.InstancedMesh;
  private readonly hardMesh: THREE.InstancedMesh;
  private readonly wreckMesh: THREE.InstancedMesh;
  private readonly particles = new MarineParticles(MAX_PARTICLES);
  private particleCountNow = 0;

  /** Snapped seabed grid centre and the env depth it was built for. */
  private seabedKey = '';
  /** Where the flora was last instanced from. */
  private floraX = Number.NaN;
  private floraY = Number.NaN;
  private floraKey = '';
  /** Island reefs near the camera, refreshed as it moves; `reefVersion` keys the rebuilds. */
  private reefs: ReefSource[] = [];
  private reefX = Number.NaN;
  private reefY = Number.NaN;
  private reefVersion = 0;
  private reefIslands = false;

  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpE = new THREE.Euler();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpC = new THREE.Color();
  private readonly tmpRgb: [number, number, number] = [0, 0, 0];
  private readonly camPos = new THREE.Vector3();

  constructor() {
    this.object.name = 'underwater-scenery';
    this.object.visible = false;

    this.seabedMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.02,
    });
    this.plantMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.hardMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.9,
      metalness: 0.02,
    });
    patchUnderwaterMaterial(this.seabedMat, this.uniforms);
    patchUnderwaterMaterial(this.plantMat, this.uniforms, { sway: true });
    patchUnderwaterMaterial(this.hardMat, this.uniforms);

    this.seabedMesh = new THREE.Mesh(buildSeabedGeometry(), this.seabedMat);
    this.seabedMesh.name = 'underwater-seabed';
    this.seabedMesh.frustumCulled = false;
    this.object.add(this.seabedMesh);

    this.plantMesh = this.makeInstanced(buildPlantGeometry(), this.plantMat, MAX_PLANTS, 'plants');
    this.hardMesh = this.makeInstanced(buildHardGeometry(), this.hardMat, MAX_HARD, 'hard');
    this.wreckMesh = this.makeInstanced(
      buildWreckGeometry(),
      this.seabedMat,
      MAX_WRECKS,
      'wrecks',
      false,
    );
    this.object.add(this.particles.points);
  }

  private makeInstanced(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    max: number,
    name: string,
    colored = true,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.name = `underwater-${name}`;
    mesh.frustumCulled = false;
    mesh.count = 0;
    if (colored) {
      const white = new THREE.Color(1, 1, 1);
      for (let i = 0; i < max; i++) mesh.setColorAt(i, white);
    }
    this.object.add(mesh);
    return mesh;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.object.visible = false;
  }

  /** Number of active draw calls in the current frame (0 when surfaced). */
  get activeDrawCalls(): number {
    if (!this.object.visible) return 0;
    let calls = this.seabedMesh.visible ? 1 : 0;
    for (const m of [this.plantMesh, this.hardMesh, this.wreckMesh]) {
      if (m.visible && m.count > 0) calls++;
    }
    if (this.particles.points.visible && this.particleCountNow > 0) calls++;
    return calls;
  }

  update(frame: SceneryFrame): void {
    if (!this.enabled || !frame.underwater) {
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    const tier = frame.tier ?? 'full';
    const envDepth = frame.waterDepth ?? 4000;
    const camX = frame.camera.position.x;
    const camZ = frame.camera.position.z;
    const worldX = camX;
    const worldY = -camZ;
    // Reefs lift a floor out of deep water: the home reef under the start (always), and each
    // island's shelf (with islands on). Refreshed as the camera moves or the islands toggle.
    const islandsOn = frame.islands === true;
    if (
      Number.isNaN(this.reefX) ||
      islandsOn !== this.reefIslands ||
      Math.hypot(worldX - this.reefX, worldY - this.reefY) > 20
    ) {
      this.reefX = worldX;
      this.reefY = worldY;
      this.reefIslands = islandsOn;
      this.reefs = reefsNear(worldX, worldY, { islands: islandsOn });
      this.reefVersion++;
    }
    const reefs = this.reefs;
    const mode = floorModeAt(worldX, worldY, envDepth, reefs);
    const draws = underwaterDraws(tier, mode);
    const waterType = frame.waterType ?? 'oceanic-ib';
    const optics = waterOptics(waterType);
    const atm = underwaterAtmosphere(waterType, frame.daylight, frame.cameraDepth ?? 4);

    const u = this.uniforms;
    u.uUwTime.value = frame.wallT;
    u.uUwCaustic.value = atm.causticStrength;
    u.uUwKd.value.fromArray(optics.attenuation);
    u.uUwSway.value = kelpSwayAmplitude(frame.hs) * 3.2;

    // 1. Seabed (shelf only).
    this.seabedMesh.visible = draws.seabed;
    if (draws.seabed) this.updateSeabed(camX, camZ, envDepth, reefs);

    // 2. Plants, coral / rock heads, wrecks (shelf only).
    this.plantMesh.visible = draws.plants;
    this.hardMesh.visible = draws.hard;
    this.wreckMesh.visible = draws.wrecks;
    if (draws.plants || draws.hard || draws.wrecks) {
      const moved = Math.hypot(worldX - this.floraX, worldY - this.floraY) > 10;
      const key = `${envDepth}:${this.reefVersion}:${draws.plants}:${draws.hard}:${draws.wrecks}`;
      if (moved || key !== this.floraKey || Number.isNaN(this.floraX)) {
        this.floraX = worldX;
        this.floraY = worldY;
        this.floraKey = key;
        this.rebuildInstances(worldX, worldY, envDepth, draws, reefs);
      }
    }

    // 3. Marine snow / bioluminescence (blue water on every tier, shelf on full).
    const count = draws.particles ? particleCount(tier, mode === 'blue') : 0;
    this.particleCountNow = count;
    this.particles.points.visible = count > 0;
    if (count > 0) {
      const bio = atm.bioStrength > 0.25;
      const gain = bio ? 0.85 : 0.5 + 1.1 * frame.daylight;
      const rad = (frame.windDirectionDeg * Math.PI) / 180;
      const drift = 0.05 + 0.012 * frame.windSpeed;
      this.particles.update({
        camera: this.camPos.copy(frame.camera.position),
        time: frame.wallT,
        count,
        box: mode === 'blue' ? 90 : 60,
        size: bio ? 0.26 : 0.17,
        color: [atm.snowTint[0] * gain, atm.snowTint[1] * gain, atm.snowTint[2] * gain],
        opacity: 0.9,
        drift: [Math.sin(rad) * drift, -Math.cos(rad) * drift],
      });
    }
  }

  private updateSeabed(
    camX: number,
    camZ: number,
    envDepth: number,
    reefs: readonly ReefSource[],
  ): void {
    const sx = Math.round(camX / SEABED_STEP) * SEABED_STEP;
    const sz = Math.round(camZ / SEABED_STEP) * SEABED_STEP;
    const key = `${sx}:${sz}:${envDepth}:${this.reefVersion}`;
    if (key === this.seabedKey) return;
    this.seabedKey = key;
    this.seabedMesh.position.set(sx, 0, sz);
    const geo = this.seabedMesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    const rgb = this.tmpRgb;
    for (let i = 0; i < pos.count; i++) {
      const wx = sx + pos.getX(i);
      const wz = sz + pos.getZ(i);
      const wy = -wz;
      const d = seabedDepthAt(wx, wy, envDepth, reefs);
      pos.setY(i, -d);
      seabedColor(reliefNoise(wx, wy), vertexHash(wx, wy), rgb);
      if (d < 4) {
        // Lagoon flats: pale, bright sand.
        const k = 0.25 * (1 - d / 4);
        rgb[0] += k;
        rgb[1] += k;
        rgb[2] += k * 0.7;
      }
      col.setXYZ(i, rgb[0], rgb[1], rgb[2]);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeVertexNormals();
  }

  private rebuildInstances(
    worldX: number,
    worldY: number,
    envDepth: number,
    draws: { plants: boolean; hard: boolean; wrecks: boolean },
    reefs: readonly ReefSource[],
  ): void {
    const features = underwaterFeaturesNear(worldX, worldY, UW_FLORA_RANGE, envDepth, reefs);
    let plantIdx = 0;
    let hardIdx = 0;
    let wreckIdx = 0;
    const up = new THREE.Vector3(0, 1, 0);
    for (const f of features) {
      const near = Math.hypot(f.x - worldX, f.y - worldY) <= UW_FLORA_RANGE + f.spread;
      if (f.kind === 'wreck-trawler' || f.kind === 'wreck-avenger') {
        if (!draws.wrecks || wreckIdx >= MAX_WRECKS) continue;
        this.tmpP.set(f.x, -f.depth + 0.3, -f.y);
        this.tmpE.set(0.18, f.yaw, -0.22);
        this.tmpQ.setFromEuler(this.tmpE);
        this.tmpS.setScalar(f.scale * (f.kind === 'wreck-trawler' ? 1.4 : 1.0));
        this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
        this.wreckMesh.setMatrixAt(wreckIdx++, this.tmpM);
        continue;
      }
      if (!near) continue;
      const plant = f.kind === 'kelp' || f.kind === 'grass';
      if (plant ? !draws.plants : !draws.hard) continue;
      const rnd = mulberry32(f.seed);
      for (let k = 0; k < f.count; k++) {
        if (plant ? plantIdx >= MAX_PLANTS : hardIdx >= MAX_HARD) break;
        const r = f.spread * Math.sqrt(rnd());
        const a = rnd() * Math.PI * 2;
        const ox = f.x + Math.cos(a) * r;
        const oy = f.y + Math.sin(a) * r;
        const d = seabedDepthAt(ox, oy, envDepth, reefs);
        const sc = f.scale * (0.7 + 0.6 * rnd());
        this.tmpP.set(ox, -d - 0.05, -oy);
        if (plant) {
          this.tmpQ.setFromAxisAngle(up, rnd() * Math.PI * 2);
          if (f.kind === 'kelp') {
            this.tmpS.set(sc, sc * (0.8 + 0.5 * rnd()), sc);
            this.tmpC.setHSL(0.14 + 0.1 * rnd(), 0.45 + 0.2 * rnd(), 0.3 + 0.1 * rnd());
          } else {
            this.tmpS.set(sc * 1.4, sc * (0.14 + 0.1 * rnd()), sc * 1.4);
            this.tmpC.setHSL(0.24 + 0.1 * rnd(), 0.55, 0.38 + 0.1 * rnd());
          }
          this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
          this.plantMesh.setMatrixAt(plantIdx, this.tmpM);
          this.plantMesh.setColorAt(plantIdx, this.tmpC);
          plantIdx++;
        } else {
          this.tmpQ.setFromAxisAngle(up, rnd() * Math.PI * 2);
          if (f.kind === 'coral') {
            // Columns, domes and plates in reef hues.
            const tall = rnd() < 0.45;
            this.tmpS.set(
              sc * (tall ? 0.6 : 1.4),
              sc * (tall ? 2.2 : 0.8),
              sc * (tall ? 0.6 : 1.4),
            );
            const hues = [0.95, 0.03, 0.09, 0.78, 0.55, 0.62];
            this.tmpC.setHSL(hues[Math.floor(rnd() * hues.length)]!, 0.65, 0.5);
          } else {
            this.tmpS.set(sc * 2.2, sc * (0.9 + 0.8 * rnd()), sc * (1.6 + 0.8 * rnd()));
            const g = 0.3 + 0.18 * rnd();
            this.tmpC.setRGB(g, g * 0.96, g * 0.9);
          }
          this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
          this.hardMesh.setMatrixAt(hardIdx, this.tmpM);
          this.hardMesh.setColorAt(hardIdx, this.tmpC);
          hardIdx++;
        }
      }
    }
    this.commit(this.plantMesh, plantIdx, true);
    this.commit(this.hardMesh, hardIdx, true);
    this.commit(this.wreckMesh, wreckIdx, false);
  }

  private commit(mesh: THREE.InstancedMesh, count: number, colored: boolean): void {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (colored && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.seabedMesh.geometry.dispose();
    for (const m of [this.plantMesh, this.hardMesh, this.wreckMesh]) {
      m.geometry.dispose();
      m.dispose();
    }
    this.seabedMat.dispose();
    this.plantMat.dispose();
    this.hardMat.dispose();
    this.particles.dispose();
    this.object.clear();
  }
}
