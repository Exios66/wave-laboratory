/**
 * The wet band on a hull: a `onBeforeCompile` hook that darkens and glosses the topsides up to
 * the wet height above the moving waterline (see `hullWetting.ts` for the height model), with
 * drip streaks below the band's edge and a thin line of foam clinging at the water.
 *
 * The waterline is found per vertex from the drawn sea itself: the ocean's cascade textures
 * and regular waves, sampled with the same GLSL chunk the ocean mesh uses
 * (`OCEAN_DISPLACEMENT_GLSL`), so the line matches what the user sees. No extra draw calls.
 * Purely visual.
 */
import * as THREE from 'three';
import { NOISE, OCEAN_DISPLACEMENT_GLSL } from '../ocean/shaders';

/** Ocean uniforms the displacement chunk and the foam line read (shared by reference). */
const OCEAN_UNIFORMS = [
  'uC0',
  'uC1',
  'uC2',
  'uC3',
  'uSize0',
  'uSize1',
  'uSize2',
  'uSize3',
  'uCount',
  'uN',
  'uTime',
  'uLambda',
  'uHasMips',
  'uRegA',
  'uRegB',
  'uRegularCount',
  'uDrift',
  'uHs',
] as const;

/** Mesh spacing the waterline is low-passed to [m]: smooths ripples, keeps the swell. */
const WATERLINE_SPACING = 2;

export interface HullWetHandle {
  /** (side, bow) wet height above the waterline [m]; update each frame. */
  readonly wet: THREE.Vector2;
}

/**
 * Hook `mat` (a hull material) for wetting. `stern` and `bow` are the body-frame x of the
 * propeller and the stem, which give the forward fraction the bow's higher wet line fades in on.
 * Chains after any existing `onBeforeCompile`.
 */
export function applyHullWetting(
  mat: THREE.Material,
  ocean: Record<string, THREE.IUniform>,
  stern: number,
  bow: number,
): HullWetHandle {
  const wet = new THREE.Vector2(0.2, 0.2);
  const hullX = new THREE.Vector2(stern, 1 / Math.max(bow - stern, 1e-3));
  const previous = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    previous.call(mat, shader, renderer);
    for (const name of OCEAN_UNIFORMS) {
      const u = ocean[name];
      if (u) shader.uniforms[name] = u;
    }
    shader.uniforms.uWet = { value: wet };
    shader.uniforms.uHullX = { value: hullX };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${OCEAN_DISPLACEMENT_GLSL}
uniform vec2 uDrift;
uniform vec2 uHullX;
varying float vWetS;
varying float vWetBow;
varying float vWetAlong;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vec4 regSlope;
  // The drawn sea moves each point sideways by its chop: find the rest point q whose displaced
  // position is this vertex (one fixed-point step), then read the height there.
  vec2 hullXY = vec2(wp.x, -wp.z);
  vec3 sea = seaDisplacement(hullXY - uDrift, ${WATERLINE_SPACING.toFixed(1)}, regSlope);
  sea = seaDisplacement(hullXY - sea.xy - uDrift, ${WATERLINE_SPACING.toFixed(1)}, regSlope);
  vWetS = wp.y - sea.z;
  vWetBow = clamp((transformed.x - uHullX.x) * uHullX.y, 0.0, 1.0);
  vWetAlong = transformed.x;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${NOISE}
uniform vec2 uWet;
uniform float uHs;
varying float vWetS;
varying float vWetBow;
varying float vWetAlong;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float hullWet;
{
  float top = mix(uWet.x, uWet.y, smoothstep(0.55, 0.95, vWetBow));
  // Drips: the wet edge runs ragged along the hull.
  top += (vnoise(vec2(vWetAlong * 6.0, vWetS * 0.6)) - 0.5) * 0.35 * top;
  hullWet = (1.0 - smoothstep(top - 0.1, top + 0.15, vWetS)) * step(-0.3, vWetS);
  diffuseColor.rgb *= mix(1.0, 0.6, hullWet);
  // A thin line of foam clings to the hull at the water.
  float width = 0.12 + 0.05 * uHs;
  float line = (1.0 - smoothstep(0.0, width, abs(vWetS - 0.03)))
    * smoothstep(0.3, 0.7, vnoise(vec2(vWetAlong * 3.0, vWetS * 9.0)));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9), 0.7 * line);
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.1, hullWet);`,
      );
  };
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${key()}|hull-wet`;
  return { wet };
}
