/**
 * Built-in experiment presets. Each one is a complete, valid experiment document with a short
 * explanation of what it demonstrates.
 */
import { WEATHER_PRESETS } from '../weather/presets';
import {
  EnvironmentSchema,
  ExperimentSchema,
  SCHEMA_VERSION,
  type Weather,
  type Environment,
  type Experiment,
  type ProbeConfig,
  type VesselConfig,
  type WaveSystem,
} from './experiment';

export interface Preset {
  id: string;
  title: string;
  summary: string;
  experiment: Experiment;
}

const env = (o: Partial<Environment> = {}): Environment => EnvironmentSchema.parse(o);

const spreading = (s: number, model: 'mitsuyasu' | 'cos2s' | 'donelan-banner' = 'mitsuyasu') => ({
  model,
  s,
});

const gauge = (x = 0, y = 0, id = 'gauge-1', name = 'Wave gauge'): ProbeConfig => ({
  id,
  name,
  kind: 'wave-gauge',
  x,
  y,
});

const vessel = (
  id: string,
  type: VesselConfig['type'],
  name: string,
  o: Partial<VesselConfig> = {},
): VesselConfig => ({
  id,
  name,
  type,
  scale: 1,
  x: 0,
  y: 0,
  headingDeg: 0,
  speedKn: 0,
  autopilot: true,
  kgFactor: 0.6,
  loadFactor: 1,
  ...o,
});

function experiment(
  name: string,
  description: string,
  environment: Environment,
  waves: WaveSystem[],
  vessels: VesselConfig[],
  probes: ProbeConfig[],
  weather?: Weather,
): Experiment {
  return ExperimentSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    name,
    description,
    environment,
    ...(weather ? { weather } : {}),
    waves,
    vessels,
    probes,
    timestep: 1 / 120,
    quality: 'high',
  });
}

/** Weather of a named situation (see `weather/presets.ts`), optionally adjusted. */
function weatherOf(id: string, o: Partial<Weather> = {}): Weather {
  const p = WEATHER_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown weather preset ${id}`);
  return { ...structuredClone(p.weather), ...o };
}

const weatherSea = (
  id: string,
  name: string,
  fetchKm: number,
  seed: number,
  s = 8,
): WaveSystem => ({
  id,
  name,
  kind: 'wind',
  enabled: true,
  followWeather: true,
  windSpeed: 10,
  fetchKm,
  directionDeg: 0,
  spreading: spreading(s),
  seed,
});

export const PRESETS: readonly Preset[] = [
  {
    id: 'moderate-sea',
    title: 'Moderate sea · container ship',
    summary:
      'A JONSWAP wind sea (Hs 2.5 m, Tp 9 s) meeting a 120 m container ship head-on at 12 knots.',
    experiment: experiment(
      'Moderate sea · container ship',
      'Sea state 4 (moderate). Watch pitch dominate in head seas and compare the gauge spectrum ' +
        'with the requested JONSWAP shape.',
      env({ windSpeed: 11, windDirectionDeg: 0 }),
      [
        {
          id: 'sea-1',
          name: 'Wind sea',
          kind: 'spectrum',
          enabled: true,
          spectrum: 'jonswap',
          hs: 2.5,
          tp: 9,
          gamma: 3.3,
          directionDeg: 0,
          depthLimited: true,
          spreading: spreading(10),
          seed: 20240,
        },
      ],
      [vessel('ship-1', 'cargo-ship', 'MV Meridian', { headingDeg: 0, speedKn: 12 })],
      [gauge(-120, 60)],
    ),
  },
  {
    id: 'rogue-wave',
    title: 'Rogue wave · container ship',
    summary:
      'A Draupner-class 17 m focused crest rises out of a 6 m sea right in front of a ship at ' +
      't = 75 s.',
    experiment: experiment(
      'Rogue wave · container ship',
      'A NewWave focused group (crest 17 m, like the 1995 Draupner wave) builds out of a ' +
        'Hs 6 m storm sea and peaks at the gauge, 380 m ahead of the ship, at t = 75 s. Use ' +
        'the Follow camera and watch the bow slam and take green water.',
      env({ windSpeed: 20, windDirectionDeg: 0, sunElevationDeg: 14 }),
      [
        {
          id: 'storm-sea',
          name: 'Storm sea',
          kind: 'spectrum',
          enabled: true,
          spectrum: 'jonswap',
          hs: 6,
          tp: 11,
          gamma: 3.3,
          directionDeg: 0,
          depthLimited: true,
          spreading: spreading(12),
          seed: 1995,
        },
        {
          id: 'rogue',
          name: 'Rogue wave',
          kind: 'focused',
          enabled: true,
          crestHeight: 17,
          tp: 12,
          focusX: 0,
          focusY: 380,
          focusTime: 75,
          directionDeg: 0,
          seed: 1,
        },
      ],
      [vessel('ship-1', 'cargo-ship', 'MV Draupner', { headingDeg: 0, speedKn: 10 })],
      [gauge(0, 380, 'gauge-1', 'Focus gauge')],
      weatherOf('gale', { rainMmH: 6 }),
    ),
  },
  {
    id: 'agulhas-current',
    title: 'Agulhas Current · light bulk carrier',
    summary:
      'A ballasted ship runs down the Agulhas Current off South Africa against a Southern Ocean ' +
      'swell: the current sets it along and Doppler shortens the waves it meets.',
    experiment: experiment(
      'Agulhas Current · light bulk carrier',
      'The Agulhas Current flows south-west at up to 2 m/s, straight into the swell arriving ' +
        'from the Southern Ocean, and is notorious for freak waves. Here a 1.8 m/s current runs ' +
        'against a 12 s swell and a ship loaded to 60 % of its design displacement (high ' +
        'freeboard, red bottom paint showing) heads down-current. The current is uniform: the ' +
        'waves are Doppler shifted, but the steepening on the current edge is not modelled.',
      env({
        currentSpeed: 1.8,
        currentDirectionDeg: 225,
        windSpeed: 12,
        windDirectionDeg: 225,
        sunElevationDeg: 35,
      }),
      [
        {
          id: 'swell-1',
          name: 'Southern Ocean swell',
          kind: 'spectrum',
          enabled: true,
          spectrum: 'jonswap',
          hs: 4,
          tp: 12,
          gamma: 5,
          directionDeg: 225,
          depthLimited: true,
          spreading: spreading(40),
          seed: 1858,
        },
      ],
      [
        vessel('ship-1', 'cargo-ship', 'MV Cape Agulhas', {
          headingDeg: 225,
          speedKn: 12,
          loadFactor: 0.6,
        }),
      ],
      [gauge(0, -150)],
    ),
  },
  {
    id: 'hurricane',
    title: 'Hurricane · tanker and carrier',
    summary:
      'Beaufort 12 with squalls, violent rain and lightning: a VLCC and an aircraft carrier ' +
      'head into a 10 m sea the wind raises itself.',
    experiment: experiment(
      'Hurricane · tanker and carrier',
      'A 42 m/s hurricane wind blows over 200 km of fetch and raises its own sea (follow the ' +
        'weather), with rain bands sweeping through as squalls. Even 330 m ships pitch hard, ' +
        'and the carrier’s huge wind profile fights its autopilot.',
      env({ windSpeed: 42, windDirectionDeg: 120, sunElevationDeg: 15 }),
      [weatherSea('hurricane-sea', 'Hurricane sea', 200, 4242, 6)],
      [
        vessel('vlcc', 'oil-tanker', 'VLCC Atlas', { headingDeg: 120, speedKn: 6 }),
        vessel('cvn', 'aircraft-carrier', 'CVN Resolute', {
          x: 450,
          y: -420,
          headingDeg: 120,
          speedKn: 12,
        }),
      ],
      [gauge(-150, 150)],
      weatherOf('hurricane'),
    ),
  },
  {
    id: 'pirate-reach',
    title: 'Pirate ship on a beam reach',
    summary:
      'A square-rigger under full sail in a fresh breeze: no engine, just the wind. Try sailing ' +
      'her into the wind.',
    experiment: experiment(
      'Pirate ship on a beam reach',
      'The wind comes over her port beam and she makes about 9 knots with the yards braced ' +
        'hard round. Change her heading toward the wind (west): below ~60° off the wind the ' +
        'sails luff and she stops. Turn the autopilot off and set full sail as the squalls ' +
        'hit to see why crews reefed.',
      env({ windSpeed: 11, windDirectionDeg: 270, sunElevationDeg: 32, sunAzimuthDeg: 160 }),
      [weatherSea('breeze-sea', 'Trade-wind sea', 120, 77, 10)],
      [vessel('ship-1', 'pirate-ship', 'Queen Anne', { headingDeg: 0, speedKn: 9 })],
      [],
      weatherOf('strong', {
        cloudCover: 0.45,
        squalls: { enabled: true, intervalMin: 7, durationMin: 2, strength: 1.6, veerDeg: 25 },
      }),
    ),
  },
  {
    id: 'north-sea-storm',
    title: 'North Sea winter storm',
    summary: 'Hs 8 m, Tp 13 s storm sea with a trawler and a patrol boat running before it.',
    experiment: experiment(
      'North Sea winter storm',
      'A severe (sea state 7) storm. Small craft struggle: look for slamming, green water and ' +
        'large roll. Try turning the trawler beam-on.',
      env({ windSpeed: 24, windDirectionDeg: 315, sunElevationDeg: 12, depth: 120 }),
      [
        {
          id: 'storm-1',
          name: 'Storm sea',
          kind: 'spectrum',
          enabled: true,
          spectrum: 'jonswap',
          hs: 8,
          tp: 13,
          gamma: 3.3,
          directionDeg: 315,
          depthLimited: true,
          spreading: spreading(8),
          seed: 1953,
        },
      ],
      [
        vessel('trawler-1', 'trawler', 'FV Northern Star', { headingDeg: 135, speedKn: 6 }),
        vessel('patrol-1', 'patrol-boat', 'Patrol 7', {
          x: 120,
          y: -60,
          headingDeg: 315,
          speedKn: 10,
        }),
      ],
      [gauge(60, 60)],
      weatherOf('storm', { rainMmH: 12, visibilityKm: 6 }),
    ),
  },
  {
    id: 'squall-line',
    title: 'Squall line · aircraft carrier',
    summary:
      'A carrier steams at 20 knots as squall fronts sweep across with a jump in wind, a veer ' +
      'and a downpour.',
    experiment: experiment(
      'Squall line · aircraft carrier',
      'Squall fronts move downwind at the wind speed: watch the dark, rough band approach on the ' +
        'water, then the wind jump to twice its strength and veer. The carrier heels and the ' +
        'autopilot works to hold her course.',
      env({ windSpeed: 9, windDirectionDeg: 240, sunElevationDeg: 25 }),
      [weatherSea('local-sea', 'Local sea', 60, 31, 10)],
      [vessel('cvn', 'aircraft-carrier', 'CVN Resolute', { headingDeg: 330, speedKn: 20 })],
      [gauge(300, 0)],
      weatherOf('squalls'),
    ),
  },
  {
    id: 'swell-and-wind-sea',
    title: 'Southern Ocean swell + wind sea',
    summary:
      'A long, narrow 16 s swell from the south-west crossed by a local wind sea from the west.',
    experiment: experiment(
      'Southern Ocean swell + wind sea',
      'A bimodal sea. The gauge spectrum shows two peaks; the ship responds mostly to the swell.',
      env({ windSpeed: 14, windDirectionDeg: 270 }),
      [
        {
          id: 'swell-1',
          name: 'SW swell',
          kind: 'spectrum',
          enabled: true,
          spectrum: 'jonswap',
          hs: 3.5,
          tp: 16,
          gamma: 5,
          directionDeg: 225,
          depthLimited: true,
          spreading: spreading(60, 'cos2s'),
          seed: 4242,
        },
        {
          id: 'wind-1',
          name: 'Local wind sea',
          kind: 'wind',
          enabled: true,
          followWeather: false,
          windSpeed: 14,
          fetchKm: 60,
          directionDeg: 270,
          spreading: spreading(10),
          seed: 99,
        },
      ],
      [vessel('ship-1', 'cargo-ship', 'MV Aurora', { headingDeg: 45, speedKn: 14 })],
      [gauge(0, -150)],
    ),
  },
  {
    id: 'wave-tank-wigley',
    title: 'Wave tank: Wigley hull in regular waves',
    summary:
      'Regular 1 m, 7 s head waves on the classic Wigley benchmark hull — a seakeeping test.',
    experiment: experiment(
      'Wave tank: Wigley hull',
      'Regular waves make response amplitude operators (RAOs) easy to read: heave and pitch ' +
        'amplitudes divided by the wave amplitude. Change the period to sweep the RAO.',
      env({ windSpeed: 2, choppiness: 0.6 }),
      [
        {
          id: 'reg-1',
          name: 'Regular waves',
          kind: 'regular',
          enabled: true,
          height: 1,
          period: 7,
          directionDeg: 0,
          phaseDeg: 0,
        },
      ],
      [vessel('wigley-1', 'wigley', 'Wigley I', { headingDeg: 0, speedKn: 0, autopilot: true })],
      [gauge(0, 40)],
    ),
  },
  {
    id: 'barge-stability',
    title: 'Box barge stability in beam seas',
    summary: 'Two barges, one loaded high (low GM), rolling in regular beam waves.',
    experiment: experiment(
      'Box barge stability',
      'Identical barges with different centres of gravity. The high-KG barge rolls slowly and ' +
        'heavily; push the KG further to see it lose stability.',
      env({ windSpeed: 6 }),
      [
        {
          id: 'reg-1',
          name: 'Beam waves',
          kind: 'regular',
          enabled: true,
          height: 1.5,
          period: 6,
          directionDeg: 270,
          phaseDeg: 0,
        },
      ],
      [
        vessel('barge-a', 'box-barge', 'Barge A (normal KG)', {
          y: 30,
          headingDeg: 0,
          kgFactor: 0.5,
          autopilot: false,
        }),
        vessel('barge-b', 'box-barge', 'Barge B (high KG)', {
          y: -30,
          headingDeg: 0,
          kgFactor: 0.85,
          autopilot: false,
        }),
      ],
      [gauge(-50, 0)],
    ),
  },
  {
    id: 'shallow-swell',
    title: 'Swell in shallow water (TMA)',
    summary:
      'A 12 s swell over 15 m of water: shorter, steeper waves and a depth-limited spectrum.',
    experiment: experiment(
      'Shallow-water swell',
      'Finite depth changes the dispersion relation: the same period gives a shorter wavelength ' +
        'and the TMA spectrum limits energy. Compare with the deep-water preset.',
      env({ depth: 15, windSpeed: 5 }),
      [
        {
          id: 'swell-1',
          name: 'Swell',
          kind: 'spectrum',
          enabled: true,
          spectrum: 'jonswap',
          hs: 2,
          tp: 12,
          gamma: 4,
          directionDeg: 250,
          depthLimited: true,
          spreading: spreading(40, 'cos2s'),
          seed: 7,
        },
      ],
      [vessel('lifeboat-1', 'lifeboat', 'Lifeboat', { headingDeg: 70, speedKn: 5 })],
      [gauge(30, 0)],
    ),
  },
  {
    id: 'calm-harbour',
    title: 'Calm harbour ripples',
    summary:
      'A light breeze over a short fetch — capillary-gravity ripples and a drifting lifeboat.',
    experiment: experiment(
      'Calm harbour',
      'Short fetch, light wind: a young sea of short waves. Surface tension matters at the ' +
        'smallest scales.',
      env({ windSpeed: 4, depth: 12, sunElevationDeg: 45 }),
      [
        {
          id: 'wind-1',
          name: 'Breeze',
          kind: 'wind',
          enabled: true,
          followWeather: false,
          windSpeed: 4,
          fetchKm: 1.5,
          directionDeg: 200,
          spreading: spreading(6),
          seed: 11,
        },
      ],
      [vessel('lifeboat-1', 'lifeboat', 'Tender', { headingDeg: 0, speedKn: 0, autopilot: false })],
      [gauge(10, 10)],
    ),
  },
];

export const DEFAULT_PRESET_ID = 'moderate-sea';

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Deep copy of a preset's experiment (presets themselves must never be mutated). */
export function presetExperiment(id: string = DEFAULT_PRESET_ID): Experiment {
  const p = getPreset(id) ?? PRESETS[0]!;
  return structuredClone(p.experiment);
}
