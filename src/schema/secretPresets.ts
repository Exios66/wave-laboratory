/**
 * Hidden experiments, reached through easter eggs rather than the preset menu. They are ordinary,
 * valid experiment documents: saving or sharing one works like any other experiment.
 */
import { EnvironmentSchema, ExperimentSchema, SCHEMA_VERSION, type Experiment } from './experiment';

/**
 * Seed of the Draupner sea: the largest crest at the platform gauge within the first two minutes,
 * out of seeds 1 to 40. Its biggest wave (about 8.5 m crest, 19 m trough to crest) arrives about a
 * minute after the experiment loads. A linear sea almost never makes the real 18.5 m crest.
 * `src/schema/secretPresets.test.ts` checks that the crest is still there.
 */
export const DRAUPNER_SEED = 19;

/** Time the largest crest passes the gauge with {@link DRAUPNER_SEED} [s]. */
export const DRAUPNER_PEAK_T = 62.8;

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
      'by an instrument. This sea has the same depth and sea state. Watch the gauge about a minute ' +
      'in: its biggest wave is roughly 19 m high. A linear sea almost never builds the real one, ' +
      'which also needed nonlinear focusing.',
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
    ],
    vessels: [],
    probes: [{ id: 'draupner-laser', name: 'Draupner E laser', kind: 'wave-gauge', x: 0, y: 0 }],
    timestep: 1 / 120,
    quality: 'high',
  });
}
