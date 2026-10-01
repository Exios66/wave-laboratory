import { useEffect, useRef } from 'react';
import { LabRenderer } from '../../render/LabRenderer';
import type { CameraMode, OverlayMode } from '../../render/api';
import { getRuntime } from '../runtime';
import { useLab } from '../store';
import { fmt } from './fields';

const CAMERAS: { mode: CameraMode; label: string; needsVessel: boolean }[] = [
  { mode: 'orbit', label: 'Orbit', needsVessel: false },
  { mode: 'top', label: 'Top', needsVessel: false },
  { mode: 'follow', label: 'Follow', needsVessel: true },
  { mode: 'bridge', label: 'Bridge', needsVessel: true },
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
  const status = useLab((s) => s.status);
  const error = useLab((s) => s.error);
  const camera = useLab((s) => s.camera);
  const overlay = useLab((s) => s.overlay);
  const cameraTarget = useLab((s) => s.cameraTarget);
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
                  tabIndex={camera === c.mode ? 0 : -1}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
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
        {overlay !== 'none' && <Legend mode={overlay} />}
      </div>
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
