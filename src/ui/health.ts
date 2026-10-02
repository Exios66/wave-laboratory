/** Wording and notices for vessel health (damage) in the UI. */
import type { CollisionEvent, SimFrame } from '../sim/types';
import type { DamageCause } from '../vessel/api';

/** Plain-language description of a damage cause. */
export const DAMAGE_CAUSE_LABELS: Record<DamageCause, string> = {
  slamming: 'Bow slamming into the waves',
  'green-water': 'Green water breaking over the deck',
  weather: 'Storm-force wind',
  heel: 'Heavy rolling and heel',
  collision: 'Collision with another vessel',
  capsize: 'Capsized',
};

/** Health in whole percent (never shows 0 % for a ship that still has some left). */
export function healthPercent(health: number): number {
  const p = Math.round(Math.max(0, Math.min(1, health)) * 100);
  return p === 0 && health > 0 ? 1 : p;
}

export type HealthTone = 'ok' | 'warning' | 'danger';

export function healthTone(health: number): HealthTone {
  return health >= 0.6 ? 'ok' : health >= 0.25 ? 'warning' : 'danger';
}

/** Collisions this light are not announced (fenders kissing, hulls resting together). */
const NOTICE_SEVERITY = 0.002;
/** At most one collision notice per this many milliseconds. */
const COLLISION_NOTICE_INTERVAL_MS = 4000;

/**
 * Turns simulation frames into short notices: collisions (rate-limited) and vessels becoming
 * disabled (once per transition).
 */
export class HealthNotifier {
  private disabled = new Set<string>();
  private lastCollisionNotice = -Infinity;

  reset(): void {
    this.disabled.clear();
    this.lastCollisionNotice = -Infinity;
  }

  /** Messages to show for this frame. `names` maps vessel ids to display names. */
  check(frame: SimFrame, names: (id: string) => string, now: number): string[] {
    const out: string[] = [];
    const hit = strongest(frame.collisions);
    if (hit && now - this.lastCollisionNotice >= COLLISION_NOTICE_INTERVAL_MS) {
      this.lastCollisionNotice = now;
      const how = hit.severity >= 0.5 ? 'Heavy collision' : 'Collision';
      out.push(`${how}: ${names(hit.a)} and ${names(hit.b)}.`);
    }
    for (const v of frame.vessels) {
      if (v.disabled && !this.disabled.has(v.id)) {
        this.disabled.add(v.id);
        out.push(`${names(v.id)} is disabled and drifting. Repair it in the inspector.`);
      } else if (!v.disabled) {
        this.disabled.delete(v.id);
      }
    }
    return out;
  }
}

function strongest(events: readonly CollisionEvent[]): CollisionEvent | null {
  let best: CollisionEvent | null = null;
  for (const e of events) {
    if (e.severity >= NOTICE_SEVERITY && (!best || e.severity > best.severity)) best = e;
  }
  return best;
}
