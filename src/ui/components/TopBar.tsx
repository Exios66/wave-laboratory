import { useId, useRef } from 'react';
import { presetExperiment } from '../../schema/presets';
import { readExperimentFile, saveExperiment, shareUrl } from '../fileOps';
import type { PerformanceMode } from '../deviceProfile';
import { useLab, type ThemePreference } from '../store';
import { Icon } from './icons';
import { Menu } from './Menu';

export function TopBar() {
  const name = useLab((s) => s.experiment.name);
  const canUndo = useLab((s) => s.past.length > 0);
  const canRedo = useLab((s) => s.future.length > 0);
  const theme = useLab((s) => s.theme);
  const performance = useLab((s) => s.performance);
  const perfId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const themeId = useId();
  const lab = useLab.getState;

  const onOpen = async (file: File | undefined) => {
    if (!file) return;
    const r = await readExperimentFile(file);
    if (r.ok) lab().loadExperiment(r.experiment, `Opened “${r.experiment.name}”`);
    else lab().notify('error', `Could not open file: ${r.errors.slice(0, 2).join('; ')}`);
    if (fileRef.current) fileRef.current.value = '';
  };

  const newExperiment = () => {
    const blank = presetExperiment('calm-harbour');
    blank.name = 'Untitled experiment';
    blank.description = '';
    blank.vessels = [];
    lab().loadExperiment(blank, 'Started a new experiment');
  };

  const onShare = async () => {
    const url = shareUrl(lab().experiment);
    try {
      await navigator.clipboard.writeText(url);
      lab().notify('success', 'Shareable link copied to the clipboard.');
    } catch {
      window.history.replaceState(null, '', url);
      lab().notify('info', 'Link placed in the address bar — copy it from there.');
    }
  };

  return (
    <header className="topbar app__header">
      <p className="brand">
        <Icon name="logo" size={24} />
        <span>Wave Laboratory</span>
      </p>
      <div className="topbar__name">
        <label htmlFor={nameId} className="visually-hidden">
          Experiment name
        </label>
        <input
          id={nameId}
          key={name}
          defaultValue={name}
          maxLength={80}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== name) {
              lab().updateExperiment(
                (d) => {
                  d.name = v;
                },
                { reload: false },
              );
            } else e.target.value = name;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <nav className="toolbar" aria-label="Experiment">
        <button
          type="button"
          className="btn"
          aria-label="Presets"
          onClick={() => lab().openDialog('presets')}
        >
          <Icon name="presets" />
          <span className="btn__label">Presets</span>
        </button>
        <span className="toolbar desktop-only">
          <button type="button" className="btn" aria-label="New experiment" onClick={newExperiment}>
            <Icon name="plus" />
            <span className="btn__label">New</span>
          </button>
          <button
            type="button"
            className="btn"
            aria-label="Open experiment file"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="open" />
            <span className="btn__label">Open…</span>
          </button>
          <button
            type="button"
            className="btn"
            aria-label="Save experiment"
            onClick={() => saveExperiment(lab().experiment)}
          >
            <Icon name="save" />
            <span className="btn__label">Save</span>
          </button>
          <button
            type="button"
            className="btn"
            aria-label="Share link"
            onClick={() => void onShare()}
          >
            <Icon name="share" />
            <span className="btn__label">Share link</span>
          </button>
          <span className="toolbar__sep" aria-hidden="true" />
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            aria-keyshortcuts="Control+Z"
            disabled={!canUndo}
            onClick={() => lab().undo()}
          >
            <Icon name="undo" />
          </button>
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
            aria-keyshortcuts="Control+Shift+Z"
            disabled={!canRedo}
            onClick={() => lab().redo()}
          >
            <Icon name="redo" />
          </button>
          <span className="toolbar__sep" aria-hidden="true" />
          <label htmlFor={perfId} className="visually-hidden">
            Graphics performance
          </label>
          <select
            id={perfId}
            className="select"
            style={{ width: 'auto' }}
            value={performance}
            title="Graphics performance — the physics is identical in every mode"
            onChange={(e) => lab().setPerformance(e.target.value as PerformanceMode)}
          >
            <option value="auto">Graphics: Auto</option>
            <option value="saver">Graphics: Battery saver</option>
            <option value="quality">Graphics: Best quality</option>
          </select>
          <label htmlFor={themeId} className="visually-hidden">
            Colour theme
          </label>
          <select
            id={themeId}
            className="select"
            style={{ width: 'auto' }}
            value={theme}
            onChange={(e) => lab().setTheme(e.target.value as ThemePreference)}
          >
            <option value="system">System theme</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Settings"
            title="Settings"
            onClick={() => lab().openDialog('settings')}
          >
            <Icon name="settings" />
          </button>
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Help and keyboard shortcuts"
            title="Help (?)"
            aria-keyshortcuts="Shift+?"
            onClick={() => lab().openDialog('help')}
          >
            <Icon name="help" />
          </button>
        </span>
        <span className="mobile-only">
          <Menu
            ariaLabel="More actions"
            className="btn btn--icon"
            label={<Icon name="more" />}
            items={[
              { label: 'New experiment', onSelect: newExperiment },
              { label: 'Open…', onSelect: () => fileRef.current?.click() },
              { label: 'Save', onSelect: () => saveExperiment(lab().experiment) },
              { label: 'Share link', onSelect: () => void onShare() },
              ...(canUndo ? [{ label: 'Undo', onSelect: () => lab().undo() }] : []),
              ...(canRedo ? [{ label: 'Redo', onSelect: () => lab().redo() }] : []),
              { label: 'Settings…', onSelect: () => lab().openDialog('settings') },
              { label: 'Help', onSelect: () => lab().openDialog('help') },
            ]}
          />
        </span>

        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => void onOpen(e.target.files?.[0])}
        />
      </nav>
    </header>
  );
}
