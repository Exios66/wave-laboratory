/**
 * Fixed-rate data recorder. Channels are sampled at exactly `rate` Hz in simulation time, which
 * gives the analysis tools (PSD, statistics) uniformly sampled records regardless of how the
 * physics and display frame rates fluctuate.
 */
export interface SampleBlock {
  rate: number;
  /** Simulation time of the first sample in this block [s]. */
  t0: number;
  channels: Record<string, number[]>;
}

export class Recorder {
  private nextIndex = 0;
  private pending: SampleBlock | null = null;

  constructor(readonly rate = 10) {}

  /** Time of the next sample [s]. */
  get nextTime(): number {
    return this.nextIndex / this.rate;
  }

  reset(time = 0): void {
    this.nextIndex = Math.ceil(time * this.rate - 1e-9);
    this.pending = null;
  }

  /** Whether a sample falls due at or before `t`. */
  due(t: number): boolean {
    return this.nextTime <= t + 1e-9;
  }

  record(values: Record<string, number>): void {
    if (!this.pending) this.pending = { rate: this.rate, t0: this.nextTime, channels: {} };
    const block = this.pending;
    const count = Math.round((this.nextTime - block.t0) * this.rate);
    for (const [name, v] of Object.entries(values)) {
      let ch = block.channels[name];
      if (!ch) {
        ch = new Array<number>(count).fill(Number.NaN);
        block.channels[name] = ch;
      }
      ch.push(v);
    }
    this.nextIndex++;
  }

  /** Take everything recorded since the last call. */
  flush(): SampleBlock | null {
    const b = this.pending;
    this.pending = null;
    return b;
  }
}
