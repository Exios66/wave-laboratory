import { useMemo, type ReactNode } from 'react';
import { beaufortFromWind } from '../../core/units';
import type { VesselType, WaveSystem, Weather } from '../../schema/experiment';
import { newProbe, newVessel, newWaveSystem, VESSEL_TYPE_LABELS } from '../factories';
import { healthPercent, healthTone } from '../health';
import { useLab, type Selection } from '../store';
import { Icon, type IconName } from './icons';
import { Menu } from './Menu';
import { HidePanelButton } from './Splitters';

function isSelected(sel: Selection, kind: string, id?: string): boolean {
  if (!sel || sel.kind !== kind) return false;
  return id === undefined || ('id' in sel && sel.id === id);
}

function weatherMeta(wind: number, w: Weather): string {
  const parts = [`Bf ${beaufortFromWind(wind)}`];
  if (w.squalls.enabled) parts.push('squalls');
  else if (w.rainMmH > 0.5) parts.push('rain');
  else if (w.visibilityKm < 1) parts.push('fog');
  return parts.join(' · ');
}

function waveMeta(w: WaveSystem): string {
  switch (w.kind) {
    case 'spectrum':
      return `Hs ${w.hs.toFixed(1)} m · Tp ${w.tp.toFixed(0)} s`;
    case 'wind':
      return w.followWeather ? 'Follows the weather wind' : `${w.windSpeed.toFixed(0)} m/s wind`;
    case 'regular':
      return `H ${w.height.toFixed(1)} m · T ${w.period.toFixed(0)} s`;
    case 'focused':
      return `Crest ${w.crestHeight.toFixed(1)} m at ${w.focusTime.toFixed(0)} s`;
  }
}

function TreeItem({
  icon,
  label,
  meta,
  status,
  current,
  disabled,
  onSelect,
  onRemove,
}: {
  icon: IconName;
  label: string;
  meta?: string;
  /** Extra status shown after the meta text (e.g. vessel health). */
  status?: ReactNode;
  current: boolean;
  disabled?: boolean;
  onSelect: () => void;
  onRemove?: () => void;
}) {
  return (
    <li className={`tree__item${disabled ? ' tree__item--disabled' : ''}`}>
      <button type="button" className="tree__select" aria-current={current} onClick={onSelect}>
        <span className="tree__icon">
          <Icon name={icon} size={16} />
        </span>
        <span className="tree__label">
          {label}
          {disabled && <span className="visually-hidden"> (disabled)</span>}
        </span>
        {meta && <span className="tree__meta">{meta}</span>}
        {status}
      </button>
      {onRemove && (
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--danger"
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
          onClick={onRemove}
        >
          <Icon name="trash" size={16} />
        </button>
      )}
    </li>
  );
}

/** Compact health pill of a vessel in the scene list. */
function HealthPill({ health, disabled }: { health: number; disabled: boolean }) {
  const pct = healthPercent(health);
  const text = disabled ? 'Disabled' : `${pct} %`;
  return (
    <span className={`tree__health tree__health--${healthTone(health)}`} title={`Health ${pct} %`}>
      <span className="visually-hidden">{disabled ? ', ' : ', health '}</span>
      {text}
    </span>
  );
}

/** Health of each vessel from the latest frame, as `id → [health, disabled]` (stable string). */
function useVesselHealth(): Map<string, [number, boolean]> {
  const key = useLab(
    (s) =>
      s.frame?.vessels
        .map((v) => `${v.id}:${healthPercent(v.health)}:${v.disabled ? 1 : 0}`)
        .join(',') ?? '',
  );
  return useMemo(() => {
    const m = new Map<string, [number, boolean]>();
    for (const part of key ? key.split(',') : []) {
      const [id, pct, dis] = part.split(':');
      m.set(id!, [Number(pct) / 100, dis === '1']);
    }
    return m;
  }, [key]);
}

export function ScenePanel() {
  const exp = useLab((s) => s.experiment);
  const selection = useLab((s) => s.selection);
  const health = useVesselHealth();
  const lab = useLab.getState;

  const addWave = (kind: WaveSystem['kind']) => {
    const w = newWaveSystem(kind, exp.waves.length);
    const added = lab().updateExperiment((d) => {
      d.waves.push(w);
    });
    if (added) lab().select({ kind: 'wave', id: w.id });
  };
  const addVessel = (type: VesselType) => {
    const v = newVessel(type, exp.vessels.length);
    const added = lab().updateExperiment((d) => {
      d.vessels.push(v);
    });
    if (added) lab().select({ kind: 'vessel', id: v.id });
  };
  const addProbe = () => {
    const p = newProbe(exp.probes.length);
    const added = lab().updateExperiment((d) => {
      d.probes.push(p);
    });
    if (added) lab().select({ kind: 'probe', id: p.id });
  };
  const remove = (kind: 'waves' | 'vessels' | 'probes', id: string, label: string) => {
    const removed = lab().updateExperiment((d) => {
      const list = d[kind] as { id: string }[];
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
    });
    if (removed) lab().notify('info', `Removed ${label}. Undo with Ctrl+Z.`);
  };

  return (
    <nav
      className="panel app__scene"
      aria-labelledby="scene-title"
      id="scene"
      // Scrollable landmark: keyboard users must be able to focus it (WCAG 2.1.1).
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      <div className="panel__header">
        <h2 className="panel__title" id="scene-title">
          Scene
        </h2>
        <HidePanelButton axis="scene" label="scene panel" />
      </div>
      <div className="panel__body">
        <section className="tree-section" aria-labelledby="env-h">
          <div className="tree-section__head">
            <h3 id="env-h">Environment</h3>
          </div>
          <ul className="tree">
            <TreeItem
              icon="globe"
              label="Water, wind & sun"
              meta={exp.environment.depth >= 1000 ? 'deep' : `${exp.environment.depth} m`}
              current={isSelected(selection, 'environment')}
              onSelect={() => lab().select({ kind: 'environment' })}
            />
            <TreeItem
              icon="cloud"
              label="Weather"
              meta={weatherMeta(exp.environment.windSpeed, exp.weather)}
              current={isSelected(selection, 'weather')}
              onSelect={() => lab().select({ kind: 'weather' })}
            />
          </ul>
        </section>

        <section className="tree-section" aria-labelledby="waves-h">
          <div className="tree-section__head">
            <h3 id="waves-h">Wave systems</h3>
            <Menu
              ariaLabel="Add wave system"
              className="btn btn--ghost"
              label={
                <>
                  <Icon name="plus" size={16} /> Add
                </>
              }
              items={[
                { label: 'Spectrum (Hs, Tp)', onSelect: () => addWave('spectrum') },
                { label: 'Wind sea (wind, fetch)', onSelect: () => addWave('wind') },
                { label: 'Regular waves (H, T)', onSelect: () => addWave('regular') },
                { label: 'Rogue wave (focused group)', onSelect: () => addWave('focused') },
              ]}
            />
          </div>
          {exp.waves.length === 0 ? (
            <p className="empty">Flat calm. Add a wave system to make waves.</p>
          ) : (
            <ul className="tree">
              {exp.waves.map((w) => (
                <TreeItem
                  key={w.id}
                  icon="wave"
                  label={w.name}
                  meta={waveMeta(w)}
                  disabled={!w.enabled}
                  current={isSelected(selection, 'wave', w.id)}
                  onSelect={() => lab().select({ kind: 'wave', id: w.id })}
                  onRemove={() => remove('waves', w.id, w.name)}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="tree-section" aria-labelledby="vessels-h">
          <div className="tree-section__head">
            <h3 id="vessels-h">Vessels</h3>
            <Menu
              ariaLabel="Add vessel"
              className="btn btn--ghost"
              label={
                <>
                  <Icon name="plus" size={16} /> Add
                </>
              }
              items={(Object.keys(VESSEL_TYPE_LABELS) as VesselType[]).map((t) => ({
                label: VESSEL_TYPE_LABELS[t],
                onSelect: () => addVessel(t),
              }))}
            />
          </div>
          {exp.vessels.length === 0 ? (
            <p className="empty">No vessels. Add one to see how it handles the sea.</p>
          ) : (
            <ul className="tree">
              {exp.vessels.map((v) => (
                <TreeItem
                  key={v.id}
                  icon="ship"
                  label={v.name}
                  meta={`${v.speedKn.toFixed(0)} kn`}
                  status={
                    exp.damage && health.has(v.id) ? (
                      <HealthPill health={health.get(v.id)![0]} disabled={health.get(v.id)![1]} />
                    ) : undefined
                  }
                  current={isSelected(selection, 'vessel', v.id)}
                  onSelect={() => lab().select({ kind: 'vessel', id: v.id })}
                  onRemove={() => remove('vessels', v.id, v.name)}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="tree-section" aria-labelledby="probes-h">
          <div className="tree-section__head">
            <h3 id="probes-h">Instruments</h3>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={addProbe}
              aria-label="Add wave gauge"
            >
              <Icon name="plus" size={16} /> Add
            </button>
          </div>
          {exp.probes.length === 0 ? (
            <p className="empty">No instruments. Add a wave gauge to record the sea surface.</p>
          ) : (
            <ul className="tree">
              {exp.probes.map((p) => (
                <TreeItem
                  key={p.id}
                  icon="gauge"
                  label={p.name}
                  meta={`${p.x.toFixed(0)}, ${p.y.toFixed(0)} m`}
                  current={isSelected(selection, 'probe', p.id)}
                  onSelect={() => lab().select({ kind: 'probe', id: p.id })}
                  onRemove={() => remove('probes', p.id, p.name)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </nav>
  );
}
