import { Component, type ReactNode } from 'react';
import { errorText, isChunkLoadError } from '../errorText';

export type ErrorArea = 'charts' | 'viewport' | 'inspector' | 'scene';

const AREA_LABEL: Record<ErrorArea, string> = {
  charts: 'The chart',
  viewport: 'The 3D view',
  inspector: 'The inspector',
  scene: 'The scene panel',
};

interface Props {
  area: ErrorArea;
  /** Layout classes for the fallback, so a failed area keeps its place in the grid. */
  className?: string;
  children: ReactNode;
}

interface State {
  error: unknown;
}

/**
 * Keeps a failure in one part of the app (most often a lazily loaded chunk that a redeploy
 * removed) from taking the whole page down: the area shows what went wrong and a Reload button.
 * Reload reloads the page for a missing chunk and otherwise just retries the area.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidCatch(error: unknown): void {
    console.warn(`${this.props.area} failed:`, error);
  }

  private readonly retry = () => {
    if (isChunkLoadError(this.state.error)) window.location.reload();
    else this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <ErrorNotice
        title={`${AREA_LABEL[this.props.area]} could not load`}
        error={error}
        onReload={this.retry}
        className={this.props.className}
      />
    );
  }
}

/** The fallback panel: a short title, the error in words, and a Reload button. */
export function ErrorNotice({
  title,
  error,
  onReload,
  className,
}: {
  title: string;
  error: unknown;
  onReload: () => void;
  className?: string;
}) {
  return (
    <div className={className ? `error-notice ${className}` : 'error-notice'} role="alert">
      <p className="error-notice__title">{title}</p>
      <p>{errorText(error)}</p>
      <button type="button" className="btn" onClick={onReload}>
        Reload
      </button>
    </div>
  );
}
