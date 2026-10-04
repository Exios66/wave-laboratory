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
  Weather,
} from '../../schema/experiment';
import { WEATHER_PRESETS } from '../../weather/presets';
import { detectDeviceProfile, effectiveQuality } from '../deviceProfile';
import { getRuntime } from '../runtime';
import { findProbe, findVessel, findWave, useLab } from '../store';
import { newWaveSystem, VESSEL_TYPE_LABELS } from '../factories';
import { DAMAGE_CAUSE_LABELS, healthPercent, healthTone } from '../health';
import { thrustFactor } from '../../vessel/damage';
import type { VesselTelemetry } from '../../vessel/api';
import { fmt, NumberField, Readout, SelectField, Switch, TextField } from './fields';
import { Icon } from './icons';
import { HidePanelButton } from './Splitters';

export function Inspector() {
  const selection = useLab((s) => s.selection);
  const exp = useLab((s) => s.experiment);

  let title = 'Sea state';
  let body = <SeaSummary />;
  if (selection?.kind === 'environment') {
    title = 'Environment';
    body = <EnvironmentInspector env={exp.environment} quality={exp.quality} damage={exp.damage} />;
  } else if (selection?.kind === 'weather') {
    title = 'Weather';
    body = <WeatherInspector />;
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
    <aside
      className="panel app__inspector"
      aria-labelledby="inspector-title"
      id="inspector"
      // Scrollable landmark: keyboard users must be able to focus it (WCAG 2.1.1).
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      <div className="panel__header">
        <h2 className="panel__title" id="inspector-title">
          {title}
        </h2>
        <div className="panel__header-actions">
          {selection && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => useLab.getState().select(null)}
            >
              Overview
            </button>
          )}
          <HidePanelButton axis="inspector" label="inspector" />
        </div>
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

const NO_WARNINGS: readonly string[] = [];

function Warnings() {
  const warnings = useLab((s) => s.diagnostics?.warnings ?? NO_WARNINGS);
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

function EnvironmentInspector({
  env,
  quality,
  damage,
}: {
  env: Environment;
  quality: OceanQuality;
  damage: boolean;
}) {
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
          max={11000}
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
        <legend>Mean wind</legend>
        <NumberField
          label="Wind speed (10 m)"
          value={env.windSpeed}
          min={0}
          max={45}
          step={0.5}
          unit="m/s"
          unitLabel="metres per second"
          onCommit={(v) => set('windSpeed', v)}
          hint={`Beaufort ${beaufortFromWind(env.windSpeed)}. Pushes on the vessels and sails, sets the whitecaps and drives any wind sea that follows the weather. Gusts and squalls are under Weather.`}
        />
        <NumberField
          label="Wind from"
          value={env.windDirectionDeg}
          min={0}
          max={360}
          step={5}
          unit="°"
          unitLabel="degrees"
          onCommit={(v) => set('windDirectionDeg', v)}
        />
      </fieldset>
      <fieldset className="fieldset">
        <legend>Surface current</legend>
        <NumberField
          label="Current speed"
          value={env.currentSpeed}
          min={0}
          max={5}
          step={0.05}
          unit="m/s"
          unitLabel="metres per second"
          onCommit={(v) => set('currentSpeed', v)}
          hint={`${fmt(env.currentSpeed / 0.5144, 1, 'kn')}. The whole sea drifts with it: waves are Doppler shifted and ships are set off their track. The Gulf Stream runs at up to 2.5 m/s.`}
        />
        <NumberField
          label="Current flowing toward"
          value={env.currentDirectionDeg}
          min={0}
          max={360}
          step={5}
          unit="°"
          unitLabel="degrees"
          onCommit={(v) => set('currentDirectionDeg', v)}
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
        <DeviceInfo quality={quality} />
        <Switch
          label="Vessel damage"
          checked={damage}
          onChange={(c) =>
            lab().updateExperiment((d) => {
              d.damage = c;
            })
          }
          hint="Slamming, green water, storm-force wind, heavy heel and collisions wear down each vessel's health, costing it power and steering until it is disabled. Small craft suffer most. Off: hulls still bounce apart but take no damage. Restarts the run."
        />
      </fieldset>
    </>
  );
}

function DeviceInfo({ quality }: { quality: OceanQuality }) {
  const mode = useLab((s) => s.performance);
  const scale = useLab((s) => s.renderScale);
  const profile = detectDeviceProfile();
  const eff = effectiveQuality(quality, mode, profile);
  return (
    <p className="field__hint">
      This device: {profile.description}. Rendering at {eff} detail
      {eff !== quality ? ` (capped from ${quality})` : ''}, {Math.round(scale * 100)} % resolution.
      Change this with the Graphics setting in the top bar.
    </p>
  );
}

// ------------------------------------------------------------------ weather

function WeatherInspector() {
  const lab = useLab.getState;
  const weather = useLab((s) => s.experiment.weather);
  const wind = useLab((s) => s.experiment.environment.windSpeed);
  const windFrom = useLab((s) => s.experiment.environment.windDirectionDeg);
  const followers = useLab(
    (s) => s.experiment.waves.filter((w) => w.kind === 'wind' && w.followWeather).length,
  );
  const reading = useLab((s) => s.frame?.weather);
  const set = (recipe: (w: Weather) => void, reload = true) =>
    lab().updateExperiment((d) => recipe(d.weather), { reload });
  const applyPreset = (id: string) => {
    const p = WEATHER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    lab().updateExperiment((d) => {
      d.environment.windSpeed = p.wind.windSpeed;
      if (p.wind.sunElevationDeg !== undefined)
        d.environment.sunElevationDeg = p.wind.sunElevationDeg;
      d.weather = structuredClone(p.weather);
    });
  };
  const addWeatherSea = () =>
    lab().updateExperiment((d) => {
      const sea = newWaveSystem('wind', d.waves.length);
      if (sea.kind === 'wind') {
        sea.name = 'Weather sea';
        sea.followWeather = true;
        sea.fetchKm = 200;
      }
      d.waves.push(sea);
    });
  const sq = weather.squalls;
  return (
    <>
      <div className="prose">
        <p>
          Gusts, squalls and the mean wind act on every vessel (windage and sails). Rain, cloud,
          visibility and lightning change what you see.
        </p>
      </div>
      {reading && (
        <Readout
          items={[
            {
              label: 'Wind now',
              value: `${fmt(reading.windSpeed, 1, 'm/s')}`,
              title: 'At the origin',
            },
            { label: 'From', value: `${reading.windFromDeg.toFixed(0)}°` },
            { label: 'Beaufort', value: String(beaufortFromWind(reading.windSpeed)) },
            { label: 'Rain', value: fmt(reading.rainMmH, 0, 'mm/h') },
          ]}
        />
      )}
      <fieldset className="fieldset">
        <legend>Situation</legend>
        <div className="chip-grid" role="group" aria-label="Weather presets">
          {WEATHER_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn btn--chip"
              title={p.summary}
              onClick={() => applyPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {followers === 0 ? (
          <>
            <p className="field__hint">
              No wave system follows the weather yet, so the sea will not change with the wind.
            </p>
            <button type="button" className="btn" onClick={addWeatherSea}>
              <Icon name="wave" size={16} /> Let the wind raise the sea
            </button>
          </>
        ) : (
          <p className="field__hint">
            {followers === 1 ? 'One wind sea follows' : `${followers} wind seas follow`} this
            weather: {fmt(wind, 0, 'm/s')} from {windFrom.toFixed(0)}° builds the waves.
          </p>
        )}
      </fieldset>
      <fieldset className="fieldset">
        <legend>Wind</legend>
        <NumberField
          label="Mean wind (10 m)"
          value={wind}
          min={0}
          max={45}
          step={0.5}
          unit="m/s"
          unitLabel="metres per second"
          onCommit={(v) =>
            lab().updateExperiment((d) => {
              d.environment.windSpeed = v;
            })
          }
          hint={`Beaufort ${beaufortFromWind(wind)}.`}
        />
        <NumberField
          label="Gustiness"
          value={weather.gustiness * 100}
          min={0}
          max={40}
          step={1}
          unit="%"
          unitLabel="percent"
          onCommit={(v) => set((w) => void (w.gustiness = v / 100))}
          hint="Turbulence intensity σu/U (open sea 6–12 %). Gusts sweep downwind as patches you can see on the water."
        />
      </fieldset>
      <fieldset className="fieldset">
        <legend>Squalls</legend>
        <Switch
          label="Squall fronts"
          checked={sq.enabled}
          onChange={(c) => set((w) => void (w.squalls.enabled = c))}
          hint="Fronts sweep through with a sudden jump in wind, a veer and a downpour."
        />
        {sq.enabled && (
          <>
            <NumberField
              label="Every"
              value={sq.intervalMin}
              min={2}
              max={60}
              step={1}
              unit="min"
              unitLabel="minutes"
              onCommit={(v) => set((w) => void (w.squalls.intervalMin = v))}
            />
            <NumberField
              label="Lasting"
              value={sq.durationMin}
              min={0.5}
              max={30}
              step={0.5}
              unit="min"
              unitLabel="minutes"
              onCommit={(v) => set((w) => void (w.squalls.durationMin = v))}
            />
            <NumberField
              label="Peak wind"
              value={sq.strength}
              min={1}
              max={2.5}
              step={0.05}
              unit="×"
              unitLabel="times the mean wind"
              onCommit={(v) => set((w) => void (w.squalls.strength = v))}
            />
            <NumberField
              label="Veer"
              value={sq.veerDeg}
              min={-90}
              max={90}
              step={5}
              unit="°"
              unitLabel="degrees"
              onCommit={(v) => set((w) => void (w.squalls.veerDeg = v))}
            />
          </>
        )}
      </fieldset>
      <fieldset className="fieldset">
        <legend>Sky and visibility</legend>
        <NumberField
          label="Cloud cover"
          value={weather.cloudCover * 100}
          min={0}
          max={100}
          step={5}
          unit="%"
          unitLabel="percent"
          onCommit={(v) => set((w) => void (w.cloudCover = v / 100), false)}
        />
        <NumberField
          label="Rain"
          value={weather.rainMmH}
          min={0}
          max={150}
          step={1}
          unit="mm/h"
          unitLabel="millimetres per hour"
          onCommit={(v) => set((w) => void (w.rainMmH = v), false)}
          hint="Moderate 2–10, heavy 10–50, violent above 50. Rain also cuts the visibility."
        />
        <NumberField
          label="Visibility"
          value={weather.visibilityKm}
          min={0.1}
          max={60}
          step={0.1}
          unit="km"
          unitLabel="kilometres"
          onCommit={(v) => set((w) => void (w.visibilityKm = v), false)}
        />
        <Switch
          label="Lightning"
          checked={weather.lightning}
          onChange={(c) => set((w) => void (w.lightning = c), false)}
        />
      </fieldset>
      <NumberField
        label="Weather seed"
        value={weather.seed}
        min={0}
        max={4294967295}
        step={1}
        slider={false}
        precision={0}
        onCommit={(v) => set((w) => void (w.seed = Math.round(v)))}
        hint="Same seed = the same gusts, squalls and lightning, every run."
      />
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
            {
              label: wave.kind === 'focused' ? 'Crest' : wave.kind === 'regular' ? 'H' : 'Hs',
              value: fmt(diag.hs, 2, 'm'),
              title:
                wave.kind === 'focused'
                  ? 'Linear crest elevation A at the focus, added to the background sea'
                  : wave.kind === 'regular'
                    ? 'Crest-to-trough height H'
                    : 'Significant wave height 4√m₀',
            },
            { label: 'Tp', value: fmt(diag.tp, 1, 's') },
            { label: 'λ peak', value: fmt(diag.wavelength, 0, 'm') },
            {
              label: 'Steepness',
              value: fmt(
                wave.kind === 'focused'
                  ? (2 * diag.hs) / diag.wavelength
                  : diag.hs / diag.wavelength,
                3,
              ),
              title:
                wave.kind === 'focused'
                  ? 'Equivalent crest steepness 2A / λp (Miche breaking limit ≈ 0.14 in deep water)'
                  : wave.kind === 'regular'
                    ? 'H / λ'
                    : 'Hs / λp',
            },
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
          <Switch
            label="Follow the weather wind"
            checked={wave.followWeather}
            onChange={(c) => update((w) => w.kind === 'wind' && void (w.followWeather = c))}
            hint="Use the environment wind speed and direction, so the sea grows with the weather."
          />
          {!wave.followWeather && (
            <NumberField
              label="Wind speed (10 m)"
              value={wave.windSpeed}
              min={1}
              max={45}
              step={0.5}
              unit="m/s"
              unitLabel="metres per second"
              onCommit={(v) => update((w) => w.kind === 'wind' && void (w.windSpeed = v))}
            />
          )}
          <NumberField
            label="Fetch"
            value={wave.fetchKm}
            min={0.5}
            max={5000}
            step={0.5}
            unit="km"
            unitLabel="kilometres"
            onCommit={(v) => update((w) => w.kind === 'wind' && void (w.fetchKm = v))}
            hint="Distance over which the wind has blown. Long fetches reach the fully developed limit."
          />
        </>
      )}
      {wave.kind === 'focused' && (
        <>
          <p className="field__hint">
            A NewWave focused group: the components of a JONSWAP sea are phased so that their crests
            meet at one point and time — the standard model of a rogue wave.
          </p>
          <NumberField
            label="Crest height"
            value={wave.crestHeight}
            min={0.5}
            max={30}
            step={0.5}
            unit="m"
            unitLabel="metres"
            onCommit={(v) => update((w) => w.kind === 'focused' && void (w.crestHeight = v))}
            hint="Linear crest added to the background sea. Draupner was 18.5 m (1.55 Hs); 2A/λp should stay below the Miche limit (~0.14 in deep water)."
          />
          <NumberField
            label="Peak period Tp"
            value={wave.tp}
            min={4}
            max={20}
            step={0.5}
            unit="s"
            unitLabel="seconds"
            onCommit={(v) => update((w) => w.kind === 'focused' && void (w.tp = v))}
          />
          <NumberField
            label="Focus time"
            value={wave.focusTime}
            min={0}
            max={3600}
            step={5}
            unit="s"
            unitLabel="seconds"
            onCommit={(v) => update((w) => w.kind === 'focused' && void (w.focusTime = v))}
            hint="Simulation time at which the crest peaks."
          />
          <NumberField
            label="Focus east (x)"
            value={wave.focusX}
            min={-2000}
            max={5000}
            step={5}
            unit="m"
            unitLabel="metres"
            onCommit={(v) => update((w) => w.kind === 'focused' && void (w.focusX = v))}
          />
          <NumberField
            label="Focus north (y)"
            value={wave.focusY}
            min={-2000}
            max={5000}
            step={5}
            unit="m"
            unitLabel="metres"
            onCommit={(v) => update((w) => w.kind === 'focused' && void (w.focusY = v))}
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
      {!(wave.kind === 'wind' && wave.followWeather) && (
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
      )}
      {(wave.kind === 'spectrum' || wave.kind === 'wind') && (
        <SpreadingFields
          spreading={wave.spreading}
          onChange={(s) =>
            update((w) => (w.kind === 'spectrum' || w.kind === 'wind') && void (w.spreading = s))
          }
        />
      )}
      {wave.kind !== 'regular' && (
        <>
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
              {
                label: 'Apparent wind',
                value: `${fmt(tel.apparentWind, 0, 'm/s')} ${Math.abs(tel.apparentWindAngleDeg).toFixed(0)}° ${tel.apparentWindAngleDeg >= 0 ? 'P' : 'S'}`,
                title: 'Apparent wind speed and angle off the bow (P = port, S = starboard)',
              },
              {
                label: 'Wind force',
                value: fmt(tel.windForce / 1000, 0, 'kN'),
                title: 'Aerodynamic force on the windage and sails',
              },
              ...(def?.sails
                ? [
                    { label: 'Sail set', value: fmt(tel.sailSet * 100, 0, '%') },
                    { label: 'Yards braced', value: fmt(Math.abs(tel.braceDeg), 0, '°') },
                  ]
                : []),
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
          <VesselHealth tel={tel} onRepair={() => live({ repair: true })} />
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
          hint={
            def?.sails
              ? 'Holds heading and trims the sails for the ordered speed, reefing as the wind rises. She cannot sail closer than about 60° to the wind.'
              : 'Holds heading and speed. Turn off to steer by hand.'
          }
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
            if (update((x) => void (x.headingDeg = v), false)) live({ headingDeg: v });
          }}
          hint="Compass course the bow points toward. Applied live."
        />
        <NumberField
          label="Speed"
          value={vessel.speedKn}
          min={0}
          max={Math.min(40, Math.max(5, Math.round(((def?.maxSpeed ?? 10) / 0.5144) * 1.1)))}
          step={0.5}
          unit="kn"
          unitLabel="knots"
          onCommit={(v) => {
            if (update((x) => void (x.speedKn = v), false)) live({ speedKn: v });
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
            {def?.sails ? (
              <NumberField
                label="Sail set (manual)"
                value={0}
                min={0}
                max={1}
                step={0.05}
                onCommit={(v) => live({ throttle: v })}
                hint="Fraction of canvas set. The crew no longer reefs for you — full sail in a gale will lay her on her beam ends."
              />
            ) : (
              <NumberField
                label="Throttle (manual)"
                value={0}
                min={-1}
                max={1}
                step={0.05}
                onCommit={(v) => live({ throttle: v })}
              />
            )}
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
        <NumberField
          label="Loading (displacement / design)"
          value={vessel.loadFactor}
          min={0.4}
          max={1.25}
          step={0.01}
          unit="×"
          onCommit={(v) => update((x) => void (x.loadFactor = v))}
          hint="Cargo and ballast. Below 1 the ship floats light and shows its red bottom paint; above 1 it is overloaded with less freeboard."
        />
        {def && (
          <Readout
            items={[
              { label: 'Length', value: fmt(def.length, 1, 'm') },
              { label: 'Beam', value: fmt(def.beam, 1, 'm') },
              { label: 'Draft', value: fmt(def.draft, 2, 'm') },
              { label: 'Freeboard', value: fmt(def.depth - def.draft, 2, 'm') },
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

/** Health meter, damage cause and the repair order. */
function VesselHealth({ tel, onRepair }: { tel: VesselTelemetry; onRepair: () => void }) {
  const damageOn = useLab((s) => s.experiment.damage);
  const pct = healthPercent(tel.health);
  const tone = healthTone(tel.health);
  let status: string;
  if (!damageOn) status = 'Damage is off for this experiment.';
  else if (tel.damageCause) status = `Damage: ${DAMAGE_CAUSE_LABELS[tel.damageCause]}.`;
  else if (tel.disabled) status = 'Engine and steering are out. She drifts until repaired.';
  else if (tel.health < 1)
    status = `Power limited to ${Math.round(thrustFactor(tel.health) * 100)} %.`;
  else status = 'No damage.';
  return (
    <section className="health" aria-labelledby="health-h">
      <div className="health__head">
        <h3 id="health-h" className="health__title">
          Hull health
        </h3>
        <span className={`health__value health__value--${tone}`} aria-hidden="true">
          {pct} %
        </span>
      </div>
      <div
        className="health__meter"
        role="meter"
        aria-labelledby="health-h"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`Health ${pct} %`}
      >
        <span className={`health__fill health__fill--${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="health__status" aria-live="polite">
        {tel.disabled ? (
          <span className="badge badge--danger">Disabled</span>
        ) : tel.health < 0.25 ? (
          <span className="badge badge--warning">Steering failing</span>
        ) : null}
        <span>{status}</span>
      </p>
      <button type="button" className="btn" onClick={onRepair} disabled={tel.health >= 1}>
        <Icon name="wrench" size={16} /> Repair
      </button>
    </section>
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
