import { EnvironmentSchema, type Environment, type WaveSystem } from '../schema/experiment';

export function env(overrides: Partial<Environment> = {}): Environment {
  return EnvironmentSchema.parse({ ...overrides });
}

export function jonswap(
  hs: number,
  tp: number,
  overrides: Partial<Extract<WaveSystem, { kind: 'spectrum' }>> = {},
): WaveSystem {
  return {
    id: 'sea',
    name: 'Sea',
    kind: 'spectrum',
    enabled: true,
    spectrum: 'jonswap',
    hs,
    tp,
    gamma: 3.3,
    directionDeg: 270,
    depthLimited: true,
    spreading: { model: 'mitsuyasu', s: 10 },
    seed: 1234,
    ...overrides,
  };
}

export function regular(height: number, period: number, directionDeg = 270): WaveSystem {
  return {
    id: 'reg',
    name: 'Regular',
    kind: 'regular',
    enabled: true,
    height,
    period,
    directionDeg,
    phaseDeg: 0,
  };
}
