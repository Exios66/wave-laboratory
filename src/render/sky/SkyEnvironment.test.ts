import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SkyEnvironment } from './SkyEnvironment';

/** A SkyEnvironment whose GPU passes are replaced by probes of the sky uniforms. */
function probe() {
  const renderer = {
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    xr: { enabled: false },
  } as unknown as THREE.WebGLRenderer;
  const material = new THREE.ShaderMaterial({
    uniforms: { uSunHdr: { value: 3 }, uFlash: { value: 0 } },
  });
  const env = new SkyEnvironment(renderer, new THREE.BufferGeometry(), material);
  const seen: { hdr: number; flash: number }[] = [];
  const inner = env as unknown as {
    cubeCamera: { update: () => void };
    pmrem: { fromCubemap: () => THREE.WebGLRenderTarget; dispose: () => void };
  };
  inner.cubeCamera.update = () =>
    seen.push({
      hdr: material.uniforms.uSunHdr!.value as number,
      flash: material.uniforms.uFlash!.value as number,
    });
  const target = new THREE.WebGLRenderTarget(1, 1);
  inner.pmrem.fromCubemap = () => target;
  inner.pmrem.dispose = () => {};
  return { env, material, seen };
}

const key = (sunY: number) => ({
  sunDir: new THREE.Vector3(0, sunY, 1).normalize(),
  cloud: 0,
  night: 0,
  dusk: 0,
  level: 1,
});

describe('SkyEnvironment', () => {
  it('captures the sky without the sun disc or a lightning flash, then restores both', () => {
    const { env, material, seen } = probe();
    material.uniforms.uFlash!.value = 0.8;
    expect(env.update(0, key(0.5))).toBe(true);
    expect(seen).toEqual([{ hdr: 0, flash: 0 }]);
    expect(material.uniforms.uSunHdr!.value).toBe(3);
    expect(material.uniforms.uFlash!.value).toBe(0.8);
    expect(env.texture).not.toBeNull();
  });

  it('redraws for a changed sky only once the minimum interval has passed', () => {
    const { env, seen } = probe();
    env.update(0, key(0.5));
    // No time has passed (a paused clock would keep it so): the change waits.
    expect(env.update(0, key(0.2))).toBe(false);
    expect(env.update(0.6, key(0.2))).toBe(true);
    expect(seen).toHaveLength(2);
  });
});
