import { beforeEach, describe, expect, it, vi } from 'vitest';
import { presetExperiment } from '../schema/presets';
import type { FromWorker, SimFrame, ToWorker } from './types';
import { SimClient } from './SimClient';

/** Records everything the client sends; tests dispatch worker messages back by hand. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  url: string;
  opts: { type?: string } | null;
  onmessage: ((ev: { data: FromWorker }) => void) | null = null;
  onerror: ((ev: { message: string; preventDefault(): void }) => void) | null = null;
  sent: ToWorker[] = [];
  terminated = false;

  constructor(url: URL | string, opts?: { type?: string }) {
    this.url = String(url);
    this.opts = opts ?? null;
    FakeWorker.instances.push(this);
  }

  postMessage(msg: ToWorker): void {
    this.sent.push(msg);
  }

  dispatch(msg: FromWorker): void {
    this.onmessage?.({ data: msg });
  }

  fail(message: string): void {
    this.onerror?.({ message, preventDefault() {} });
  }

  terminate(): void {
    this.terminated = true;
  }
}

const LOADED: FromWorker = {
  type: 'loaded',
  ocean: {} as never,
  vessels: [],
  diagnostics: { hs: 1, systems: [], warnings: [] },
} as unknown as FromWorker;

function frame(t: number, overrides: Partial<SimFrame> = {}): Extract<FromWorker, { type: 'frame' }> {
  return {
    type: 'frame',
    frame: {
      t,
      vessels: [],
      probes: [],
      stepMs: 1,
      lagging: false,
      samples: null,
      weather: { windSpeed: 5, windFromDeg: 270, squall: 0, rainMmH: 0 },
      collisions: [],
      ...overrides,
    },
  };
}

function client(): { c: SimClient; w: FakeWorker } {
  const c = new SimClient(() => new FakeWorker('fake://worker', { type: 'module' }) as unknown as Worker);
  return { c, w: FakeWorker.instances.at(-1)! };
}

/** load → loaded → frame: the handshake SimClient waits for before the run loop opens. */
function runUp(c: SimClient, w: FakeWorker): void {
  c.load(presetExperiment('moderate-sea'));
  w.dispatch(LOADED);
  w.dispatch(frame(0));
}

describe('SimClient', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
  });

  it('sends the load and opens the loop only after loaded + frame', () => {
    const { c, w } = client();
    const exp = presetExperiment('moderate-sea');
    c.load(exp);
    expect(w.url).toContain('worker');
    expect(w.opts).toEqual({ type: 'module' });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toEqual({ type: 'load', experiment: exp });
    expect(c.busy).toBe(true);
    w.dispatch(LOADED);
    expect(c.busy).toBe(true); // the load's reply frame is still missing
    w.dispatch(frame(0));
    expect(c.busy).toBe(false);
    c.load(exp, 'high');
    expect(w.sent[1]).toEqual({ type: 'load', experiment: exp, visualQuality: 'high' });
  });

  it('queues advances while the worker is busy and drains them loss-free', () => {
    const { c, w } = client();
    runUp(c, w);
    c.advance(0.1);
    expect(w.sent[1]).toEqual({ type: 'advance', dt: 0.1 });
    // Three more seconds requested while the sweep is in flight: nothing is posted yet.
    c.advance(0.2);
    c.advance(0.2);
    c.advance(0.2);
    expect(w.sent).toHaveLength(2);
    // The reply reopens the loop; the accumulated time is flushed on the next request.
    w.dispatch(frame(0.5));
    expect(w.sent).toHaveLength(2);
    c.advance(0.05);
    const queued = w.sent[2] as { type: 'advance'; dt: number };
    expect(queued.type).toBe('advance');
    expect(queued.dt).toBeCloseTo(0.65, 12); // 0.2 + 0.2 + 0.2 + 0.05, three seconds don't queue
    expect(c.busy).toBe(true);
    // A camera probe is carried along with the advance it belongs to.
    w.dispatch(frame(0.75)); // reply to the drained sweep
    c.advance(1, { x: 3, y: -4 });
    expect(w.sent[3]).toEqual({ type: 'advance', dt: 1, cameraProbe: { x: 3, y: -4 } });
  });

  it('drops stale pending advances on a mid-flight reload', () => {
    const { c, w } = client();
    const exp = presetExperiment('moderate-sea');
    runUp(c, w);
    c.advance(0.5);
    expect(w.sent[1]).toEqual({ type: 'advance', dt: 0.5 });
    c.advance(0.3); // queued against the old experiment
    expect(w.sent).toHaveLength(2);
    // Reload while the sweep is running: pending time must not leak into the new experiment.
    c.load(exp);
    expect(w.sent).toHaveLength(3);
    expect(w.sent[2]!.type).toBe('load');
    expect(w.sent.filter((m) => m.type === 'advance')).toHaveLength(1);
    // Still loading: even a fresh advance request waits for the reload's reply.
    c.advance(0.055);
    expect(w.sent.filter((m) => m.type === 'advance')).toHaveLength(1);
    expect(c.busy).toBe(true);
    w.dispatch(LOADED); // the reload's handshake: loaded, then the frame
    w.dispatch(frame(0));
    expect(c.busy).toBe(false);
    c.advance(0.045); // the pre-reload 0.3 s is gone; only the fresh requests drain
    const afterReload = w.sent[3] as { type: 'advance'; dt: number };
    expect(afterReload.type).toBe('advance');
    expect(afterReload.dt).toBeCloseTo(0.1, 12); // 0.055 + 0.045, not 0.4 (0.3 + 0.055 + 0.045)
  });

  it('routes loaded, ocean, frame and error frames to their listeners', () => {
    const { c, w } = client();
    const onLoaded = vi.fn();
    const onOcean = vi.fn();
    const onFrame = vi.fn();
    const onError = vi.fn();
    c.on('loaded', onLoaded);
    c.on('ocean', onOcean);
    c.on('frame', onFrame);
    c.on('error', onError);
    c.load(presetExperiment('moderate-sea'));
    w.dispatch(LOADED);
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded.mock.calls[0]![0]).toBe(LOADED);
    w.dispatch({ type: 'ocean', ocean: { cascades: [] } as never });
    expect(onOcean).toHaveBeenCalledTimes(1);
    w.dispatch(frame(2));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![0].t).toBe(2);
    w.dispatch({ type: 'error', message: 'Invalid experiment: heading out of range' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe('Invalid experiment: heading out of range');
    // A worker crash (onerror) also surfaces as an error event and frees the loop.
    w.fail('Simulation worker crashed');
    w.dispatch(frame(3)); // the next request is accepted after the crash
    c.advance(1);
    expect(w.sent.at(-1)).toEqual({ type: 'advance', dt: 1 });
  });

  it('probes the surface without advancing, skipping the request while busy', () => {
    const { c, w } = client();
    c.load(presetExperiment('moderate-sea'));
    expect(c.probe({ x: 1, y: 2 })).toBe(false); // loading
    w.dispatch(LOADED);
    w.dispatch(frame(0));
    expect(c.probe({ x: 1, y: 2 })).toBe(true);
    expect(w.sent[1]).toEqual({ type: 'advance', dt: 0, cameraProbe: { x: 1, y: 2 } });
    expect(c.probe({ x: 9, y: 9 })).toBe(false); // in flight
    expect(w.sent).toHaveLength(2);
    w.dispatch(frame(0));
    expect(c.probe({ x: 5, y: 5 })).toBe(true);
    expect(w.sent[2]).toEqual({ type: 'advance', dt: 0, cameraProbe: { x: 5, y: 5 } });
  });

  it('passes step, weather, command and visual messages straight through', () => {
    const { c, w } = client();
    runUp(c, w);
    c.step(3);
    expect(w.sent[1]).toEqual({ type: 'step', count: 3 });
    c.step(3, { x: 1, y: 1 });
    expect(w.sent[2]).toEqual({ type: 'step', count: 3, cameraProbe: { x: 1, y: 1 } });
    const weather = {
      windSpeed: 0,
      windFromDeg: 0,
      squall: 0,
      rainMmH: 0,
      clouds: 0,
      visibility: 0,
      lightning: 0,
    } as never;
    c.setWeather(weather);
    expect(w.sent[3]).toEqual({ type: 'weather', weather });
    c.command('v1', { rudderDeg: 5 });
    expect(w.sent[4]).toEqual({ type: 'command', vesselId: 'v1', command: { rudderDeg: 5 } });
    c.setVisualQuality('low');
    expect(w.sent[5]).toEqual({ type: 'visual', quality: 'low' });
  });

  it('dispose terminates the worker and silences the client', () => {
    const { c, w } = client();
    const onFrame = vi.fn();
    c.on('frame', onFrame);
    c.dispose();
    expect(w.terminated).toBe(true);
    expect(() => c.advance(1)).not.toThrow();
    expect(w.sent).toHaveLength(0); // no message sent after dispose
    w.dispatch(frame(1)); // a late worker reply must not revive events
    expect(onFrame).not.toHaveBeenCalled();
  });
});
