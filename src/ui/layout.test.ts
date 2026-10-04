import { describe, expect, it } from 'vitest';
import {
  clampLayout,
  defaultLayout,
  isViewExpanded,
  layoutCssVars,
  parseLayout,
  DOCK_STRIP,
  LAYOUT_LIMITS,
} from './layout';

describe('lab layout', () => {
  it('gives a short laptop a shallower dock so the ocean is taller', () => {
    const laptop = defaultLayout({ w: 1366, h: 768 });
    const desktop = defaultLayout({ w: 1440, h: 900 });
    expect(laptop.dockHeight).toBeLessThan(desktop.dockHeight);
    expect(laptop.dockHeight).toBeLessThan(LAYOUT_LIMITS.dock.fallback);
    expect(laptop.sceneWidth).toBeLessThanOrEqual(desktop.sceneWidth);
  });

  it('treats a fully collapsed chrome as an expanded 3D view', () => {
    const open = defaultLayout();
    expect(isViewExpanded(open)).toBe(false);
    expect(
      isViewExpanded({
        ...open,
        sceneCollapsed: true,
        inspectorCollapsed: true,
        dockCollapsed: true,
      }),
    ).toBe(true);
  });

  it('keeps a transport strip when the dock is collapsed', () => {
    const layout = parseLayout({
      sceneWidth: 280,
      inspectorWidth: 320,
      dockHeight: 200,
      dockCollapsed: true,
    });
    expect(layoutCssVars(layout).dock).toBe(DOCK_STRIP);
    expect(layout.dockHeight).toBe(200);
  });

  it('rejects garbage and out-of-range sizes', () => {
    const parsed = parseLayout({ sceneWidth: 'wide', inspectorWidth: 9000, dockHeight: 10 });
    expect(parsed.sceneWidth).toBe(defaultLayout({ w: 1440, h: 900 }).sceneWidth);
    expect(parsed.inspectorWidth).toBeLessThanOrEqual(LAYOUT_LIMITS.inspector.max);
    expect(parsed.dockHeight).toBeGreaterThanOrEqual(LAYOUT_LIMITS.dock.min);
  });

  it('shrinks side panels before letting the 3D view go below its minimum width', () => {
    const squeezed = clampLayout(
      {
        sceneWidth: 480,
        inspectorWidth: 520,
        dockHeight: 200,
        sceneCollapsed: false,
        inspectorCollapsed: false,
        dockCollapsed: false,
      },
      { w: 900, h: 800 },
    );
    const vars = layoutCssVars(squeezed);
    expect(vars.scene + vars.inspector).toBeLessThan(900 - 360);
  });
});
