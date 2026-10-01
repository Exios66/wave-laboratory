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

export const SpreadingSchema = z.object({
  model: z.enum(['cos2s', 'mitsuyasu', 'donelan-banner', 'none']).default('mitsuyasu'),
  /** Spreading exponent s (cos-2s) or peak s_p (Mitsuyasu). Larger = narrower. */
  s: finite().min(0.5).max(200).default(10),
});
export type Spreading = z.infer<typeof SpreadingSchema>;

const waveSystemBase = {
  id: z.string().min(1),
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

export const WaveSystemSchema = z.discriminatedUnion('kind', [
  SpectrumSystemSchema,
  WindSeaSystemSchema,
  RegularWaveSystemSchema,
]);
export type WaveSystem = z.infer<typeof WaveSystemSchema>;
export type SpectrumSystem = z.infer<typeof SpectrumSystemSchema>;
export type WindSeaSystem = z.infer<typeof WindSeaSystemSchema>;
export type RegularWaveSystem = z.infer<typeof RegularWaveSystemSchema>;

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
  /** Horizontal choppiness λ. 1 = first-order Lagrangian (physical). */
  choppiness: finite().min(0).max(1.5).default(1),
  /** Sun elevation/azimuth for rendering [deg]. */
  sunElevationDeg: finite().min(-10).max(90).default(28),
  sunAzimuthDeg: finite().min(0).max(360).default(220),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const VesselTypeSchema = z.enum([
  'box-barge',
  'wigley',
  'cargo-ship',
  'trawler',
  'patrol-boat',
  'lifeboat',
]);
export type VesselType = z.infer<typeof VesselTypeSchema>;

export const VesselSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  type: VesselTypeSchema,
  /** Uniform scale relative to the type's design length (0.25–4). */
  scale: finite().min(0.25).max(4).default(1),
  x: finite(),
  y: finite(),
  /** Compass heading the bow points toward [deg]. */
  headingDeg: finite().min(0).max(360),
  /** Initial and commanded speed through water [knots]. */
  speedKn: finite().min(0).max(40).default(0),
  /** Autopilot keeps the commanded heading and speed (otherwise drifts freely). */
  autopilot: z.boolean().default(true),
  /** Vertical centre of gravity as a fraction of depth (KG / D). Higher = less stable. */
  kgFactor: finite().min(0.2).max(1.2).default(0.6),
});
export type VesselConfig = z.infer<typeof VesselSchema>;

export const ProbeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  kind: z.literal('wave-gauge'),
  x: finite(),
  y: finite(),
});
export type ProbeConfig = z.infer<typeof ProbeSchema>;

export const OceanQualitySchema = z.enum(['low', 'medium', 'high', 'ultra']);
export type OceanQuality = z.infer<typeof OceanQualitySchema>;

export const ExperimentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: z.string().min(1).max(80),
  description: z.string().max(2000).default(''),
  environment: EnvironmentSchema,
  waves: z.array(WaveSystemSchema).max(8),
  vessels: z.array(VesselSchema).max(8),
  probes: z.array(ProbeSchema).max(8),
  /** Fixed physics timestep [s]. */
  timestep: finite()
    .min(1 / 1000)
    .max(1 / 30)
    .default(1 / 120),
  quality: OceanQualitySchema.default('high'),
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

export function decodeExperiment(encoded: string): ParseResult {
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
