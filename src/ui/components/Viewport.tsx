import { beaufortFromWind } from '../../core/units';
import { useEffect, useRef, useState } from 'react';
import { LabRenderer } from '../../render/LabRenderer';
import type { CameraMode, OverlayMode } from '../../render/api';
import { getRuntime } from '../runtime';
import { useLab } from '../store';
import { dayPhase, formatClock } from './clock';
import { fmt } from './fields';
import { Icon } from './icons';
import { Minimap } from './Minimap';
import { ExpandViewButton, RevealButtons } from './Splitters';

const CAMERAS: { mode: CameraMode; label: string; needsVessel: boolean }[] = [
  { mode: 'orbit', label: 'Orbit', needsVessel: false },
  { mode: 'top', label: 'Top', needsVessel: false },
  { mode: 'follow', label: 'Follow', needsVessel: true },
  { mode: 'bridge', label: 'Bridge', needsVessel: true },
  { mode: 'underwater', label: 'Underwater', needsVessel: false },
];

const OVERLAYS: { mode: OverlayMode; label: string }[] = [
  { mode: 'none', label: 'Realistic' },
  { mode: 'height', label: 'Surface height η' },
  { mode: 'steepness', label: 'Slope / steepness' },
  { mode: 'foam', label: 'Breaking & foam' },
];

export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const status = useLab((s) => s.status);
  const error = useLab((s) => s.error);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rt = getRuntime();
    rt.attach(
      canvas,
      (c) =>
        new LabRenderer(c, {
          onContextLost: () =>
            useLab.getState().notify('warning', 'Graphics context lost — trying to restore…'),
          onContextRestored: () => useLab.getState().notify('success', 'Graphics restored.'),
        }),
    );
    return () => rt.detach();
  }, []);

  return (
    <main className="viewport app__viewport" aria-labelledby="viewport-title" id="viewport">
      <h2 id="viewport-title" className="visually-hidden">
        3D view
      </h2>
      <canvas
        ref={canvasRef}
        id="viewport-canvas"
        tabIndex={0}
        aria-label="3D ocean view. Drag to orbit, scroll to zoom, click a vessel or gauge to select it. With the view focused, use arrow keys to orbit, plus and minus to zoom and Home to reset."
        aria-describedby="viewport-desc"
        onKeyDown={(e) => {
          const r = getRuntime().rendererApi;
          if (!r) return;
          const map: Record<string, Parameters<typeof r.nudgeCamera>[0]> = {
            ArrowLeft: 'left',
            ArrowRight: 'right',
            ArrowUp: 'up',
            ArrowDown: 'down',
            '+': 'in',
            '=': 'in',
            '-': 'out',
            Home: 'reset',
          };
          const action = map[e.key];
          if (action) {
            e.preventDefault();
            r.nudgeCamera(action);
          }
        }}
        onClick={(e) => {
          const r = getRuntime().rendererApi;
          if (!r) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const hit = r.pick(e.clientX - rect.left, e.clientY - rect.top);
          const lab = useLab.getState();
          if (hit?.kind === 'vessel' && hit.id) lab.select({ kind: 'vessel', id: hit.id });
          else if (hit?.kind === 'probe' && hit.id) lab.select({ kind: 'probe', id: hit.id });
        }}
      />
      <p id="viewport-desc" className="visually-hidden">
        The scene shows the simulated sea surface and vessels. All values shown visually are also
        available as text in the inspector and in the statistics tab.
      </p>
      {status === 'unsupported' ? (
        <div className="viewport__message" role="alert">
          <div>
            <h3>3D view unavailable</h3>
            <p>
              This browser could not start WebGL 2, which the ocean renderer needs. The physics
              still runs: the inspector, charts and statistics stay fully usable.
            </p>
            <p style={{ opacity: 0.8, fontSize: 13 }}>{error}</p>
          </div>
        </div>
      ) : (
        <Hud />
      )}
    </main>
  );
}

function Hud() {
  const t = useLab((s) => s.frame?.t ?? 0);
  const lagging = useLab((s) => s.frame?.lagging ?? false);
  const hs = useLab((s) => s.diagnostics?.hs);
  const weather = useLab((s) => s.frame?.weather);
  const status = useLab((s) => s.status);
  const error = useLab((s) => s.error);
  const camera = useLab((s) => s.camera);
  const overlay = useLab((s) => s.overlay);
  const cameraTarget = useLab((s) => s.cameraTarget);
  const groundCamera = useLab((s) => s.groundCamera);
  const selection = useLab((s) => s.selection);
  const vessels = useLab((s) => s.experiment.vessels);
  const lab = useLab.getState;

  const selectedVessel =
    selection?.kind === 'vessel' ? selection.id : (cameraTarget ?? vessels[0]?.id ?? null);

  return (
    <div className="hud">
      <div className="hud__row">
        <div className="hud__card">
          <dl className="hud__stats">
            <div>
              <dt>t</dt>
              <dd>{fmt(t, 1, 's')}</dd>
            </div>
            <div>
              <dt>Hs</dt>
              <dd>{fmt(hs, 2, 'm')}</dd>
            </div>
            {weather && (
              <div title={`Wind from ${weather.windFromDeg.toFixed(0)}° (at the origin)`}>
                <dt>Wind</dt>
                <dd>
                  {fmt(weather.windSpeed, 0, 'm/s')} · Bf {beaufortFromWind(weather.windSpeed)}
                  {weather.squall > 0.3 ? ' · squall' : weather.rainMmH > 0.5 ? ' · rain' : ''}
                </dd>
              </div>
            )}
            <HudClock />
            {lagging && (
              <div>
                <dt className="visually-hidden">Status</dt>
                <dd style={{ color: '#fbbf24' }}>slower than real time</dd>
              </div>
            )}
          </dl>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div className="segmented" role="radiogroup" aria-label="Camera">
            {CAMERAS.map((c) => {
              const disabled = c.needsVessel && !selectedVessel;
              return (
                <button
                  key={c.mode}
                  type="button"
                  role="radio"
                  aria-checked={camera === c.mode}
                  disabled={disabled}
                  onClick={() =>
                    lab().setCamera(c.mode, c.needsVessel ? selectedVessel : cameraTarget)
                  }
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                    e.preventDefault();
                    const enabled = CAMERAS.filter((x) => !(x.needsVessel && !selectedVessel));
                    const i = enabled.findIndex((x) => x.mode === camera);
                    const next =
                      enabled[
                        (i + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length
                      ]!;
                    lab().setCamera(next.mode, next.needsVessel ? selectedVessel : cameraTarget);
                    const group = e.currentTarget.parentElement;
                    requestAnimationFrame(() =>
                      group?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(),
                    );
                  }}
                  tabIndex={
                    camera === c.mode || (camera === 'plane' && groundCamera === c.mode) ? 0 : -1
                  }
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="hud__plane"
            aria-pressed={camera === 'plane'}
            title={
              camera === 'plane'
                ? 'Back to the previous view'
                : 'Ride one of the lost flights for a bird’s-eye view of the lab'
            }
            onClick={() => lab().togglePlaneView()}
          >
            <Icon name="plane" size={16} />
            {camera === 'plane' ? 'Land' : 'Plane'}
          </button>
          <ExpandViewButton />
          <label className="visually-hidden" htmlFor="overlay-select">
            Surface overlay
          </label>
          <select
            id="overlay-select"
            value={overlay}
            onChange={(e) => lab().setOverlay(e.target.value as OverlayMode)}
          >
            {OVERLAYS.map((o) => (
              <option key={o.mode} value={o.mode}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="hud__row" style={{ alignItems: 'flex-end' }}>
        <div
          role="status"
          aria-live="polite"
          className={status === 'ready' ? 'visually-hidden' : 'hud__card'}
        >
          {status === 'loading' && 'Synthesising the sea…'}
          {status === 'error' && `Simulation error: ${error ?? 'unknown'}`}
          {status === 'ready' && 'Simulation running'}
        </div>
        {camera === 'plane' && <RideCaption />}
        <DepthBadge />
        <div className="hud__corner">
          {overlay !== 'none' && <Legend mode={overlay} />}
          <Minimap />
        </div>
      </div>
      <RevealButtons />
    </div>
  );
}

/** Live "Underwater · 4.2 m" badge while the camera is under the sea, whichever view is active. */
function DepthBadge() {
  const [depth, setDepth] = useState<number | null>(null);
  useEffect(() => {
    const read = () => {
      const stats = getRuntime().rendererApi?.stats;
      setDepth(stats?.underwater ? stats.cameraDepth : null);
    };
    read();
    const id = window.setInterval(read, 250);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className={depth === null ? 'visually-hidden' : 'hud__card hud__depth'}>
      <span
        aria-live="polite"
        role="status"
        className={depth === null ? undefined : 'visually-hidden'}
      >
        {depth === null ? '' : 'Underwater'}
      </span>
      {depth !== null && <span aria-hidden="true">Underwater · {depth.toFixed(1)} m</span>}
    </div>
  );
}

/** Which flight the plane view is riding, and how to look around from it. */
function RideCaption() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setLabel(getRuntime().rendererApi?.planeRide() ?? null);
    read();
    const id = window.setInterval(read, 500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="hud__card hud__ride" role="status">
      <strong>{label ? `Riding with ${label}` : 'Joining a lost flight…'}</strong>
      <span>Drag to look around · scroll to sit further back</span>
    </div>
  );
}

const PHASE_LABEL = { night: 'night', dawn: 'dawn', day: 'daytime', dusk: 'dusk' } as const;

/** Clock time of the day:night cycle with a sun or moon glyph. Hidden when the cycle is off. */
function HudClock() {
  const on = useLab((s) => s.ambience.dayNight);
  const clock = useLab((s) => formatClock(s.timeOfDay));
  const phase = useLab((s) => dayPhase(s.timeOfDay));
  if (!on) return null;
  const moon = phase === 'night';
  return (
    <div className="hud__clock" title="Time of day (Settings → Day & night)">
      <dt>
        <svg
          viewBox="0 0 16 16"
          width="13"
          height="13"
          aria-hidden="true"
          focusable="false"
          style={{ verticalAlign: '-2px' }}
        >
          {moon ? (
            <path d="M10.5 1.5a6.5 6.5 0 1 0 4 11.2A5.5 5.5 0 0 1 10.5 1.5z" fill="#c7d2fe" />
          ) : (
            <g fill="none" stroke={phase === 'day' ? '#fcd34d' : '#fb923c'} strokeWidth="1.6">
              <circle cx="8" cy="8" r="3.2" fill={phase === 'day' ? '#fcd34d' : '#fb923c'} />
              <path
                d="M8 .8v2.2M8 13v2.2M.8 8H3M13 8h2.2M2.9 2.9l1.6 1.6M11.5 11.5l1.6 1.6M2.9 13.1l1.6-1.6M11.5 4.5l1.6-1.6"
                strokeLinecap="round"
              />
            </g>
          )}
        </svg>
        <span className="visually-hidden">Time of day</span>
      </dt>
      <dd>
        <time>{clock}</time>
        <span className="visually-hidden">, {PHASE_LABEL[phase]}</span>
      </dd>
    </div>
  );
}

function Legend({ mode }: { mode: OverlayMode }) {
  const hs = useLab((s) => s.diagnostics?.hs ?? 1);
  const a = Math.max(0.25, hs * 0.75);
  const spec =
    mode === 'height'
      ? {
          title: 'Surface elevation η',
          gradient: 'linear-gradient(90deg,#2166ac,#67a9cf,#f7f7f7,#ef8a62,#b2182b)',
          ticks: [`−${a.toFixed(1)} m`, '0', `+${a.toFixed(1)} m`],
        }
      : mode === 'steepness'
        ? {
            title: 'Slope |∇η|',
            gradient: 'linear-gradient(90deg,#0d0887,#7e03a8,#cc4778,#f89540,#f0f921)',
            ticks: ['0', '0.15', '0.3+'],
          }
        : {
            title: 'Breaking (Jacobian) & foam',
            gradient: 'linear-gradient(90deg,#08306b,#4292c6,#f7fbff)',
            ticks: ['none', '', 'breaking'],
          };
  return (
    <figure className="hud__card legend" style={{ margin: 0 }}>
      <figcaption>{spec.title}</figcaption>
      <div className="legend__bar" style={{ background: spec.gradient }} aria-hidden="true" />
      <div className="legend__ticks">
        {spec.ticks.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
    </figure>
  );
}
