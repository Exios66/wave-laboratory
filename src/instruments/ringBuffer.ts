/** Fixed-capacity FIFO of numbers (oldest values are overwritten). Allocation-free pushes. */
export class RingBuffer {
  private readonly data: Float64Array;
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be ≥ 1');
    this.data = new Float64Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  push(value: number): void {
    const end = (this.start + this.count) % this.capacity;
    this.data[end] = value;
    if (this.count < this.capacity) this.count++;
    else this.start = (this.start + 1) % this.capacity;
  }

  /** i-th oldest value (0 = oldest). */
  get(i: number): number {
    if (i < 0 || i >= this.count) throw new RangeError('index out of range');
    return this.data[(this.start + i) % this.capacity]!;
  }

  last(): number | undefined {
    return this.count > 0 ? this.get(this.count - 1) : undefined;
  }

  /** Copy into a new array, oldest first (optionally only the newest `n` values). */
  toArray(n = this.count): Float64Array {
    const m = Math.min(n, this.count);
    const out = new Float64Array(m);
    const offset = this.count - m;
    for (let i = 0; i < m; i++) out[i] = this.get(offset + i);
    return out;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }
}
