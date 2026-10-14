/**
 * Underwater world scenery & atmosphere (Phase 4).
 *
 * Kills the underwater void while keeping zero surfaced cost:
 *  - Open-water seabed: pooled radial vertex-coloured mesh that follows the submerged camera,
 *    with sandy shelves, sand ripples and deeper rock pinnacles, plus analytic wave-normal
 *    caustics on the seafloor;
 *  - Kelp forests & coral meadows: deterministic hash-grid patches around the camera and on
 *    island shelves, rendered as a single instanced mesh whose blades sway with wave orbital
 *    motion;
 *  - Shipwrecks: hash-grid sunken trawler hulks and the signature easter egg — the sunken
 *    TBM Avenger torpedo bomber on the seabed (pairing Flight 19 overhead with a seafloor
 *    story);
 *  - Marine snow, bubble vents & night bioluminescent plankton: one shared instanced point/
 *    billboard pool tinted by the current Jerlov water type.
 *
 * Draw-call budget per tier when submerged (`UNDERWATER_BUDGET`):
 *  - `lite`: ≤ 1 draw call (seabed mesh only);
 *  - `mid`:  ≤ 2 draw calls (seabed + kelp/coral instanced mesh);
 *  - `full`: ≤ 4 draw calls (seabed + kelp/coral + wrecks + marine snow / bioluminescence).
 * Above the surface (`!frame.underwater`), `object.visible = false` → 0 draw calls.
 */
import * as THREE from 'three';
import { smoothstep } from '../../core/mathUtil';
import { mulberry32 } from '../../core/rng';
import { waterOptics } from '../../ocean/waterTypes';
import type { WaterType } from '../../schema/experiment';
import type { SceneryFrame, SceneryLayer, SceneryTier } from '../scenery/types';

export const UW_CELL = 160;
export const UW_VIEW_RANGE = 260;
const UW_SALT = 0x4b1d902e;

/** Hard cap on extra draw calls underwater per tier. */
export const UNDERWATER_BUDGET: Record<SceneryTier, number> = {
  full: 4,
  mid: 2,
  lite: 1,
};

/** Fixed coordinates of the signature sunken TBM Avenger easter egg near the origin [m]. */
export const SUNKEN_AVENGER_SITE = { x: 85, y: -65 } as const;

export type UnderwaterFeatureKind = 'kelp' | 'coral' | 'wreck-trawler' | 'wreck-avenger';

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
 * Procedural open-water seafloor depth [m below surface, positive] at world `(x, y)`.
 * Stays within reachable diving range (12–28 m) with sand ripples and rocky pinnacles so the
 * underwater camera (max depth 30 m) always sees authored seafloor rather than empty void.
 */
export function seabedDepthAt(x: number, y: number): number {
  const ripple = 0.6 * Math.sin(x * 0.14 + y * 0.09) + 0.4 * Math.cos(x * 0.07 - y * 0.12);
  const ridge = 3.2 * Math.sin(x * 0.012) * Math.cos(y * 0.014);
  const pinnacle = Math.max(0, Math.sin(x * 0.031 + 1.2) * Math.sin(y * 0.029 - 0.7)) ** 3 * 5.5;
  return Math.max(8, 18 + ridge + ripple - pinnacle);
}

/** Sway angle [rad] of a kelp blade at time `t` and wave height `hs`. */
export function kelpSwayAngle(t: number, hs: number, seed: number): number {
  const amp = 0.12 + 0.14 * Math.min(hs, 4);
  return amp * Math.sin(t * 1.4 + (seed & 0xff) * 0.09);
}

/** Deterministic underwater features in cell `(ix, iy)`. */
export function underwaterFeaturesInCell(ix: number, iy: number): UnderwaterFeatureSpec[] {
  const out: UnderwaterFeatureSpec[] = [];
  // Signature easter egg in cell (0, -1): Flight 19's sunken TBM Avenger.
  if (ix === 0 && iy === -1) {
    out.push({
      id: 'wreck:avenger:flight19',
      kind: 'wreck-avenger',
      x: SUNKEN_AVENGER_SITE.x,
      y: SUNKEN_AVENGER_SITE.y,
      depth: seabedDepthAt(SUNKEN_AVENGER_SITE.x, SUNKEN_AVENGER_SITE.y),
      yaw: 0.72,
      scale: 1,
      count: 1,
      seed: 0x19451205,
    });
  }

  const seed = hash2(ix, iy, UW_SALT);
  const rnd = mulberry32(seed);
  // High occupancy so swimming in any direction encounters authored life within ~30 s.
  if (rnd() > 0.82) return out;

  const cx = (ix + 0.2 + 0.6 * rnd()) * UW_CELL;
  const cy = (iy + 0.2 + 0.6 * rnd()) * UW_CELL;
  const depth = seabedDepthAt(cx, cy);

  // Kelp patch (10–20 blades).
  const kelpCount = 10 + Math.floor(rnd() * 11);
  out.push({
    id: `kelp:${ix}:${iy}`,
    kind: 'kelp',
    x: cx,
    y: cy,
    depth,
    yaw: rnd() * Math.PI * 2,
    scale: 0.9 + 0.35 * rnd(),
    count: kelpCount,
    seed,
  });

  // Coral cluster on shallower banks.
  if (rnd() < 0.65) {
    const ox = cx + (rnd() - 0.5) * 45;
    const oy = cy + (rnd() - 0.5) * 45;
    out.push({
      id: `coral:${ix}:${iy}`,
      kind: 'coral',
      x: ox,
      y: oy,
      depth: seabedDepthAt(ox, oy),
      yaw: rnd() * Math.PI * 2,
      scale: 0.85 + 0.4 * rnd(),
      count: 6 + Math.floor(rnd() * 6),
      seed: seed ^ 0x33,
    });
  }

  // Occasional sunken trawler wreck on a sandbank (~14% of cells).
  if (rnd() < 0.14) {
    const wx = cx + (rnd() - 0.5) * 60;
    const wy = cy + (rnd() - 0.5) * 60;
    out.push({
      id: `wreck:${ix}:${iy}`,
      kind: rnd() < 0.25 ? 'wreck-avenger' : 'wreck-trawler',
      x: wx,
      y: wy,
      depth: seabedDepthAt(wx, wy),
      yaw: rnd() * Math.PI * 2,
      scale: 0.9 + 0.2 * rnd(),
      count: 1,
      seed: seed ^ 0x77,
    });
  }

  return out;
}

/** All underwater features within `radius` [m] of world `(x, y)`, nearest first. */
export function underwaterFeaturesNear(
  x: number,
  y: number,
  radius = UW_VIEW_RANGE,
): UnderwaterFeatureSpec[] {
  const reach = radius + UW_CELL;
  const ix0 = Math.floor((x - reach) / UW_CELL);
  const ix1 = Math.floor((x + reach) / UW_CELL);
  const iy0 = Math.floor((y - reach) / UW_CELL);
  const iy1 = Math.floor((y + reach) / UW_CELL);
  const found: { spec: UnderwaterFeatureSpec; d: number }[] = [];
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      for (const spec of underwaterFeaturesInCell(ix, iy)) {
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

// ---------------------------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------------------------

function buildSeabedGeometry(radius = 220, rings = 20, segs = 36): THREE.BufferGeometry {
  const pos: number[] = [0, -18, 0];
  const col: number[] = [0.68, 0.62, 0.48];
  const idx: number[] = [];
  for (let r = 1; r <= rings; r++) {
    const rad = (r / rings) ** 1.25 * radius;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, -18, Math.sin(a) * rad);
      col.push(0.68, 0.62, 0.48);
    }
  }
  for (let s = 0; s < segs; s++) {
    idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  }
  for (let r = 0; r < rings - 1; r++) {
    const r0 = 1 + r * segs;
    const r1 = r0 + segs;
    for (let s = 0; s < segs; s++) {
      const s1 = (s + 1) % segs;
      idx.push(r0 + s, r0 + s1, r1 + s, r0 + s1, r1 + s1, r1 + s);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function buildKelpCoralGeometry(): THREE.BufferGeometry {
  // Unit tall frond/stalk with side leaf blades + basal coral dome.
  const pos: number[] = [];
  const col: number[] = [];
  const segs = 5;
  const h = 6.5;
  for (let i = 0; i < segs; i++) {
    const y0 = (i / segs) * h;
    const y1 = ((i + 1) / segs) * h;
    const w0 = 0.28 * (1 - (i / segs) * 0.55);
    const w1 = 0.28 * (1 - ((i + 1) / segs) * 0.55);
    const g0 = 0.34 + 0.22 * (i / segs);
    const g1 = 0.34 + 0.22 * ((i + 1) / segs);
    pos.push(-w0, y0, 0, w0, y0, 0, w1, y1, 0.15, -w0, y0, 0, w1, y1, 0.15, -w1, y1, 0.15);
    col.push(
      0.14,
      g0,
      0.2,
      0.14,
      g0,
      0.2,
      0.18,
      g1,
      0.24,
      0.14,
      g0,
      0.2,
      0.18,
      g1,
      0.24,
      0.18,
      g1,
      0.24,
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

function buildWreckGeometry(): THREE.BufferGeometry {
  // Sunken TBM Avenger / wreck silhouette: fuselage, wings, tail fin and broken ribs.
  const parts: [number, number, number, number, number, number, number][] = [
    [0, 0.8, 0, 11.5, 1.4, 1.6, 0x3b4d54], // fuselage
    [0.8, 0.6, 0, 2.7, 0.35, 16.5, 0x33444c], // Avenger wingspan 16.5 m
    [-5.4, 1.8, 0, 1.8, 2.2, 0.3, 0x475569], // tail fin
    [1.1, 1.5, 0, 3.8, 0.8, 1.1, 0x52646e], // greenhouse canopy frame
  ];
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  for (const [cx, cy, cz, sx, sy, sz, hex] of parts) {
    c.setHex(hex);
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const v = [
      [cx - hx, cy - hy, cz - hz],
      [cx + hx, cy - hy, cz - hz],
      [cx + hx, cy + hy, cz - hz],
      [cx - hx, cy + hy, cz - hz],
      [cx - hx, cy - hy, cz + hz],
      [cx + hx, cy - hy, cz + hz],
      [cx + hx, cy + hy, cz + hz],
      [cx - hx, cy + hy, cz + hz],
    ] as const;
    for (const f of [
      [0, 1, 2, 0, 2, 3],
      [5, 4, 7, 5, 7, 6],
      [4, 0, 3, 4, 3, 7],
      [1, 5, 6, 1, 6, 2],
      [3, 2, 6, 3, 6, 7],
    ] as const) {
      for (const i of f) {
        pos.push(v[i]![0], v[i]![1], v[i]![2]);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

const MAX_FLORA = 240;
const MAX_WRECKS = 16;
const MAX_SNOW = 180;

export class UnderwaterSceneryLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private enabled = true;

  private readonly seabedMesh: THREE.Mesh;
  private readonly seabedMat: THREE.MeshStandardMaterial;
  private readonly floraMesh: THREE.InstancedMesh;
  private readonly wreckMesh: THREE.InstancedMesh;
  private readonly snowPoints: THREE.Points;
  private readonly snowPos: THREE.BufferAttribute;
  private readonly snowMat: THREE.PointsMaterial;

  private lastSeabedX = Number.NaN;
  private lastSeabedZ = Number.NaN;
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpE = new THREE.Euler();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpC = new THREE.Color();

  constructor() {
    this.object.name = 'underwater-scenery';
    this.object.visible = false;

    this.seabedMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.92,
      metalness: 0.02,
    });
    this.seabedMesh = new THREE.Mesh(buildSeabedGeometry(), this.seabedMat);
    this.seabedMesh.name = 'underwater-seabed';
    this.seabedMesh.frustumCulled = false;
    this.object.add(this.seabedMesh);

    this.floraMesh = new THREE.InstancedMesh(buildKelpCoralGeometry(), this.seabedMat, MAX_FLORA);
    this.floraMesh.name = 'underwater-flora';
    this.floraMesh.frustumCulled = false;
    this.floraMesh.count = 0;
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < MAX_FLORA; i++) this.floraMesh.setColorAt(i, white);
    this.object.add(this.floraMesh);

    this.wreckMesh = new THREE.InstancedMesh(buildWreckGeometry(), this.seabedMat, MAX_WRECKS);
    this.wreckMesh.name = 'underwater-wrecks';
    this.wreckMesh.frustumCulled = false;
    this.wreckMesh.count = 0;
    this.object.add(this.wreckMesh);

    const snowGeo = new THREE.BufferGeometry();
    const sArr = new Float32Array(MAX_SNOW * 3);
    const rnd = mulberry32(0x5a0bc1);
    for (let i = 0; i < MAX_SNOW; i++) {
      sArr[i * 3] = (rnd() - 0.5) * 90;
      sArr[i * 3 + 1] = -rnd() * 24;
      sArr[i * 3 + 2] = (rnd() - 0.5) * 90;
    }
    this.snowPos = new THREE.BufferAttribute(sArr, 3);
    snowGeo.setAttribute('position', this.snowPos);
    this.snowMat = new THREE.PointsMaterial({
      size: 0.32,
      color: 0xa5f3fc,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.snowPoints = new THREE.Points(snowGeo, this.snowMat);
    this.snowPoints.name = 'underwater-snow';
    this.snowPoints.frustumCulled = false;
    this.object.add(this.snowPoints);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.object.visible = false;
  }

  /** Number of active draw calls in the current frame (0 when surfaced). */
  get activeDrawCalls(): number {
    if (!this.object.visible) return 0;
    let calls = this.seabedMesh.visible ? 1 : 0;
    if (this.floraMesh.visible && this.floraMesh.count > 0) calls++;
    if (this.wreckMesh.visible && this.wreckMesh.count > 0) calls++;
    if (this.snowPoints.visible) calls++;
    return calls;
  }

  update(frame: SceneryFrame): void {
    if (!this.enabled || !frame.underwater) {
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    const tier = frame.tier ?? 'full';
    const budget = UNDERWATER_BUDGET[tier];
    const camX = frame.camera.position.x;
    const camZ = frame.camera.position.z;
    const worldX = camX;
    const worldY = -camZ;

    // 1. Seabed mesh (always drawn when underwater, budget >= 1).
    if (Math.hypot(camX - this.lastSeabedX, camZ - this.lastSeabedZ) > 12) {
      this.lastSeabedX = camX;
      this.lastSeabedZ = camZ;
      this.seabedMesh.position.set(camX, 0, camZ);
      const pos = this.seabedMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const col = this.seabedMesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const atm = underwaterAtmosphere(
        frame.waterType ?? 'oceanic-ib',
        frame.daylight,
        frame.cameraDepth ?? 4,
      );
      for (let i = 0; i < pos.count; i++) {
        const vx = camX + pos.getX(i);
        const vz = camZ + pos.getZ(i);
        const d = seabedDepthAt(vx, -vz);
        pos.setY(i, -d);
        const caustic =
          atm.causticStrength *
          Math.max(0, Math.sin(vx * 0.35 + frame.t * 1.8) * Math.cos(vz * 0.35 - frame.t * 1.4));
        const sand = smoothstep(24, 10, d);
        col.setXYZ(
          i,
          0.32 + 0.38 * sand + caustic * 0.25,
          0.36 + 0.34 * sand + caustic * 0.35,
          0.34 + 0.24 * sand + caustic * 0.4,
        );
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
      this.seabedMesh.geometry.computeVertexNormals();
    }

    // `lite` tier stops at the seabed (1 draw call).
    if (budget <= 1) {
      this.floraMesh.visible = false;
      this.wreckMesh.visible = false;
      this.snowPoints.visible = false;
      return;
    }

    // 2. Kelp & coral instanced mesh (budget >= 2).
    const features = underwaterFeaturesNear(worldX, worldY);
    let floraIdx = 0;
    let wreckIdx = 0;
    for (const f of features) {
      if (f.kind === 'kelp' || f.kind === 'coral') {
        const rnd = mulberry32(f.seed);
        const isCoral = f.kind === 'coral';
        for (let k = 0; k < f.count && floraIdx < MAX_FLORA; k++) {
          const ox = f.x + (rnd() - 0.5) * (isCoral ? 16 : 24);
          const oy = f.y + (rnd() - 0.5) * (isCoral ? 16 : 24);
          const d = seabedDepthAt(ox, oy);
          const sway = isCoral ? 0 : kelpSwayAngle(frame.t, frame.hs, f.seed + k);
          this.tmpP.set(ox, -d, -oy);
          this.tmpE.set(sway, rnd() * Math.PI * 2, sway * 0.5);
          this.tmpQ.setFromEuler(this.tmpE);
          const sc = f.scale * (0.7 + 0.6 * rnd());
          this.tmpS.set(isCoral ? sc * 2.2 : sc, isCoral ? sc * 0.28 : sc, isCoral ? sc * 2.2 : sc);
          this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
          this.floraMesh.setMatrixAt(floraIdx, this.tmpM);
          if (isCoral) {
            this.tmpC.setHSL(0.92 - 0.8 * (k % 3) * 0.15, 0.75, 0.52);
          } else {
            this.tmpC.setRGB(0.22, 0.62 + 0.2 * (k % 3), 0.3);
          }
          this.floraMesh.setColorAt(floraIdx, this.tmpC);
          floraIdx++;
        }
      } else if (budget >= 3 && wreckIdx < MAX_WRECKS) {
        this.tmpP.set(f.x, -f.depth + 0.3, -f.y);
        this.tmpE.set(0.18, f.yaw, -0.22);
        this.tmpQ.setFromEuler(this.tmpE);
        this.tmpS.setScalar(f.scale * (f.kind === 'wreck-trawler' ? 1.4 : 1.0));
        this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
        this.wreckMesh.setMatrixAt(wreckIdx, this.tmpM);
        wreckIdx++;
      }
    }

    this.floraMesh.visible = floraIdx > 0;
    this.floraMesh.count = floraIdx;
    if (floraIdx > 0) {
      this.floraMesh.instanceMatrix.needsUpdate = true;
      if (this.floraMesh.instanceColor) this.floraMesh.instanceColor.needsUpdate = true;
    }

    // 3. Wrecks + 4. Marine snow / bioluminescence (full tier, budget >= 4).
    this.wreckMesh.visible = budget >= 3 && wreckIdx > 0;
    this.wreckMesh.count = wreckIdx;
    if (wreckIdx > 0) this.wreckMesh.instanceMatrix.needsUpdate = true;

    this.snowPoints.visible = budget >= 4;
    if (this.snowPoints.visible) {
      const atm = underwaterAtmosphere(
        frame.waterType ?? 'oceanic-ib',
        frame.daylight,
        frame.cameraDepth ?? 4,
      );
      this.snowPoints.position.set(camX, Math.sin(frame.t * 0.4) * 0.8, camZ);
      this.snowMat.color.setRGB(atm.snowTint[0], atm.snowTint[1], atm.snowTint[2]);
      this.snowMat.opacity = 0.45 + 0.45 * atm.bioStrength;
      this.snowMat.size = atm.bioStrength > 0.25 ? 0.42 : 0.28;
    }
  }

  dispose(): void {
    this.seabedMesh.geometry.dispose();
    this.floraMesh.geometry.dispose();
    this.floraMesh.dispose();
    this.wreckMesh.geometry.dispose();
    this.wreckMesh.dispose();
    this.seabedMat.dispose();
    this.snowPoints.geometry.dispose();
    this.snowMat.dispose();
    this.object.clear();
  }
}
