/**
 * Hull wetting: how high the sea climbs a hull above the moving waterline. The drawn wet band
 * (see `hullWettingMaterial.ts`) is darker and glossier than the dry topsides; its height is a
 * slowly changing envelope of the largest recent excursions, because wetness remembers: water
 * climbs the plating fast and the steel dries slowly. Purely visual; nothing feeds the forces.
 */

const G = 9.81;

/** Clamps of the wet height above the waterline [m]. */
export const WET_MIN = 0.1;
export const WET_MAX = 6;
/** Time constants [s]: the hull wets quickly and dries slowly. */
export const WET_RISE_TAU = 0.4;
export const WET_FALL_TAU = 25;

export interface WetInputs {
  /** Significant wave height [m]. */
  hs: number;
  /** Envelope of the roll angle [rad]. */
  rollAmp: number;
  /** Envelope of the heave about its mean [m]. */
  heaveAmp: number;
  /** Envelope of the pitch angle [rad] (reserved: the bow already rides the speed term). */
  pitchAmp: number;
  /** Speed through the water [m/s]. */
  speed: number;
  length: number;
  beam: number;
}

export interface WetHeights {
  /** Along the sides [m above the waterline]. */
  side: number;
  /** At the bow, where the bow wave piles up [m]. */
  bow: number;
}

const clamp = (v: number): number => Math.min(WET_MAX, Math.max(WET_MIN, v));

/** Target wet height: 0.15 + 0.32 Hs + 0.5 B |sin roll| + heave, plus the bow wave's rise. */
export function wetTarget(i: WetInputs): WetHeights {
  const side =
    0.15 + 0.32 * Math.max(0, i.hs) + 0.5 * i.beam * Math.abs(Math.sin(i.rollAmp)) + i.heaveAmp;
  const bowRise = Math.min((i.speed * i.speed) / (2 * G), 0.08 * i.length);
  return { side: clamp(side), bow: clamp(side + bowRise) };
}

/** One step of an envelope toward `target`: fast up, slow down (exact for any dt). */
export function stepWetEnvelope(current: number, target: number, dt: number): number {
  const tau = target > current ? WET_RISE_TAU : WET_FALL_TAU;
  return target + (current - target) * Math.exp(-Math.max(0, dt) / tau);
}

/** Window over which the mean heave is tracked [s]. */
const HEAVE_MEAN_WINDOW = 6;

/**
 * One hull's wetting state: envelopes of its roll and heave excursions, and the wet heights they
 * lead to. Feed it the drawn pose each frame.
 */
export class HullWetState {
  readonly wet: WetHeights = { side: WET_MIN, bow: WET_MIN };
  private rollAmp = 0;
  private heaveAmp = 0;
  private meanHeave: number | null = null;
  private lastT = Number.NaN;

  /** @param roll body roll angle [rad] (sign ignored). @param heave height of the hull [m]. */
  step(
    t: number,
    hs: number,
    roll: number,
    heave: number,
    speed: number,
    length: number,
    beam: number,
  ): WetHeights {
    // A jump back in time (reload) or the first call: start from the present.
    const dt = Number.isNaN(this.lastT) || t < this.lastT ? 0 : Math.min(t - this.lastT, 1);
    this.lastT = t;
    if (this.meanHeave === null) this.meanHeave = heave;
    const k = 1 - Math.exp(-dt / HEAVE_MEAN_WINDOW);
    this.meanHeave += (heave - this.meanHeave) * k;
    this.rollAmp = stepWetEnvelope(this.rollAmp, Math.abs(roll), dt);
    this.heaveAmp = stepWetEnvelope(this.heaveAmp, Math.abs(heave - this.meanHeave), dt);
    const target = wetTarget({
      hs,
      rollAmp: this.rollAmp,
      heaveAmp: this.heaveAmp,
      pitchAmp: 0,
      speed,
      length,
      beam,
    });
    // The heights themselves rise and fall through the same envelopes.
    this.wet.side = stepWetEnvelope(this.wet.side, target.side, dt);
    this.wet.bow = stepWetEnvelope(this.wet.bow, target.bow, dt);
    return this.wet;
  }
}
