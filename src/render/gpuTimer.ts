/**
 * GPU time of a frame from `EXT_disjoint_timer_query_webgl2`, split into the frame's stages.
 * CPU time inside render() says little about how long the GPU takes to draw, so these are the
 * numbers to compare against a frame budget. Timer queries cannot nest, so the stages are timed
 * one after another (`begin(pass)` … `end()`). Results arrive a few frames late; each pass is
 * smoothed, and `ms` is their sum. Both are null where the extension is missing (Safari, Firefox
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
  /** Smoothed GPU time per pass [ms], or null before the first result or without the extension. */
  passes: Partial<Record<GpuPass, number>> | null = null;
  private ext: unknown;
  private readonly pending: { query: WebGLQuery; pass: GpuPass }[] = [];
  private active: { query: WebGLQuery; pass: GpuPass } | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  /** Smoothed GPU frame time [ms]: the sum of the timed passes. */
  get ms(): number | null {
    if (!this.passes) return null;
    let sum = 0;
    for (const v of Object.values(this.passes)) sum += v;
    return sum;
  }

  begin(pass: GpuPass): void {
    if (!this.ext || this.active || this.pending.length > MAX_PENDING) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(TIME_ELAPSED_EXT, query);
    this.active = { query, pass };
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
      const { query, pass } = this.pending[0]!;
      if (!disjoint && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) {
        const ms = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6;
        const passes = (this.passes ??= {});
        const prev = passes[pass];
        passes[pass] = prev === undefined ? ms : prev + (ms - prev) * EMA;
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
    this.passes = null;
  }
}
