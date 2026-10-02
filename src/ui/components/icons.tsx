/** Inline SVG icons (decorative: always aria-hidden; buttons carry their own labels). */
import type { ReactElement } from 'react';

type IconName =
  | 'logo'
  | 'play'
  | 'pause'
  | 'step'
  | 'restart'
  | 'plus'
  | 'trash'
  | 'undo'
  | 'redo'
  | 'save'
  | 'open'
  | 'share'
  | 'help'
  | 'close'
  | 'wave'
  | 'ship'
  | 'gauge'
  | 'globe'
  | 'cloud'
  | 'download'
  | 'presets'
  | 'eye'
  | 'eye-off'
  | 'camera'
  | 'warning'
  | 'wrench'
  | 'more';

const paths: Record<IconName, ReactElement> = {
  logo: <path d="M2 15c3-5 6-5 9 0s6 5 9 0 2-2 2-2v8H2z" fill="currentColor" stroke="none" />,
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  step: (
    <>
      <path d="M5 5v14l10-7z" fill="currentColor" stroke="none" />
      <rect x="16" y="5" width="3" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  restart: <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V4h6v3" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />,
  redo: <path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />,
  save: <path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6" />,
  open: <path d="M3 7h6l2 2h10v10H3zM3 7V5h6" />,
  share: <path d="M8 12h8M14 6l6 6-6 6M4 4v16" />,
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  wave: <path d="M2 12c2.5-4 5-4 7.5 0s5 4 7.5 0 3.5-3 5-3M2 18c2.5-3 5-3 7.5 0s5 3 7.5 0" />,
  ship: <path d="M3 15h18l-3 5H6zM6 15V9h9l3 6M9 9V5h4v4" />,
  gauge: (
    <>
      <path d="M12 3v14" />
      <circle cx="12" cy="18" r="3" />
      <path d="M9 6h6" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </>
  ),
  cloud: (
    <path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 10 4 4 0 0 0 7 18zM9 21l1-2M13 21l1-2" />
  ),
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  presets: <path d="M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z" />,
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  'eye-off': (
    <path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3 3.6M6.4 6.4C3.6 8.2 2 12 2 12s3.5 6 10 6a9.6 9.6 0 0 0 4.6-1.2" />
  ),
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  warning: <path d="M12 3 2 20h20zM12 10v4M12 17v.01" />,
  wrench: (
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

export type { IconName };
