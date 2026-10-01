/**
 * Rolling telemetry history for charts and statistics. Lives outside React state (it changes at
 * the recorder rate); components subscribe to a cheap version counter.
 */
import { RingBuffer } from '../instruments/ringBuffer';
import type { SampleBlock } from '../sim/recorder';

/** 30 minutes at 10 Hz. */
const CAPACITY = 18_000;

type Listener = () => void;

export class TelemetryHistory {
  readonly time = new RingBuffer(CAPACITY);
  private readonly channels = new Map<string, RingBuffer>();
  private rate = 10;
  private version = 0;
  private readonly listeners = new Set<Listener>();

  get sampleRate(): number {
    return this.rate;
  }

  get revision(): number {
    return this.version;
  }

  clear(): void {
    this.time.clear();
    this.channels.clear();
    this.bump();
  }

  append(block: SampleBlock): void {
    this.rate = block.rate;
    const names = Object.keys(block.channels);
    const n = names.reduce((m, k) => Math.max(m, block.channels[k]!.length), 0);
    const before = this.time.length;
    for (let i = 0; i < n; i++) this.time.push(block.t0 + i / block.rate);
    for (const name of names) {
      let buf = this.channels.get(name);
      if (!buf) {
        buf = new RingBuffer(CAPACITY);
        // Align a channel that appears late with the shared time axis.
        for (let i = 0; i < before; i++) buf.push(Number.NaN);
        this.channels.set(name, buf);
      }
      const values = block.channels[name]!;
      for (let i = 0; i < n; i++) buf.push(values[i] ?? Number.NaN);
    }
    // Channels missing from this block are padded so all buffers stay aligned.
    for (const [name, buf] of this.channels) {
      if (!(name in block.channels)) for (let i = 0; i < n; i++) buf.push(Number.NaN);
    }
    if (n > 0) this.bump();
  }

  channel(name: string): RingBuffer | undefined {
    return this.channels.get(name);
  }

  /** Newest `seconds` of a channel with matching times (NaNs removed). */
  window(name: string, seconds: number): { t: Float64Array; v: Float64Array } {
    const buf = this.channels.get(name);
    if (!buf) return { t: new Float64Array(0), v: new Float64Array(0) };
    const n = Math.min(buf.length, Math.ceil(seconds * this.rate));
    const t = this.time.toArray(n);
    const v = buf.toArray(n);
    let m = 0;
    for (let i = 0; i < v.length; i++) {
      if (!Number.isNaN(v[i]!)) {
        t[m] = t[i]!;
        v[m] = v[i]!;
        m++;
      }
    }
    return { t: t.subarray(0, m), v: v.subarray(0, m) };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private bump(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** CSV export of every channel (time + channels). */
  toCsv(): string {
    const names = [...this.channels.keys()].sort();
    const lines = [['time_s', ...names].join(',')];
    const n = this.time.length;
    for (let i = 0; i < n; i++) {
      const row = [this.time.get(i).toFixed(3)];
      for (const name of names) {
        const buf = this.channels.get(name)!;
        const v = i < buf.length ? buf.get(i) : Number.NaN;
        row.push(Number.isNaN(v) ? '' : v.toPrecision(6));
      }
      lines.push(row.join(','));
    }
    return lines.join('\n');
  }
}

export const telemetry = new TelemetryHistory();
