import { beaufortFromWind, wmoSeaState } from '../../core/units';
import { wavelengthForPeriod, dispersionFor } from '../../ocean/systems';
import type {
  Environment,
  OceanQuality,
  ProbeConfig,
  Spreading,
  VesselConfig,
  VesselType,
  WaveSystem,
} from '../../schema/experiment';
import { getRuntime } from '../runtime';
import { findProbe, findVessel, findWave, useLab } from '../store';
import { VESSEL_TYPE_LABELS } from '../factories';
import { fmt, NumberField, Readout, SelectField, Switch, TextField } from './fields';
import { Icon } from './icons';

export function Inspector() {
  const selection = useLab((s) => s.selection);
  const exp = useLab((s) => s.experiment);

  let title = 'Sea state';
  let body = <SeaSummary />;
  if (selection?.kind === 'environment') {
    title = 'Environment';
    body = <EnvironmentInspector env={exp.environment} quality={exp.quality} />;
  } else if (selection?.kind === 'wave') {
    const w = findWave(exp, selection.id);
    if (w) {
      title = 'Wave system';
      body = <WaveInspector wave={w} />;
    }
  } else if (selection?.kind === 'vessel') {
    const v = findVessel(exp, selection.id);
    if (v) {
      title = 'Vessel';
      body = <VesselInspector vessel={v} />;
    }
  } else if (selection?.kind === 'probe') {
    const p = findProbe(exp, selection.id);
    if (p) {
      title = 'Wave gauge';
      body = <ProbeInspector probe={p} />;
    }
  }

  return (
    <aside className="panel app__inspector" aria-labelledby="inspector-title" id="inspector">
      <div className="panel__header">
        <h2 className="panel__title" id="inspector-title">
          {title}
        </h2>
        {selection && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => useLab.getState().select(null)}
          >
            Overview
          </button>
        )}
      </div>
      <div className="panel__body">{body}</div>
    </aside>
  );
}

// ------------------------------------------------------------------ overview

function SeaSummary() {
  const diag = useLab((s) => s.diagnostics);
  const exp = useLab((s) => s.experiment);
  const hs = diag?.hs ?? 0;
  const ss = wmoSeaState(hs);
  const bf = beaufortFromWind(exp.environment.windSpeed);
  return (
    <>
      <div className="prose">
        <p>{exp.description || 'Select an item in the scene to edit it.'}</p>
      </div>
      <Readout
        items={[
          { label: 'Hs (total)', value: fmt(hs, 2, 'm'), title: 'Significant wave height 4√m₀' },
          { label: 'Sea state', value: `${ss.code} · ${ss.label}`, title: 'WMO sea state code' },
          { label: 'Wind', value: `${fmt(exp.environment.windSpeed, 0, 'm/s')} · Bf ${bf}` },
          {
            label: 'Depth',
            value: exp.environment.depth >= 1000 ? 'Deep' : fmt(exp.environment.depth, 0, 'm'),
          },
        ]}
      />
      {diag && diag.systems.length > 0 && (
        <table className="data-table">
          <caption>Wave systems</caption>
          <thead>
            <tr>
              <th scope="col">System</th>
              <th scope="col">Hs</th>
              <th scope="col">Tp</th>
              <th scope="col">λp</th>
            </tr>
          </thead>
          <tbody>
            {diag.systems.map((s) => (
              <tr key={s.id}>
                <th scope="row">{exp.waves.find((w) => w.id === s.id)?.name ?? s.id}</th>
                <td>{fmt(s.hs, 2, 'm')}</td>
                <td>{fmt(s.tp, 1, 's')}</td>
                <td>{fmt(s.wavelength, 0, 'm')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Warnings />
    </>
  );
}

function Warnings() {
  const warnings = useLab((s) => s.diagnostics?.warnings ?? []);
  if (warnings.length === 0) return null;
  return (
    <div className="callout" role="note" style={{ marginTop: 12 }}>
      <strong>
        <Icon name="warning" size={14} /> Model validity
      </strong>
      <ul>
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ environment

function EnvironmentInspector({ env, quality }: { env: Environment; quality: OceanQuality }) {
  const lab = useLab.getState;
  const set = <K extends keyof Environment>(key: K, value: Environment[K], reload = true) =>
    lab().updateExperiment(
      (d) => {
        d.environment[key] = value;
      },
      { reload },
    );
  return (
    <>
      <fieldset className="fieldset">
        <legend>Water</legend>
        <NumberField
          label="Water depth"
          value={env.depth}
          min={2}
          max={4000}
          step={1}
          unit="m"
          unitLabel="metres"
          onCommit={(v) => set('depth', v)}
          hint="Depths of 1000 m or more behave as deep water. Shallow water shortens waves and limits their energy (TMA)."
        />
        <SelectField
          label="Water type"
          value={env.waterDensity > 1010 ? 'sea' : 'fresh'}
          options={[
            { value: 'sea', label: 'Seawater (1025 kg/m³)' },
            { value: 'fresh', label: 'Fresh water (999 kg/m³)' },
          ]}
          onChange={(v) => set('waterDensity', v === 'sea' ? 1025 : 999.1)}
        />
        <NumberField
          label="Choppiness λ"
          value={env.choppiness}
          min={0}
          max={1.5}
          step={0.05}
          onCommit={(v) => set('choppiness', v)}
          hint="1 = physical first-order Lagrangian motion (sharp crests). Other values are artistic."
        />
      </fieldset>
      <fieldset className="fieldset">
        <legend>Wind (visuals & whitecaps)</legend>
        <NumberField
          label="Wind speed (10 m)"
          value={env.windSpeed}
          min={0}
          max={40}
          step={0.5}
          unit="m/s"
          unitLabel="metres per second"
          onCommit={(v) => set('windSpeed', v, false)}
          hint={`Beaufort ${beaufortFromWind(env.windSpeed)}. To generate waves from wind, add a “Wind sea” system.`}
        />
        <NumberField
          label="Wind from"
          value={env.windDirectionDeg}
          min={0}
          max={360}
          step={5}
          unit="°"
          unitLabel="degrees"
          onCommit={(v) => set('windDirectionDeg', v, false)}
        />
      </fieldset>
      <fieldset className="fieldset">
        <legend>Sun</legend>
        <NumberField
          label="Sun elevation"
          value={env.sunElevationDeg}
          min={-5}
          max={90}
          step={1}
          unit="°"
          unitLabel="degrees"
          onCommit={(v) => set('sunElevationDeg', v, false)}
        />
        <NumberField
          label="Sun azimuth"
          value={env.sunAzimuthDeg}
          min={0}
          max={360}
          step={5}
          unit="°"
          unitLabel="degrees"
          onCommit={(v) => set('sunAzimuthDeg', v, false)}
        />
      </fieldset>
      <fieldset className="fieldset">
        <legend>Simulation</legend>
        <SelectField
          label="Ocean detail"
          value={quality}
          options={[
            { value: 'low', label: 'Low (64² FFT)' },
            { value: 'medium', label: 'Medium (128² FFT)' },
            { value: 'high', label: 'High (256² FFT)' },
            { value: 'ultra', label: 'Ultra (512² FFT)' },
          ]}
          onChange={(v) =>
            lab().updateExperiment((d) => {
              d.quality = v;
            })
          }
          hint="Visual resolution only; the physics always uses the same wave components."
        />
      </fieldset>
    </>
  );
}

// ------------------------------------------------------------------ waves

function WaveInspector({ wave }: { wave: WaveSystem }) {
  const lab = useLab.getState;
  const env = useLab((s) => s.experiment.environment);
  const diag = useLab((s) => s.diagnostics?.systems.find((x) => x.id === wave.id));
  const update = (recipe: (w: WaveSystem) => void) =>
    lab().updateExperiment((d) => {
      const w = d.waves.find((x) => x.id === wave.id);
      if (w) recipe(w);
    });

  const disp = dispersionFor(env);
  return (
    <>
      <TextField
        label="Name"
        value={wave.name}
        onCommit={(v) => update((w) => void (w.name = v))}
      />
      <Switch
        label="Enabled"
        checked={wave.enabled}
        onChange={(c) => update((w) => void (w.enabled = c))}
      />
      {diag && (
        <Readout
          items={[
            { label: 'Hs', value: fmt(diag.hs, 2, 'm') },
            { label: 'Tp', value: fmt(diag.tp, 1, 's') },
            { label: 'λ peak', value: fmt(diag.wavelength, 0, 'm') },
            { label: 'Steepness', value: fmt(diag.hs / diag.wavelength, 3), title: 'H / λ' },
          ]}
        />
      )}
      {diag?.note && <p className="field__hint">{diag.note}</p>}
      {wave.kind === 'spectrum' && (
        <>
          <SelectField
            label="Spectrum"
            value={wave.spectrum}
            options={[
              { value: 'jonswap', label: 'JONSWAP (developing sea)' },
              { value: 'pierson-moskowitz', label: 'Pierson–Moskowitz (fully developed)' },
              { value: 'bretschneider', label: 'Bretschneider / ITTC' },
            ]}
            onChange={(v) => update((w) => w.kind === 'spectrum' && void (w.spectrum = v))}
          />
          <NumberField
            label="Significant wave height Hs"
            value={wave.hs}
            min={0}
            max={20}
            step={0.1}
            unit="m"
            unitLabel="metres"
            onCommit={(v) => update((w) => w.kind === 'spectrum' && void (w.hs = v))}
          />
          <NumberField
            label="Peak period Tp"
            value={wave.tp}
            min={1}
            max={25}
            step={0.5}
            unit="s"
            unitLabel="seconds"
            onCommit={(v) => update((w) => w.kind === 'spectrum' && void (w.tp = v))}
            hint={`Peak wavelength ≈ ${wavelengthForPeriod(wave.tp, disp).toFixed(0)} m at this depth.`}
          />
          {wave.spectrum === 'jonswap' && (
            <NumberField
              label="Peak enhancement γ"
              value={wave.gamma}
              min={1}
              max={7}
              step={0.1}
              onCommit={(v) => update((w) => w.kind === 'spectrum' && void (w.gamma = v))}
              hint="3.3 is the JONSWAP mean; 1 reduces to Pierson–Moskowitz; swell is often 5–7."
            />
          )}
          <Switch
            label="Depth-limited (TMA)"
            checked={wave.depthLimited}
            onChange={(c) => update((w) => w.kind === 'spectrum' && void (w.depthLimited = c))}
            hint="Applies the Kitaigorodskii depth factor in water shallower than 1000 m."
          />
        </>
      )}
      {wave.kind === 'wind' && (
        <>
          <NumberField
            label="Wind speed (10 m)"
            value={wave.windSpeed}
            min={1}
            max={40}
            step={0.5}
            unit="m/s"
            unitLabel="metres per second"
            onCommit={(v) => update((w) => w.kind === 'wind' && void (w.windSpeed = v))}
          />
          <NumberField
            label="Fetch"
            value={wave.fetchKm}
            min={0.5}
            max={2000}
            step={0.5}
            unit="km"
            unitLabel="kilometres"
            onCommit={(v) => update((w) => w.kind === 'wind' && void (w.fetchKm = v))}
            hint="Distance over which the wind has blown. Long fetches reach the fully developed limit."
          />
        </>
      )}
      {wave.kind === 'regular' && (
        <>
          <NumberField
            label="Wave height H"
            value={wave.height}
            min={0}
            max={15}
            step={0.1}
            unit="m"
            unitLabel="metres"
            onCommit={(v) => update((w) => w.kind === 'regular' && void (w.height = v))}
          />
          <NumberField
            label="Period T"
            value={wave.period}
            min={1}
            max={25}
            step={0.1}
            unit="s"
            unitLabel="seconds"
            onCommit={(v) => update((w) => w.kind === 'regular' && void (w.period = v))}
            hint={`Wavelength ${wavelengthForPeriod(wave.period, disp).toFixed(1)} m at this depth.`}
          />
          <NumberField
            label="Phase"
            value={wave.phaseDeg}
            min={-180}
            max={180}
            step={5}
            unit="°"
            unitLabel="degrees"
            onCommit={(v) => update((w) => w.kind === 'regular' && void (w.phaseDeg = v))}
          />
        </>
      )}
      <NumberField
        label="Coming from"
        value={wave.directionDeg}
        min={0}
        max={360}
        step={5}
        unit="°"
        unitLabel="degrees"
        onCommit={(v) => update((w) => void (w.directionDeg = v))}
        hint="Compass bearing the waves arrive from (0 = north, 90 = east)."
      />
      {wave.kind !== 'regular' && (
        <>
          <SpreadingFields
            spreading={wave.spreading}
            onChange={(s) => update((w) => w.kind !== 'regular' && void (w.spreading = s))}
          />
          <NumberField
            label="Random seed"
            value={wave.seed}
            min={0}
            max={4294967295}
            step={1}
            slider={false}
            precision={0}
            onCommit={(v) => update((w) => w.kind !== 'regular' && void (w.seed = Math.round(v)))}
            hint="Same seed + same settings = the identical sea, every time."
          />
        </>
      )}
      <Warnings />
    </>
  );
}

function SpreadingFields({
  spreading,
  onChange,
}: {
  spreading: Spreading;
  onChange: (s: Spreading) => void;
}) {
  return (
    <fieldset className="fieldset">
      <legend>Directional spreading</legend>
      <SelectField
        label="Model"
        value={spreading.model}
        options={[
          { value: 'mitsuyasu', label: 'Mitsuyasu (frequency-dependent)' },
          { value: 'cos2s', label: 'cos-2s (fixed s)' },
          { value: 'donelan-banner', label: 'Donelan–Banner (sech²)' },
          { value: 'none', label: 'Long-crested (no spreading)' },
        ]}
        onChange={(model) => onChange({ ...spreading, model })}
      />
      {(spreading.model === 'mitsuyasu' || spreading.model === 'cos2s') && (
        <NumberField
          label="Spreading exponent s"
          value={spreading.s}
          min={1}
          max={100}
          step={1}
          onCommit={(s) => onChange({ ...spreading, s })}
          hint="Small = short-crested wind sea (≈10); large = long-crested swell (≥ 50)."
        />
      )}
    </fieldset>
  );
}

// ------------------------------------------------------------------ vessels

function VesselInspector({ vessel }: { vessel: VesselConfig }) {
  const lab = useLab.getState;
  const tel = useLab((s) => s.frame?.vessels.find((v) => v.id === vessel.id));
  const def = useLab((s) => s.vesselDefinitions[vessel.id]);
  const camera = useLab((s) => s.camera);
  const target = useLab((s) => s.cameraTarget);
  const update = (recipe: (v: VesselConfig) => void, reload = true) =>
    lab().updateExperiment(
      (d) => {
        const v = d.vessels.find((x) => x.id === vessel.id);
        if (v) recipe(v);
      },
      { reload },
    );
  const live = (cmd: Parameters<ReturnType<typeof getRuntime>['command']>[1]) =>
    getRuntime().command(vessel.id, cmd);

  const following = target === vessel.id && (camera === 'follow' || camera === 'bridge');

  return (
    <>
      <TextField
        label="Name"
        value={vessel.name}
        onCommit={(v) => update((x) => void (x.name = v), false)}
      />
      <div className="toolbar" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          aria-pressed={following && camera === 'follow'}
          onClick={() => lab().setCamera('follow', vessel.id)}
        >
          <Icon name="camera" size={16} /> Follow
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={following && camera === 'bridge'}
          onClick={() => lab().setCamera('bridge', vessel.id)}
        >
          <Icon name="eye" size={16} /> Bridge view
        </button>
      </div>

      {tel && (
        <>
          <Readout
            items={[
              { label: 'Roll', value: fmt(tel.rollDeg, 1, '°') },
              { label: 'Pitch', value: fmt(tel.pitchDeg, 1, '°') },
              { label: 'Heave', value: fmt(tel.heave, 2, 'm') },
              { label: 'Speed', value: fmt(tel.speedKn, 1, 'kn') },
              { label: 'Heading', value: fmt(tel.headingDeg, 0, '°') },
              { label: 'Rudder', value: fmt(tel.rudderDeg, 1, '°') },
            ]}
          />
          <p
            aria-live="polite"
            style={{ margin: '0 0 12px', display: 'flex', gap: 6, flexWrap: 'wrap' }}
          >
            {tel.capsized && <span className="badge badge--danger">Capsized</span>}
            {tel.slamming && <span className="badge badge--warning">Slamming</span>}
            {tel.greenWater && <span className="badge badge--warning">Green water</span>}
            {!tel.capsized && !tel.slamming && !tel.greenWater && (
              <span className="badge badge--ok">Normal</span>
            )}
          </p>
        </>
      )}

      <fieldset className="fieldset">
        <legend>Orders</legend>
        <Switch
          label="Autopilot"
          checked={vessel.autopilot}
          onChange={(c) => {
            update((x) => void (x.autopilot = c), false);
            live({ autopilot: c });
          }}
          hint="Holds heading and speed. Turn off to steer by hand."
        />
        <NumberField
          label="Heading"
          value={vessel.headingDeg}
          min={0}
          max={360}
          step={5}
          unit="°"
          unitLabel="degrees"
          onCommit={(v) => {
            update((x) => void (x.headingDeg = v), false);
            live({ headingDeg: v });
          }}
          hint="Compass course the bow points toward. Applied live."
        />
        <NumberField
          label="Speed"
          value={vessel.speedKn}
          min={0}
          max={Math.max(5, Math.round(((def?.maxSpeed ?? 10) / 0.5144) * 1.1))}
          step={0.5}
          unit="kn"
          unitLabel="knots"
          onCommit={(v) => {
            update((x) => void (x.speedKn = v), false);
            live({ speedKn: v });
          }}
        />
        {!vessel.autopilot && (
          <>
            <NumberField
              label="Rudder (manual)"
              value={0}
              min={-35}
              max={35}
              step={1}
              unit="°"
              unitLabel="degrees"
              onCommit={(v) => live({ rudderDeg: v })}
              hint="Positive turns to port."
            />
            <NumberField
              label="Throttle (manual)"
              value={0}
              min={-1}
              max={1}
              step={0.05}
              onCommit={(v) => live({ throttle: v })}
            />
          </>
        )}
      </fieldset>

      <fieldset className="fieldset">
        <legend>Design & loading</legend>
        <SelectField
          label="Hull type"
          value={vessel.type}
          options={(Object.keys(VESSEL_TYPE_LABELS) as VesselType[]).map((t) => ({
            value: t,
            label: VESSEL_TYPE_LABELS[t],
          }))}
          onChange={(t) => update((x) => void (x.type = t))}
        />
        <NumberField
          label="Scale"
          value={vessel.scale}
          min={0.25}
          max={4}
          step={0.05}
          unit="×"
          onCommit={(v) => update((x) => void (x.scale = v))}
        />
        <NumberField
          label="Centre of gravity height (KG / depth)"
          value={vessel.kgFactor}
          min={0.2}
          max={1.2}
          step={0.01}
          onCommit={(v) => update((x) => void (x.kgFactor = v))}
          hint="Higher = less stable. Watch GM: negative GM means the vessel cannot stay upright."
        />
        {def && (
          <Readout
            items={[
              { label: 'Length', value: fmt(def.length, 1, 'm') },
              { label: 'Beam', value: fmt(def.beam, 1, 'm') },
              { label: 'Draft', value: fmt(def.draft, 2, 'm') },
              { label: 'Mass', value: fmt(def.mass / 1000, 0, 't') },
              { label: 'GM', value: fmt(def.gm, 2, 'm'), title: 'Transverse metacentric height' },
              { label: 'Max speed', value: fmt(def.maxSpeed / 0.5144, 0, 'kn') },
            ]}
          />
        )}
      </fieldset>

      <fieldset className="fieldset">
        <legend>Start position</legend>
        <div className="grid-2">
          <NumberField
            label="East (x)"
            value={vessel.x}
            min={-2000}
            max={2000}
            step={5}
            unit="m"
            unitLabel="metres"
            slider={false}
            onCommit={(v) => update((x) => void (x.x = v))}
          />
          <NumberField
            label="North (y)"
            value={vessel.y}
            min={-2000}
            max={2000}
            step={5}
            unit="m"
            unitLabel="metres"
            slider={false}
            onCommit={(v) => update((x) => void (x.y = v))}
          />
        </div>
      </fieldset>
    </>
  );
}

// ------------------------------------------------------------------ probes

function ProbeInspector({ probe }: { probe: ProbeConfig }) {
  const lab = useLab.getState;
  const eta = useLab((s) => s.frame?.probes.find((p) => p.id === probe.id)?.eta);
  const update = (recipe: (p: ProbeConfig) => void, reload = true) =>
    lab().updateExperiment(
      (d) => {
        const p = d.probes.find((x) => x.id === probe.id);
        if (p) recipe(p);
      },
      { reload },
    );
  return (
    <>
      <TextField
        label="Name"
        value={probe.name}
        onCommit={(v) => update((p) => void (p.name = v), false)}
      />
      <Readout items={[{ label: 'Surface η', value: fmt(eta, 2, 'm') }]} />
      <div className="grid-2">
        <NumberField
          label="East (x)"
          value={probe.x}
          min={-2000}
          max={2000}
          step={1}
          unit="m"
          unitLabel="metres"
          slider={false}
          onCommit={(v) => update((p) => void (p.x = v))}
        />
        <NumberField
          label="North (y)"
          value={probe.y}
          min={-2000}
          max={2000}
          step={1}
          unit="m"
          unitLabel="metres"
          slider={false}
          onCommit={(v) => update((p) => void (p.y = v))}
        />
      </div>
      <p className="field__hint">
        The gauge records the free-surface elevation at a fixed point, like a wave staff or radar
        gauge. See the dock below for its time series, spectrum and statistics.
      </p>
    </>
  );
}
