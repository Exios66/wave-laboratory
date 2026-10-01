/**
 * GLSL ES 3.00 shaders of the GPU spectral ocean (used with RawShaderMaterial + GLSL3).
 *
 * Conventions (docs/PHYSICS.md, identical to src/ocean/fft.ts):
 *  - texel (ix, iy) ↔ k = (2π/L)(m(ix), m(iy)),  m(i) = i < N/2 ? i : i − N;
 *  - spatial sample (px, py) ↔ x = (px, py)·L/N;
 *  - inverse transform f(x) = Σ_k F(k) e^{+i k·x}, unnormalised.
 *
 * Eight real fields are produced per cascade with four complex FFTs. Two real fields A, B are
 * packed into one complex signal C = Â + i·B̂: because A and B are real, the inverse transform
 * of C is A + iB, so Re/Im of the result are the two fields.
 *
 *   C0 = Dₓ   + i η        C1 = D_y   + i ∂η/∂x
 *   C2 = ∂η/∂y + i ∂Dₓ/∂x   C3 = ∂D_y/∂y + i ∂Dₓ/∂y
 *
 * Render target layout (MRT, 2 attachments): attachment 0 = (C0.re, C0.im, C1.re, C1.im),
 * attachment 1 = (C2.re, C2.im, C3.re, C3.im).
 */

const HEADER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
`;

/** Full-screen triangle: the only geometry used by the compute passes. */
export const FULLSCREEN_VERTEX = /* glsl */ `
${HEADER}
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Time evolution + derived spectra. Writes the four packed complex spectra of one cascade.
 *
 *   e₁ = h₀(k) e^{−iωt},  e₂ = conj(h₀(−k)) e^{+iωt},  ĥ = e₁ + e₂
 *   ∂η/∂x = i kₓ ĥ,  Dₓ = λ i k̂ₓ coth(kh) ĥ,  ∂Dₓ/∂x = −λ kₓ k̂ₓ coth(kh) ĥ,  …
 */
export const SPECTRUM_FRAGMENT = /* glsl */ `
${HEADER}
uniform sampler2D uH0;     // (Re h₀, Im h₀, ω, 0), natural FFT order
uniform int uN;
uniform float uSize;       // patch size L [m]
uniform float uTime;       // t [s]
uniform float uLambda;     // choppiness λ
uniform float uDepth;      // water depth h [m]

layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
// Multiplication by i: (r, s) → (−s, r).
vec2 mulI(vec2 a) { return vec2(-a.y, a.x); }
// Pack two complex spectra of real fields: Â + i B̂.
vec2 pack2(vec2 a, vec2 b) { return a + mulI(b); }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 pm = ivec2((uN - p.x) % uN, (uN - p.y) % uN);   // texel of −k
  vec4 h0k = texelFetch(uH0, p, 0);
  vec4 h0mk = texelFetch(uH0, pm, 0);

  // Signed wavenumber indices and wave vector.
  vec2 m = vec2(p.x < uN / 2 ? p.x : p.x - uN, p.y < uN / 2 ? p.y : p.y - uN);
  vec2 kv = m * (6.283185307179586 / uSize);
  float k = length(kv);

  // Phase ωt reduced to [0, 2π) before sin/cos (GPU sin/cos lose accuracy for large arguments).
  float omega = h0k.z;
  float ph = omega * uTime;
  ph -= 6.283185307179586 * floor(ph * 0.15915494309189535);
  vec2 e = vec2(cos(ph), sin(ph));            // e^{+iωt}
  vec2 eConj = vec2(e.x, -e.y);               // e^{−iωt}
  vec2 e1 = cmul(h0k.xy, eConj);
  vec2 e2 = cmul(vec2(h0mk.x, -h0mk.y), e);   // conj(h₀(−k)) e^{+iωt}
  vec2 h = e1 + e2;

  // k̂ coth(kh): horizontal/vertical orbital amplitude ratio along the propagation direction.
  vec2 khat = k > 0.0 ? kv / k : vec2(0.0);
  float kh = k * uDepth;
  float coth = kh > 20.0 ? 1.0 : 1.0 / max(tanh(kh), 1e-6);
  vec2 dfac = uLambda * coth * khat;          // λ k̂ coth(kh)

  vec2 eta = h;
  vec2 etaX = kv.x * mulI(h);                 // i kₓ ĥ
  vec2 etaY = kv.y * mulI(h);                 // i k_y ĥ
  vec2 dX = dfac.x * mulI(h);                 // λ i k̂ₓ coth ĥ
  vec2 dY = dfac.y * mulI(h);                 // λ i k̂_y coth ĥ
  vec2 dXX = -kv.x * dfac.x * h;              // −λ kₓ k̂ₓ coth ĥ
  vec2 dYY = -kv.y * dfac.y * h;              // −λ k_y k̂_y coth ĥ
  vec2 dXY = -kv.y * dfac.x * h;              // −λ k_y k̂ₓ coth ĥ

  outA = vec4(pack2(dX, eta), pack2(dY, etaX));
  outB = vec4(pack2(etaY, dXX), pack2(dYY, dXY));
}
`;

/**
 * One radix-2 Stockham pass of the inverse FFT along x (uAxis = 0) or y (uAxis = 1), applied to
 * all four packed complex signals at once. The pass is "output-indexed": every texel computes its
 * own output from two inputs, which is what a fragment shader needs.
 *
 * With Ns = 2^s (s = 0 … log₂N − 1) and output index o:
 *     r = o mod 2Ns,  j = ⌊o / 2Ns⌋·Ns + (r mod Ns)
 *     out[o] = in[j] ± w·in[j + N/2],   w = e^{+2πi (r mod Ns) / (2Ns)},   + if r < Ns else −
 * After log₂N passes the natural-order input yields the natural-order transform
 * Σ_m F[m] e^{+2πi m p / N} (Stockham auto-sort: no bit reversal needed).
 * Twiddles come from a table computed in double precision on the CPU.
 */
export const FFT_PASS_FRAGMENT = /* glsl */ `
${HEADER}
uniform sampler2D uInA;
uniform sampler2D uInB;
uniform sampler2D uTwiddle;   // texel t: e^{+2πi t / N}, t ∈ [0, N/2)
uniform int uN;
uniform int uNs;
uniform int uAxis;

layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int o = uAxis == 0 ? p.x : p.y;
  int span = 2 * uNs;
  int r = o % span;
  int kk = r % uNs;
  int j = (o / span) * uNs + kk;
  float sgn = r < uNs ? 1.0 : -1.0;
  vec2 w = texelFetch(uTwiddle, ivec2(kk * (uN / span), 0), 0).xy;

  ivec2 p0 = uAxis == 0 ? ivec2(j, p.y) : ivec2(p.x, j);
  ivec2 p1 = uAxis == 0 ? ivec2(j + uN / 2, p.y) : ivec2(p.x, j + uN / 2);
  vec4 a0 = texelFetch(uInA, p0, 0);
  vec4 a1 = texelFetch(uInA, p1, 0);
  vec4 b0 = texelFetch(uInB, p0, 0);
  vec4 b1 = texelFetch(uInB, p1, 0);

  outA = vec4(a0.xy + sgn * cmul(w, a1.xy), a0.zw + sgn * cmul(w, a1.zw));
  outB = vec4(b0.xy + sgn * cmul(w, b1.xy), b0.zw + sgn * cmul(w, b1.zw));
}
`;

/**
 * Unpacks the transformed fields into the sampling textures and updates the persistent foam.
 *
 * Outputs (MRT, 3 attachments):
 *   0 displacement  (Dₓ, η, D_y, ∂Dₓ/∂y)     — world z-up meaning
 *   1 derivatives   (∂η/∂x, ∂η/∂y, ∂Dₓ/∂x, ∂D_y/∂y)
 *   2 foam          (foam ∈ [0,1], Jacobian J, 0, 1)
 *
 * Foam (Tessendorf 2001; Dupuy & Bruneton 2012): the Lagrangian surface folds where the Jacobian
 * J = (1 + ∂Dₓ/∂x)(1 + ∂D_y/∂y) − (∂Dₓ/∂y)² of the horizontal map x₀ → x₀ + D drops; breaking
 * crests inject foam where J < J_thr. The foam lives in label space, so it rides with the surface
 * particles, and decays exponentially: foam ← foam·e^{−Δt/τ} + injection·Δt·rate.
 */
export const ASSEMBLE_FRAGMENT = /* glsl */ `
${HEADER}
uniform sampler2D uInA;
uniform sampler2D uInB;
uniform sampler2D uFoamPrev;
uniform float uDt;             // simulation time step since the previous update [s]
uniform float uFoamDecay;      // e^{−Δt/τ}
uniform float uFoamThreshold;  // J below which foam is injected
uniform float uFoamRate;       // injection rate [1/s] at full strength
uniform float uFoamEnabled;    // 0 for cascades whose foam is not tracked

layout(location = 0) out vec4 outDisp;
layout(location = 1) out vec4 outDeriv;
layout(location = 2) out vec4 outFoam;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uInA, p, 0);   // (Dₓ, η, D_y, ∂η/∂x)
  vec4 b = texelFetch(uInB, p, 0);   // (∂η/∂y, ∂Dₓ/∂x, ∂D_y/∂y, ∂Dₓ/∂y)
  float dxx = b.y;
  float dyy = b.z;
  float dxy = b.w;
  outDisp = vec4(a.x, a.y, a.z, dxy);
  outDeriv = vec4(a.w, b.x, dxx, dyy);

  float jac = (1.0 + dxx) * (1.0 + dyy) - dxy * dxy;
  float prev = texelFetch(uFoamPrev, p, 0).x;
  // Injection grows linearly as J sinks below the threshold (saturates 0.5 below it).
  float inject = clamp((uFoamThreshold - jac) * 2.0, 0.0, 1.0);
  float foam = clamp(prev * uFoamDecay + inject * uFoamRate * uDt, 0.0, 1.0) * uFoamEnabled;
  outFoam = vec4(foam, jac, 0.0, 1.0);
}
`;
