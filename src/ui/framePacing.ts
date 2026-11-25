/**
 * Frame pacing and power policy (pure logic, no DOM): when to skip a frame, and when to stop
 * drawing altogether. Physics keeps its own clock; this only decides how often we draw and
 * whether the canvas is worth drawing at all (hidden tab, scrolled off-screen).
 */

export interface PowerSignals {
  /** `navigator.connection.saveData`. */
  saveData: boolean;
  /** Battery level 0..1 when known, and whether it is charging. */
  batteryLevel: number | null;
  charging: boolean;
  /** Software renderer: every frame is expensive, so draw fewer of them. */
  software: boolean;
}

export const NO_SIGNALS: PowerSignals = {
  saveData: false,
  batteryLevel: null,
  charging: true,
  software: false,
};

/** Frame-rate cap for the current power situation; 0 = uncapped (display refresh rate). */
export function frameCapFor(s: PowerSignals): number {
  if (s.software) return 30;
  if (s.saveData) return 30;
  if (s.batteryLevel !== null && !s.charging && s.batteryLevel <= 0.2) return 30;
  return 0;
}

/**
 * Skips frames to hold a cap. Tolerates rAF jitter: a frame arriving up to 15 % early still
 * counts, so a 30 fps cap on a 60 Hz display alternates cleanly instead of drifting to 20 fps.
 */
export class FramePacer {
  private last = Number.NEGATIVE_INFINITY;

  constructor(public capFps = 0) {}

  /** True when a frame should be produced at `nowMs` (and records it). */
  accept(nowMs: number): boolean {
    if (!(this.capFps > 0)) {
      this.last = nowMs;
      return true;
    }
    const interval = 1000 / this.capFps;
    if (nowMs - this.last < interval * 0.85) return false;
    // Keep phase locked to the cap, but never accumulate a backlog after a stall.
    this.last = nowMs - this.last > interval * 2 ? nowMs : this.last + interval;
    return true;
  }

  reset(): void {
    this.last = Number.NEGATIVE_INFINITY;
  }
}

/** Whether the lab should run: tab visible and canvas at least partly on screen. */
export function shouldRun(documentHidden: boolean, onScreen: boolean): boolean {
  return !documentHidden && onScreen;
}

/** Governor target: never ask for more fps than the cap allows. */
export function governorTarget(targetFps: number, capFps: number): number {
  return capFps > 0 ? Math.min(targetFps, capFps) : targetFps;
}
