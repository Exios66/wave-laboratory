/** Menu button following the WAI-ARIA menu-button pattern (arrow keys, Esc, Home/End). */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

interface MenuProps {
  label: ReactNode;
  /** Accessible name of the trigger button. */
  ariaLabel: string;
  items: MenuItem[];
  className?: string;
}

export function Menu({ label, ariaLabel, items, className = 'btn' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const focusItem = (i: number) => {
    const els = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!els || els.length === 0) return;
    els[(i + els.length) % els.length]!.focus();
  };

  useEffect(() => {
    if (!open) return;
    focusItem(0);
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!listRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="menu">
      <button
        ref={triggerRef}
        type="button"
        className={className}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {label}
      </button>
      {open && (
        <div
          id={id}
          ref={listRef}
          className="menu__list"
          role="menu"
          tabIndex={-1}
          aria-label={ariaLabel}
          onKeyDown={(e) => {
            const els = Array.from(
              listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
            );
            const i = els.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              focusItem(i + 1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              focusItem(i - 1);
            } else if (e.key === 'Home') {
              e.preventDefault();
              focusItem(0);
            } else if (e.key === 'End') {
              e.preventDefault();
              focusItem(els.length - 1);
            } else if (e.key === 'Escape' || e.key === 'Tab') {
              e.preventDefault();
              close();
            }
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close();
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
