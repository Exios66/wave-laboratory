/**
 * Drag handles and hide/show controls for the desktop scene, inspector and data dock.
 * Hidden on the phone layout (CSS). Playback stays on a strip when the dock is collapsed.
 */
import {
  useCallback,
  useRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  DOCK_STRIP,
  defaultLayout,
  isViewExpanded,
  LAYOUT_LIMITS,
  viewportSize,
  type LabLayout,
} from '../layout';
import { useLab } from '../store';
import { Icon, type IconName } from './icons';

type Axis = 'scene' | 'inspector' | 'dock';

export function Splitters() {
  return (
    <>
      <Splitter axis="scene" />
      <Splitter axis="inspector" />
      <Splitter axis="dock" />
    </>
  );
}

export function HidePanelButton({ axis, label }: { axis: Axis; label: string }) {
  const icon: IconName =
    axis === 'dock' ? 'chevron-down' : axis === 'scene' ? 'chevron-left' : 'chevron-right';
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon btn--hide-panel desktop-only"
      aria-label={`Hide ${label}`}
      title={`Hide ${label}. Drag the edge to resize. V enlarges the 3D view.`}
      onClick={() =>
        useLab
          .getState()
          .patchLayout(
            axis === 'scene'
              ? { sceneCollapsed: true }
              : axis === 'inspector'
                ? { inspectorCollapsed: true }
                : { dockCollapsed: true },
          )
      }
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

export function ExpandViewButton({ className = 'hud__plane' }: { className?: string }) {
  const expanded = useLab((s) => isViewExpanded(s.layout));
  return (
    <button
      type="button"
      className={`${className} desktop-only`}
      aria-pressed={expanded}
      title={
        expanded
          ? 'Show the scene, inspector and data dock (V)'
          : 'Enlarge the 3D view — hide the side panels and chart dock (V)'
      }
      onClick={() => useLab.getState().toggleExpandedView()}
    >
      <Icon name={expanded ? 'compress' : 'expand'} size={16} />
      {expanded ? 'Panels' : 'Enlarge view'}
    </button>
  );
}

export function RevealButtons() {
  const layout = useLab((s) => s.layout);
  if (isViewExpanded(layout)) return null;
  return (
    <>
      {layout.sceneCollapsed && (
        <RevealEdge
          side="left"
          label="Show scene panel"
          icon="chevron-right"
          onClick={() => useLab.getState().patchLayout({ sceneCollapsed: false })}
        />
      )}
      {layout.inspectorCollapsed && (
        <RevealEdge
          side="right"
          label="Show inspector"
          icon="chevron-left"
          onClick={() => useLab.getState().patchLayout({ inspectorCollapsed: false })}
        />
      )}
      {layout.dockCollapsed && (
        <RevealEdge
          side="bottom"
          label="Show data charts"
          icon="expand"
          onClick={() => useLab.getState().patchLayout({ dockCollapsed: false })}
        />
      )}
    </>
  );
}

function RevealEdge({
  side,
  label,
  icon,
  onClick,
}: {
  side: 'left' | 'right' | 'bottom';
  label: string;
  icon: IconName;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`layout-reveal layout-reveal--${side} desktop-only`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

function Splitter({ axis }: { axis: Axis }) {
  /* Window splitters are ARIA separators that take pointer and keyboard input. */
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  const collapsed = useLab((s) => s.layout[`${axis}Collapsed`]);
  const value = useLab((s) =>
    axis === 'scene'
      ? s.layout.sceneWidth
      : axis === 'inspector'
        ? s.layout.inspectorWidth
        : s.layout.dockHeight,
  );
  const drag = useRef<{
    pointer: number;
    start: number;
    size: number;
  } | null>(null);

  const limits = LAYOUT_LIMITS[axis];
  const vertical = axis === 'dock';
  const label =
    axis === 'scene'
      ? 'Resize scene panel'
      : axis === 'inspector'
        ? 'Resize inspector'
        : 'Resize data dock';

  const apply = useCallback(
    (clientX: number, clientY: number, start: (typeof drag)['current']) => {
      if (!start) return;
      const delta = vertical ? start.start - clientY : clientX - start.start;
      const signed = axis === 'inspector' ? -delta : delta;
      const next = start.size + signed;
      const patch: Partial<LabLayout> = {};
      if (axis === 'dock') {
        if (next < LAYOUT_LIMITS.dock.min * 0.6) {
          patch.dockCollapsed = true;
        } else {
          patch.dockCollapsed = false;
          patch.dockHeight = next;
        }
      } else if (axis === 'scene') {
        if (next < LAYOUT_LIMITS.scene.min * 0.55) patch.sceneCollapsed = true;
        else {
          patch.sceneCollapsed = false;
          patch.sceneWidth = next;
        }
      } else {
        if (next < LAYOUT_LIMITS.inspector.min * 0.55) patch.inspectorCollapsed = true;
        else {
          patch.inspectorCollapsed = false;
          patch.inspectorWidth = next;
        }
      }
      useLab.getState().patchLayout(patch);
    },
    [axis, vertical],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const layout = useLab.getState().layout;
    drag.current = {
      pointer: e.pointerId,
      start: vertical ? e.clientY : e.clientX,
      size:
        axis === 'scene'
          ? layout.sceneCollapsed
            ? 0
            : layout.sceneWidth
          : axis === 'inspector'
            ? layout.inspectorCollapsed
              ? 0
              : layout.inspectorWidth
            : layout.dockCollapsed
              ? DOCK_STRIP
              : layout.dockHeight,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointer !== e.pointerId) return;
    apply(e.clientX, e.clientY, drag.current);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    const layout = useLab.getState().layout;
    const def = defaultLayout(viewportSize());
    if (e.key === 'Home') {
      e.preventDefault();
      if (axis === 'scene')
        useLab.getState().patchLayout({ sceneWidth: def.sceneWidth, sceneCollapsed: false });
      if (axis === 'inspector')
        useLab
          .getState()
          .patchLayout({ inspectorWidth: def.inspectorWidth, inspectorCollapsed: false });
      if (axis === 'dock')
        useLab.getState().patchLayout({ dockHeight: def.dockHeight, dockCollapsed: false });
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      if (axis === 'scene')
        useLab.getState().patchLayout({ sceneWidth: limits.max, sceneCollapsed: false });
      if (axis === 'inspector')
        useLab.getState().patchLayout({ inspectorWidth: limits.max, inspectorCollapsed: false });
      if (axis === 'dock')
        useLab.getState().patchLayout({ dockHeight: limits.max, dockCollapsed: false });
      return;
    }
    const grow =
      (vertical && e.key === 'ArrowUp') ||
      (!vertical && axis === 'scene' && e.key === 'ArrowRight') ||
      (!vertical && axis === 'inspector' && e.key === 'ArrowLeft');
    const shrink =
      (vertical && e.key === 'ArrowDown') ||
      (!vertical && axis === 'scene' && e.key === 'ArrowLeft') ||
      (!vertical && axis === 'inspector' && e.key === 'ArrowRight');
    if (!grow && !shrink) return;
    e.preventDefault();
    const delta = grow ? step : -step;
    if (axis === 'scene')
      useLab.getState().patchLayout({
        sceneCollapsed: false,
        sceneWidth: layout.sceneWidth + delta,
      });
    else if (axis === 'inspector')
      useLab.getState().patchLayout({
        inspectorCollapsed: false,
        inspectorWidth: layout.inspectorWidth + delta,
      });
    else
      useLab.getState().patchLayout({
        dockCollapsed: false,
        dockHeight: layout.dockHeight + delta,
      });
  };

  const onDoubleClick = () => {
    const def = defaultLayout(viewportSize());
    if (axis === 'scene')
      useLab.getState().patchLayout({ sceneWidth: def.sceneWidth, sceneCollapsed: false });
    if (axis === 'inspector')
      useLab.getState().patchLayout({
        inspectorWidth: def.inspectorWidth,
        inspectorCollapsed: false,
      });
    if (axis === 'dock')
      useLab.getState().patchLayout({ dockHeight: def.dockHeight, dockCollapsed: false });
  };

  const valuetext =
    axis === 'dock'
      ? collapsed
        ? 'charts hidden'
        : `${Math.round(value)} pixels tall`
      : collapsed
        ? 'hidden'
        : `${Math.round(value)} pixels wide`;

  return (
    <div
      className={`splitter splitter--${axis} desktop-only`}
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={Math.round(collapsed ? limits.min : value)}
      aria-valuetext={valuetext}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    />
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
