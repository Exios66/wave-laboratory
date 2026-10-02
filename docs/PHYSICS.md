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

Vessel forces sample the sea on a moving patch of up to 280 columns (minimum spacing
max(0.25 m, 0.012 L)), so waves of a few hull-breadths contribute to the pressure integral instead of
being averaged away.

**What the GPU actually draws.** `render/ocean` inverse-FFTs η and the packed horizontal
displacement (Dx + i Dy) only. Slope and Jacobian for shading and the scientific overlays are
finite differences of that displaced surface, not extra spectral FFTs. Foam ramps in as J falls
through a wind-dependent gate (about 0.45 in calm air to about 0.75 in a strong wind). Pressure,
orbital velocity and the other rows of the table above stay on the CPU.

**Regular (Airy) components** are analytic, not in the FFT, and identical on CPU and GPU:

    θ = k (d̂·x₀) − ω t + φ,   η = a cos θ,   D = −λ a coth(kh) sin θ · d̂

When choppiness λ > 0 a second-order Stokes harmonic is added, a₂ cos 2θ, with
a₂ = (k a² / 4) (3 − σ²) / σ³ and σ = tanh(kh), held at a/4. That raises crests and
lifts troughs. The cap is where the harmonic would put a second crest in the trough, the
shallow-water regime (Ursell number ≳ 26) where Stokes theory no longer applies.
It is omitted for λ = 0 so a pure Airy wave stays linear. The harmonic averages to zero,
so the Eulerian mean level of the choppy wave is still −k a² / 2.

## Pressure and kinematics (CPU)

Total gauge pressure below the surface uses Wheeler stretching:

    p(x, z) = ρ g (−z + head(ζ)),   ζ = (z − η)·h/(h + η)

where `head(ζ)` is the sum over cascades of the depth-attenuated dynamic head. Each cascade
evaluates it exactly at three levels `k_ref·|ζ| = 0.5, 1.5, 3.5` (k_ref = energy-weighted mean
wavenumber of the cascade), interpolates linearly between levels and decays as `e^{k_ref ζ}`
below. Particle velocities use the surface orbital velocity attenuated by `e^{k_ref ζ}`
(deep-water approximation per cascade). Regular components are evaluated exactly, with
vertical velocity attenuated by sinh(k(z+h))/sinh(kh) so it vanishes at the seabed.

Fields are evaluated at snapshot instants (default every 1/20 s) and interpolated linearly in
time. η uses bicubic Hermite interpolation with spectrally exact derivatives (< 0.5 % error at
the shortest physics wavelength); other fields use Catmull–Rom.

## Uniform surface current

The environment can carry a uniform current **U** (speed and the bearing it flows toward). Every
wave system is specified in the frame of the moving water, and the whole sea is advected:

    η(x, t) = η_water(x − U t, t),   u(x, z, t) = u_water(x − U t, z, t) + U

so each component seen from a fixed point has the Doppler-shifted frequency ω = σ(k) + k·U, and
∂η/∂t at a fixed point gains −U·∇η. The CPU field and the GPU renderer apply the same shift
(the shader samples at `worldXY − U t`), so the FFT textures and their agreement check are
unchanged. Vessels feel the current through their hull forces, which act on the velocity
through the water: resistance, cross-flow drag, manoeuvring derivatives, rudder inflow and the
autopilot's speed through the water. A drifting hull is therefore carried along, and a ship
holding a heading is set across its track.

Not modelled: refraction by current gradients, current shear with depth, and the shortening and
steepening of waves against an opposing current. The inspector warns when an opposing current
exceeds half the peak group velocity, and when it exceeds the group velocity (wave blocking).

## Loading condition

`loadFactor` scales the displacement relative to the design. The draft is found by bisection on
the hull mesh so that the immersed volume equals `loadFactor · ∇_design` (capped just below the
deck), and all hydrostatics, inertia and the strip model are built at that draft. KG stays
`kgFactor · D`, so a light ship gains GM from its wider relative waterplane and a deep-loaded one
loses freeboard. The boot-top paint stays at the design waterline.

## Spectra

- **JONSWAP** `S(ω) = α g² ω⁻⁵ exp(−5/4 (ω_p/ω)⁴) γ^r`, σ = 0.07/0.09, normalised so 4√m₀ = H_s.
- **Pierson–Moskowitz / Bretschneider**: JONSWAP with γ = 1, normalised to H_s.
- **TMA**: multiplied by the Kitaigorodskii depth factor when depth < 1000 m; H_s re-normalised.
- **Wind sea**: Hasselmann et al. (1973) fetch-limited growth, capped by the fully developed
  Pierson–Moskowitz limit (H_s ≈ 0.209 U²/g): when the fetch-limited H_s reaches the
  fully developed one, the fully developed sea is used, so a longer fetch never gives a smaller sea.
- **Spreading**: cos-2s, Mitsuyasu (frequency-dependent s), Donelan–Banner sech², all
  normalised to ∫D dθ = 1.

## Focused (rogue) waves

A `focused` wave system is a NewWave group (Tromans, Anaturk & Hagemeijer 1991): 40 linear
components between 0.6 ω_p and 3 ω_p with amplitudes `a_n = A_c S(ω_n)Δω / Σ S(ω_m)Δω`
(JONSWAP shape, γ = 3.3) and phases chosen so every crest coincides at the focus point and time
(`k·x_f − ω t_f + φ = 0`). Frequencies are jittered inside their bins so the group does not
refocus periodically. The components are evaluated exactly like regular waves and add to the
spectral sea, so the crest height at the focus is A_c above the background sea.

## Weather (`src/weather`)

Everything is a pure function of (seed, x, y, t), so the worker, the renderer and the tests see
the same weather.

- **Mean wind** is the environment's U₁₀ and compass "from" direction.
- **Gusts:** longitudinal and lateral turbulence u′, v′ is a sum of 24 Fourier modes drawn
  from the von Kármán spectrum `S_u(f) = 4σ_u²(L/U) / (1 + 70.8 (fL/U)²)^(5/6)` with
  L = 180 m, σ_u = I·U (I = gustiness) and σ_v = 0.75 σ_u (ESDU 85020). The field is advected
  with the mean wind (Taylor's frozen turbulence) and varies across the wind, so gusts arrive
  as moving patches. The truncated band is rescaled so σ_u is exactly the requested value.
- **Squalls:** fronts move downwind at the mean wind speed (at least 2 m/s), arriving on
  average every `intervalMin`. Each has a sharp gust-front rise, a plateau, and a slower decay
  over `durationMin`. Inside a squall the wind is multiplied by up to `strength`, turbulence
  rises by half, the wind veers clockwise by up to `veerDeg`, rain rises by max(25, 2R) mm/h and
  cloud cover goes to 95 %.
- **Rain and visibility:** Koschmieder's law with rain extinction
  `β = 3.912/V_clear + 0.25 R^0.63 km⁻¹`.
- **Whitecaps:** coverage `W = 3.84·10⁻⁶ U₁₀^3.41` (Monahan & O'Muircheartaigh 1980), capped
  at 1.
- **Lightning:** a Poisson-like process (one hash per 0.25 s slot) whose rate rises with rain
  and squalls. It is visual only.
- **Wind sea following the weather:** a `wind` wave system with `followWeather` takes its U₁₀
  and direction from the environment, so the fetch-limited JONSWAP sea grows and turns with the
  wind you set. Gusts and squalls act on the vessels and the picture, not on the spectrum.

## Wind loads and sails (`src/vessel/windLoads.ts`)

Wind acts on every vessel at the air velocity relative to the ship, V_a, in the body frame.

- **Windage** (Isherwood/Blendermann-type drag, Fossen 2011 §10.1):
  `X = ½ρ_a C_X A_F |V_a| V_ax`, `Y = ½ρ_a C_Y A_L |V_a| V_ay` with C_X = 0.7, C_Y = 0.9.
  The lateral force acts at the centroid of the lateral area shifted 0.15 L toward the windward
  end (Hughes 1930), which gives the weather-vaning yaw moment. The heeling moment is that force
  times the centroid height. Frontal and lateral areas are rasterised from each hull and its
  superstructure.
- **Square sails:** one aerodynamic surface of area A_s set to a fraction `set` with
  `C_L(α) = 1.25 sin 2α · f(α)` and `C_D(α) = 0.08 + 1.2 sin² α`. f rises smoothly from 0 at
  α = 8° to 1 at 20° because a square sail luffs at small angles of attack. Lift is
  perpendicular and drag parallel to the apparent wind, and the force falls with cos² of heel.
  The crew braces the yards between a minimum angle and square to maximise drive, which
  reproduces a square-rigger's inability to point higher than about 60° off the wind. With the
  autopilot on, the crew reefs above 13 m/s apparent wind (about Beaufort 6).
