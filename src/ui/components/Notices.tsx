import { useEffect } from 'react';
import { useLab, type Notice } from '../store';
import { Icon } from './icons';

function NoticeItem({ notice }: { notice: Notice }) {
  useEffect(() => {
    if (notice.tone === 'error') return;
    const t = setTimeout(() => useLab.getState().dismissNotice(notice.id), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  return (
    <li className={`notice notice--${notice.tone}`}>
      <p>{notice.message}</p>
      <button
        type="button"
        className="btn btn--ghost btn--icon"
        aria-label="Dismiss notification"
        onClick={() => useLab.getState().dismissNotice(notice.id)}
      >
        <Icon name="close" size={16} />
      </button>
    </li>
  );
}

/** Polite live region for status messages (errors are announced assertively). */
export function Notices() {
  const notices = useLab((s) => s.notices);
  const hasError = notices.some((n) => n.tone === 'error');
  return (
    <ul
      className="notices"
      aria-live={hasError ? 'assertive' : 'polite'}
      aria-label="Notifications"
    >
      {notices.map((n) => (
        <NoticeItem key={n.id} notice={n} />
      ))}
    </ul>
  );
}
