import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  motionSicknessIncidence,
  rms,
  spectralParameters,
  welchPsd,
  zeroCrossingStatistics,
} from '../../instruments/analysis';
import { downloadText, slug } from '../fileOps';
import { getRuntime } from '../runtime';
import { useLab, type DockTab } from '../store';
import { telemetry } from '../telemetry';
import { Chart, type ChartSeries } from './Chart';
import { fmt } from './fields';
import { Icon } from './icons';

const TABS: { id: DockTab; label: string }[] = [
  { id: 'gauges', label: 'Wave gauges' },
  { id: 'motions', label: 'Vessel motions' },
  { id: 'spectrum', label: 'Spectrum' },
  { id: 'statistics', label: 'Statistics' },
];

const WINDOW_S = 120;
const COLORS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4'];

/** Re-render on new telemetry, at most once per `intervalMs`. */
function useTelemetryRevision(intervalMs = 250): number {
  const [rev, setRev] = useState(telemetry.revision);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = telemetry.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setRev(telemetry.revision);
      }, intervalMs);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);
  return rev;
}

export function Dock() {
  const tab = useLab((s) => s.dockTab);
  const lab = useLab.getState;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    lab().setDockTab(TABS[next]!.id);
    requestAnimationFrame(() => document.getElementById(`tab-${TABS[next]!.id}`)?.focus());
  };

  return (
    <section className="panel app__dock" aria-label="Playback and data" id="dock">
      <div className="transport">
        <Transport />
        <div className="tabs" role="tablist" aria-label="Data views">
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => lab().setDockTab(t.id)}
              onKeyDown={onTabKey}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div
        className="dock__panel"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
      >
        {tab === 'gauges' && <GaugeCharts />}
        {tab === 'motions' && <MotionCharts />}
        {tab === 'spectrum' && <SpectrumChart />}
        {tab === 'statistics' && <Statistics />}
      </div>
    </section>
  );
}

function Transport() {
  const playing = useLab((s) => s.playing);
  const timeScale = useLab((s) => s.timeScale);
  const t = useLab((s) => s.frame?.t ?? 0);
  const stepMs = useLab((s) => s.frame?.stepMs ?? 0);
  const ready = useLab((s) => s.status === 'ready');
  const lab = useLab.getState;
  return (
    <div className="toolbar" role="group" aria-label="Playback">
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => lab().setPlaying(!playing)}
        aria-keyshortcuts="Space"
        disabled={!ready}
        style={{ minWidth: 92 }}
      >
        <Icon name={playing ? 'pause' : 'play'} />
        {playing ? 'Pause' : 'Play'}
      </button>
      <button
        type="button"
        className="btn btn--icon"
        aria-label="Step 0.1 seconds"
        title="Step 0.1 s (.)"
        aria-keyshortcuts="."
        disabled={playing || !ready}
        onClick={() => getRuntime().stepOnce()}
      >
        <Icon name="step" />
      </button>
      <button
        type="button"
        className="btn btn--icon"
        aria-label="Restart from t = 0"
        title="Restart (R)"
        aria-keyshortcuts="R"
        onClick={() => getRuntime().restart()}
      >
        <Icon name="restart" />
      </button>
      <label className="visually-hidden" htmlFor="speed">
        Simulation speed
      </label>
      <select
        id="speed"
        className="select"
        style={{ width: 'auto' }}
        value={String(timeScale)}
        onChange={(e) => lab().setTimeScale(Number(e.target.value))}
      >
        {[0.1, 0.25, 0.5, 1, 2, 4].map((s) => (
          <option key={s} value={String(s)}>
            {s}× speed
          </option>
        ))}
      </select>
      <span className="transport__time" aria-label={`Simulation time ${t.toFixed(1)} seconds`}>
        {formatClock(t)}
      </span>
      <span className="field__hint" title="Physics cost of the last update">
        {stepMs.toFixed(1)} ms
      </span>
    </div>
  );
}

function formatClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

// ------------------------------------------------------------------ charts

function GaugeCharts() {
  const probes = useLab((s) => s.experiment.probes);
  const series: ChartSeries[] = useMemo(
    () => probes.slice(0, 4).map((p, i) => ({ label: p.name, colorVar: COLORS[i]!, unit: 'm' })),
    [probes],
  );
  useTelemetryRevision();
  if (probes.length === 0) {
    return (
      <p className="empty">Add a wave gauge in the Scene panel to record surface elevation.</p>
    );
  }
  const latest = probes
    .slice(0, 4)
    .map((p) => `${p.name}: ${fmt(telemetry.channel(`${p.id}:eta`)?.last(), 2, 'm')}`)
    .join(', ');
  return (
    <Chart
      title={`Surface elevation η, last ${WINDOW_S} s`}
      series={series}
      xLabel="Time [s]"
      yLabel="η [m]"
      summary={`Latest values — ${latest}.`}
      getData={() => {
        const base = telemetry.window(`${probes[0]!.id}:eta`, WINDOW_S);
        return [base.t, ...probes.slice(0, 4).map((p) => alignTo(base.t, `${p.id}:eta`))];
      }}
    />
  );
}

function alignTo(t: Float64Array, channel: string): Float64Array {
  const w = telemetry.window(channel, WINDOW_S);
  if (w.v.length === t.length) return w.v;
  const out = new Float64Array(t.length).fill(Number.NaN);
  out.set(w.v.subarray(Math.max(0, w.v.length - t.length)), Math.max(0, t.length - w.v.length));
  return out;
}

function useFocusVessel() {
  const selection = useLab((s) => s.selection);
  const vessels = useLab((s) => s.experiment.vessels);
  const id = selection?.kind === 'vessel' ? selection.id : vessels[0]?.id;
  return vessels.find((v) => v.id === id);
}

function MotionCharts() {
  const vessel = useFocusVessel();
  useTelemetryRevision();
  const angleSeries: ChartSeries[] = useMemo(
    () => [
      { label: 'Roll', colorVar: '--chart-1', unit: '°' },
      { label: 'Pitch', colorVar: '--chart-2', unit: '°' },
    ],
    [],
  );
  const heaveSeries: ChartSeries[] = useMemo(
    () => [
      { label: 'Heave', colorVar: '--chart-3', unit: 'm' },
      { label: 'Bridge vert. accel.', colorVar: '--chart-4', unit: 'm/s²', dash: [4, 3] },
    ],
    [],
  );
  if (!vessel) return <p className="empty">Add a vessel to see its motions.</p>;
  const ch = (q: string) => `${vessel.id}:${q}`;
  return (
    <div className="charts-row">
      <Chart
        title={`${vessel.name}: roll and pitch`}
        series={angleSeries}
        xLabel="Time [s]"
        yLabel="Angle [°]"
        summary={`Roll ${fmt(telemetry.channel(ch('roll'))?.last(), 1, '°')}, pitch ${fmt(telemetry.channel(ch('pitch'))?.last(), 1, '°')}.`}
        getData={() => {
          const r = telemetry.window(ch('roll'), WINDOW_S);
          return [r.t, r.v, alignTo(r.t, ch('pitch'))];
        }}
      />
      <Chart
        title={`${vessel.name}: heave and bridge acceleration`}
        series={heaveSeries}
        xLabel="Time [s]"
        yLabel="m · m/s²"
        summary={`Heave ${fmt(telemetry.channel(ch('heave'))?.last(), 2, 'm')}.`}
        getData={() => {
          const h = telemetry.window(ch('heave'), WINDOW_S);
          return [h.t, h.v, alignTo(h.t, ch('bridgeAccel'))];
        }}
      />
    </div>
  );
}

function SpectrumChart() {
  const probes = useLab((s) => s.experiment.probes);
  const vessel = useFocusVessel();
  useTelemetryRevision(1000);
  const series: ChartSeries[] = useMemo(() => {
    const s: ChartSeries[] = probes
      .slice(0, 2)
      .map((p, i) => ({ label: `${p.name} η`, colorVar: COLORS[i]!, unit: 'm²/Hz' }));
    if (vessel) s.push({ label: `${vessel.name} heave`, colorVar: '--chart-3', unit: 'm²/Hz' });
    return s;
  }, [probes, vessel]);
  const channels = [
    ...probes.slice(0, 2).map((p) => `${p.id}:eta`),
    ...(vessel ? [`${vessel.id}:heave`] : []),
  ];
  if (channels.length === 0)
    return <p className="empty">Add a gauge or vessel to analyse spectra.</p>;
  const rate = telemetry.sampleRate;
  const n = telemetry.channel(channels[0]!)?.length ?? 0;
  if (n < 128) {
    return (
      <p className="empty">
        Collecting data… spectra need at least {Math.ceil(128 / rate)} s of record (currently{' '}
        {(n / rate).toFixed(0)} s).
      </p>
    );
  }
  const params = channels.map((c) =>
    spectralParameters(welchPsd(telemetry.window(c, 600).v, rate, 256)),
  );
  return (
    <Chart
      title="Power spectral density (Welch, Hann, 50 % overlap, last 10 min)"
      series={series}
      xLabel="Frequency [Hz]"
      yLabel="S(f)"
      summary={params
        .map((p, i) => `${series[i]?.label}: Hm0 ${p.hm0.toFixed(2)} m, Tp ${p.tp.toFixed(1)} s`)
        .join('; ')}
      getData={() => {
        const psds = channels.map((c) => welchPsd(telemetry.window(c, 600).v, rate, 256));
        const len = Math.min(...psds.map((p) => p.freq.length));
        const maxBin = Math.min(len, Math.ceil(0.5 / (rate / 256)) + 1); // up to 0.5 Hz
        return [
          psds[0]!.freq.subarray(1, maxBin),
          ...psds.map((p) => p.density.subarray(1, maxBin)),
        ];
      }}
    />
  );
}

// ------------------------------------------------------------------ statistics

function Statistics() {
  const exp = useLab((s) => s.experiment);
  useTelemetryRevision(1000);
  const frame = useLab.getState().frame;
  const rate = telemetry.sampleRate;
  const duration = telemetry.time.length / rate;

  const gaugeRows = exp.probes.map((p) => {
    const v = telemetry.window(`${p.id}:eta`, 1800).v;
    const zc = zeroCrossingStatistics(v, rate);
    const sp = v.length >= 128 ? spectralParameters(welchPsd(v, rate, 256)) : null;
    return { p, zc, sp };
  });
  const vesselRows = exp.vessels.map((ves) => {
    const w = (q: string) => telemetry.window(`${ves.id}:${q}`, 1800).v;
    const roll = w('roll');
    const pitch = w('pitch');
    const heave = w('heave');
    const acc = w('bridgeAccel');
    const accRms = rms(acc);
    const fz = acc.length >= 128 ? spectralParameters(welchPsd(acc, rate, 256)) : null;
    const msi = fz && fz.tp > 0 ? motionSicknessIncidence(accRms, 1 / fz.tp) : Number.NaN;
    let maxRoll = 0;
    for (const r of roll) maxRoll = Math.max(maxRoll, Math.abs(r));
    const tel = frame?.vessels.find((x) => x.id === ves.id);
    return {
      ves,
      roll: rms(roll),
      pitch: rms(pitch),
      heave: rms(heave),
      maxRoll,
      accRms,
      msi,
      tel,
    };
  });

  const exportCsv = () =>
    downloadText(`${slug(exp.name)}-telemetry.csv`, telemetry.toCsv(), 'text/csv');

  return (
    <div>
      <div className="toolbar" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="field__hint">
          Record length {duration.toFixed(0)} s at {rate} Hz. Statistics stabilise after several
          minutes of simulated time.
        </span>
        <button type="button" className="btn" onClick={exportCsv} disabled={duration === 0}>
          <Icon name="download" size={16} /> Export CSV
        </button>
      </div>
      {gaugeRows.length > 0 && (
        <table className="data-table">
          <caption>Wave gauges</caption>
          <thead>
            <tr>
              <th scope="col">Gauge</th>
              <th scope="col">
                H<sub>m0</sub>
              </th>
              <th scope="col">
                H<sub>1/3</sub>
              </th>
              <th scope="col">
                H<sub>max</sub>
              </th>
              <th scope="col">
                T<sub>p</sub>
              </th>
              <th scope="col">
                T<sub>z</sub>
              </th>
              <th scope="col">Waves</th>
            </tr>
          </thead>
          <tbody>
            {gaugeRows.map(({ p, zc, sp }) => (
              <tr key={p.id}>
                <th scope="row">{p.name}</th>
                <td>{fmt(sp?.hm0, 2, 'm')}</td>
                <td>{fmt(zc.h13, 2, 'm')}</td>
                <td>{fmt(zc.hmax, 2, 'm')}</td>
                <td>{fmt(sp?.tp, 1, 's')}</td>
                <td>{fmt(zc.tz, 1, 's')}</td>
                <td>{zc.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {vesselRows.length > 0 && (
        <table className="data-table" style={{ marginTop: 12 }}>
          <caption>Vessel seakeeping</caption>
          <thead>
            <tr>
              <th scope="col">Vessel</th>
              <th scope="col">Roll RMS</th>
              <th scope="col">Max |roll|</th>
              <th scope="col">Pitch RMS</th>
              <th scope="col">Heave RMS</th>
              <th scope="col">Bridge acc. RMS</th>
              <th scope="col">
                <abbr title="Motion sickness incidence (O'Hanlon & McCauley), % in 2 h">MSI</abbr>
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {vesselRows.map((r) => (
              <tr key={r.ves.id}>
                <th scope="row">{r.ves.name}</th>
                <td>{fmt(r.roll, 2, '°')}</td>
                <td>{fmt(r.maxRoll, 1, '°')}</td>
                <td>{fmt(r.pitch, 2, '°')}</td>
                <td>{fmt(r.heave, 2, 'm')}</td>
                <td>{fmt(r.accRms, 2, 'm/s²')}</td>
                <td>{fmt(r.msi, 0, '%')}</td>
                <td>
                  {r.tel?.capsized
                    ? 'Capsized'
                    : r.tel?.slamming
                      ? 'Slamming'
                      : r.tel?.greenWater
                        ? 'Green water'
                        : 'Normal'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {gaugeRows.length === 0 && vesselRows.length === 0 && (
        <p className="empty">Nothing to analyse yet — add gauges or vessels.</p>
      )}
    </div>
  );
}
