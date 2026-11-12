/**
 * Render-only detail on the built-in vessels: deck-edge railings, a radar mast with a turning
 * scanner, navigation lights, lit windows after dark, container colours and corrugation, and hull
 * plating. Nothing here touches the vessel definition, so hydrostatics and windage are unchanged:
 * the boxes in `VesselDefinition.superstructure` stay the physical truth, and this only dresses
 * them.
 *
 * Coordinates: the vessel body frame (x forward, y port, z up, relative to the CoG) maps to the
 * group's Three.js axes as (x, z, −y), as in LabRenderer.
 *
 * Textures are generated from pure functions as DataTextures (no canvas), shared by every vessel
 * and never disposed: they are a few hundred kilobytes in all.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ModelPart } from '../scenery/models';
import type { VesselType } from '../../schema/experiment';
import type { VesselDefinition, VisualBox } from '../../vessel/api';

type V3 = [number, number, number];

// ---------------------------------------------------------------------------------------------
// What each vessel type gets
// ---------------------------------------------------------------------------------------------

export interface DetailKit {
  /** Railing along the deck edge, and what it is made of. */
  rails: 'steel' | 'wood' | null;
  radar: boolean;
  navLights: boolean;
  /** Steel plating on the hull (not on wooden or composite hulls). */
  plating: boolean;
}

const KITS: Record<VesselType, DetailKit> = {
  'box-barge': { rails: 'steel', radar: false, navLights: false, plating: true },
  wigley: { rails: null, radar: false, navLights: false, plating: false },
  'cargo-ship': { rails: 'steel', radar: true, navLights: true, plating: true },
  trawler: { rails: 'steel', radar: true, navLights: true, plating: true },
  'patrol-boat': { rails: 'steel', radar: true, navLights: true, plating: true },
  lifeboat: { rails: 'steel', radar: true, navLights: true, plating: false },
  'oil-tanker': { rails: 'steel', radar: true, navLights: true, plating: true },
  // The flight deck overhangs the hull: rails at the sheer would stand inside the hangar.
  'aircraft-carrier': { rails: null, radar: true, navLights: true, plating: true },
  'pirate-ship': { rails: 'wood', radar: false, navLights: false, plating: false },
  'sloop-yacht': { rails: null, radar: false, navLights: true, plating: false },
  submarine: { rails: null, radar: false, navLights: false, plating: false },
  catamaran: { rails: 'steel', radar: true, navLights: true, plating: false },
};

export function detailKit(type: VesselType): DetailKit {
  return KITS[type];
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers (pure)
// ---------------------------------------------------------------------------------------------

/**
 * The deck edge as a closed ring in the body frame, inset `inset` metres toward the centreline:
 * starboard from aft to bow, then port from bow to aft. Points closer than `minGap` to the one
 * before are dropped (the stations bunch up at a fine bow).
 */
export function deckRing(def: VesselDefinition, inset: number, minGap = 0.4): V3[] {
  const p = def.physicsHull.positions;
  const edge = def.deckEdgeVertices;
  const port: V3[] = [];
  const stbd: V3[] = [];
  for (let k = 0; k + 1 < edge.length; k += 2) {
    for (const [i, side] of [
      [edge[k]!, port],
      [edge[k + 1]!, stbd],
    ] as const) {
      const y = p[i * 3 + 1]!;
      const ay = Math.max(0, Math.abs(y) - inset);
      side.push([p[i * 3]!, Math.sign(y) * ay, p[i * 3 + 2]!]);
    }
  }
  stbd.sort((a, b) => a[0] - b[0]);
  port.sort((a, b) => b[0] - a[0]);
  const out: V3[] = [];
  for (const q of [...stbd, ...port]) {
    const last = out[out.length - 1];
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) < minGap) continue;
    out.push(q);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (
    first &&
    last &&
    out.length > 2 &&
    Math.hypot(first[0] - last[0], first[1] - last[1]) < minGap
  ) {
    out.pop();
  }
  return out;
}

/** Height of a deck railing [m]: about a metre on ships, lower on small boats. */
export function railHeight(length: number): number {
  return THREE.MathUtils.clamp(0.45 + length * 0.004, 0.6, 1.1);
}

/** A box spanning body-frame points a → b, `w` wide and `h` tall, in Three.js axes. */
function barBetween(a: V3, b: V3, w: number, h: number): THREE.BufferGeometry | null {
  const ta = new THREE.Vector3(a[0], a[2], -a[1]);
  const tb = new THREE.Vector3(b[0], b[2], -b[1]);
  const len = ta.distanceTo(tb);
  if (len < 1e-3) return null;
  const g = new THREE.BoxGeometry(len, h, w);
  const m = new THREE.Matrix4();
  const dir = tb.clone().sub(ta).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  m.compose(ta.clone().add(tb).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/**
 * Railing along a closed body-frame ring: a top rail, a mid rail and stanchions about every
 * `spacing` metres, merged into one geometry in Three.js axes.
 */
export function railGeometry(
  ring: V3[],
  height: number,
  spacing: number,
): THREE.BufferGeometry | null {
  if (ring.length < 3) return null;
  const parts: THREE.BufferGeometry[] = [];
  const t = THREE.MathUtils.clamp(height * 0.055, 0.035, 0.06);
  const up = (q: V3, dz: number): V3 => [q[0], q[1], q[2] + dz];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    for (const level of [height, height * 0.5]) {
      const bar = barBetween(up(a, level), up(b, level), t, t);
      if (bar) parts.push(bar);
    }
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const n = Math.max(1, Math.round(len / spacing));
    for (let k = 0; k < n; k++) {
      const u = k / n;
      const q: V3 = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
      const post = barBetween(q, up(q, height), t, t);
      if (post) parts.push(post);
    }
  }
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return merged;
}

/**
 * Remap a box's UVs to metres on each face (divided by the tile size), measured from the box's
 * bottom, so textures keep their real size whatever the box. Faces pointing up or down get
 * `roof`, a single texel of plain wall.
 */
export function worldUvs(
  geo: THREE.BufferGeometry,
  tileW: number,
  tileH: number,
  roof: [number, number] | null = null,
): void {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i) - bb.min.x;
    const y = pos.getY(i) - bb.min.y;
    const z = pos.getZ(i) - bb.min.z;
    if (ny >= nx && ny >= nz) {
      uv[i * 2] = roof ? roof[0] : x / tileW;
      uv[i * 2 + 1] = roof ? roof[1] : z / tileW;
    } else {
      uv[i * 2] = (nx >= nz ? z : x) / tileW;
      uv[i * 2 + 1] = y / tileH;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

/** Container liveries (sRGB): rust, blue, green, ochre, grey, white, maroon, teal. */
export const CONTAINER_COLORS = [
  0xa8432d, 0x2f5d8a, 0x3a7a4a, 0xc98d26, 0x8a8f94, 0xd7d9db, 0x7b3f5e, 0x1f5e6f,
] as const;

/** Colour of the container box at `center` on vessel `seed`: deterministic, varied. */
export function containerColor(seed: string, center: { x: number; y: number; z: number }): number {
  let h = 2166136261;
  const s = `${seed}:${center.x.toFixed(1)}:${center.y.toFixed(1)}:${center.z.toFixed(1)}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return CONTAINER_COLORS[(h >>> 0) % CONTAINER_COLORS.length]!;
}

/** Size of one container side as the container texture tiles it [m] (a 20 ft box). */
export const CONTAINER_TILE: [number, number] = [6.06, 2.59];

/** Paint a whole box in one colour through vertex colours. */
export function paintBox(geo: THREE.BufferGeometry, hex: number): void {
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

// ---------------------------------------------------------------------------------------------
// Textures (pure data)
// ---------------------------------------------------------------------------------------------

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hash2(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Height field → RGBA8 tangent-space normal map (tiling). */
function heightToNormals(h: Float32Array, w: number, ht: number, strength: number): Uint8Array {
  const out = new Uint8Array(w * ht * 4);
  for (let y = 0; y < ht; y++) {
    for (let x = 0; x < w; x++) {
      const at = (i: number, j: number) => h[((j + ht) % ht) * w + ((i + w) % w)]!;
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * w + x) * 4;
      out[o] = Math.round((-dx / len) * 127.5 + 127.5);
      out[o + 1] = Math.round((-dy / len) * 127.5 + 127.5);
      out[o + 2] = Math.round((1 / len) * 127.5 + 127.5);
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Deckhouse wall tile grid: 4 × 4 decks of 2.8 m. */
export const WINDOW_TILES = 4;
/** One deck's height and one window bay's width [m]. */
export const DECK_HEIGHT = 2.8;
/** UV of a plain-wall texel, used for deckhouse roofs. */
export const WALL_UV: [number, number] = [0.5 / WINDOW_TILES, 0.2 / WINDOW_TILES];

/**
 * Deckhouse walls: RGBA8 colour (white wall, dark glass, a darker deck stripe) and a glow
 * texture (warm light in about half the windows), both `size`² over 4 × 4 window bays.
 */
export function windowTextureData(size = 256): { color: Uint8Array; glow: Uint8Array } {
  const color = new Uint8Array(size * size * 4);
  const glow = new Uint8Array(size * size * 4);
  const tile = size / WINDOW_TILES;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tx = Math.floor(x / tile);
      const ty = Math.floor(y / tile);
      const u = (x % tile) / tile;
      const v = (y % tile) / tile;
      const win = (u > 0.12 && u < 0.42) || (u > 0.58 && u < 0.88);
      const inWin = win && v > 0.45 && v < 0.78;
      const stripe = v < 0.04;
      const o = (y * size + x) * 4;
      const wall = stripe ? 150 : 245;
      if (inWin) {
        // Glass: dark, a touch bluer at the top where it catches the sky.
        const sky = smooth(0.45, 0.78, v);
        color[o] = 40 + 25 * sky;
        color[o + 1] = 52 + 30 * sky;
        color[o + 2] = 64 + 40 * sky;
        const lit = hash2(tx * 2 + (u > 0.5 ? 1 : 0), ty) < 0.5;
        if (lit) {
          glow[o] = 255;
          glow[o + 1] = 205;
          glow[o + 2] = 140;
        }
      } else {
        color[o] = wall;
        color[o + 1] = wall;
        color[o + 2] = wall;
      }
      color[o + 3] = 255;
      glow[o + 3] = 255;
    }
  }
  return { color, glow };
}

/** Container side: greyscale colour (ribs, frame) and normal map, 128 × 64 over one 20 ft side. */
export function containerTextureData(): {
  color: Uint8Array;
  normal: Uint8Array;
  w: number;
  h: number;
} {
  const w = 128;
  const h = 64;
  const height = new Float32Array(w * h);
  const color = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      // Trapezoidal corrugation: 26 ribs along the side.
      const rib = smooth(0.2, 0.4, Math.abs(((u * 26) % 1) - 0.5) * 2);
      const frame = Math.min(u, 1 - u) * 6.06 < 0.12 || Math.min(v, 1 - v) * 2.59 < 0.1;
      height[y * w + x] = frame ? 1.2 : rib;
      const g = frame ? 150 : 205 + 40 * rib;
      const o = (y * w + x) * 4;
      color[o] = g;
      color[o + 1] = g;
      color[o + 2] = g;
      color[o + 3] = 255;
    }
  }
  return { color, normal: heightToNormals(height, w, h, 1.6), w, h };
}

/** Hull plating tile [m]: two 8 m plates by two 2.5 m strakes. */
export const PLATE_TILE: [number, number] = [16, 5];

/** Hull plating normal map: welded seams and slightly dished plates, `size`². */
export function plateNormalData(size = 256): Uint8Array {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x / size) * 2) % 1;
      const v = ((y / size) * 2) % 1;
      const seam = Math.min(
        smooth(0, 0.012, Math.min(u, 1 - u)),
        smooth(0, 0.03, Math.min(v, 1 - v)),
      );
      const dish = -0.25 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
      h[y * size + x] = seam + dish;
    }
  }
  return heightToNormals(h, size, size, 2.5);
}

/** Radial glow for navigation lights, RGBA8 `size`². */
export function glowData(size = 64): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.max(0, 1 - r) ** 2.2;
      const o = (y * size + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = 255;
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

function dataTexture(data: Uint8Array, w: number, h: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

let shared: {
  window: THREE.DataTexture;
  windowGlow: THREE.DataTexture;
  container: THREE.DataTexture;
  containerNormal: THREE.DataTexture;
  plate: THREE.DataTexture;
  glow: THREE.DataTexture;
} | null = null;

/** The shared detail textures, built on first use. */
export function detailTextures(): NonNullable<typeof shared> {
  if (!shared) {
    const win = windowTextureData();
    const box = containerTextureData();
    shared = {
      window: dataTexture(win.color, 256, 256, true),
      windowGlow: dataTexture(win.glow, 256, 256, true),
      container: dataTexture(box.color, box.w, box.h, true),
      containerNormal: dataTexture(box.normal, box.w, box.h, false),
      plate: dataTexture(plateNormalData(), 256, 256, false),
      glow: dataTexture(glowData(), 64, 64, false),
    };
    shared.glow.wrapS = shared.glow.wrapT = THREE.ClampToEdgeWrapping;
  }
  return shared;
}

// ---------------------------------------------------------------------------------------------
// Lit windows
// ---------------------------------------------------------------------------------------------

/** How strongly lit windows glow, shared by every vessel (0 by day). */
export const windowLight = { value: 0 };

/**
 * Give a deckhouse material its window texture and the after-dark glow. The glow goes in through
 * a shader hook rather than `emissive`, which the renderer keeps for the selection highlight.
 */
export function applyWindows(mat: THREE.MeshStandardMaterial): void {
  const tex = detailTextures();
  mat.map = tex.window;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindowGlow = { value: tex.windowGlow };
    shader.uniforms.uWindowLight = windowLight;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D uWindowGlow;\nuniform float uWindowLight;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += texture2D(uWindowGlow, vMapUv).rgb * uWindowLight;',
      );
  };
  mat.customProgramCacheKey = () => 'vessel-windows';
}

// ---------------------------------------------------------------------------------------------
// Per-vessel detail
// ---------------------------------------------------------------------------------------------

const NAV = {
  red: new THREE.Color(0xff2a1a),
  green: new THREE.Color(0x19ff5a),
  white: new THREE.Color(0xfff4dc),
};

let navMaterials: {
  bulb: Record<keyof typeof NAV, THREE.MeshBasicMaterial>;
  glow: Record<keyof typeof NAV, THREE.SpriteMaterial>;
} | null = null;

function navMats(): NonNullable<typeof navMaterials> {
  if (!navMaterials) {
    const glowTex = detailTextures().glow;
    const bulb = {} as Record<keyof typeof NAV, THREE.MeshBasicMaterial>;
    const glow = {} as Record<keyof typeof NAV, THREE.SpriteMaterial>;
    for (const k of Object.keys(NAV) as (keyof typeof NAV)[]) {
      bulb[k] = new THREE.MeshBasicMaterial({ color: NAV[k] });
      glow[k] = new THREE.SpriteMaterial({
        map: glowTex,
        color: NAV[k],
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0,
      });
    }
    navMaterials = { bulb, glow };
  }
  return navMaterials;
}

/** Fade navigation-light glows and window light with the night (0 day … 1 night). */
export function setVesselNight(night: number, dusk: number): void {
  const n = Math.min(1, Math.max(0, night + 0.5 * dusk));
  windowLight.value = 1.6 * n;
  if (!navMaterials) return;
  for (const m of Object.values(navMaterials.glow)) m.opacity = 0.15 + 0.85 * n;
}

/** The deckhouse that carries the bridge: the tallest one over the bridge station. */
export function bridgeHouse(def: VesselDefinition): VisualBox | null {
  const bx = def.points.bridge.x;
  let best: VisualBox | null = null;
  for (const b of def.superstructure) {
    if (b.material !== 'superstructure' || b.size.x < 1.5 || b.size.y < 1.5) continue;
    if (Math.abs(b.center.x - bx) > b.size.x / 2 + 0.5) continue;
    if (!best || b.center.z + b.size.z / 2 > best.center.z + best.size.z / 2) best = b;
  }
  return best;
}

export class VesselDetail {
  readonly group = new THREE.Group();
  /** Materials owned by this vessel (railings), for damage tint and disposal. */
  readonly materials: THREE.MeshStandardMaterial[] = [];
  private scanner: THREE.Object3D | null = null;
  private readonly phase: number;
  private lifebuoys: 'pending' | 'done' = 'pending';

  constructor(
    private readonly def: VesselDefinition,
    private readonly id: string,
    colors: { rail: number },
  ) {
    const kit = detailKit(def.type);
    this.phase = (id.length * 1.37) % (Math.PI * 2);
    const tag = (o: THREE.Object3D) => {
      o.userData.pickKind = 'vessel';
      o.userData.pickId = id;
    };

    if (kit.rails) {
      const ring = deckRing(def, 0.3);
      const geo = railGeometry(ring, railHeight(def.length), def.length < 20 ? 1 : 1.6);
      if (geo) {
        const mat = new THREE.MeshStandardMaterial({
          color: colors.rail,
          roughness: kit.rails === 'wood' ? 0.8 : 0.5,
          metalness: kit.rails === 'wood' ? 0 : 0.3,
        });
        this.materials.push(mat);
        const mesh = new THREE.Mesh(geo, mat);
        tag(mesh);
        this.group.add(mesh);
      }
    }

    const house = bridgeHouse(def);
    const s = THREE.MathUtils.clamp(def.length / 120, 0.3, 1.2);
    let mastTop: THREE.Vector3 | null = null;
    if (kit.radar && house) {
      const top = house.center.z + house.size.z / 2;
      const h = 2.6 * s;
      const x = house.center.x - house.size.x * 0.15;
      const mastMat =
        this.materials[0] ?? new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.5 });
      if (!this.materials.includes(mastMat)) this.materials.push(mastMat);
      const mast = new THREE.Mesh(new THREE.BoxGeometry(0.22 * s, h, 0.22 * s), mastMat);
      mast.position.set(x, top + h / 2, 0);
      tag(mast);
      this.group.add(mast);
      const scanner = new THREE.Mesh(new THREE.BoxGeometry(0.3 * s, 0.18 * s, 3.2 * s), mastMat);
      scanner.position.set(x, top + h + 0.1 * s, 0);
      tag(scanner);
      this.group.add(scanner);
      this.scanner = scanner;
      mastTop = new THREE.Vector3(x, top + h + 0.45 * s, 0);
    }

    if (kit.navLights) {
      const mats = navMats();
      const bulbGeo = new THREE.SphereGeometry(Math.max(0.08, 0.16 * s), 8, 6);
      const glowSize = Math.max(1.2, 4 * s);
      const add = (k: keyof typeof NAV, p: THREE.Vector3) => {
        const bulb = new THREE.Mesh(bulbGeo, mats.bulb[k]);
        bulb.position.copy(p);
        bulb.castShadow = false;
        tag(bulb);
        const glow = new THREE.Sprite(mats.glow[k]);
        glow.position.copy(p);
        glow.scale.setScalar(glowSize);
        this.group.add(bulb, glow);
      };
      const ring = deckRing(def, 0.1);
      const xs = ring.map((q) => q[0]);
      const aft = Math.min(...xs);
      const fwd = Math.max(...xs);
      const deckAt = (x: number) => {
        let z = 0;
        let best = Infinity;
        for (const q of ring) {
          const d = Math.abs(q[0] - x);
          if (d < best) {
            best = d;
            z = q[2];
          }
        }
        return z;
      };
      // Sidelights on the bridge wings (or the deck edge abreast the bridge), red to port.
      const bx = house ? house.center.x : def.points.bridge.x;
      const halfBeam = house ? house.size.y / 2 + 0.1 : def.beam / 2;
      const sz = house ? house.center.z + house.size.z / 2 - 0.5 * s : deckAt(bx) + 1.2 * s;
      add('red', new THREE.Vector3(bx, sz, -halfBeam));
      add('green', new THREE.Vector3(bx, sz, halfBeam));
      add('white', mastTop ?? new THREE.Vector3(fwd - def.length * 0.15, deckAt(fwd) + 3 * s, 0));
      add('white', new THREE.Vector3(aft + 0.2, deckAt(aft) + 1 * s, 0));
    }
  }

  /**
   * Hang lifebuoys (the CC0 model) on both sides of the bridge house, two a side, on ships that
   * carry them. Safe to call every frame: it only does anything once.
   */
  addLifebuoys(parts: ModelPart[]): void {
    if (this.lifebuoys !== 'pending') return;
    this.lifebuoys = 'done';
    const house = bridgeHouse(this.def);
    const kit = detailKit(this.def.type);
    if (!house || kit.rails !== 'steel' || !kit.radar || house.size.x < 4) return;
    const k = THREE.MathUtils.clamp(this.def.length / 60, 0.5, 1);
    const y = house.center.z - house.size.z / 2 + Math.min(1.7, house.size.z * 0.5);
    const m = new THREE.Matrix4();
    for (const part of parts) {
      const copies: THREE.BufferGeometry[] = [];
      for (const side of [-1, 1]) {
        for (const dx of [-0.28, 0.28]) {
          m.compose(
            new THREE.Vector3(
              house.center.x + dx * house.size.x,
              y - 0.4 * k,
              side * (house.size.y / 2 + 0.12),
            ),
            new THREE.Quaternion(),
            new THREE.Vector3(k, k, k),
          );
          copies.push(part.geometry.clone().applyMatrix4(m));
        }
      }
      const geo = mergeGeometries(copies);
      for (const g of copies) g.dispose();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, part.material);
      mesh.name = 'lifebuoys';
      mesh.userData.pickKind = 'vessel';
      mesh.userData.pickId = this.id;
      this.group.add(mesh);
    }
  }

  /** Turn the radar scanner. */
  update(t: number): void {
    if (this.scanner) this.scanner.rotation.y = this.phase + t * 2.4;
  }
}
