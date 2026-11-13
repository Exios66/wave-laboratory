import { describe, expect, it } from 'vitest';
import { createElement, isValidElement, type ReactElement } from 'react';
import { ErrorBoundary, ErrorNotice } from './ErrorBoundary';

/** Render one boundary without a DOM: set its state as getDerivedStateFromError would. */
function fallbackOf(className?: string): ReactElement<{ className?: string; title: string }> {
  const b = new ErrorBoundary({ area: 'scene', className, children: createElement('p') });
  b.state = ErrorBoundary.getDerivedStateFromError(new Error('boom'));
  const out = b.render();
  if (!isValidElement(out)) throw new Error('no element');
  return out as ReactElement<{ className?: string; title: string }>;
}

describe('ErrorBoundary', () => {
  it('passes its grid class to the fallback, so a failed area keeps its place', () => {
    const el = fallbackOf('panel app__scene');
    expect(el.type).toBe(ErrorNotice);
    expect(el.props.className).toBe('panel app__scene');
    expect(el.props.title).toBe('The scene panel could not load');
  });

  it('adds the class to the notice wrapper', () => {
    const div = ErrorNotice({
      title: 't',
      error: new Error('x'),
      onReload: () => {},
      className: 'app__viewport',
    });
    expect(div.props.className).toBe('error-notice app__viewport');
    const plain = ErrorNotice({ title: 't', error: new Error('x'), onReload: () => {} });
    expect(plain.props.className).toBe('error-notice');
  });
});
