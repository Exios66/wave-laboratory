import { useEffect } from 'react';
import type { CameraMode, OverlayMode } from '../render/api';
import { Dialogs } from './components/Dialogs';
import { Dock } from './components/Dock';
import { Inspector } from './components/Inspector';
import { Notices } from './components/Notices';
import { ScenePanel } from './components/ScenePanel';
import { TopBar } from './components/TopBar';
import { Viewport } from './components/Viewport';
import { useEasterEggs } from './easterEggs';
import { experimentFromLocation } from './fileOps';
import { getRuntime } from './runtime';
import { useLab, type MobilePanel } from './store';
import './styles.css';

const CAMERA_CYCLE: CameraMode[] = ['orbit', 'top', 'follow', 'bridge', 'plane'];
const OVERLAY_CYCLE: OverlayMode[] = ['none', 'height', 'steepness', 'foam'];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    target.isContentEditable ||
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.closest('dialog') !== null
  );
}

function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const lab = useLab.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !isTyping(e.target)) {
        e.preventDefault();
        if (e.shiftKey) lab.redo();
        else lab.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y' && !isTyping(e.target)) {
        e.preventDefault();
        lab.redo();
        return;
      }
      if (mod || e.altKey || isTyping(e.target)) return;
      const target = e.target as HTMLElement | null;
      const onButton = target?.tagName === 'BUTTON' || target?.getAttribute('role') === 'tab';
      switch (e.key) {
        case ' ':
          if (onButton) return; // let Space activate the focused button
          e.preventDefault();
          if (lab.status === 'ready') lab.setPlaying(!lab.playing);
          break;
        case '.':
          if (!lab.playing) getRuntime().stepOnce();
          break;
        case 'r':
        case 'R':
          getRuntime().restart();
          break;
        case '[':
          lab.setTimeScale(lab.timeScale / 2);
          break;
        case ']':
          lab.setTimeScale(lab.timeScale * 2);
          break;
        case 'c':
        case 'C': {
          const vesselId =
            lab.selection?.kind === 'vessel'
              ? lab.selection.id
              : (lab.experiment.vessels[0]?.id ?? null);
          const options = CAMERA_CYCLE.filter(
            (m) => vesselId || m === 'orbit' || m === 'top' || m === 'plane',
          );
          const next = options[(options.indexOf(lab.camera) + 1) % options.length]!;
          lab.setCamera(next, next === 'follow' || next === 'bridge' ? vesselId : lab.cameraTarget);
          lab.notify('info', `Camera: ${next}`);
          break;
        }
        case 'o':
        case 'O': {
          const next =
            OVERLAY_CYCLE[(OVERLAY_CYCLE.indexOf(lab.overlay) + 1) % OVERLAY_CYCLE.length]!;
          lab.setOverlay(next);
          lab.notify('info', `Overlay: ${next === 'none' ? 'realistic' : next}`);
          break;
        }
        case 'f':
        case 'F':
          if (lab.selection?.kind === 'vessel') lab.setCamera('follow', lab.selection.id);
          break;
        case 'Escape':
          lab.select(null);
          break;
        case 'Delete':
        case 'Backspace': {
          const sel = lab.selection;
          if (!sel || sel.kind === 'environment' || sel.kind === 'weather') return;
          const key = sel.kind === 'wave' ? 'waves' : sel.kind === 'vessel' ? 'vessels' : 'probes';
          const removed = lab.updateExperiment((d) => {
            const list = d[key] as { id: string }[];
            const i = list.findIndex((x) => x.id === sel.id);
            if (i >= 0) list.splice(i, 1);
          });
          if (removed) lab.notify('info', 'Item removed. Undo with Ctrl+Z.');
          break;
        }
        case '?':
          lab.openDialog('help');
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useTheme(): void {
  const theme = useLab((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
}

function useInitialExperimentFromUrl(): void {
  useEffect(() => {
    const load = () => {
      const r = experimentFromLocation();
      if (!r) return;
      if (r.ok)
        useLab
          .getState()
          .loadExperiment(r.experiment, `Loaded shared experiment “${r.experiment.name}”`);
      else useLab.getState().notify('error', `The shared link is invalid: ${r.errors[0] ?? ''}`);
      history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    load();
    // A share link pasted into an already open tab only changes the hash.
    window.addEventListener('hashchange', load);
    return () => window.removeEventListener('hashchange', load);
  }, []);
}

function useDocumentTitle(): void {
  const name = useLab((s) => s.experiment.name);
  useEffect(() => {
    document.title = `${name} · Wave Laboratory`;
  }, [name]);
}

const MOBILE_PANELS: { id: MobilePanel; label: string; controls: string }[] = [
  { id: 'scene', label: 'Scene', controls: 'scene' },
  { id: 'inspector', label: 'Inspector', controls: 'inspector' },
  { id: 'data', label: 'Data', controls: 'dock' },
];

/** Panel switcher shown under the 3D view on narrow screens (hidden on desktop). */
function MobileTabs() {
  const panel = useLab((s) => s.mobilePanel);
  const set = useLab.getState().setMobilePanel;
  return (
    <div className="mobile-tabs" role="tablist" aria-label="Panels">
      {MOBILE_PANELS.map((p, i) => (
        <button
          key={p.id}
          id={`mtab-${p.id}`}
          type="button"
          role="tab"
          aria-selected={panel === p.id}
          aria-controls={p.controls}
          tabIndex={panel === p.id ? 0 : -1}
          onClick={() => set(p.id)}
          onKeyDown={(e) => {
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const next = MOBILE_PANELS[(i + d + MOBILE_PANELS.length) % MOBILE_PANELS.length]!;
            set(next.id);
            requestAnimationFrame(() => document.getElementById(`mtab-${next.id}`)?.focus());
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

export function App() {
  useGlobalShortcuts();
  useEasterEggs();
  useTheme();
  useInitialExperimentFromUrl();
  useDocumentTitle();
  const mobilePanel = useLab((s) => s.mobilePanel);
  return (
    <>
      <a className="skip-link" href="#viewport-canvas">
        Skip to 3D view
      </a>
      <a className="skip-link" href="#inspector">
        Skip to inspector
      </a>
      <div className="app" data-mobile-panel={mobilePanel}>
        <TopBar />
        <ScenePanel />
        <Viewport />
        <MobileTabs />
        <Inspector />
        <Dock />
      </div>
      <Notices />
      <Dialogs />
    </>
  );
}
