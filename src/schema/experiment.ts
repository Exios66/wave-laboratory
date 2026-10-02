/**
 * Experiment file format (versioned). Every experiment the lab can run is fully described by
 * one of these documents, which makes runs reproducible, shareable and diff-able.
 *
 * Conventions:
 *  - SI units unless the field name says otherwise (…Deg, …Kn, …Km).
 *  - Wave & wind directions are compass bearings the waves/wind COME FROM (0 = from north,
 *    90 = from east), as used by NDBC/WMO.
 *  - Vessel headings are compass bearings the bow points TOWARD (0 = north, 90 = east).
 *  - World frame: x east, y north, z up, origin at the mean water level.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

const finite = () => z.number().finite();
/**
 * Scene-object ids appear in CSV headers and telemetry channel names, so they are short and
 * plain: letters, digits, '-' and '_'.
 */
const objectId = () =>
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Ids use 1–64 letters, digits, "-" or "_".');
/** Horizontal position [m]; the lab is a few kilometres across, far inside float32 range. */
const position = () => finite().min(-20000).max(20000);

export const SpreadingSchema = z.object({
  model: z.enum(['cos2s', 'mitsuyasu', 'donelan-banner', 'none']).default('mitsuyasu'),
  /** Spreading exponent s (cos-2s) or peak s_p (Mitsuyasu). Larger = narrower. */
  s: finite().min(0.5).max(200).default(10),
});
export type Spreading = z.infer<typeof SpreadingSchema>;

const waveSystemBase = {
  id: objectId(),
  name: z.string().min(1).max(60),
  enabled: z.boolean().default(true),
  /** Compass bearing the waves come FROM [deg]. */
  directionDeg: finite().min(0).max(360),
};

export const SpectrumSystemSchema = z.object({
  ...waveSystemBase,
  kind: z.literal('spectrum'),
  spectrum: z.enum(['jonswap', 'pierson-moskowitz', 'bretschneider']),
  /** Significant wave height H_s = 4√m₀ [m]. */
  hs: finite().min(0).max(30),
  /** Peak period T_p [s]. */
  tp: finite().min(0.5).max(30),
  /** JONSWAP peak enhancement γ (ignored by PM/Bretschneider). */
  gamma: finite().min(1).max(10).default(3.3),
  /** Apply the TMA (Kitaigorodskii) finite-depth correction. H_s is then re-normalised. */
  depthLimited: z.boolean().default(true),
  spreading: SpreadingSchema,
  seed: z.number().int().min(0).max(0xffffffff),
});

export const WindSeaSystemSchema = z.object({
  ...waveSystemBase,
  kind: z.literal('wind'),
  /**
   * Take wind speed and direction from the weather (environment wind) instead of the values
   * below, so the sea builds and veers with the weather you set.
   */
  followWeather: z.boolean().default(false),
  /** 10 m wind speed [m/s]. */
  windSpeed: finite().min(0).max(45),
  /** Fetch [km]. Sea becomes fully developed (Pierson–Moskowitz) for long fetches. */
  fetchKm: finite().min(0.1).max(5000),
  spreading: SpreadingSchema,
  seed: z.number().int().min(0).max(0xffffffff),
});

export const RegularWaveSystemSchema = z.object({
  ...waveSystemBase,
  kind: z.literal('regular'),
  /** Wave height H (crest to trough) [m]. */
  height: finite().min(0).max(30),
  /** Wave period T [s]. */
  period: finite().min(0.3).max(30),
  phaseDeg: finite().min(-360).max(360).default(0),
});

/**
 * Focused wave group ("NewWave", Tromans et al. 1991): the linear components of a JONSWAP sea
 * phased so that their crests coincide at one place and time. The standard deterministic
 * model of an extreme (rogue) crest such as the 1995 Draupner wave.
 */
export const FocusedWaveSystemSchema = z.object({
  ...waveSystemBase,
  kind: z.literal('focused'),
  /** Linear crest elevation at the focus [m]. */
  crestHeight: finite().min(0).max(30),
  /** Peak period of the underlying spectrum [s]. */
  tp: finite().min(2).max(25),
  /** Focus point [m] and time [s]. */
  focusX: finite().min(-5000).max(5000).default(0),
  focusY: finite().min(-5000).max(5000).default(0),
  focusTime: finite().min(0).max(3600).default(60),
  /** Seed for the slight frequency jitter that stops the group refocusing periodically. */
  seed: z.number().int().min(0).max(0xffffffff).default(1),
});

export const WaveSystemSchema = z.discriminatedUnion('kind', [
  SpectrumSystemSchema,
  WindSeaSystemSchema,
  RegularWaveSystemSchema,
  FocusedWaveSystemSchema,
]);
export type WaveSystem = z.infer<typeof WaveSystemSchema>;
export type SpectrumSystem = z.infer<typeof SpectrumSystemSchema>;
export type WindSeaSystem = z.infer<typeof WindSeaSystemSchema>;
export type RegularWaveSystem = z.infer<typeof RegularWaveSystemSchema>;
export type FocusedWaveSystem = z.infer<typeof FocusedWaveSystemSchema>;

export const EnvironmentSchema = z.object({
  /** Still-water depth [m]. Values ≥ 1000 behave as deep water. */
  depth: finite().min(1).max(11000).default(4000),
  gravity: finite().min(1).max(30).default(9.80665),
  waterDensity: finite().min(900).max(1100).default(1025),
  /** Surface tension [N/m] (affects capillary ripples only). */
  surfaceTension: finite().min(0).max(0.1).default(0.074),
  /** 10 m wind used for visuals (whitecaps, spray) and vessel windage [m/s]. */
  windSpeed: finite().min(0).max(45).default(8),
  windDirectionDeg: finite().min(0).max(360).default(270),
  /**
   * Uniform surface current [m/s]. The whole water body moves: wave spectra are given in the
   * frame of the moving water (so the waves seen from a fixed point are Doppler shifted) and
   * ships drift with it, because their hull forces act on the velocity through the water.
   */
  currentSpeed: finite().min(0).max(5).default(0),
  /** Compass bearing the current flows TOWARD [deg] (oceanographic convention). */
  currentDirectionDeg: finite().min(0).max(360).default(0),
  /** Horizontal choppiness λ. 1 = first-order Lagrangian (physical). */
  choppiness: finite().min(0).max(1.5).default(1),
  /** Sun elevation/azimuth for rendering [deg]. */
  sunElevationDeg: finite().min(-10).max(90).default(28),
  sunAzimuthDeg: finite().min(0).max(360).default(220),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const SquallSchema = z.object({
  enabled: z.boolean().default(false),
  /** Mean time between squall fronts [min]. */
  intervalMin: finite().min(2).max(120).default(12),
  /** Duration of the strong-wind part of a squall [min]. */
  durationMin: finite().min(0.5).max(30).default(4),
  /** Peak wind as a multiple of the mean wind (typical 1.4–2). */
  strength: finite().min(1).max(2.5).default(1.6),
  /** Wind veer through a squall [deg] (positive = clockwise). */
  veerDeg: finite().min(-90).max(90).default(30),
});
export type Squall = z.infer<typeof SquallSchema>;

/**
 * Weather around the mean wind of the environment. Gusts and squalls act on the vessels
 * (windage, sails) and on the picture; rain, cloud, visibility and lightning are visual.
 */
export const WeatherSchema = z.object({
  /** Longitudinal turbulence intensity σ_u / U (open sea 0.06–0.12, squally 0.2+). */
  gustiness: finite().min(0).max(0.4).default(0.1),
  squalls: SquallSchema.default({
    enabled: false,
    intervalMin: 12,
    durationMin: 4,
    strength: 1.6,
    veerDeg: 30,
  }),
  /** Rain rate [mm/h] (moderate 2–10, heavy 10–50, violent > 50). */
  rainMmH: finite().min(0).max(150).default(0),
  /** Cloud cover fraction 0–1 (0 clear, 1 overcast). */
  cloudCover: finite().min(0).max(1).default(0.25),
  /** Meteorological visibility [km]. */
  visibilityKm: finite().min(0.1).max(60).default(40),
  lightning: z.boolean().default(false),
  seed: z.number().int().min(0).max(0xffffffff).default(7),
});
export type Weather = z.infer<typeof WeatherSchema>;

export const DEFAULT_WEATHER: Weather = WeatherSchema.parse({});

export const VesselTypeSchema = z.enum([
  'box-barge',
  'wigley',
  'cargo-ship',
  'trawler',
  'patrol-boat',
  'lifeboat',
  'oil-tanker',
  'aircraft-carrier',
  'pirate-ship',
]);
export type VesselType = z.infer<typeof VesselTypeSchema>;

export const VesselSchema = z.object({
  id: objectId(),
  name: z.string().min(1).max(60),
  type: VesselTypeSchema,
  /** Uniform scale relative to the type's design length (0.25–4). */
  scale: finite().min(0.25).max(4).default(1),
  x: position(),
  y: position(),
  /** Compass heading the bow points toward [deg]. */
  headingDeg: finite().min(0).max(360),
  /** Initial and commanded speed through water [knots]. */
  speedKn: finite().min(0).max(40).default(0),
  /** Autopilot keeps the commanded heading and speed (otherwise drifts freely). */
  autopilot: z.boolean().default(true),
  /** Vertical centre of gravity as a fraction of depth (KG / D). Higher = less stable. */
  kgFactor: finite().min(0.2).max(1.2).default(0.6),
  /**
   * Loading condition: displacement as a fraction of the design displacement (cargo and
   * ballast). The ship floats at the draft that carries this mass: 0.5 is light ballast, 1 the
   * design load, above 1 overloaded with less freeboard.
   */
  loadFactor: finite().min(0.4).max(1.25).default(1),
});
export type VesselConfig = z.infer<typeof VesselSchema>;

export const ProbeSchema = z.object({
  id: objectId(),
  name: z.string().min(1).max(60),
  kind: z.literal('wave-gauge'),
  x: position(),
  y: position(),
});
export type ProbeConfig = z.infer<typeof ProbeSchema>;

export const OceanQualitySchema = z.enum(['low', 'medium', 'high', 'ultra']);
export type OceanQuality = z.infer<typeof OceanQualitySchema>;

export const ExperimentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: z.string().min(1).max(80),
  description: z.string().max(2000).default(''),
  environment: EnvironmentSchema,
  weather: WeatherSchema.default(DEFAULT_WEATHER),
  waves: z.array(WaveSystemSchema).max(8),
  vessels: z.array(VesselSchema).max(8),
  probes: z.array(ProbeSchema).max(8),
  /** Fixed physics timestep [s]. */
  timestep: finite()
    .min(1 / 1000)
    .max(1 / 30)
    .default(1 / 120),
  quality: OceanQualitySchema.default('high'),
  /**
   * Vessels take structural damage from slamming, green water, storms, heavy heel and
   * collisions, losing power and steering. Off: health stays full and colliding hulls still
   * bounce apart. Defaults on (older files without the field parse unchanged).
   */
  damage: z.boolean().default(true),
});
export type Experiment = z.infer<typeof ExperimentSchema>;

export type ParseResult = { ok: true; experiment: Experiment } | { ok: false; errors: string[] };

/** Parse and validate unknown JSON (e.g. a loaded file or URL fragment). */
export function parseExperiment(input: unknown): ParseResult {
  const result = ExperimentSchema.safeParse(input);
  if (result.success) {
    const ids = new Set<string>();
    const dupes: string[] = [];
    for (const item of [...result.data.waves, ...result.data.vessels, ...result.data.probes]) {
      if (ids.has(item.id)) dupes.push(`Duplicate id "${item.id}"`);
      ids.add(item.id);
    }
    if (dupes.length > 0) return { ok: false, errors: dupes };
    return { ok: true, experiment: result.data };
  }
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/** Compact, URL-safe encoding of an experiment (base64url of UTF-8 JSON). */
export function encodeExperiment(exp: Experiment): string {
  const bytes = new TextEncoder().encode(JSON.stringify(exp));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Share links longer than this are refused before decoding (real experiments are < 10 kB). */
const MAX_ENCODED_LENGTH = 200_000;

export function decodeExperiment(encoded: string): ParseResult {
  if (encoded.length > MAX_ENCODED_LENGTH) {
    return { ok: false, errors: ['The shared experiment is too large.'] };
  }
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return parseExperiment(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (err) {
    return { ok: false, errors: [`Could not decode experiment: ${(err as Error).message}`] };
  }
}

let idCounter = 0;
/** Short unique id for new scene objects. */
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}`;
}
