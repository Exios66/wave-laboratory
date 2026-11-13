/**
 * GPU time of a frame from `EXT_disjoint_timer_query_webgl2`, split into the frame's stages.
 * CPU time inside render() says little about how long the GPU takes to draw, so these are the
 * numbers to compare against a frame budget. Timer queries cannot nest, so the stages are timed
 * one after another (`begin(pass)` … `end()`). Results arrive a few frames late; each pass is
 * smoothed, and `ms` is their sum. Call `frame()` once at the start of every frame: a pass the
 * latest frame did not run (post-processing switched off, say) drops out of both, and starts
 * afresh if it comes back. Both are null where the extension is missing (Safari, Firefox
 * by default, software renderers).
 */
const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
/** Smoothing weight of a new sample. */
const EMA = 0.1;
/** Queries in flight before new ones are skipped (about six frames of four passes). */
const MAX_PENDING = 24;

/** The stages of a frame that are timed: FFT ocean update, scene prepasses, scene, post chain. */
export type GpuPass = 'ocean' | 'prepass' | 'scene' | 'post';

export class GpuTimer {
  private ext: unknown;
  private readonly smoothed = new Map<GpuPass, number>();
  /** Frame number in which each pass last began. */
  private readonly lastRun = new Map<GpuPass, number>();
  private frameNo = 0;
  private readonly pending: { query: WebGLQuery; pass: GpuPass; frame: number }[] = [];
  private active: { query: WebGLQuery; pass: GpuPass; frame: number } | null = null;
  /** Frame from which each pass's current run of samples began. */
  private readonly runStart = new Map<GpuPass, number>();

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  /**
   * Smoothed GPU time per pass the current frame runs [ms], or null before the first result or
   * without the extension.
   */
  get passes(): Partial<Record<GpuPass, number>> | null {
    let out: Partial<Record<GpuPass, number>> | null = null;
    for (const [pass, ms] of this.smoothed) {
      if (this.lastRun.get(pass) === this.frameNo) (out ??= {})[pass] = ms;
    }
    return out;
  }

  /** Smoothed GPU frame time [ms]: the sum of the timed passes. */
  get ms(): number | null {
    const passes = this.passes;
    if (!passes) return null;
    let sum = 0;
    for (const v of Object.values(passes)) sum += v;
    return sum;
  }

  /** Start a new frame. */
  frame(): void {
    this.frameNo++;
  }

  begin(pass: GpuPass): void {
    if (!this.ext) return;
    const last = this.lastRun.get(pass);
    // A pass that skipped a frame is a different workload when it returns: start it afresh, and
    // ignore results of its earlier run still in flight.
    if (last === undefined || last < this.frameNo - 1) {
      this.smoothed.delete(pass);
      this.runStart.set(pass, this.frameNo);
    }
    this.lastRun.set(pass, this.frameNo);
    if (this.active || this.pending.length > MAX_PENDING) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(TIME_ELAPSED_EXT, query);
    this.active = { query, pass, frame: this.frameNo };
  }

  end(): void {
    if (!this.ext) return;
    const gl = this.gl;
    if (this.active) {
      gl.endQuery(TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
    }
    const disjoint = Boolean(gl.getParameter(GPU_DISJOINT_EXT));
    while (this.pending.length > 0) {
      const { query, pass, frame } = this.pending[0]!;
      if (!disjoint && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint && frame >= (this.runStart.get(pass) ?? 0)) {
        const ms = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6;
        const prev = this.smoothed.get(pass);
        this.smoothed.set(pass, prev === undefined ? ms : prev + (ms - prev) * EMA);
      }
      gl.deleteQuery(query);
      this.pending.shift();
    }
  }

  /**
   * Forget queries that belonged to a lost context, and take the extension again from the
   * restored one (timing stays off if it is gone).
   */
  reset(): void {
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending.length = 0;
    this.active = null;
    this.smoothed.clear();
    this.lastRun.clear();
    this.runStart.clear();
  }
}
