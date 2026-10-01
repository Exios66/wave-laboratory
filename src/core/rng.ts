/**
 * PCG32 (XSH-RR) pseudo-random generator — small, fast, statistically solid and fully
 * deterministic across platforms. Used for every random choice in a simulation so that an
 * experiment file + seed always reproduces the same sea.
 */
export class Pcg32 {
  private state: bigint;
  private readonly inc: bigint;
  private spareGaussian: number | null = null;

  private static readonly MULT = 6364136223846793005n;
  private static readonly MASK64 = (1n << 64n) - 1n;

  constructor(seed: number | bigint, stream: number | bigint = 54) {
    this.state = 0n;
    this.inc = ((BigInt(stream) << 1n) | 1n) & Pcg32.MASK64;
    this.nextUint32();
    this.state = (this.state + (BigInt(seed) & Pcg32.MASK64)) & Pcg32.MASK64;
    this.nextUint32();
  }

  nextUint32(): number {
    const old = this.state;
    this.state = (old * Pcg32.MULT + this.inc) & Pcg32.MASK64;
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
    const rot = Number(old >> 59n);
    return ((xorshifted >>> rot) | (xorshifted << (-rot & 31))) >>> 0;
  }

  /** Uniform in [0, 1) with 32 bits of resolution. */
  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform in (0, 1] — safe for logarithms. */
  nextFloatOpenZero(): number {
    return (this.nextUint32() + 1) / 4294967296;
  }

  /** Standard normal deviate (Box–Muller, both values used). */
  nextGaussian(): number {
    if (this.spareGaussian !== null) {
      const s = this.spareGaussian;
      this.spareGaussian = null;
      return s;
    }
    const u1 = this.nextFloatOpenZero();
    const u2 = this.nextFloat();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    this.spareGaussian = r * Math.sin(theta);
    return r * Math.cos(theta);
  }
}

/** Mix an integer into a seed (for deriving independent per-system/per-cascade streams). */
export function deriveSeed(seed: number, salt: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (salt + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
