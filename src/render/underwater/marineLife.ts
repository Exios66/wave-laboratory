/**
 * Underwater fauna renderer (issue #53): schools of baitfish, reef fish on the coral, kelp and
 * wreck sites, tuna, gliding rays and pulsing jellyfish.
 *
 * Placement and motion are the pure functions in `marineLifeModel.ts`; this layer owns one
 * `InstancedMesh` per species (one draw call each) and rewrites the instance matrices every
 * frame with no allocation. Tails, wings and bells animate in the vertex shader. The plan (which
 * schools occupy which instance slots) is rebuilt only when the camera has moved a fair way.
 *
 * Draw-call budget (`MARINE_BUDGET`): full 6, mid 3, lite 1 (jellyfish only). Surfaced
 * (`!frame.underwater`) the group is hidden and nothing updates.
 *
 * The absorption pass fades red first, so the palettes lean blue, green and silver, with a small
 * emissive floor so fish stay readable at depth. Jellyfish glow brighter at night.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SceneryFrame, SceneryLayer } from '../scenery/types';
import {
  fishPose,
  makeFishPose,
  MARINE_BUDGET,
  planMarineLife,
  unitHash,
  type MarinePlan,
  type MarineSpecies,
  type ReefSite,
  type SchoolSpec,
} from './marineLifeModel';
import { seabedDepthAt, underwaterFeaturesInCell, UW_CELL } from './scenery';

/** The plan is rebuilt once the camera is this far [m] from where it was last made. */
const REPLAN_DISTANCE = 20;

type Wiggle = 'tail' | 'wing' | 'bell';

const WIGGLE_GLSL: Record<Wiggle, string> = {
  tail: /* glsl */ `
    float ph = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 2.3;
    float tailK = clamp(0.3 - position.x, 0.0, 1.0);
    transformed.z += sin(uTime * uFreq + ph - position.x * 5.0) * uAmp * tailK * tailK * 3.0;
  `,
  wing: /* glsl */ `
    float ph = instanceMatrix[3].x * 0.9 + instanceMatrix[3].z * 1.1;
    transformed.y += sin(uTime * uFreq + ph) * uAmp * abs(position.z);
  `,
  bell: /* glsl */ `
    float ph = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.9;
    float pulse = sin(uTime * uFreq + ph);
    float rim = smoothstep(-0.6, 0.4, position.y);
    transformed.xz *= 1.0 + uAmp * pulse * rim;
    transformed.y *= 1.0 - 0.5 * uAmp * pulse;
    transformed.xz += 0.06 * sin(uTime * 1.3 + ph + position.y * 5.0) * max(0.0, -position.y);
  `,
};

function animate(
  mat: THREE.Material,
  kind: Wiggle,
  time: { value: number },
  freq: number,
  amp: number,
): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.uFreq = { value: freq };
    shader.uniforms.uAmp = { value: amp };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uTime;\nuniform float uFreq;\nuniform float uAmp;',
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIGGLE_GLSL[kind]}`);
  };
  mat.customProgramCacheKey = () => `marine-${kind}-${freq}-${amp}`;
}

function strip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  return g;
}

/** Fish: lens-shaped body along +x with a tail cone behind it. Length 1. */
function fishGeometry(): THREE.BufferGeometry {
  const body = strip(new THREE.SphereGeometry(0.5, 10, 7));
  body.scale(0.9, 0.34, 0.16);
  body.translate(0.05, 0, 0);
  const tail = strip(new THREE.ConeGeometry(0.2, 0.34, 4));
  tail.rotateZ(Math.PI / 2);
  tail.scale(1, 1, 0.3);
  tail.translate(-0.55, 0, 0);
  const fin = strip(new THREE.ConeGeometry(0.1, 0.24, 3));
  fin.translate(0.0, 0.26, 0);
  const g = mergeGeometries([body, tail, fin], false)!;
  body.dispose();
  tail.dispose();
  fin.dispose();
  return g;
}

/** Ray: flattened disc, wings along z, a whip tail behind. Wingspan ~1.6. */
function rayGeometry(): THREE.BufferGeometry {
  const disc = strip(new THREE.SphereGeometry(0.5, 12, 6));
  disc.scale(0.75, 0.07, 1.6);
  const tail = strip(new THREE.ConeGeometry(0.03, 1.1, 4));
  tail.rotateZ(Math.PI / 2);
  tail.translate(-0.95, 0, 0);
  const g = mergeGeometries([disc, tail], false)!;
  disc.dispose();
  tail.dispose();
  return g;
}

/** Jellyfish: hemispherical bell (open side down) with a few trailing tentacles. */
function jellyGeometry(): THREE.BufferGeometry {
  const bell = strip(new THREE.SphereGeometry(0.5, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2));
  const parts: THREE.BufferGeometry[] = [bell];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const t = strip(new THREE.ConeGeometry(0.025, 1.0, 3, 4));
    t.rotateX(Math.PI);
    t.translate(0.28 * Math.cos(a), -0.5, 0.28 * Math.sin(a));
    parts.push(t);
  }
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return g;
}

interface SpeciesStyle {
  /** Instance colours: [r, g, b] bases, picked per fish. */
  palette: readonly (readonly [number, number, number])[];
}

const STYLE: Record<MarineSpecies, SpeciesStyle> = {
  baitfish: {
    palette: [
      [0.75, 0.9, 1.0],
      [0.6, 0.85, 0.95],
      [0.85, 0.95, 0.9],
    ],
  },
  reef: {
    palette: [
      [0.3, 0.8, 1.0],
      [0.4, 1.0, 0.7],
      [1.0, 0.9, 0.3],
      [0.7, 0.45, 1.0],
    ],
  },
  tuna: {
    palette: [
      [0.3, 0.5, 0.8],
      [0.35, 0.55, 0.7],
    ],
  },
  ray: {
    palette: [
      [0.4, 0.55, 0.7],
      [0.3, 0.45, 0.55],
    ],
  },
  shark: {
    palette: [
      [0.45, 0.55, 0.65],
      [0.5, 0.58, 0.6],
    ],
  },
  jelly: {
    palette: [
      [0.7, 0.85, 1.0],
      [0.9, 0.75, 1.0],
      [0.6, 1.0, 0.95],
    ],
  },
};

interface SpeciesMesh {
  species: MarineSpecies;
  mesh: THREE.InstancedMesh;
  mat: THREE.Material;
  /** Schools assigned to this species in the current plan. */
  schools: SchoolSpec[];
}

export class MarineLifeLayer implements SceneryLayer {
  readonly object = new THREE.Group();
  private enabled = true;
  private readonly time = { value: 0 };
  private readonly meshes: SpeciesMesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly jellyMat: THREE.MeshBasicMaterial;
  private readonly pose = makeFishPose();
  private readonly sites: ReefSite[] = [];
  private plan: MarinePlan | null = null;
  private planX = Number.NaN;
  private planY = Number.NaN;
  private planTier = '';

  constructor() {
    this.object.name = 'marine-life';
    this.object.visible = false;
    const fishGeo = fishGeometry();
    const rayGeo = rayGeometry();
    const jellyGeo = jellyGeometry();
    this.geometries.push(fishGeo, rayGeo, jellyGeo);

    this.jellyMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    animate(this.jellyMat, 'bell', this.time, 1.7, 0.16);

    const lambert = (kind: Wiggle, freq: number, amp: number): THREE.MeshLambertMaterial => {
      const m = new THREE.MeshLambertMaterial({
        emissive: new THREE.Color(0x3a7f99),
        side: kind === 'wing' ? THREE.DoubleSide : THREE.FrontSide,
      });
      animate(m, kind, this.time, freq, amp);
      return m;
    };

    const defs: { sp: MarineSpecies; geo: THREE.BufferGeometry; mat: THREE.Material }[] = [
      { sp: 'baitfish', geo: fishGeo, mat: lambert('tail', 11, 0.1) },
      { sp: 'reef', geo: fishGeo, mat: lambert('tail', 8, 0.1) },
      { sp: 'tuna', geo: fishGeo, mat: lambert('tail', 6, 0.08) },
      { sp: 'shark', geo: fishGeo, mat: lambert('tail', 3.5, 0.07) },
      { sp: 'ray', geo: rayGeo, mat: lambert('wing', 1.6, 0.4) },
      { sp: 'jelly', geo: jellyGeo, mat: this.jellyMat },
    ];
    for (const d of defs) {
      // Full-tier caps are the largest; lower tiers just use fewer slots.
      const cap = MARINE_BUDGET.full.caps[d.sp] ?? 0;
      const mesh = new THREE.InstancedMesh(d.geo, d.mat, cap);
      mesh.name = `marine-${d.sp}`;
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Allocate the colour attribute up front so the plan only rewrites it.
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      this.object.add(mesh);
      this.meshes.push({ species: d.sp, mesh, mat: d.mat, schools: [] });
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.object.visible = false;
  }

  /** Number of active draw calls this frame (0 when surfaced). */
  get activeDrawCalls(): number {
    if (!this.object.visible) return 0;
    let n = 0;
    for (const m of this.meshes) if (m.mesh.visible && m.mesh.count > 0) n++;
    return n;
  }

  /** Instances drawn this frame, all species. */
  get activeInstances(): number {
    if (!this.object.visible) return 0;
    let n = 0;
    for (const m of this.meshes) if (m.mesh.visible) n += m.mesh.count;
    return n;
  }

  private gatherSites(wx: number, wy: number): void {
    this.sites.length = 0;
    const ix = Math.floor(wx / UW_CELL);
    const iy = Math.floor(wy / UW_CELL);
    for (let j = iy - 1; j <= iy + 1; j++) {
      for (let i = ix - 1; i <= ix + 1; i++) {
        for (const f of underwaterFeaturesInCell(i, j)) {
          this.sites.push({ id: f.id, x: f.x, y: f.y, seed: f.seed });
        }
      }
    }
  }

  private replan(wx: number, wy: number, tier: SceneryFrame['tier']): void {
    const t = tier ?? 'full';
    this.gatherSites(wx, wy);
    this.plan = planMarineLife(wx, wy, t, this.sites);
    this.planX = wx;
    this.planY = wy;
    this.planTier = t;
    const col = new THREE.Color();
    for (const m of this.meshes) {
      m.schools.length = 0;
      m.mesh.count = this.plan.totals[m.species];
      m.mesh.visible = m.mesh.count > 0;
    }
    const slot: Partial<Record<MarineSpecies, number>> = {};
    for (const s of this.plan.schools) {
      const m = this.meshes.find((x) => x.species === s.species)!;
      m.schools.push(s);
      const pal = STYLE[s.species].palette;
      let at = slot[s.species] ?? 0;
      for (let i = 0; i < s.count; i++, at++) {
        const c = pal[Math.floor(unitHash(s.seed, i * 7 + 99) * pal.length) % pal.length]!;
        const v = 0.85 + 0.3 * unitHash(s.seed, i * 7 + 98);
        col.setRGB(c[0] * v, c[1] * v, c[2] * v);
        m.mesh.setColorAt(at, col);
      }
      slot[s.species] = at;
    }
    for (const m of this.meshes) {
      if (m.mesh.instanceColor) m.mesh.instanceColor.needsUpdate = true;
    }
  }

  update(frame: SceneryFrame): void {
    if (!this.enabled || !frame.underwater) {
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    const cam = frame.camera.position;
    // Three.js (x, y up, z) -> world (x east, y north).
    const wx = cam.x;
    const wy = -cam.z;
    const tier = frame.tier ?? 'full';
    if (
      this.plan === null ||
      tier !== this.planTier ||
      Math.hypot(wx - this.planX, wy - this.planY) > REPLAN_DISTANCE
    ) {
      this.replan(wx, wy, tier);
    }

    // Time in a bounded range keeps float precision for the shader phase.
    this.time.value = frame.wallT % 4000;
    const night = 1 - Math.min(1, Math.max(0, frame.daylight));
    const glow = 0.55 + 0.9 * night;
    this.jellyMat.color.setRGB(glow, glow, glow);
    this.jellyMat.opacity = 0.42 + 0.35 * night;

    const t = frame.t;
    const pose = this.pose;
    for (const m of this.meshes) {
      if (!m.mesh.visible) continue;
      const arr = m.mesh.instanceMatrix.array as Float32Array;
      const upright = m.species === 'jelly';
      let o = 0;
      for (const s of m.schools) {
        for (let i = 0; i < s.count; i++, o += 16) {
          fishPose(s, i, t, seabedDepthAt, frame.hs, pose);
          const yaw = upright ? s.phase : pose.yaw;
          const c = Math.cos(yaw) * pose.scale * 6;
          const sn = Math.sin(yaw) * pose.scale * 6;
          arr[o] = c;
          arr[o + 1] = 0;
          arr[o + 2] = -sn;
          arr[o + 3] = 0;
          arr[o + 4] = 0;
          arr[o + 5] = pose.scale * 6;
          arr[o + 6] = 0;
          arr[o + 7] = 0;
          arr[o + 8] = sn;
          arr[o + 9] = 0;
          arr[o + 10] = c;
          arr[o + 11] = 0;
          arr[o + 12] = pose.x;
          arr[o + 13] = -pose.depth;
          arr[o + 14] = -pose.y;
          arr[o + 15] = 1;
        }
      }
      m.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.mesh.dispose();
      m.mat.dispose();
    }
    for (const g of this.geometries) g.dispose();
    this.meshes.length = 0;
    this.object.clear();
  }
}
