import { PRESETS, presetExperiment } from '../../schema/presets';
import {
  detectDeviceProfile,
  PERFORMANCE_LABELS,
  PERFORMANCE_MODES,
  type PerformanceMode,
} from '../deviceProfile';
import { useLab, type ThemePreference } from '../store';
import { Dialog } from './Dialog';
import { SelectField } from './fields';

export function Dialogs() {
  const dialog = useLab((s) => s.dialog);
  const close = () => useLab.getState().openDialog(null);
  return (
    <>
      <Dialog open={dialog === 'presets'} title="Experiment presets" onClose={close}>
        <p className="field__hint" style={{ marginTop: 0 }}>
          Each preset is a complete experiment. Loading one replaces the current scene (you can undo
          with Ctrl+Z).
        </p>
        <ul className="preset-grid">
          {PRESETS.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="preset-card"
                onClick={() => {
                  useLab.getState().loadExperiment(presetExperiment(p.id), `Loaded “${p.title}”`);
                  close();
                }}
              >
                <strong>{p.title}</strong>
                <span>{p.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
      <Dialog open={dialog === 'help'} title="Help & keyboard shortcuts" onClose={close}>
        <HelpContent />
      </Dialog>
      <Dialog open={dialog === 'settings'} title="Settings" onClose={close}>
        <SettingsContent />
      </Dialog>
    </>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['.', 'Step 0.1 s (while paused)'],
  ['R', 'Restart the experiment from t = 0'],
  ['[ / ]', 'Slower / faster simulation'],
  ['C', 'Cycle camera (orbit, top, follow, bridge)'],
  ['O', 'Cycle surface overlay'],
  ['F', 'Follow the selected vessel'],
  ['Esc', 'Clear selection / close dialog'],
  ['Delete', 'Remove the selected item'],
  ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / redo'],
  ['Arrow keys, + / −, Home', 'Orbit, zoom and reset the 3D view (when the view is focused)'],
  ['?', 'This help'],
];

function HelpContent() {
  return (
    <div className="prose">
      <h3>What is this?</h3>
      <p>
        Wave Laboratory simulates ocean waves from oceanographic wave spectra and lets you put ships
        into them. Waves come from linear (Airy) wave theory with choppy Lagrangian displacement;
        ships feel the same waves through pressure integration over their instantaneous wetted hull,
        with added mass, damping, propulsion and steering.
      </p>
      <h3>Getting started</h3>
      <p>
        Pick a preset, or edit the sea in the <strong>Scene</strong> panel: add wave systems
        (spectra, wind seas or regular waves), vessels and wave gauges. Select anything to edit it
        in the <strong>Inspector</strong>. Data appears in the dock at the bottom; the Statistics
        tab can export everything as CSV. On a phone the ocean fills the top of the screen and
        Scene, Inspector and Data switch underneath it. Drag with one finger to orbit and pinch with
        two fingers to zoom. Presets stays in the header; everything else is in the More menu,
        including Settings for theme and graphics quality.
      </p>
      <h3>Keyboard shortcuts</h3>
      <table className="data-table">
        <caption className="visually-hidden">Keyboard shortcuts</caption>
        <thead>
          <tr>
            <th scope="col">Keys</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map(([k, a]) => (
            <tr key={k}>
              <td style={{ textAlign: 'left' }}>
                <kbd>{k}</kbd>
              </td>
              <td style={{ textAlign: 'left', whiteSpace: 'normal' }}>{a}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Scientific notes</h3>
      <p>
        Spectra: JONSWAP, Pierson–Moskowitz and Bretschneider, with the TMA finite-depth factor;
        wind seas follow Hasselmann et al. (1973) fetch-limited growth. Directional spreading:
        Mitsuyasu, cos-2s or Donelan–Banner. Dispersion includes finite depth and surface tension.
        The sea is a sum of four FFT cascades (1 km down to centimetre ripples); the ship physics
        uses the same components at wavelengths above ~2.7 m.
      </p>
      <p>
        Limits: linear wave theory (no wave–wave interaction or true breaking dynamics), constant
        added mass and empirical damping. Model-validity warnings appear in the inspector when you
        leave the range where these assumptions hold.
      </p>
    </div>
  );
}

function SettingsContent() {
  const theme = useLab((s) => s.theme);
  const performance = useLab((s) => s.performance);
  const lab = useLab.getState;
  return (
    <>
      <SelectField<ThemePreference>
        label="Colour theme"
        value={theme}
        options={[
          { value: 'system', label: 'Match system' },
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ]}
        onChange={(v) => lab().setTheme(v)}
      />
      <SelectField<PerformanceMode>
        label="Graphics"
        value={performance}
        options={PERFORMANCE_MODES.map((m) => ({ value: m, label: PERFORMANCE_LABELS[m] }))}
        onChange={(v) => lab().setPerformance(v)}
        hint={`Detected: ${detectDeviceProfile().description}. Higher levels draw a denser sea, finer ripples and more rain and spray at a higher resolution. The physics is identical at every level.`}
      />
    </>
  );
}
