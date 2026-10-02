/** Defaults for objects the user adds to a scene. */
import {
  newId,
  type ProbeConfig,
  type VesselConfig,
  type VesselType,
  type WaveSystem,
} from '../schema/experiment';

const randomSeed = (): number => Math.floor(Math.random() * 0xffffffff);

export function newWaveSystem(kind: WaveSystem['kind'], count: number): WaveSystem {
  const base = { id: newId('wave'), enabled: true, directionDeg: 270 };
  switch (kind) {
    case 'spectrum':
      return {
        ...base,
        kind,
        name: `Wave spectrum ${count + 1}`,
        spectrum: 'jonswap',
        hs: 2,
        tp: 8,
        gamma: 3.3,
        depthLimited: true,
        spreading: { model: 'mitsuyasu', s: 10 },
        seed: randomSeed(),
      };
    case 'wind':
      return {
        ...base,
        kind,
        name: `Wind sea ${count + 1}`,
        followWeather: true,
        windSpeed: 12,
        fetchKm: 100,
        spreading: { model: 'mitsuyasu', s: 10 },
        seed: randomSeed(),
      };
    case 'regular':
      return {
        ...base,
        kind,
        name: `Regular waves ${count + 1}`,
        height: 1,
        period: 8,
        phaseDeg: 0,
      };
    case 'focused':
      return {
        ...base,
        kind,
        name: `Rogue wave ${count + 1}`,
        crestHeight: 12,
        tp: 12,
        focusX: 0,
        focusY: 0,
        focusTime: 60,
        seed: randomSeed(),
      };
  }
}

export const VESSEL_TYPE_LABELS: Record<VesselType, string> = {
  'box-barge': 'Box barge',
  wigley: 'Wigley hull (benchmark)',
  'cargo-ship': 'Container ship',
  trawler: 'Fishing trawler',
  'patrol-boat': 'Patrol boat',
  lifeboat: 'Lifeboat',
  'oil-tanker': 'Oil tanker (VLCC)',
  'aircraft-carrier': 'Aircraft carrier',
  'pirate-ship': 'Pirate ship (square-rigged)',
};

export function newVessel(type: VesselType, count: number): VesselConfig {
  const angle = count * 2.4;
  const r = count === 0 ? 0 : 60 + 25 * count;
  return {
    id: newId('vessel'),
    name: `${VESSEL_TYPE_LABELS[type].replace(/ \(.*\)$/, '')} ${count + 1}`,
    type,
    scale: 1,
    x: Math.round(r * Math.cos(angle)),
    y: Math.round(r * Math.sin(angle)),
    headingDeg: 0,
    speedKn: type === 'box-barge' ? 0 : type === 'pirate-ship' ? 5 : 6,
    autopilot: type !== 'box-barge',
    kgFactor: 0.6,
  };
}

export function newProbe(count: number): ProbeConfig {
  return {
    id: newId('probe'),
    name: `Wave gauge ${count + 1}`,
    kind: 'wave-gauge',
    x: 20 * (count + 1),
    y: -20 * (count + 1),
  };
}
