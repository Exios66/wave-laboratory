/**
 * Ship wakes: the track each hull has left on the water, handed to the ocean shader as a small
 * float texture so the foam can be drawn where the ship actually went (curving with its turns)
 * and age as it should.
 *
 * Points are kept in the water's own frame (world position minus current × time), because foam
 * is carried by the water: on a current the whole wake drifts downstream, exactly as the drawn
 * sea and the hull physics do. Purely visual; nothing here feeds back into the forces.
 *
 * Physics behind the shader's foam (see `WAKE_GLSL` in ../ocean/shaders.ts):
 *  - the turbulent (propeller and boundary-layer) wake starts about a beam wide and widens
 *    slowly with distance astern (≈ x^⅓ for a self-similar momentum wake), its white water
 *    decaying with bubble lifetime while a smoother "slick" lane lasts several times longer;
 *  - the screw race throws the water aft at a fraction of ship speed, slowing within seconds,
 *    so the churned foam visibly streams away from the stern and then comes to rest;
 *  - the Kelvin arms of divergent waves run at 19.47° to the track from the bow, with breaking
 *    cusps spaced by the divergent wavelength ⅔ · 2πU²/g, strong only above Froude ≈ 0.2.
 */
import * as THREE from 'three';

/** Vessels whose wakes are drawn and points per wake (2 live hull points + history). */
export const WAKE_VESSELS = 8;
export const WAKE_POINTS = 32;

export interface WakeSource {
  id: string;
  length: number;
  beam: number;
  /** World (x, y) of the bow and the stern (propeller) [m]. */
  bow: { x: number; y: number };
  stern: { x: number; y: number };
  /** Speed through the water [m/s]. */
  speed: number;
}

export interface WakePoint {
  /** Water-frame position [m]. */
  x: number;
  y: number;
  /** Simulation time the stern passed here [s]. */
  t: number;
  /** Distance the stern had sailed through the water [m]. */
  odo: number;
  /** Speed through the water at the time [m/s]. */
  speed: number;
}

/** Bright-foam decay time [s]: ~10 s for a small craft, over half a minute for a carrier. */
export function foamDecay(length: number): number {
  return 8 + 0.08 * length;
}

/** How long a wake is kept at all [s] (the slick lane fades out by then). */
export function wakeLifetime(length: number): number {
  return 6 * foamDecay(length);
}

/** Half-width of the turbulent wake at a distance astern of the stern [m]. */
export function wakeHalfWidth(beam: number, astern: number): number {
  return 0.5 * beam * (0.85 + 0.55 * Math.cbrt(Math.max(0, astern) / Math.max(beam, 1)));
}

/** tan(19.47°): the Kelvin half-angle for deep water. */
export const KELVIN_TAN = Math.tan(Math.asin(1 / 3));

/** One ship's track through the water. */
export class WakeTrail {
  /** Newest first. */
  readonly points: WakePoint[] = [];
  odo = 0;
  private last: { x: number; y: number } | null = null;

  /**
   * Advance to time `t` with the stern at water-frame (x, y). Records a point every
   * lifetime / (points − 2) seconds, or sooner after a sharp turn, and drops expired ones.
   */
  update(
    t: number,
    x: number,
    y: number,
    speed: number,
    length: number,
    capacity: number,
    heading?: { x: number; y: number },
  ): void {
    const newest = this.points[0];
    if (newest && (t < newest.t - 1e-6 || t - newest.t > wakeLifetime(length))) this.reset();
    if (!this.last && heading && speed > 0.3)
      this.backfill(t, x, y, heading, speed, length, capacity);
    if (this.last) this.odo += Math.hypot(x - this.last.x, y - this.last.y);
    this.last = { x, y };
    const head = this.points[0];
    const interval = wakeLifetime(length) / (capacity - 2);
    let due = !head || t - head.t >= interval;
    if (head && !due) {
      // Record early when the track bends, so turning circles stay round.
      const prev = this.points[1];
      if (prev) {
        const ax = head.x - prev.x;
        const ay = head.y - prev.y;
        const bx = x - head.x;
        const by = y - head.y;
        const la = Math.hypot(ax, ay);
        const lb = Math.hypot(bx, by);
        if (la > 1e-3 && lb > length * 0.05 && (ax * bx + ay * by) / (la * lb) < Math.cos(0.12))
          due = true;
      }
    }
    if (due) this.points.unshift({ x, y, t, odo: this.odo, speed });
    const life = wakeLifetime(length);
    while (this.points.length > capacity - 2) this.points.pop();
    while (this.points.length > 1 && t - this.points[this.points.length - 1]!.t > life)
      this.points.pop();
  }

  /**
   * A ship that starts the run already under way has been sailing before t: lay the track it
   * would have left on its present course and speed, so it does not appear out of a clean sea.
   */
  private backfill(
    t: number,
    x: number,
    y: number,
    heading: { x: number; y: number },
    speed: number,
    length: number,
    capacity: number,
  ): void {
    const norm = Math.hypot(heading.x, heading.y) || 1;
    const life = wakeLifetime(length);
    const steps = capacity - 3;
    for (let k = 1; k <= steps; k++) {
      const age = (life * k) / steps;
      this.points.push({
        x: x - (heading.x / norm) * speed * age,
        y: y - (heading.y / norm) * speed * age,
        t: t - age,
        odo: -speed * age,
        speed,
      });
    }
  }

  reset(): void {
    this.points.length = 0;
    this.last = null;
    this.odo = 0;
  }
}

/** Keeps the trails of all vessels and packs them for the ocean shader. */
export class WakeField {
  readonly texture: THREE.DataTexture;
  /** Per wake: (length, beam, current speed, head odometer). */
  readonly ship = Array.from({ length: WAKE_VESSELS }, () => new THREE.Vector4());
  /** Per wake: (point count, Froude number, foam decay [s], lifetime [s]). */
  readonly info = Array.from({ length: WAKE_VESSELS }, () => new THREE.Vector4());
  /** Per wake: water-frame bounding box (min x, min y, max x, max y) of everything it can draw. */
  readonly box = Array.from({ length: WAKE_VESSELS }, () => new THREE.Vector4());
  count = 0;
  private readonly data: Float32Array;
  private readonly trails = new Map<string, WakeTrail>();

  constructor() {
    this.data = new Float32Array(WAKE_POINTS * WAKE_VESSELS * 2 * 4);
    this.texture = new THREE.DataTexture(
      this.data,
      WAKE_POINTS,
      WAKE_VESSELS * 2,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /**
   * @param drift current × t: the offset between world and water frames [m]
   */
  update(t: number, sources: readonly WakeSource[], drift: { x: number; y: number }): void {
    const live = new Set<string>();
    let n = 0;
    for (const src of sources) {
      if (n >= WAKE_VESSELS) break;
      live.add(src.id);
      let trail = this.trails.get(src.id);
      if (!trail) this.trails.set(src.id, (trail = new WakeTrail()));
      const sx = src.stern.x - drift.x;
      const sy = src.stern.y - drift.y;
      trail.update(t, sx, sy, src.speed, src.length, WAKE_POINTS, {
        x: src.bow.x - src.stern.x,
        y: src.bow.y - src.stern.y,
      });
      this.pack(n, t, src, trail, drift);
      n++;
    }
    for (const id of [...this.trails.keys()]) if (!live.has(id)) this.trails.delete(id);
    this.count = n;
    this.texture.needsUpdate = true;
  }

  clear(): void {
    this.trails.clear();
    this.count = 0;
  }

  private pack(
    row: number,
    t: number,
    src: WakeSource,
    trail: WakeTrail,
    drift: { x: number; y: number },
  ): void {
    const d = this.data;
    const w = WAKE_POINTS * 4;
    const base = row * 2 * w;
    const L = src.length;
    const head = trail.odo + L;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const put = (j: number, x: number, y: number, pt: number, odo: number, speed: number) => {
      d[base + 4 * j] = x;
      d[base + 4 * j + 1] = y;
      d[base + 4 * j + 2] = pt;
      d[base + 4 * j + 3] = odo;
      d[base + w + 4 * j] = speed;
      d[base + w + 4 * j + 1] = 0;
      d[base + w + 4 * j + 2] = 0;
      d[base + w + 4 * j + 3] = 0;
      // Everything the shader can draw around this point: the turbulent wake or a Kelvin arm.
      const s = head - odo;
      const arm = s < 4 * L ? KELVIN_TAN * s + 0.1 * s + src.beam : 0;
      const reach = Math.max(wakeHalfWidth(src.beam, s - L) * 1.3, arm) + 2;
      minX = Math.min(minX, x - reach);
      minY = Math.min(minY, y - reach);
      maxX = Math.max(maxX, x + reach);
      maxY = Math.max(maxY, y + reach);
    };
    put(0, src.bow.x - drift.x, src.bow.y - drift.y, t, head, src.speed);
    put(1, src.stern.x - drift.x, src.stern.y - drift.y, t, trail.odo, src.speed);
    let j = 2;
    for (const p of trail.points) {
      if (j >= WAKE_POINTS) break;
      // The newest recorded point can coincide with the live stern; skip a zero-length segment.
      if (j === 2 && Math.hypot(p.x - d[base + 4]!, p.y - d[base + 5]!) < 1e-3) continue;
      put(j++, p.x, p.y, p.t, p.odo, p.speed);
    }
    const froude = src.speed / Math.sqrt(9.81 * Math.max(L, 1));
    this.ship[row]!.set(L, src.beam, src.speed, head);
    this.info[row]!.set(j, froude, foamDecay(L), wakeLifetime(L));
    this.box[row]!.set(minX, minY, maxX, maxY);
  }

  dispose(): void {
    this.texture.dispose();
  }
}
