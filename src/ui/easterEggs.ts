/**
 * Easter eggs. Nothing here changes the physics: the duck is drawn over the real hull, the
 * Draupner sea is an ordinary experiment, and the gravity greetings only post a notice.
 *
 *  - Konami code (↑ ↑ ↓ ↓ ← → ← → B A), or naming the experiment "rubber duck": toggle duck mode.
 *  - Typing "draupner" anywhere outside a text field, or naming the experiment "Draupner":
 *    load the New Year's Wave of 1995.
 *  - Setting gravity to that of the Moon, Mars, Titan or Jupiter: a greeting.
 */
import { useEffect } from 'react';
import { draupnerExperiment } from '../schema/secretPresets';
import { useLab } from './store';

export const KONAMI = [
  'arrowup',
  'arrowup',
  'arrowdown',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'arrowleft',
  'arrowright',
  'b',
  'a',
] as const;

export const DRAUPNER_WORD = [...'draupner'];

/** Watches a stream of keys for any of several sequences. */
export class SequenceMatcher<Id extends string> {
  private readonly longest: number;
  private recent: string[] = [];

  constructor(private readonly sequences: Record<Id, readonly string[]>) {
    this.longest = Math.max(...Object.values<readonly string[]>(sequences).map((s) => s.length));
  }

  /** Feed one key (compared case-insensitively). Returns the id of a sequence it completes. */
  push(key: string): Id | null {
    this.recent.push(key.toLowerCase());
    if (this.recent.length > this.longest) this.recent.shift();
    for (const id of Object.keys(this.sequences) as Id[]) {
      const seq = this.sequences[id];
      if (seq.length > this.recent.length) continue;
      const tail = this.recent.slice(-seq.length);
      if (tail.every((k, i) => k === seq[i])) {
        this.recent = [];
        return id;
      }
    }
    return null;
  }
}

interface GravityGreeting {
  body: string;
  g: number;
  tolerance: number;
  message: string;
}

export const GRAVITY_GREETINGS: readonly GravityGreeting[] = [
  {
    body: 'moon',
    g: 1.62,
    tolerance: 0.03,
    message:
      'Welcome to the Lunar Sea. At 1.62 m/s² every wave travels about 2.5 times slower than on ' +
      'Earth. The Mare Tranquillitatis was never this wet.',
  },
  {
    body: 'titan',
    g: 1.35,
    tolerance: 0.03,
    message:
      'Kraken Mare, Titan. The largest methane sea in the Solar System sits under 1.35 m/s², and ' +
      'its waves are thought to be mostly ripples.',
  },
  {
    body: 'mars',
    g: 3.71,
    tolerance: 0.05,
    message:
      'Ares Vallis is flooded again. Under Martian gravity a 10 s swell is only 59 m long, against ' +
      '156 m on Earth.',
  },
  {
    body: 'jupiter',
    g: 24.79,
    tolerance: 0.3,
    message:
      'Jupiter has no sea to float in, but at 24.8 m/s² these waves move about 1.6 times faster ' +
      'than on Earth.',
  },
];

export function gravityGreeting(g: number): GravityGreeting | null {
  return GRAVITY_GREETINGS.find((x) => Math.abs(g - x.g) <= x.tolerance) ?? null;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function toggleDuckMode(): void {
  const lab = useLab.getState();
  const on = !lab.duckMode;
  lab.setDuckMode(on);
  lab.notify(
    'success',
    on
      ? 'Rubber duck mode. Only the paint changed: each duck still floats, rolls and slams like the ship underneath.'
      : 'The ducks have gone home.',
  );
}

export function loadDraupner(): void {
  useLab
    .getState()
    .loadExperiment(
      draupnerExperiment(),
      '1 January 1995, 15:20. Draupner E platform, North Sea. Keep an eye on the gauge.',
    );
}

export function useEasterEggs(): void {
  useEffect(() => {
    const matcher = new SequenceMatcher({ konami: KONAMI, draupner: DRAUPNER_WORD });
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTextEntry(e.target)) return;
      const hit = matcher.push(e.key);
      if (hit === 'konami') toggleDuckMode();
      else if (hit === 'draupner') loadDraupner();
    };
    window.addEventListener('keydown', onKey);

    const unsubscribe = useLab.subscribe((s, prev) => {
      const name = s.experiment.name.trim().toLowerCase();
      if (name !== prev.experiment.name.trim().toLowerCase()) {
        if (/^rubber ?duck(ie|y)?$/.test(name)) {
          if (!s.duckMode) toggleDuckMode();
        } else if (name === 'draupner') {
          loadDraupner();
          return;
        }
      }
      const g = s.experiment.environment.gravity;
      const before = prev.experiment.environment.gravity;
      if (g === before) return;
      const now = gravityGreeting(g);
      if (now && now !== gravityGreeting(before)) s.notify('info', now.message);
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      unsubscribe();
    };
  }, []);
}
