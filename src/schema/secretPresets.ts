/**
 * Hidden experiments, reached through easter eggs rather than the preset menu. They are ordinary,
 * valid experiment documents: saving or sharing one works like any other experiment.
 */
import { EnvironmentSchema, ExperimentSchema, SCHEMA_VERSION, type Experiment } from './experiment';

/**
 * Seed of the background storm sea: out of seeds 1 to 40 it has the largest natural crest at the
 * platform gauge in the first two minutes (about 8.5 m at t ≈ 62.8 s). A focused wave group is
 * added at that place and moment, so the two together reach the recorded 18.5 m crest.
 * `src/schema/secretPresets.test.ts` checks the crest.
 */
export const DRAUPNER_SEED = 19;

/** Time the largest crest passes the gauge with {@link DRAUPNER_SEED} [s]. */
export const DRAUPNER_PEAK_T = 62.8;

/** Linear crest of the focused group added on top of the storm sea at that moment [m]. */
export const DRAUPNER_FOCUS_CREST = 10;

/**
 * The New Year's Wave: 1 January 1995, Draupner E jacket platform, central North Sea, 70 m of water.
 * A downward-looking laser recorded a 25.6 m wave with an 18.5 m crest in a sea of Hs ≈ 12 m. It was
 * the first rogue wave measured by an instrument, and it settled the argument that they exist.
 */
export function draupnerExperiment(): Experiment {
  return ExperimentSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    name: 'The New Year’s Wave (Draupner, 1995)',
    description:
      'Draupner E platform, central North Sea, 1 January 1995. In a storm sea of Hs ≈ 12 m the ' +
      'platform laser recorded a 25.6 m wave with an 18.5 m crest, the first rogue wave measured ' +
      'by an instrument. This sea has the same depth and sea state, plus a focused wave group ' +
      '(NewWave) that meets the largest natural crest at the gauge about a minute in, so the ' +
      'gauge sees an 18.5 m crest again.',
    environment: EnvironmentSchema.parse({
      depth: 70,
      windSpeed: 24,
      windDirectionDeg: 200,
      sunElevationDeg: 6,
      sunAzimuthDeg: 200,
    }),
    waves: [
      {
        id: 'draupner-sea',
        name: 'North Sea storm',
        enabled: true,
        kind: 'spectrum',
        spectrum: 'jonswap',
        hs: 11.9,
        tp: 15,
        gamma: 3.3,
        directionDeg: 200,
        depthLimited: true,
        spreading: { model: 'mitsuyasu', s: 25 },
        seed: DRAUPNER_SEED,
      },
      {
        id: 'draupner-wave',
        name: 'New Year’s Wave',
        enabled: true,
        kind: 'focused',
        crestHeight: DRAUPNER_FOCUS_CREST,
        tp: 13,
        directionDeg: 200,
        focusX: 0,
        focusY: 0,
        focusTime: DRAUPNER_PEAK_T,
        seed: 1995,
      },
    ],
    vessels: [],
    probes: [{ id: 'draupner-laser', name: 'Draupner E laser', kind: 'wave-gauge', x: 0, y: 0 }],
    timestep: 1 / 120,
    quality: 'high',
  });
}
