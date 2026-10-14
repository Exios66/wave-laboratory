import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presetExperiment } from '../schema/presets';
import type { Experiment } from '../schema/experiment';
import { useLab } from './store';
import { experimentFromLocation } from './fileOps';
import { LabRuntime } from './runtime';
import type { FromWorker, SimFrame, ToWorker } from '../sim/types';
import { telemetry } from './telemetry';

const lab = useLab.getState;

let now = 1000;

/** Records everything the runtime's SimClient sends; tests drive worker replies by hand. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((ev: { data: FromWorker }) => void) | null = null;
  onerror: ((ev: { message: string; preventDefault(): void }) => void) | null = null;
  sent: ToWorker[] = [];
  terminated = false;

  constructor(url: URL | string, _opts?: { type?: string }) {
    void url;
    FakeWorker.instances.push(this);
  }

  postMessage(msg: ToWorker): void {
    this.sent.push(msg);
  }

  dispatch(msg: FromWorker): void {
    this.onmessage?.({ data: msg });
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

let runtime: LabRuntime | null = null;
let worker: FakeWorker;

beforeEach(() => {
  now = 1000;
  FakeWorker.instances = [];
  const storage = new Map<string, string>();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const win = {
    matchMedia: () => ({ matches: false }),
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    innerWidth: 1440,
    innerHeight: 900,
    location: { hash: '', pathname: '/', search: '' },
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  });
  lab().loadExperiment(presetExperiment('moderate-sea'));
  runtime = new LabRuntime();
  worker = FakeWorker.instances.at(-1)!;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Complete the load handshake the runtime waits for. */
function loadReply(t = 4): void {
  worker.dispatch(LOADED);
  worker.dispatch(frame(t));
}

function loadedCount(): number {
  return worker.sent.filter((m) => m.type === 'load').length;
}

describe('LabRuntime', () => {
  it('sends the initial load and opens the store only after the loaded + frame handshake', () => {
    expect(loadedCount()).toBe(1);
    expect(lab().status).toBe('loading');
    worker.dispatch(LOADED);
    expect(lab().status).toBe('ready');
  });

  it('reloads on a revision bump: worker reload, telemetry clear, simulated clock rewind', () => {
    loadReply();
    // Build some telemetry, then make an experiment edit (revision bump).
    now = 1090;
    worker.dispatch(frame(5, { samples: { rate: 10, t0: 0, channels: { 'v1:eta': [1, 2] } } }));
    expect(lab().frame!.t).toBe(5);
    expect(telemetry.time.length).toBe(2);
    expect(lab().updateExperiment((d) => void (d.environment.windSpeed = 11))).toBe(true);
    const loads = worker.sent.filter((m) => m.type === 'load') as {
      type: 'load';
      experiment: Experiment;
      visualQuality?: string;
    }[];
    expect(loads).toHaveLength(2);
    expect(loads[1]!.experiment.environment.windSpeed).toBe(11);
    expect(loads[1]!.visualQuality).toBe('high');
    expect(lab().status).toBe('loading');
    expect(telemetry.time.length).toBe(0); // the old experiment's history is gone
    // The reload's reply rewinds the simulated clock: no stale t = 5 metrics survive.
    now = 2200;
    worker.dispatch(LOADED);
    expect(lab().status).toBe('ready');
    worker.dispatch(frame(0));
    expect(lab().frame!.t).toBe(0);
    runtime!.dispose();
    expect(worker.terminated).toBe(true);
  });

  it('pushes live weather edits to the worker without reloading', () => {
    loadReply();
    const before = loadedCount();
    expect(
      lab().updateExperiment((d) => void (d.environment.windSpeed = 13), { reload: false }),
    ).toBe(true);
    expect(loadedCount()).toBe(before); // no reload
    expect(lab().status).toBe('ready');
    expect(worker.sent.at(-1)).toMatchObject({ type: 'weather' });
  });

  it('coalesces worker frames into the store on the ~80 ms rhythm while telemetry keeps every sample', () => {
    loadReply();
    const a = frame(1, { samples: { rate: 10, t0: 1, channels: { 'v1:eta': [1, 1] } } }).frame;
    const b = frame(2, { samples: { rate: 10, t0: 2, channels: { 'v1:eta': [2, 2] } } }).frame;
    const c = frame(3, { samples: { rate: 10, t0: 3, channels: { 'v1:eta': [3, 3, 3] } } }).frame;
    now = 1200; // 200 ms after the handshake frame: this one lands
    worker.dispatch({ type: 'frame', frame: a });
    expect(lab().frame).toBe(a);
    now = 1250; // 50 ms after the previous store update: coalesced away
    worker.dispatch({ type: 'frame', frame: b });
    expect(lab().frame).toBe(a);
    now = 1290; // 90 ms after the previous store update: lands
    worker.dispatch({ type: 'frame', frame: c });
    expect(lab().frame).toBe(c);
    // Telemetry is fed from every worker frame, coalesced or not.
    expect(telemetry.time.length).toBe(2 + 2 + 3);
    const eta = telemetry.channel('v1:eta')!;
    expect(eta.get(0)).toBe(1);
    expect(eta.get(2)).toBe(2);
    expect(eta.last()).toBe(3);
    // Paused, nothing is coalesced: the store tracks the simulation exactly.
    lab().setPlaying(false);
    const d = frame(4).frame;
    now = 1420;
    worker.dispatch({ type: 'frame', frame: d });
    expect(lab().frame).toBe(d);
  });

  it('caps undo history at 100 structured-cloned experiments', () => {
    loadReply();
    // Snapshots are independent copies, not aliases of the live experiment.
    const base = lab().experiment.environment.windSpeed;
    lab().updateExperiment((d) => void (d.environment.windSpeed = (base + 1) % 40));
    const top = lab().past.at(-1)!;
    expect(top.environment.windSpeed).toBe(base);
    expect(top).not.toBe(lab().experiment);
    // 105 more edits: the earliest snapshots fall off the front.
    for (let k = 2; k <= 106; k++) {
      expect(lab().updateExperiment((d) => void (d.environment.windSpeed = (base + k) % 40))).toBe(
        true,
      );
    }
    expect(lab().past).toHaveLength(100);
    // The six pre-eviction snapshots are gone; the oldest retained is the 7th edit's parent.
    expect(lab().past[0]!.environment.windSpeed).toBe((base + 6) % 40);
    lab().undo();
    expect(lab().experiment.environment.windSpeed).toBe((base + 105) % 40);
    expect(lab().future).toHaveLength(1);
    expect(lab().past).toHaveLength(99);
  });

  it('surfaces share-link and experiment parse errors as notices instead of throwing', () => {
    loadReply();
    const revision = lab().revision;
    expect(() => lab().loadExperiment({ garbage: true } as unknown as Experiment)).not.toThrow();
    const notice = lab().notices.at(-1)!;
    expect(notice.tone).toBe('error');
    expect(notice.message.startsWith('Could not load experiment')).toBe(true);
    // The broken document was never applied: no revision bump, no reload.
    expect(lab().revision).toBe(revision);
    expect(loadedCount()).toBe(1);
    // A corrupted share-link hash parses to a failed result rather than an exception.
    const w = globalThis.window as { location: { hash: string } };
    w.location.hash = '#exp=@@@not-base64@@@';
    const parsed = experimentFromLocation();
    expect(parsed?.ok).toBe(false);
    if (!parsed || parsed.ok) throw new Error('expected a failed parse');
    expect(parsed.errors.length).toBeGreaterThan(0);
    // No share payload at all → nothing to load (App treats that as "not a share link").
    w.location.hash = '#something-else';
    expect(experimentFromLocation()).toBeNull();
  });

  it('restart() reloads with the experiment as it is right now', () => {
    loadReply();
    const before = loadedCount();
    runtime!.restart();
    const loads = worker.sent.filter((m) => m.type === 'load');
    expect(loads).toHaveLength(before + 1);
    expect(telemetry.time.length).toBe(0);
    // restart() does not touch the store status: the reload reply decides when it's ready again.
    expect(lab().status).toBe('ready');
    now = 3000;
    worker.dispatch(LOADED);
    worker.dispatch(frame(0));
    expect(lab().frame!.t).toBe(0);
  });
});
