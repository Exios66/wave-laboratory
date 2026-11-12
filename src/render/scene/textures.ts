/** Small procedural textures: vessel details, and the fine structure of the sea surface. */
import * as THREE from 'three';
import { FFT } from '../../ocean/fft';

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (g) draw(g);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Black flag with a skull and crossed bones. */
export function jollyRogerTexture(): THREE.Texture {
  return canvasTexture(256, 160, (g) => {
    g.fillStyle = '#0b0b0b';
    g.fillRect(0, 0, 256, 160);
    g.strokeStyle = '#ededea';
    g.fillStyle = '#ededea';
    g.lineCap = 'round';
    g.lineWidth = 14;
    g.beginPath();
    g.moveTo(78, 128);
    g.lineTo(178, 58);
    g.moveTo(78, 58);
    g.lineTo(178, 128);
    g.stroke();
    g.beginPath();
    g.arc(128, 66, 34, 0, Math.PI * 2);
    g.fill();
    g.fillRect(108, 86, 40, 24);
    g.fillStyle = '#0b0b0b';
    g.beginPath();
    g.arc(115, 64, 9, 0, Math.PI * 2);
    g.arc(141, 64, 9, 0, Math.PI * 2);
    g.fill();
    g.fillRect(118, 98, 4, 12);
    g.fillRect(126, 98, 4, 12);
    g.fillRect(134, 98, 4, 12);
  });
}

/** Flight-deck paint: edge lines, a dashed centre line and yellow taxi lines. */
export function flightDeckTexture(): THREE.Texture {
  return canvasTexture(1024, 192, (g) => {
    g.fillStyle = '#3b4047';
    g.fillRect(0, 0, 1024, 192);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 400; i++) g.fillRect(Math.random() * 1024, Math.random() * 192, 6, 2);
    g.strokeStyle = '#e9ecef';
    g.lineWidth = 3;
    g.strokeRect(6, 6, 1012, 180);
    g.setLineDash([28, 22]);
    g.beginPath();
    g.moveTo(10, 96);
    g.lineTo(1014, 96);
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = '#facc15';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(560, 160);
    g.lineTo(1010, 40);
    g.moveTo(600, 170);
    g.lineTo(1010, 70);
    g.stroke();
  });
}

/** Slopes in the surface-detail texture are stored as s / (2 · range) + ½ in R and G. */
export const DETAIL_SLOPE_RANGE = 4;

/** Deterministic uniform [0, 1) generator (mulberry32), so every build draws the same sea. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * Tileable slope field of short wind ripples: a random-phase spectrum between 1/3 and 1/48 of
 * the tile with height amplitudes falling as k⁻² (the saturation range) and a mild cos² spread
 * about +x (the wind). Returns (∂η/∂x, ∂η/∂y) normalised so E[sx² + sy²] = 2.
 */
function rippleSlopes(size: number, seed: number): { sx: Float64Array; sy: Float64Array } {
  const rand = seeded(seed);
  const sx = new Float64Array(2 * size * size);
  const sy = new Float64Array(2 * size * size);
  const mMin = 3;
  const mMax = size / 5;
  for (let iy = 0; iy < size; iy++) {
    const my = iy < size / 2 ? iy : iy - size;
    for (let ix = 0; ix < size; ix++) {
      const mx = ix < size / 2 ? ix : ix - size;
      const g1 = gaussian(rand);
      const g2 = gaussian(rand);
      const m = Math.hypot(mx, my);
      if (m < mMin || m > mMax) continue;
      const cos = mx / m;
      // Soft band edges keep the field free of ringing.
      const edge = Math.min(1, (m - mMin + 1) / 2) * Math.min(1, (mMax - m + 1) / 4);
      const amp = (edge * (0.35 + 0.65 * cos * cos)) / (m * m);
      const re = amp * g1;
      const im = amp * g2;
      const c = 2 * (iy * size + ix);
      // ∂/∂x of Ĥ e^{ik·x} is i kx Ĥ.
      sx[c] = -mx * im;
      sx[c + 1] = mx * re;
      sy[c] = -my * im;
      sy[c + 1] = my * re;
    }
  }
  const fft = new FFT(size);
  fft.inverse2D(sx);
  fft.inverse2D(sy);
  let ms = 0;
  for (let i = 0; i < size * size; i++) ms += sx[2 * i]! ** 2 + sy[2 * i]! ** 2;
  const scale = Math.sqrt(2 / Math.max(ms / (size * size), 1e-30));
  for (let i = 0; i < size * size; i++) {
    sx[2 * i] = sx[2 * i]! * scale;
    sy[2 * i] = sy[2 * i]! * scale;
  }
  return { sx, sy };
}

/**
 * Tileable cellular (Worley) pattern: F2 − F1 to the feature points of a `cells`² grid, so it is
 * small along the walls between cells and large in their middles.
 */
function worleyEdges(size: number, cells: number, seed: number): Float32Array {
  const rand = seeded(seed);
  const pts = new Float32Array(2 * cells * cells);
  for (let i = 0; i < pts.length; i++) pts[i] = rand();
  const out = new Float32Array(size * size);
  const cellPx = size / cells;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x + 0.5) / cellPx;
      const fy = (y + 0.5) / cellPx;
      const cx = Math.floor(fx);
      const cy = Math.floor(fy);
      let f1 = 9;
      let f2 = 9;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx;
          const gy = cy + dy;
          const wx = ((gx % cells) + cells) % cells;
          const wy = ((gy % cells) + cells) % cells;
          const px = gx + pts[2 * (wy * cells + wx)]!;
          const py = gy + pts[2 * (wy * cells + wx) + 1]!;
          const d = Math.hypot(px - fx, py - fy);
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else if (d < f2) {
            f2 = d;
          }
        }
      }
      out[y * size + x] = f2 - f1;
    }
  }
  return out;
}

/** Tileable value-noise fbm in [0, 1], octaves from `cells` cells per tile upward. */
function tileFbm(size: number, cells: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const g = cells << o;
    const rand = seeded(seed + o * 101);
    const lattice = new Float32Array(g * g);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    for (let y = 0; y < size; y++) {
      const v = ((y + 0.5) * g) / size;
      const y0 = Math.floor(v);
      const ty = v - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const u = ((x + 0.5) * g) / size;
        const x0 = Math.floor(u);
        const tx = u - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const at = (i: number, j: number) => lattice[(j % g) * g + (i % g)]!;
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
        out[y * size + x] = out[y * size + x]! + amp * (a + (b - a) * sy);
      }
    }
    norm += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}

/**
 * RGBA8 texels of the sea's surface-detail texture, `size`² and tileable:
 *   R, G = ripple slopes (∂η/∂x, ∂η/∂y) / (2 · DETAIL_SLOPE_RANGE) + ½, E[sx² + sy²] = 2
 *   B    = foam lace: bright walls between bubbles of two sizes
 *   A    = foam body: soft fbm that sets where the lace thins out first
 */
export function surfaceDetailData(size = 256): Uint8Array {
  const { sx, sy } = rippleSlopes(size, 0x5eed);
  const big = worleyEdges(size, 12, 0xb0b);
  const small = worleyEdges(size, 32, 0xb1b);
  const body = tileFbm(size, 4, 5, 0xf0a);
  const data = new Uint8Array(4 * size * size);
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let i = 0; i < size * size; i++) {
    const wallBig = 1 - smoothstepJs(0.0, 0.22, big[i]!);
    const wallSmall = 1 - smoothstepJs(0.0, 0.3, small[i]!);
    // Inside the big bubbles the film is thinner but not empty: small bubbles fill them.
    const lace = Math.max(wallBig, 0.6 * wallSmall);
    data[4 * i] = byte(sx[2 * i]! / (2 * DETAIL_SLOPE_RANGE) + 0.5);
    data[4 * i + 1] = byte(sy[2 * i]! / (2 * DETAIL_SLOPE_RANGE) + 0.5);
    data[4 * i + 2] = byte(lace);
    data[4 * i + 3] = byte(body[i]!);
  }
  return data;
}

function smoothstepJs(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The surface-detail texture (see surfaceDetailData), mipmapped and repeating. */
export function surfaceDetailTexture(size = 256): THREE.DataTexture {
  const tex = new THREE.DataTexture(surfaceDetailData(size), size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}
