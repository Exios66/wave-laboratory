/**
 * Fixed-timestep accumulator. Physics always advances in exact multiples of `dt` regardless of
 * the display frame rate; the renderer interpolates with `alpha`. A cap on steps per frame
 * prevents the "spiral of death" when the machine cannot keep up (the simulation then runs
 * slower than requested and `lagging` is reported to the UI).
 */
export class FixedStepClock {
  private accumulator = 0;
  /** Simulation time [s] — always an integer multiple of dt. */
  time = 0;
  steps = 0;
  lagging = false;

  constructor(
    public dt: number,
    public maxStepsPerFrame = 32,
  ) {
    if (!(dt > 0)) throw new RangeError('dt must be positive');
  }

  /**
   * Feed elapsed wall-clock time (seconds) multiplied by the time scale; returns how many fixed
   * steps to run now. Call `commit()` once per step actually executed.
   */
  advance(elapsed: number): number {
    this.accumulator += Math.max(0, elapsed);
    let n = Math.floor(this.accumulator / this.dt + 1e-9);
    this.lagging = n > this.maxStepsPerFrame;
    if (this.lagging) {
      n = this.maxStepsPerFrame;
      this.accumulator = n * this.dt;
    }
    return n;
  }

  commit(): void {
    this.accumulator -= this.dt;
    if (this.accumulator < 0) this.accumulator = 0;
    this.steps += 1;
    this.time = this.steps * this.dt;
  }

  /** Fraction of a step left in the accumulator, for render interpolation. */
  get alpha(): number {
    return Math.min(1, this.accumulator / this.dt);
  }

  reset(time = 0): void {
    this.steps = Math.round(time / this.dt);
    this.time = this.steps * this.dt;
    this.accumulator = 0;
    this.lagging = false;
  }
}
