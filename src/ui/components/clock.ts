/** "HH:MM" for a clock time in hours (wraps into 0–24). */
export function formatClock(hours: number): string {
  const total = Math.floor((((hours % 24) + 24) % 24) * 60 + 1e-6) % (24 * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Rough phase of the day for a clock time (matches the sun path in scenery/lighting). */
export function dayPhase(hours: number): 'night' | 'dawn' | 'day' | 'dusk' {
  const h = ((hours % 24) + 24) % 24;
  if (h >= 5.25 && h < 7) return 'dawn';
  if (h >= 7 && h < 17) return 'day';
  if (h >= 17 && h < 18.75) return 'dusk';
  return 'night';
}
