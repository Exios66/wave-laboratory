import { useEffect } from 'react';
import type { CameraMode, OverlayMode } from '../render/api';
import { Dialogs } from './components/Dialogs';
import { Dock } from './components/Dock';
import { Inspector } from './components/Inspector';
import { Notices } from './components/Notices';
import { ScenePanel } from './components/ScenePanel';
import { TopBar } from './components/TopBar';
import { Viewport } from './components/Viewport';
import { experimentFromLocation } from './fileOps';
import { getRuntime } from './runtime';
import { useLab } from './store';
import './styles.css';

const CAMERA_CYCLE: CameraMode[] = ['orbit', 'top', 'follow', 'bridge'];
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
          const options = CAMERA_CYCLE.filter((m) => vesselId || m === 'orbit' || m === 'top');
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
          if (!sel || sel.kind === 'environment') return;
          const key = sel.kind === 'wave' ? 'waves' : sel.kind === 'vessel' ? 'vessels' : 'probes';
          lab.updateExperiment((d) => {
            const list = d[key] as { id: string }[];
            const i = list.findIndex((x) => x.id === sel.id);
            if (i >= 0) list.splice(i, 1);
          });
          lab.select(null);
          lab.notify('info', 'Item removed. Undo with Ctrl+Z.');
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
    const r = experimentFromLocation();
    if (!r) return;
    if (r.ok)
      useLab
        .getState()
        .loadExperiment(r.experiment, `Loaded shared experiment “${r.experiment.name}”`);
    else useLab.getState().notify('error', `The shared link is invalid: ${r.errors[0] ?? ''}`);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
}

function useDocumentTitle(): void {
  const name = useLab((s) => s.experiment.name);
  useEffect(() => {
    document.title = `${name} · Wave Laboratory`;
  }, [name]);
}

export function App() {
  useGlobalShortcuts();
  useTheme();
  useInitialExperimentFromUrl();
  useDocumentTitle();
  return (
    <>
      <a className="skip-link" href="#viewport-canvas">
        Skip to 3D view
      </a>
      <a className="skip-link" href="#inspector">
        Skip to inspector
      </a>
      <div className="app">
        <TopBar />
        <ScenePanel />
        <Viewport />
        <Inspector />
        <Dock />
      </div>
      <Notices />
      <Dialogs />
    </>
  );
}
