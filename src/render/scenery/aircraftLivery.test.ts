import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ATLAS_RECTS,
  insigniaSpots,
  liveryFor,
  paintAtlas,
  projectUv,
  remapUv,
  texelIndex,
  type AtlasRegion,
} from './aircraftLivery';

/** sRGB bytes → CIE L*a*b* (D65), for colour-difference checks. */
function lab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(rgb: ArrayLike<number>, at: number, hex: number): number {
  const a = lab(rgb[at]!, rgb[at + 1]!, rgb[at + 2]!);
  const b = lab((hex >> 16) & 255, (hex >> 8) & 255, hex & 255);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('aircraft liveries', () => {
  it('paints the same atlas every time', () => {
    const a = paintAtlas(liveryFor('avenger'), 256);
    const b = paintAtlas(liveryFor('avenger'), 256);
    expect(sameBytes(a.albedo, b.albedo)).toBe(true);
    expect(sameBytes(a.roughness, b.roughness)).toBe(true);
    expect(sameBytes(a.normal, b.normal)).toBe(true);
    expect(a.albedo.length).toBe(256 * 256 * 4);
    expect(a.roughness.length).toBe(256 * 256);
    expect(a.normal.length).toBe(256 * 256 * 3);
  });

  it('paints the Avenger underside white', () => {
    const r = ATLAS_RECTS.wingBottom;
    const at = texelIndex(256, (r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2) * 4;
    expect(deltaE(paintAtlas(liveryFor('avenger'), 256).albedo, at, 0xe8eaec)).toBeLessThan(3);
  });

  it('paints a white star on a blue disc for the fuselage insignia', () => {
    const livery = liveryFor('avenger');
    const { albedo } = paintAtlas(livery, 512);
    const spots = insigniaSpots(livery, 512).filter((s) => s.region === 'fuselage');
    expect(spots.length).toBeGreaterThan(0);
    for (const s of spots) {
      const c = (Math.round(s.y) * 512 + Math.round(s.x)) * 4;
      expect(albedo[c]).toBeGreaterThan(225);
      expect(albedo[c + 1]).toBeGreaterThan(225);
      expect(albedo[c + 2]).toBeGreaterThan(225);
      for (const sign of [1, -1]) {
        const d = (Math.round(s.y) * 512 + Math.round(s.x + sign * 0.9 * s.rx)) * 4;
        expect(deltaE(albedo, d, 0x1f2f4a)).toBeLessThan(6);
      }
    }
  });

  it('keeps roughness in the paint-to-aluminium range', () => {
    for (const kind of ['avenger', 'mariner', 'dc3', 'tudor'] as const) {
      const { roughness } = paintAtlas(liveryFor(kind), 256);
      let lo = 255;
      let hi = 0;
      for (const b of roughness) {
        lo = Math.min(lo, b);
        hi = Math.max(hi, b);
      }
      expect(lo).toBeGreaterThanOrEqual(Math.floor(0.2 * 255));
      expect(hi).toBeLessThanOrEqual(Math.ceil(0.7 * 255));
    }
  });

  it('keeps the normal map pointing out of the surface', () => {
    for (const kind of ['avenger', 'tudor'] as const) {
      const { normal } = paintAtlas(liveryFor(kind), 256);
      let minZ = 1;
      for (let i = 0; i < normal.length; i += 3)
        minZ = Math.min(minZ, (normal[i + 2]! / 255) * 2 - 1);
      expect(minZ).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('gives the DC-3 bare metal and no military insignia', () => {
    const l = liveryFor('dc3');
    expect(l.metal).toBe(true);
    expect(l.insignia).toBeNull();
    expect(insigniaSpots(l, 256)).toEqual([]);
  });

  it('remaps a geometry into its atlas region', () => {
    for (const region of Object.keys(ATLAS_RECTS) as AtlasRegion[]) {
      const g = remapUv(new THREE.CylinderGeometry(1, 0.5, 4, 16), region);
      const r = ATLAS_RECTS[region];
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        expect(uv.getX(i)).toBeGreaterThanOrEqual(r.u0);
        expect(uv.getX(i)).toBeLessThanOrEqual(r.u1);
        expect(uv.getY(i)).toBeGreaterThanOrEqual(r.v0);
        expect(uv.getY(i)).toBeLessThanOrEqual(r.v1);
      }
    }
  });

  it('projects by facing, clamped into the chosen region', () => {
    const g = projectUv(new THREE.BoxGeometry(2, 0.2, 6), (p, n) => ({
      region: n.y < -0.5 ? 'wingBottom' : 'wingTop',
      u: p.x + 0.5,
      v: Math.abs(p.z) * 2,
    }));
    const uv = g.getAttribute('uv');
    const normal = g.getAttribute('normal');
    for (let i = 0; i < uv.count; i++) {
      const r = normal.getY(i) < -0.5 ? ATLAS_RECTS.wingBottom : ATLAS_RECTS.wingTop;
      expect(uv.getX(i)).toBeGreaterThanOrEqual(r.u0);
      expect(uv.getX(i)).toBeLessThanOrEqual(r.u1);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(r.v0);
      expect(uv.getY(i)).toBeLessThanOrEqual(r.v1);
    }
  });
});
