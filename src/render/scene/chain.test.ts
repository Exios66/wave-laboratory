import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
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

describe('chain geometry boundaries', () => {
  it.each([
    { name: 'diagonal', profile: [0, 0, 30, 10], fairlead: { x: 28, y: 4, z: -20 } },
    { name: 'vertical', profile: [0, 0, 0, 40], fairlead: { x: 10, y: -20, z: 10 } },
    { name: 'duplicate points', profile: [0, 0, 0, 0, 30, 40], fairlead: { x: 40, y: -20, z: 10 } },
    { name: 'collapsed', profile: [0, 0, 0, 0], fairlead: { x: 10, y: -20, z: -30 } },
  ])(
    '$name chain keeps the anchor fixed and meets the interpolated hawse',
    ({ profile, fairlead }) => {
      const chain = new ChainView(100);
      try {
        const m = { ...telemetry(true), profile, fairlead };
        const hawse = new THREE.Vector3(fairlead.x + 0.5, fairlead.z + 0.2, -fairlead.y - 0.3);
        chain.update(m, hawse);
        const mesh = chain.group.children[0] as THREE.Mesh;
        const positions = mesh.geometry.getAttribute('position');
        const normals = mesh.geometry.getAttribute('normal');
        for (const attr of [positions, normals])
          for (const value of attr.array) expect(Number.isFinite(value)).toBe(true);
        // The mean of a tube's six radial vertices is its centreline point.
        const centre = (start: number) => {
          const p = new THREE.Vector3();
          for (let j = 0; j < 6; j++)
            p.add(new THREE.Vector3().fromBufferAttribute(positions, start + j));
          return p.divideScalar(6);
        };
        expect(centre(0).distanceTo(new THREE.Vector3(10, -30, 20))).toBeLessThan(1e-5);
        expect(centre(positions.count - 6).distanceTo(hawse)).toBeLessThan(1e-5);
      } finally {
        chain.dispose();
      }
    },
  );

  it('switches markers between anchor and buoy and hides a missing profile', () => {
    const chain = new ChainView(100);
    try {
      const m = telemetry(true);
      chain.update(m, new THREE.Vector3(130, 10, 20));
      const [, anchor, buoy] = chain.group.children;
      expect(anchor!.visible).toBe(true);
      expect(buoy!.visible).toBe(false);
      chain.update({ ...m, kind: 'buoy' }, new THREE.Vector3(130, 10, 20));
      expect(anchor!.visible).toBe(false);
      expect(buoy!.visible).toBe(true);
      expect(buoy!.position.x).toBe(10);
      expect(buoy!.position.z).toBe(20);
      for (const profile of [[], [0, 0]]) {
        chain.update({ ...m, profile }, new THREE.Vector3());
        expect(chain.group.visible).toBe(false);
      }
      chain.update(m, new THREE.Vector3(130, 10, 20));
      expect(chain.group.visible).toBe(true);
      chain.update({ ...m, deployed: false }, new THREE.Vector3());
      expect(chain.group.visible).toBe(false);
    } finally {
      chain.dispose();
    }
  });

  it('disposes every geometry and each shared material once', () => {
    const chain = new ChainView(100);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    chain.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        materials.add(material);
    });
    const spies = [...geometries, ...materials].map((resource) => vi.spyOn(resource, 'dispose'));
    chain.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});
