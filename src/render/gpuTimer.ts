/**
 * GPU time of a frame from `EXT_disjoint_timer_query_webgl2`. CPU time inside render() says
 * little about how long the GPU takes to draw, so this is the number to compare against a
 * frame budget. Results arrive a few frames late; `ms` is a smoothed value, or null where the
 * extension is missing (Safari, Firefox by default, software renderers).
 */
const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;

export class GpuTimer {
  /** Smoothed GPU frame time [ms], or null before the first result or without the extension. */
  ms: number | null = null;
  private readonly ext: unknown;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  begin(): void {
    if (!this.ext || this.active || this.pending.length > 4) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(TIME_ELAPSED_EXT, q);
    this.active = q;
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
      const q = this.pending[0]!;
      if (!disjoint && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) {
        const ms = Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6;
        this.ms = this.ms === null ? ms : this.ms + (ms - this.ms) * 0.1;
      }
      gl.deleteQuery(q);
      this.pending.shift();
    }
  }

  /** Forget queries that belonged to a lost context. */
  reset(): void {
    this.pending.length = 0;
    this.active = null;
    this.ms = null;
  }
}
