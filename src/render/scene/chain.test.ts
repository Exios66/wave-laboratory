import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { catenaryProfile, solveCatenary } from '../../vessel/mooring';
import type { MooringTelemetry } from '../../vessel/api';
import { ChainView } from './chain';

function telemetry(deployed: boolean): MooringTelemetry {
  const X = 120;
  const h = 40;
  const sol = solveCatenary(X, h, 150, 800, 3e8);
  return {
    deployed,
    kind: 'anchor',
    available: true,
    chainCapacity: 300,
    lineLength: 150,
    scope: 5,
    tension: sol.T,
    horizontalTension: sol.H,
    fairleadAngleDeg: 0,
    suspendedLength: sol.suspended,
    groundedLength: sol.grounded,
    touchdownDistance: sol.touchdown,
    holdingLimit: 1e6,
    loadFraction: 0.1,
    anchor: { x: 10, y: -20, z: -30 },
    fairlead: { x: 10 + X, y: -20, z: 10 },
    distance: X,
    dragging: false,
    regime: sol.regime,
    profile: deployed ? catenaryProfile(sol, X, h, 150, 800, 3e8) : [],
  };
}

describe('ChainView', () => {
  it('is hidden without an anchor and draws a finite tube ending at the hawse pipe', () => {
    const chain = new ChainView(180);
    chain.update(telemetry(false), new THREE.Vector3());
    expect(chain.group.visible).toBe(false);
    const hawse = new THREE.Vector3(130.5, 10.2, 20);
    chain.update(telemetry(true), hawse);
    expect(chain.group.visible).toBe(true);
    const tube = chain.group.children[0] as THREE.Mesh;
    const p = tube.geometry.getAttribute('position');
    let maxY = -Infinity;
    for (let i = 0; i < p.count; i++) {
      for (const v of [p.getX(i), p.getY(i), p.getZ(i)]) expect(Number.isFinite(v)).toBe(true);
      maxY = Math.max(maxY, p.getY(i));
    }
    expect(maxY).toBeGreaterThan(9); // reaches the hawse height
    expect(maxY).toBeLessThan(12);
    chain.dispose();
  });
});
