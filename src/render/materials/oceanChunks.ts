/**
 * Shared GLSL for sampling the ocean surface (vertex displacement, fragment derivatives),
 * generated for a given cascade count. Used by the water material and by the GPU surface sampler,
 * so the test harness exercises exactly the code that renders the sea.
 *
 * All quantities are in the world z-up frame: x₀ = (x, y) is the Lagrangian label of a surface
 * particle, which is displayed at (x₀ + D(x₀), η(x₀)) (docs/PHYSICS.md).
 */
import { SLOPE_TABLE_LEVELS } from '../ocean/oceanStats';

export const MAX_CASCADES = 4;
export const MAX_REGULAR_WAVES = 8;

/** Uniform declarations (no samplers arrays: GLSL ES 3.00 forbids dynamic sampler indexing). */
function declarations(count: number): string {
  let s = '';
  for (let i = 0; i < count; i++) {
    s += `uniform sampler2D uDisp${i};\nuniform sampler2D uDeriv${i};\nuniform sampler2D uFoam${i};\n`;
  }
  return /* glsl */ `
${s}
// (L [m], N, ½ texel in uv, 0). Texel centres sit at x = p·L/N, hence the ½-texel uv offset.
uniform vec4 uCascade[${MAX_CASCADES}];
// Regular Airy components: A = (a, k, φ − ωt (mod 2π, from the CPU in double), λ a coth(kh)),
// D = (d̂ₓ, d̂_y, wavelength, 0).
uniform vec4 uRegA[${MAX_REGULAR_WAVES}];
uniform vec4 uRegD[${MAX_REGULAR_WAVES}];
uniform int uRegCount;
// Unresolved mean-square slope per cascade and mip level (see oceanStats.ts).
uniform float uSlopeVar[${MAX_CASCADES * SLOPE_TABLE_LEVELS}];
`;
}

/** Vertex-stage chunk: filtered displacement. */
export function oceanVertexChunk(count: number): string {
  let cascades = '';
  for (let i = 0; i < count; i++) {
    cascades += /* glsl */ `
  {
    vec4 c = uCascade[${i}];
    // Fade a cascade once the mesh can no longer represent it (prevents vertex aliasing).
    float fade = 1.0 - smoothstep(c.x * 0.125, c.x * 0.33, sEff);
    if (fade > 0.0) {
      // Pre-filter with the mip level whose texel matches the local vertex spacing.
      float lod = log2(max(sEff * c.y / c.x, 1.0));
      vec4 t = textureLod(uDisp${i}, x0 / c.x + c.z, lod);
      d += fade * vec3(t.x, t.z, t.y);
    }
  }`;
  }
  return /* glsl */ `
${declarations(count)}

// Displacement (Dₓ, D_y, η) [m] of the particle labelled x0, band-limited for a mesh spacing sEff.
vec3 oceanDisplacement(vec2 x0, float sEff) {
  vec3 d = vec3(0.0);
  ${cascades}
  // Regular waves: θ = k d̂·x₀ − ωt + φ,  η = a cos θ,  D = −λ a coth(kh) sin θ d̂.
  for (int r = 0; r < ${MAX_REGULAR_WAVES}; r++) {
    if (r >= uRegCount) break;
    vec4 A = uRegA[r];
    vec4 D = uRegD[r];
    float fade = 1.0 - smoothstep(D.z * 0.125, D.z * 0.33, sEff);
    float th = A.y * dot(D.xy, x0) + A.z;
    d += fade * vec3(-A.w * sin(th) * D.xy, A.x * cos(th));
  }
  return d;
}
`;
}

/** Fragment-stage chunk: full-resolution (mip/aniso filtered) derivatives, foam, roughness. */
export function oceanFragmentChunk(count: number): string {
  let cascades = '';
  for (let i = 0; i < count; i++) {
    cascades += /* glsl */ `
  {
    vec4 c = uCascade[${i}];
    vec2 uv = x0 / c.x + c.z;
    vec4 dsp = texture(uDisp${i}, uv);    // (Dₓ, η, D_y, ∂Dₓ/∂y)
    vec4 der = texture(uDeriv${i}, uv);   // (∂η/∂x, ∂η/∂y, ∂Dₓ/∂x, ∂D_y/∂y)
    vec4 fm = texture(uFoam${i}, uv);     // (foam, J, -, -)
    s.slope += der.xy;
    s.dxx += der.z;
    s.dyy += der.w;
    s.dxy += dsp.w;
    s.eta += dsp.y;
    s.foam += fm.x;
    // Mip level the hardware picks (texels per pixel, anisotropic footprint).
    float lod = clamp(lodMeters + log2(c.y / c.x), 0.0, ${SLOPE_TABLE_LEVELS - 1}.0);
    int l0 = int(floor(lod));
    int l1 = min(l0 + 1, ${SLOPE_TABLE_LEVELS - 1});
    s.unresolvedMss += mix(uSlopeVar[${i * SLOPE_TABLE_LEVELS} + l0], uSlopeVar[${i * SLOPE_TABLE_LEVELS} + l1], fract(lod));
  }`;
  }
  return /* glsl */ `
${declarations(count)}

struct OceanSurface {
  vec2 slope;          // (∂η/∂x₀, ∂η/∂y₀)
  float dxx;           // ∂Dₓ/∂x₀
  float dyy;           // ∂D_y/∂y₀
  float dxy;           // ∂Dₓ/∂y₀ = ∂D_y/∂x₀ (irrotational)
  float eta;           // η [m]
  float foam;          // persistent foam (sum of cascades)
  float unresolvedMss; // slope variance lost by texture filtering (→ specular roughness)
};

// Sample everything at label x0. maxAniso is the anisotropic filtering limit of the textures.
OceanSurface oceanSurface(vec2 x0, float maxAniso) {
  OceanSurface s;
  s.slope = vec2(0.0);
  s.dxx = 0.0; s.dyy = 0.0; s.dxy = 0.0; s.eta = 0.0; s.foam = 0.0; s.unresolvedMss = 0.0;

  // Pixel footprint in metres → mip level per cascade, the way the hardware selects it:
  // λ = log₂(max(Pmax / min(Pmax/Pmin, maxAniso), Pmin)).
  vec2 px = dFdx(x0);
  vec2 py = dFdy(x0);
  float pa = length(px);
  float pb = length(py);
  float pMax = max(max(pa, pb), 1e-6);
  float pMin = max(min(pa, pb), 1e-6);
  float lodMeters = log2(max(pMax / min(pMax / pMin, maxAniso), pMin));
  ${cascades}

  // Regular waves, evaluated analytically (exact derivatives of the Airy/Gerstner map).
  for (int r = 0; r < ${MAX_REGULAR_WAVES}; r++) {
    if (r >= uRegCount) break;
    vec4 A = uRegA[r];
    vec4 D = uRegD[r];
    float th = A.y * dot(D.xy, x0) + A.z;
    float sn = sin(th);
    float cs = cos(th);
    s.slope += -A.x * A.y * sn * D.xy;           // ∇η = −a k sin θ d̂
    vec3 dd = -A.w * A.y * cs * vec3(D.x * D.x, D.y * D.y, D.x * D.y);
    s.dxx += dd.x; s.dyy += dd.y; s.dxy += dd.z;  // ∂D/∂x₀ = −λ a coth k cos θ d̂ d̂ᵀ
    s.eta += A.x * cs;
  }
  return s;
}

// Exact normal of the displaced Lagrangian surface P(x₀) = (x₀ + D, η):
//   ∂P/∂x₀ = (1 + Dₓₓ, Dₓᵧ, ηₓ),   ∂P/∂y₀ = (Dₓᵧ, 1 + Dᵧᵧ, ηᵧ),   n ∝ ∂P/∂x₀ × ∂P/∂y₀.
// Returned in the world z-up frame.
vec3 oceanNormalWorld(OceanSurface s) {
  vec3 tx = vec3(1.0 + s.dxx, s.dxy, s.slope.x);
  vec3 ty = vec3(s.dxy, 1.0 + s.dyy, s.slope.y);
  vec3 n = cross(tx, ty);
  return n.z > 1e-4 ? normalize(n) : vec3(0.0, 0.0, 1.0);
}

// Jacobian of the horizontal map (folding indicator).
float oceanJacobian(OceanSurface s) {
  return (1.0 + s.dxx) * (1.0 + s.dyy) - s.dxy * s.dxy;
}
`;
}
