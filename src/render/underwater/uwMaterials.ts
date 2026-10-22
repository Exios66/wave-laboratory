/**
 * Shared shader patch for the underwater scenery materials. One `MeshStandardMaterial` per surface
 * type (seabed, plants, hard heads) is patched with
 *  - world-space animated caustics added as emission on every upward-facing surface, fading with depth
 *    by the water's K_d (so the seabed, kelp, rocks and wrecks all catch the same moving light);
 *  - optional vertex sway for plants (`UW_SWAY`), so instance matrices stay static between rebuilds.
 * The absorption pass fogs the result as for everything else underwater.
 */
import * as THREE from 'three';
import { UW_BLADE_H } from './uwGeometry';

export interface UwUniforms {
  uUwTime: { value: number };
  /** Caustic brightness 0–1 (daylight × clarity). */
  uUwCaustic: { value: number };
  /** Diffuse attenuation K_d [1/m] of the water. */
  uUwKd: { value: THREE.Vector3 };
  /** Sway amplitude at the blade tip, in blade-local metres. */
  uUwSway: { value: number };
}

export function createUwUniforms(): UwUniforms {
  return {
    uUwTime: { value: 0 },
    uUwCaustic: { value: 0 },
    uUwKd: { value: new THREE.Vector3(0.245, 0.052, 0.02) },
    uUwSway: { value: 0.4 },
  };
}

const CAUSTIC_GLSL = /* glsl */ `
varying vec3 vUwWorld;
uniform float uUwTime;
uniform float uUwCaustic;
uniform vec3 uUwKd;
// Tiling interference caustics (three folded warps): bright, sharp networks of light.
float uwCaustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0;
  float inten = 0.0075;
  for (int n = 0; n < 3; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 3.0;
  c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 1.5);
}
`;

/** Patch `material` in place. Call once per material, before its first render. */
export function patchUnderwaterMaterial(
  material: THREE.MeshStandardMaterial,
  uniforms: UwUniforms,
  opts: { sway?: boolean } = {},
): void {
  if (opts.sway) material.defines = { ...material.defines, UW_SWAY: '' };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vUwWorld;
uniform float uUwTime;
uniform float uUwSway;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef UW_SWAY
{
  float uwH = max(transformed.y, 0.0) / ${UW_BLADE_H.toFixed(1)};
  float uwPh = 0.0;
  #ifdef USE_INSTANCING
    uwPh = instanceMatrix[3][0] * 0.37 + instanceMatrix[3][2] * 0.53;
  #endif
  float uwBend = uwH * uwH * uUwSway;
  transformed.x += sin(uUwTime * 1.3 + uwPh + uwH * 1.7) * uwBend;
  transformed.z += cos(uUwTime * 1.05 + uwPh * 1.3 + uwH * 1.2) * uwBend * 0.6;
}
#endif`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  vec4 uwP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    uwP = instanceMatrix * uwP;
  #endif
  vUwWorld = (modelMatrix * uwP).xyz;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CAUSTIC_GLSL}`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float uwDepth = max(0.0, -vUwWorld.y);
  // Flat world normal from screen derivatives: caustics land on upward faces.
  vec3 uwN = normalize(cross(dFdx(vUwWorld), dFdy(vUwWorld)));
  float uwUp = smoothstep(0.25, 0.85, abs(uwN.y));
  float uwFade = exp(-uUwKd.g * 2.2 * uwDepth);
  float uwC = uwCaustic(vUwWorld.xz * 0.28, uUwTime * 0.5);
  totalEmissiveRadiance += diffuseColor.rgb * uwC * uUwCaustic * uwFade * uwUp * 0.9;
}`,
      );
  };
  material.customProgramCacheKey = () => (opts.sway ? 'uw-sway' : 'uw');
}
