/**
 * Water surface material: clipmap vertex displacement + physically motivated shading.
 *
 * Shading model (all radiometric quantities in the units of the three.js `Sky` shader):
 *  - Fresnel reflectance of the air–water interface, Schlick with F₀ = 0.02 (n = 1.333).
 *  - Sky reflection from a mip-mapped cube capture of the sky; the mip level follows the
 *    roughness.
 *  - Sun glitter: Beckmann microfacet BRDF whose mean-square slope is the slope variance that the
 *    texture filtering removed (LEAN-style, see oceanStats.ts) plus unresolved capillaries
 *    (Cox & Munk 1954), so distant water widens the glitter instead of aliasing.
 *  - Water-leaving radiance: deep-water reflectance R∞ (absorption-dominated, Jerlov I-like
 *    colour) under the downwelling irradiance, plus a sub-surface scattering term on thin crests
 *    lit from behind.
 *  - Foam/whitecaps (persistent Jacobian foam + instantaneous crest folding) as a Lambertian layer.
 *  - Aerial perspective: blend toward the sky radiance at the horizon with distance.
 *  - Back faces (camera under water): Snell's window with total internal reflection.
 */
import { DoubleSide, ShaderMaterial, Vector2, type IUniform } from 'three';
import {
  colorMapGlsl,
  DIVERGING_BLUE_ORANGE,
  SEQUENTIAL_CIVIDIS,
  SEQUENTIAL_VIRIDIS,
  SRGB_TO_LINEAR_GLSL,
} from './colorMaps';
import { oceanFragmentChunk, oceanVertexChunk } from './oceanChunks';

export type UniformMap = Record<string, IUniform>;

/** Per-mesh uniforms of one clipmap level or of the horizon skirt. */
export function createLevelUniforms(): UniformMap {
  return {
    uMode: { value: 0 }, // 0 = clipmap level, 1 = skirt
    uCenter: { value: new Vector2() },
    uSpacing: { value: 1 },
    uCells: { value: 64 },
    uFineCenter: { value: new Vector2() },
    uFineHalf: { value: -1 },
    uSkirtExtent: { value: 1 },
    uSkirtSpacing: { value: 1 },
    uSkirtOuter: { value: 2e5 },
  };
}

const VERTEX = (count: number) => /* glsl */ `
${oceanVertexChunk(count)}

uniform float uMode;
uniform vec2 uCenter;      // snapped level centre (world x, y) [m]
uniform float uSpacing;    // vertex spacing of this level [m]
uniform float uCells;      // half extent of the level in cells (M)
uniform float uSkirtExtent;   // half extent E of the last clipmap level [m]
uniform float uSkirtSpacing;  // vertex spacing at the skirt's inner edge [m]
uniform float uSkirtOuter;    // half extent of the skirt's outer edge [m]

varying vec2 vLabel;       // Lagrangian label x₀ (world x, y)
varying vec3 vWorld;       // displaced position, three.js frame
varying float vHeight;     // η at this vertex

void main() {
  vec2 label;
  float sEff;
  if (uMode < 0.5) {
    vec2 g = position.xy;  // integer grid coordinates relative to the level centre
    // CDLOD geomorphing: towards the outer edge, odd vertices slide onto their even neighbours
    // so the edge matches the next (2× coarser) level exactly — no cracks, no popping.
    float cheb = max(abs(g.x), abs(g.y)) / uCells;
    float k = clamp((cheb - 0.7) / 0.2, 0.0, 1.0);
    g -= fract(g * 0.5) * 2.0 * k;
    label = uCenter + g * uSpacing;
    sEff = uSpacing * (1.0 + k);  // continuous effective spacing across level boundaries
  } else {
    // Horizon skirt: position.xy is a point on the unit square, position.z ∈ [0, 1] the ring.
    // Rings grow geometrically from the last level's edge (z = 0) out to uSkirtOuter (z = 1).
    float f = exp(position.z * log(max(uSkirtOuter / uSkirtExtent, 1.0)));
    label = uCenter + position.xy * (uSkirtExtent * f);
    sEff = uSkirtSpacing * f;
  }
  vec3 d = oceanDisplacement(label, sEff);
  // World z-up (x₀ + D, η) → three.js (x, z, −y).
  vec3 p = vec3(label.x + d.x, d.z, -(label.y + d.y));
  vLabel = label;
  vWorld = p;
  vHeight = d.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAGMENT = (count: number) => /* glsl */ `
${oceanFragmentChunk(count)}
${SRGB_TO_LINEAR_GLSL}
${colorMapGlsl('cmapDiverging', DIVERGING_BLUE_ORANGE)}
${colorMapGlsl('cmapViridis', SEQUENTIAL_VIRIDIS)}
${colorMapGlsl('cmapCividis', SEQUENTIAL_CIVIDIS)}

#define PI_W 3.141592653589793

uniform vec2 uFineCenter;
uniform float uFineHalf;
uniform float uMaxAniso;

uniform samplerCube uSkyCube;   // linear sky radiance (sun disc removed), mip-mapped
uniform float uSkyMaxMip;
uniform vec3 uSunDir;           // towards the sun, three.js frame
uniform vec3 uSunIrradiance;    // E_sun on a surface facing the sun
uniform vec3 uWaterReflectance; // deep-water R∞ per channel
uniform vec3 uSssColor;
uniform float uSssScale;        // crest height scale for SSS [m]
uniform float uBaseMss;         // unresolved capillary mean-square slope
uniform float uFoamThreshold;
uniform float uWhitecap;        // crest foam strength (wind)
uniform float uFogDistance;     // e-folding distance of the aerial perspective [m]
uniform int uOverlay;           // 0 none, 1 height, 2 steepness, 3 foam
uniform vec2 uOverlayRange;

varying vec2 vLabel;
varying vec3 vWorld;
varying float vHeight;

// Colour/BRDF terms are bounded and tolerate mediump (fp16 ALUs on mobile GPUs); positions,
// labels and texture coordinates stay highp.
mediump float schlick(mediump float c) {
  mediump float x = 1.0 - clamp(c, 0.0, 1.0);
  mediump float x2 = x * x;
  return 0.02 + 0.98 * x2 * x2 * x;
}

// Smith masking for the Beckmann distribution (Walter et al. 2007 rational approximation).
mediump float smithG1(mediump float c, mediump float m) {
  c = clamp(c, 1e-4, 1.0);
  mediump float a = c / (m * sqrt(1.0 - c * c) + 1e-4);
  if (a >= 1.6) return 1.0;
  return (3.535 * a + 2.181 * a * a) / (1.0 + 2.276 * a + 2.577 * a * a);
}

void main() {
  // Sample first: screen-space derivatives and implicit-LOD fetches stay in uniform control flow.
  OceanSurface s = oceanSurface(vLabel, uMaxAniso);

  // The finer clipmap level owns this part of the plane (rings overlap by one cell). The test
  // runs once per pixel (at its centre) even with MSAA, so a coarse pixel straddling the shared
  // edge must survive if any of its samples can lie outside the finer square: keep a margin of
  // one pixel footprint in label space. The resulting 1-px overlap is depth-resolved between two
  // practically identical surfaces.
  if (uFineHalf > 0.0) {
    vec2 q = abs(vLabel - uFineCenter);
    vec2 fw = fwidth(vLabel);
    if (max(q.x, q.y) < uFineHalf - max(fw.x, fw.y)) discard;
  }
  vec3 nw = oceanNormalWorld(s);
  vec3 N = vec3(nw.x, nw.z, -nw.y);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 L = normalize(uSunDir);
  float mss = s.unresolvedMss + uBaseMss;

  // Downwelling irradiance: direct sun + sky (1×1 mip of the upper cube face ≈ mean sky radiance).
  mediump vec3 skyIrr = PI_W * textureLod(uSkyCube, vec3(0.0, 1.0, 0.0), uSkyMaxMip).rgb;
  float sunUp = smoothstep(-0.03, 0.08, L.y);
  mediump vec3 Ed = uSunIrradiance * max(L.y, 0.0) + skyIrr;

  mediump vec3 col;
  float J = oceanJacobian(s);
  // Whitecaps: instantaneous folding plus the persistent (decaying) foam textures.
  float crest = smoothstep(uFoamThreshold, uFoamThreshold - 0.45, J) * uWhitecap;
  float foam = clamp(0.7 * s.foam + crest, 0.0, 1.0);

  if (gl_FrontFacing) {
    float NdV = dot(N, V);
    // Normals facing away from the eye (grazing views of steep slopes): bend towards the viewer.
    if (NdV < 0.02) {
      N = normalize(N + V * (0.02 - NdV));
      NdV = 0.02;
    }
    float F = schlick(NdV);

    // Sky reflection, blurred according to the roughness.
    vec3 R = reflect(-V, N);
    R.y = max(R.y, 0.0);
    R = normalize(R + vec3(0.0, 1e-3, 0.0));
    float envLod = clamp(log2(sqrt(mss) * 326.0), 0.0, uSkyMaxMip);
    mediump vec3 sky = textureLod(uSkyCube, R, envLod).rgb;

    // Sun glitter: Beckmann NDF with mean-square slope m² = mss.
    vec3 H = normalize(L + V);
    float NdL = dot(N, L);
    float NdH = max(dot(N, H), 1e-4);
    float c2 = NdH * NdH;
    float tan2 = (1.0 - c2) / c2;
    float D = exp(-tan2 / mss) / (PI_W * mss * c2 * c2);
    float m = sqrt(mss);
    float G = smithG1(NdV, m) * smithG1(max(NdL, 0.0), m);
    vec3 spec = NdL > 0.0
      ? uSunIrradiance * (D * schlick(dot(H, V)) * G / (4.0 * NdV)) * sunUp
      : vec3(0.0);

    // Water-leaving radiance: R∞ E_d / π, with a sub-surface glow through thin crests seen
    // against the sun (light refracted into the crest and scattered towards the eye).
    mediump vec3 body = uWaterReflectance * Ed / PI_W;
    vec3 Lh = normalize(vec3(L.x, 0.0, L.z) + vec3(0.0, 1e-4, 0.0));
    float backlit = pow(max(dot(-V, Lh), 0.0), 4.0) * pow(clamp(0.5 - 0.5 * dot(L, N), 0.0, 1.0), 2.0);
    float crestMask = clamp(vHeight / uSssScale + 0.25, 0.0, 1.5);
    float facing = pow(max(dot(V, N), 0.0), 2.0) * 0.3;
    mediump vec3 sss = uSssColor * uSunIrradiance * sunUp * (backlit * crestMask + facing * crestMask * 0.25) / PI_W;

    col = F * sky + (1.0 - F) * (body + sss) + spec * (1.0 - foam);
    mediump vec3 foamCol = vec3(0.85) * (uSunIrradiance * max(dot(N, L), 0.0) * sunUp + skyIrr) / PI_W;
    col = mix(col, foamCol, foam);
  } else {
    // Seen from below: Snell's window (refracted sky) inside the critical angle 48.6°, total
    // internal reflection of the dark water body outside it.
    vec3 Nd = -N;
    vec3 T = refract(-V, Nd, 1.333);
    vec3 under = uWaterReflectance * Ed / PI_W * 1.5;
    if (dot(T, T) > 0.0) {
      float Ft = schlick(dot(V, Nd));
      col = mix(textureLod(uSkyCube, normalize(T), 2.0).rgb * (1.0 - Ft), under, 0.25);
    } else {
      col = under;
    }
    col = mix(col, foam * skyIrr / PI_W, foam * 0.5);
  }

  if (uOverlay == 0) {
    // Aerial perspective: fade to the horizon sky radiance along the view direction.
    vec3 hdir = normalize(vec3(-V.x, 0.0, -V.z) + vec3(0.0, 0.03, 0.0));
    vec3 haze = textureLod(uSkyCube, hdir, 3.0).rgb;
    float fog = 1.0 - exp(-dist / uFogDistance);
    col = mix(col, haze, fog);
  } else {
    // Scientific overlays: exact colour maps (tone mapping is disabled for this material),
    // lightly shaded so the wave relief remains readable.
    float v;
    vec3 c;
    if (uOverlay == 1) {
      v = (s.eta - uOverlayRange.x) / (uOverlayRange.y - uOverlayRange.x);
      c = cmapDiverging(v);
    } else if (uOverlay == 2) {
      // Geometric slope of the displaced surface, |∇z| = |n_h| / n_z.
      v = (length(nw.xy) / max(nw.z, 1e-3) - uOverlayRange.x) / (uOverlayRange.y - uOverlayRange.x);
      c = cmapViridis(v);
    } else {
      v = (foam - uOverlayRange.x) / (uOverlayRange.y - uOverlayRange.x);
      c = cmapCividis(v);
    }
    float shade = 0.8 + 0.2 * dot(N, normalize(vec3(0.3, 1.0, 0.2)));
    col = c * shade;
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createWaterMaterial(
  cascadeCount: number,
  shared: UniformMap,
  level: UniformMap,
): ShaderMaterial {
  const mat = new ShaderMaterial({
    name: 'WaterMaterial',
    vertexShader: VERTEX(cascadeCount),
    fragmentShader: FRAGMENT(cascadeCount),
    uniforms: { ...shared, ...level },
    side: DoubleSide,
  });
  return mat;
}
