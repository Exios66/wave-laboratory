/**
 * Accessible form primitives. Every control has a programmatic label, units are announced, and
 * numeric controls pair a slider (coarse, pointer-friendly) with a text box (precise, typed).
 * Values are committed when the interaction ends (slider release, Enter, blur) so expensive
 * re-simulations are not triggered on every intermediate value.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Spoken unit name for screen readers (e.g. "metres"). */
  unitLabel?: string;
  hint?: ReactNode;
  /** Show the slider (default true). */
  slider?: boolean;
  /** Decimal places shown in the text box. */
  precision?: number;
  disabled?: boolean;
}

export function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 0.1,
  unit,
  unitLabel,
  hint,
  slider = true,
  precision,
  disabled,
}: NumberFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const decimals = precision ?? Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const [draft, setDraft] = useState<number>(value);
  const [text, setText] = useState<string>(value.toFixed(decimals));
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) {
      setDraft(value);
      setText(value.toFixed(decimals));
      setError(null);
    }
  }, [value, decimals]);

  const commit = (v: number) => {
    editing.current = false;
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(max, Math.max(min, v));
    setDraft(clamped);
    setText(clamped.toFixed(decimals));
    if (Math.abs(clamped - value) > 1e-12) onCommit(clamped);
  };

  const commitText = () => {
    const v = Number(text.replace(',', '.'));
    if (text.trim() === '' || !Number.isFinite(v)) {
      setError(`Enter a number between ${min} and ${max}.`);
      return;
    }
    if (v < min || v > max) {
      setError(`Allowed range: ${min} to ${max}${unit ? ` ${unit}` : ''}. Value was clamped.`);
    } else {
      setError(null);
    }
    commit(v);
  };

  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ');
  const valueText = `${draft.toFixed(decimals)} ${unitLabel ?? unit ?? ''}`.trim();

  return (
    <div className="field">
      <div className="field__label-row">
        <label htmlFor={`${id}-num`}>{label}</label>
      </div>
      <div className="field__row" style={slider ? undefined : { gridTemplateColumns: '1fr' }}>
        {slider && (
          <input
            type="range"
            aria-label={`${label} slider`}
            aria-valuetext={valueText}
            min={min}
            max={max}
            step={step}
            value={draft}
            disabled={disabled}
            aria-describedby={describedBy || undefined}
            onChange={(e) => {
              editing.current = true;
              const v = Number(e.target.value);
              setDraft(v);
              setText(v.toFixed(decimals));
            }}
            onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onBlur={(e) => {
              if (editing.current) commit(Number(e.target.value));
            }}
          />
        )}
        <div className="number-input">
          <input
            id={`${id}-num`}
            className="input"
            inputMode="decimal"
            value={text}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy || undefined}
            onChange={(e) => {
              editing.current = true;
              setText(e.target.value);
            }}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitText();
              if (e.key === 'Escape') {
                editing.current = false;
                setText(value.toFixed(decimals));
                setError(null);
              }
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const base = Number(text) || value;
                const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
                commit(Math.round((base + delta) / step) * step);
              }
            }}
          />
          {unit && (
            <span className="number-input__unit" aria-hidden="true">
              {unit}
            </span>
          )}
          {unitLabel && <span className="visually-hidden">{unitLabel}</span>}
        </div>
      </div>
      {hint && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__hint" id={errId} role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}

interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: ReactNode;
  disabled?: boolean;
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: SelectFieldProps<T>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="select"
        value={value}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  maxLength?: number;
}

export function TextField({ label, value, onCommit, maxLength = 60 }: TextFieldProps) {
  const id = useId();
  const [text, setText] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    // Adopt external changes (e.g. undo) — the documented "derive state from props" pattern.
    setPrevValue(value);
    setText(value);
  }
  const commit = () => {
    const t = text.trim();
    if (t && t !== value) onCommit(t);
    else setText(value);
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        value={text}
        maxLength={maxLength}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setText(value);
        }}
      />
    </div>
  );
}

interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}

export function Switch({ label, checked, onChange, hint }: SwitchProps) {
  const id = useId();
  return (
    <div className="field">
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__track" aria-hidden="true">
          <span className="switch__thumb" />
        </span>
        {label}
      </button>
      {hint && (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function Readout({ items }: { items: { label: string; value: string; title?: string }[] }) {
  return (
    <dl className="readout">
      {items.map((it) => (
        <div key={it.label} title={it.title}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export const fmt = (v: number | undefined, digits = 2, unit = ''): string =>
  v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
