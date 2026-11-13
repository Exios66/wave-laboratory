import { describe, expect, it } from 'vitest';
import { GpuTimer } from './gpuTimer';

/**
 * A WebGL 2 context with just the timer-query surface. Every query's result is ready at once and
 * takes the next duration from `cycle` [ms], in the order the queries were created.
 */
function fakeGl(cycle: number[], withExtension = true): WebGL2RenderingContext {
  let created = 0;
  const durations = new Map<object, number>();
  return {
    QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867,
    getExtension: () => (withExtension ? {} : null),
    createQuery: () => {
      const q = {};
      durations.set(q, cycle[created++ % cycle.length]!);
      return q;
    },
    beginQuery: () => {},
    endQuery: () => {},
    deleteQuery: (q: object) => durations.delete(q),
    getParameter: () => false,
    getQueryParameter: (q: object, pname: number) =>
      pname === 0x8867 ? true : durations.get(q)! * 1e6,
  } as unknown as WebGL2RenderingContext;
}

describe('GpuTimer', () => {
  it('times each pass separately and sums them into the frame time', () => {
    const t = new GpuTimer(fakeGl([2, 5]));
    for (let frame = 0; frame < 120; frame++) {
      t.begin('ocean');
      t.end();
      t.begin('scene');
      t.end();
    }
    expect(t.passes?.ocean).toBeCloseTo(2, 1);
    expect(t.passes?.scene).toBeCloseTo(5, 1);
    expect(t.passes?.post).toBeUndefined();
    expect(t.ms).toBeCloseTo(7, 1);
  });

  it('reports nothing without the timer extension', () => {
    const t = new GpuTimer(fakeGl([2, 5], false));
    for (let frame = 0; frame < 10; frame++) {
      t.begin('ocean');
      t.end();
    }
    expect(t.passes).toBeNull();
    expect(t.ms).toBeNull();
  });

  it('forgets every pass on reset (context restore)', () => {
    const t = new GpuTimer(fakeGl([3]));
    t.begin('prepass');
    t.end();
    expect(t.passes?.prepass).toBeCloseTo(3, 5);
    t.reset();
    expect(t.passes).toBeNull();
    expect(t.ms).toBeNull();
  });
});
