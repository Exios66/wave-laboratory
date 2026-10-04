import { beforeEach, describe, expect, it } from 'vitest';
import { presetExperiment } from '../schema/presets';
import { useLab } from './store';

const lab = useLab.getState;

describe('lab store', () => {
  beforeEach(() => {
    lab().loadExperiment(presetExperiment('moderate-sea'));
    lab().simLoaded({}, { hs: 0, systems: [], warnings: [] });
  });

  it('reports whether an edit was accepted', () => {
    expect(lab().updateExperiment((d) => void (d.environment.windSpeed = 12))).toBe(true);
    expect(lab().updateExperiment((d) => void (d.environment.windSpeed = -5))).toBe(false);
    expect(lab().experiment.environment.windSpeed).toBe(12);
  });

  it('drops a selection and a followed camera when the vessel is removed', () => {
    const id = lab().experiment.vessels[0]!.id;
    lab().select({ kind: 'vessel', id });
    lab().setCamera('follow', id);
    lab().updateExperiment((d) => void d.vessels.splice(0, 1));
    expect(lab().selection).toBeNull();
    expect(lab().cameraTarget).toBeNull();
    expect(lab().camera).toBe('orbit');
  });

  it('drops a selection that undo removes', () => {
    const before = lab().experiment.probes.length;
    lab().updateExperiment((d) => {
      d.probes.push({ id: 'probe-new', name: 'New gauge', kind: 'wave-gauge', x: 10, y: 0 });
    });
    lab().select({ kind: 'probe', id: 'probe-new' });
    lab().undo();
    expect(lab().experiment.probes).toHaveLength(before);
    expect(lab().selection).toBeNull();
  });

  it('keeps reporting a missing WebGL 2 renderer after the simulation loads', () => {
    lab().simUnsupported('WebGL 2 is not available');
    lab().updateExperiment((d) => void (d.environment.windSpeed = 9));
    expect(lab().status).toBe('unsupported');
    lab().simLoaded({}, { hs: 0, systems: [], warnings: [] });
    expect(lab().status).toBe('unsupported');
  });

  it('enlarges the 3D view by collapsing the chrome and restores it', () => {
    lab().resetLayout();
    expect(lab().layout.sceneCollapsed).toBe(false);
    lab().toggleExpandedView();
    expect(lab().layout.sceneCollapsed).toBe(true);
    expect(lab().layout.inspectorCollapsed).toBe(true);
    expect(lab().layout.dockCollapsed).toBe(true);
    lab().toggleExpandedView();
    expect(lab().layout.sceneCollapsed).toBe(false);
    lab().patchLayout({ inspectorCollapsed: true });
    lab().select({ kind: 'environment' });
    expect(lab().layout.inspectorCollapsed).toBe(false);
  });
});
