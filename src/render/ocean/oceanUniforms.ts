/**
 * Uniforms consumed by the shared ocean GLSL (materials/oceanChunks.ts): cascade textures and
 * parameters, regular Airy components and the LEAN slope-variance table.
 */
import { Vector4, type IUniform } from 'three';
import type { GpuOceanData } from '../../ocean/gpuData';
import { MAX_CASCADES, MAX_REGULAR_WAVES } from '../materials/oceanChunks';
import type { OceanSimulationGpu } from './OceanSimulationGpu';
import { SLOPE_TABLE_LEVELS, type OceanStats } from './oceanStats';

export type OceanUniforms = Record<string, IUniform>;

const TWO_PI = 2 * Math.PI;

export function createOceanUniforms(cascadeCount: number): OceanUniforms {
  const u: OceanUniforms = {
    uCascade: { value: Array.from({ length: MAX_CASCADES }, () => new Vector4(1, 1, 0, 0)) },
    uRegA: { value: Array.from({ length: MAX_REGULAR_WAVES }, () => new Vector4()) },
    uRegD: { value: Array.from({ length: MAX_REGULAR_WAVES }, () => new Vector4(1, 0, 1, 0)) },
    uRegCount: { value: 0 },
    uSlopeVar: { value: new Float32Array(MAX_CASCADES * SLOPE_TABLE_LEVELS) },
  };
  for (let i = 0; i < cascadeCount; i++) {
    u[`uDisp${i}`] = { value: null };
    u[`uDeriv${i}`] = { value: null };
    u[`uFoam${i}`] = { value: null };
  }
  return u;
}

/** Static per-sea parameters (call after every setOcean). */
export function bindOceanData(u: OceanUniforms, data: GpuOceanData, stats: OceanStats): void {
  const cascade = u.uCascade!.value as Vector4[];
  data.cascades.forEach((c, i) => {
    // (L, N, ½ texel in uv): spatial sample p sits at x = p·L/N, i.e. at the texel centre when
    // uv = x/L + ½/N.
    cascade[i]?.set(c.size, c.n, 0.5 / c.n, 0);
  });
  const table = u.uSlopeVar!.value as Float32Array;
  table.fill(0);
  stats.cascades.forEach((c, i) => table.set(c.unresolvedSlopeVariance, i * SLOPE_TABLE_LEVELS));
  const regD = u.uRegD!.value as Vector4[];
  const count = Math.min(MAX_REGULAR_WAVES, data.regular.length);
  for (let r = 0; r < count; r++) {
    const w = data.regular[r]!;
    regD[r]!.set(w.dirX, w.dirY, w.k > 0 ? TWO_PI / w.k : 1, 0);
  }
  u.uRegCount!.value = count;
}

/**
 * Per-frame values: current cascade textures and regular-wave phases. The phase φ − ωt is
 * reduced modulo 2π here in double precision, so long runs stay exact on the GPU.
 */
export function updateOceanUniforms(
  u: OceanUniforms,
  sim: OceanSimulationGpu | null,
  data: GpuOceanData,
  t: number,
): void {
  for (let i = 0; sim && i < sim.cascadeCount; i++) {
    const tex = sim.textures(i);
    if (!tex) continue;
    u[`uDisp${i}`]!.value = tex.displacement;
    u[`uDeriv${i}`]!.value = tex.derivatives;
    u[`uFoam${i}`]!.value = tex.foam;
  }
  const regA = u.uRegA!.value as Vector4[];
  const count = Math.min(MAX_REGULAR_WAVES, data.regular.length);
  for (let r = 0; r < count; r++) {
    const w = data.regular[r]!;
    let phase = (w.phase - w.omega * t) % TWO_PI;
    if (phase < 0) phase += TWO_PI;
    regA[r]!.set(w.amplitude, w.k, phase, data.choppiness * w.amplitude * w.cothKh);
  }
}
