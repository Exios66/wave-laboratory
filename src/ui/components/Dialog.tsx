/** Modal dialog built on the native <dialog> element (focus trap, Esc, inert background). */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './icons';

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Dialog({ open, title, onClose, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnFocus.current = document.activeElement;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
      if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <div className="dialog__header">
            <h2 id={titleId}>{title}</h2>
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              aria-label="Close dialog"
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="dialog__body">{children}</div>
        </>
      )}
    </dialog>
  );
}
