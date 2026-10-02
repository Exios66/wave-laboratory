# Physics reference & conventions

This document is the single source of truth for conventions shared by the CPU physics
(`src/ocean`, `src/vessel`) and the GPU renderer (`src/render`). If code and this file disagree,
that is a bug.

## Frames and units

- SI units internally. Display conversions live in `src/core/units.ts`.
- **World frame:** right-handed, **z up**, x east, y north, origin on the mean water level (MWL).
  The Three.js scene uses y-up; the renderer maps world (x, y, z) → three (x, z, −y).
- **Vessel body frame:** x forward, y to port, z up, origin at the centre of gravity (CoG).
  Roll + = starboard side down, pitch + = bow down, yaw + = counter-clockwise from above.
- **Compass conventions (experiment file / UI):** wave & wind directions are bearings the
  energy comes **from**; vessel headings are bearings the bow points **toward**.
  - propagation angle θ₀ = (−90° − from) (mathematical, CCW from +x);
  - yaw = 90° − heading.

## Linear wave theory

Dispersion (finite depth h, surface tension σ, density ρ):

    ω² = (g k + (σ/ρ) k³) · tanh(k h)

Dynamic-pressure depth attenuation: `A(k, z) = cosh(k(z+h)) / cosh(kh)`.

## Spectral synthesis (shared CPU/GPU)

The surface is a sum of `C = 4` periodic cascades with sizes `L = [1024, 256, 64, 16] m`.
Cascade _i_ owns wavenumbers `kLow_i ≤ |k| < kHigh_i` with `kHigh_i = kLow_{i+1} = 6·2π/L_{i+1}`.
The last cascade extends to the grid Nyquist and is **visual only**; the first three are
evaluated by the CPU physics on 128² grids (no components are lost, as each band fits within
|m| ≤ 24 cells).

**Grid convention.** For an N×N grid, texel/array index `(ix, iy)` (row-major, row ↔ y) holds
wavenumber `k = (2π/L)·(m(ix), m(iy))`, `m(i) = i < N/2 ? i : i − N`. Spatial sample `(px, py)`
is at `x = px·L/N`, `y = py·L/N`. The inverse transform is unnormalised with a **positive**
exponent: `f(x) = Σ_k F(k) e^{+i k·x}`.

**Initial amplitudes** `h₀(k)` (computed once on the CPU, uploaded to the GPU as RGBA32F
`(Re h₀, Im h₀, ω, 0)`):

    h₀(k) = ½ (ξ_r + i ξ_i) √(S(k) Δk²),   S(k) = S(ω) D(θ; ω) (dω/dk) / k

with ξ standard normals from a counter-based hash of (system seed, cascade, mx, my), so every
grid resolution sees the same sea.

**Time evolution** (waves travel along +k):

    e₁ = h₀(k) e^{−iωt},   e₂ = conj(h₀(−k)) e^{+iωt}
    ĥ(k, t)  = e₁ + e₂                       → η = Σ ĥ e^{ik·x}  (real)
    ∂ĥ/∂t    = −iω e₁ + iω e₂

**Derived spectra** (k̂ = k/|k|, λ = choppiness, coth = 1/tanh(kh)):

| Field                            | Spectrum                                             |
| -------------------------------- | ---------------------------------------------------- |
| η                                | ĥ                                                    |
| ∂η/∂x, ∂η/∂y                     | i kₓ ĥ, i k_y ĥ                                      |
| Horizontal displacement Dₓ, D_y  | λ · i k̂ₓ coth(kh) ĥ, λ · i k̂_y coth(kh) ĥ            |
| ∂Dₓ/∂x, ∂D_y/∂y, ∂Dₓ/∂y          | −λ kₓ k̂ₓ coth ĥ, −λ k_y k̂_y coth ĥ, −λ k_y k̂ₓ coth ĥ |
| ∂η/∂t                            | ∂ĥ/∂t                                                |
| Surface orbital velocity uₓ, u_y | i k̂ₓ coth(kh) ∂ĥ/∂t, i k̂_y coth(kh) ∂ĥ/∂t            |
| Dynamic pressure head at depth z | A(k, z) ĥ                                            |

A surface particle with label x₀ is displayed at `x₀ + D(x₀)` with height `η(x₀)`. Point
queries at a world position invert this by fixed-point iteration `x₀ ← x − D(x₀)`.
For a single Airy wave this produces the exact Gerstner trochoid; the Eulerian mean level is
`−k a²/2` (tested).

**Jacobian / folding:** `J = (1 + ∂Dₓ/∂x)(1 + ∂D_y/∂y) − (∂Dₓ/∂y)²`. `J < 0` means the surface
has folded (a breaking crest).

Vessel forces sample the sea on a moving patch of up to 220 columns (0.35 m minimum
spacing), so waves of a few hull-breadths contribute to the pressure integral instead of
being averaged away.

**What the GPU actually draws.** `render/ocean` inverse-FFTs η and the packed horizontal
displacement (Dx + i Dy) only. Slope and Jacobian for shading and the scientific overlays are
finite differences of that displaced surface, not extra spectral FFTs. Foam ramps in as J falls
through a wind-dependent gate (about 0.45 in calm air to about 0.75 in a strong wind). Pressure,
orbital velocity and the other rows of the table above stay on the CPU.

**Regular (Airy) components** are analytic, not in the FFT, and identical on CPU and GPU:

    θ = k (d̂·x₀) − ω t + φ,   η = a cos θ,   D = −λ a coth(kh) sin θ · d̂

## Pressure and kinematics (CPU)

Total gauge pressure below the surface uses Wheeler stretching:

    p(x, z) = ρ g (−z + head(ζ)),   ζ = (z − η)·h/(h + η)

where `head(ζ)` is the sum over cascades of the depth-attenuated dynamic head. Each cascade
evaluates it exactly at three levels `k_ref·|ζ| = 0.5, 1.5, 3.5` (k_ref = energy-weighted mean
wavenumber of the cascade), interpolates linearly between levels and decays as `e^{k_ref ζ}`
below. Particle velocities use the surface orbital velocity attenuated by `e^{k_ref ζ}`
(deep-water approximation per cascade). Regular components are evaluated exactly.

Fields are evaluated at snapshot instants (default every 1/20 s) and interpolated linearly in
time. η uses bicubic Hermite interpolation with spectrally exact derivatives (< 0.5 % error at
the shortest physics wavelength); other fields use Catmull–Rom.

## Spectra

- **JONSWAP** `S(ω) = α g² ω⁻⁵ exp(−5/4 (ω_p/ω)⁴) γ^r`, σ = 0.07/0.09, normalised so 4√m₀ = H_s.
- **Pierson–Moskowitz / Bretschneider**: JONSWAP with γ = 1, normalised to H_s.
- **TMA**: multiplied by the Kitaigorodskii depth factor when depth < 1000 m; H_s re-normalised.
- **Wind sea**: Hasselmann et al. (1973) fetch-limited growth, capped by the fully developed
  Pierson–Moskowitz limit (H_s ≈ 0.209 U²/g).
- **Spreading**: cos-2s, Mitsuyasu (frequency-dependent s), Donelan–Banner sech², all
  normalised to ∫D dθ = 1.
