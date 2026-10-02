import { describe, expect, it } from 'vitest';
import { DRAUPNER_WORD, gravityGreeting, KONAMI, SequenceMatcher } from './easterEggs';

describe('SequenceMatcher', () => {
  const keys = (m: SequenceMatcher<string>, seq: readonly string[]) => seq.map((k) => m.push(k));

  it('fires on the Konami code with real key names, in any case', () => {
    const m = new SequenceMatcher({ konami: KONAMI, draupner: DRAUPNER_WORD });
    const out = keys(m, [
      'ArrowUp',
      'ArrowUp',
      'ArrowDown',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowLeft',
      'ArrowRight',
      'B',
      'a',
    ]);
    expect(out.slice(0, -1).every((x) => x === null)).toBe(true);
    expect(out.at(-1)).toBe('konami');
  });

  it('finds a word typed after other keys, and only once', () => {
    const m = new SequenceMatcher({ draupner: DRAUPNER_WORD });
    const out = keys(m, [...'xxdraupner']);
    expect(out.filter(Boolean)).toEqual(['draupner']);
    expect(m.push('r')).toBeNull();
  });

  it('ignores a broken sequence', () => {
    const m = new SequenceMatcher({ draupner: DRAUPNER_WORD });
    expect(keys(m, [...'draupXner']).some(Boolean)).toBe(false);
  });
});

describe('gravityGreeting', () => {
  it('greets the Moon, Mars, Titan and Jupiter but not Earth', () => {
    expect(gravityGreeting(1.62)?.body).toBe('moon');
    expect(gravityGreeting(3.71)?.body).toBe('mars');
    expect(gravityGreeting(1.35)?.body).toBe('titan');
    expect(gravityGreeting(24.79)?.body).toBe('jupiter');
    expect(gravityGreeting(9.80665)).toBeNull();
  });

  it('quotes Martian wavelengths that match deep-water dispersion', () => {
    const L = (g: number, T: number) => (g * T * T) / (2 * Math.PI);
    expect(Math.round(L(3.71, 10))).toBe(59);
    expect(Math.round(L(9.80665, 10))).toBe(156);
    expect(Math.sqrt(9.80665 / 1.62)).toBeCloseTo(2.5, 1);
    expect(Math.sqrt(24.79 / 9.80665)).toBeCloseTo(1.6, 1);
  });
});
