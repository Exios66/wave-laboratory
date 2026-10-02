# Wave Laboratory: Master Plan

**A real-time, scientifically grounded 3D ocean-wave sandbox for setting up wave experiments and dropping ships into them.**

Status: v0.1 in the repository · Last updated: 2026-10-02

---

## 0. Implementation status (v0.1)

The first build implements the core of Phases 0–4 and part of Phase 7. Checks and publishing
are local: `pnpm check` and `pnpm test:e2e` on a developer machine, and `pnpm deploy:pages`
commits the static build into `docs/` on `main`. There is no GitHub Actions workflow and no
`gh-pages` branch.

| Area                                                                                                                     | Status                 |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| Tooling, local tests, schema, deterministic core                                                                         | ✅ Done                |
| Spectral ocean (JONSWAP/PM/Bretschneider, TMA, wind-sea growth, spreading, 4 cascades, choppy)                           | ✅ CPU reference + GPU |
| Regular (Airy) waves                                                                                                     | ✅                     |
| Vessel dynamics: pressure integration with waterline clipping, L0 radiation, viscous drag, propulsion, rudder, autopilot | ✅                     |
| Instruments: wave gauges, motion recorders, Welch PSD, statistics, MSI, CSV export                                       | ✅                     |
| Sandbox UI: presets, save/open/share, undo/redo, phone layout, accessibility checks                                      | ✅                     |
| Stokes/cnoidal/focused waves, grid (SWE/Boussinesq) solvers, scripting API, L1/L2 radiation                              | ⏳ Later phases        |

**Deviation from §2:** the renderer uses **WebGL 2 through Three.js**, not raw WebGPU. Every
current desktop and mobile browser supports WebGL 2. Playwright runs it under SwiftShader, and
the renderer compares one GPU texel with the CPU FFT on each new sea (half-float devices skip
the readback). The renderer is isolated behind `src/render/api.ts`, so a WebGPU backend can be
added later without touching the rest of the app.

**Deviation from §3.3:** vessels do not read the GPU surface back. They sample a CPU evaluation
of _the same_ spectral components (`src/ocean/oceanField.ts`) in the simulation worker. This
keeps the physics deterministic, testable in Node, and free of GPU read-back latency.

## 1. Vision

Wave Laboratory is an interactive "ocean lab." A user can:

1. **Build a sea state**: pick a calm lake, a North Sea storm, a long Pacific swell, a tsunami running up a beach, or a single focused rogue wave, then adjust every parameter that matters.
2. **Shape the world**: water depth, seabed bathymetry, currents, wind, breakwaters, wave-tank walls and wavemakers.
3. **Deploy vessels**: from a kayak to a container ship, each with real mass properties, hull geometry, propulsion and steering.
4. **Observe and measure**: watch heave, pitch, roll, slamming, green water and capsize in HD, and record the numbers with virtual instruments (wave gauges, buoys, motion sensors).
5. **Save, share and repeat**: every experiment is a deterministic, versioned file that can be replayed, shared by link, or run headless in parameter sweeps.

### Guiding principles

| Principle                 | What it means in practice                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scientifically sound**  | Each model rests on published theory, has a stated validity range, and is checked against analytic or published benchmark results in CI. The UI warns when the user leaves a model's validity range. |
| **High speed**            | 60 fps minimum and a 120 fps target at 1440p on a mid-range GPU. Physics runs at a fixed timestep, decoupled from rendering.                                                                         |
| **High definition**       | Physically based water shading, multi-scale wave detail from 1 cm ripples up to 1 km swells, foam, spray and underwater views.                                                                       |
| **Honest about fidelity** | Two run modes: **Real-time** (GPU, float32, interactive) and **Reference** (CPU, float64, can run slower than real time and is used for validation and exports).                                     |
| **Customizable**          | Every parameter can be edited in the UI and through a scripting API. Nothing important is hard-coded.                                                                                                |

---

## 2. Platform & technology decision

### Recommendation: TypeScript + WebGPU, running in the browser (desktop wrapper optional later)

| Option                                 | Pros                                                                                               | Cons                                                                                              | Verdict                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **TypeScript + WebGPU (WGSL compute)** | Zero-install sharing by URL; compute shaders for FFT and PDE solvers; fast iteration; one codebase | WebGPU still maturing on some browsers/OSes; float32 only on GPU                                  | ✅ **Chosen**                                                                                       |
| Rust + wgpu (native + WASM)            | Excellent performance, float64 on CPU, same WGSL shaders                                           | Slower UI iteration; heavier toolchain                                                            | Keep as an **escape hatch**: hot CPU kernels can move to Rust→WASM later behind the same interfaces |
| Unreal / Unity                         | Good-looking renderers out of the box                                                              | Little control over the numerics, hard to validate, licensing, heavy downloads, poor shareability | ❌                                                                                                  |

### Stack

- **Language:** TypeScript (strict), WGSL for GPU kernels.
- **Build:** Vite, pnpm workspaces (monorepo), Vitest for unit tests, Playwright for browser/GPU smoke tests.
- **GPU:** raw WebGPU behind a thin in-house abstraction. We considered Three.js's WebGPURenderer, but the ocean pipeline needs close control over compute passes, so we own the renderer. A small scene graph covers ships and props.
- **UI:** React + a docked panel system, Zustand for the app store, Zod for experiment-schema validation.
- **Plots:** uPlot for live time series and spectra (fast, canvas-based).
- **Workers:** Web Workers for the CPU physics (vessel dynamics, Reference mode) so the main thread stays responsive.
- **Optional later:** Tauri desktop wrapper (native file access, bigger GPU budgets) and Rust→WASM SIMD kernels.

---

## 3. System architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                           apps/lab  (UI)                             │
│  Experiment editor · Ship dock · Instruments · Timeline · Scripting  │
└───────────────┬──────────────────────────────────────┬───────────────┘
                │ Experiment (JSON, Zod schema)         │ commands/events
┌───────────────▼──────────────────────────────────────▼───────────────┐
│                     packages/core — Simulation kernel                 │
│  Fixed-step clock · deterministic RNG · units · event bus · snapshot  │
├──────────────┬───────────────┬────────────────┬───────────────────────┤
│ packages/    │ packages/     │ packages/      │ packages/             │
│ ocean        │ shallow       │ vessel         │ instruments           │
│ spectra, FFT │ SWE /         │ 6-DOF rigid    │ gauges, buoys, IMU,   │
│ cascades,    │ Boussinesq    │ body, hull     │ spectral analysis,    │
│ analytic     │ solvers,      │ forces,        │ statistics, export    │
│ waves        │ wavemakers,   │ propulsion,    │                       │
│              │ absorbers     │ control        │                       │
├──────────────┴───────┬───────┴────────────────┴───────────────────────┤
│        OceanField interface (the single coupling point)               │
│   sample(x, y, t) → η, ∇η, orbital velocity u(z), pressure p(z)       │
├───────────────────────┴───────────────────────────────────────────────┤
│                 packages/render — WebGPU renderer                     │
│  Ocean LOD mesh · PBR water · sky · foam · spray · underwater · viz   │
└───────────────────────────────────────────────────────────────────────┘
          tools/validation — headless benchmark suite (Node + CI)
```

### 3.1 The `OceanField` contract

Everything that consumes the water (ships, instruments, particles, the renderer) uses one interface:

```ts
interface OceanField {
  /** Free-surface elevation η and its horizontal gradient at (x, y, t). */
  surface(x: number, y: number, t: number): { eta: number; dEtaDx: number; dEtaDy: number };
  /** Horizontal displacement (choppy waves) used to find the Lagrangian surface point. */
  displacement(x: number, y: number, t: number): Vec3;
  /** Fluid particle velocity and acceleration at depth z (z ≤ η). */
  kinematics(x: number, y: number, z: number, t: number): { u: Vec3; a: Vec3 };
  /** Total pressure at depth z (hydrostatic + dynamic), Wheeler-stretched above MWL. */
  pressure(x: number, y: number, z: number, t: number): number;
  /** Local water depth and current. */
  depth(x: number, y: number): number;
  current(x: number, y: number, z: number): Vec3;
}
```

Wave models are **composable**: a `CompositeField` sums linear components (spectral sea + swell + analytic packets) and blends in grid-solver regions (nearshore, wave tank, ship wakes) through masks. Each model ships with a **CPU float64 reference** and a **GPU float32 implementation**, and tests check that the two agree within tolerance.

### 3.2 Timing & determinism

- Physics runs at a fixed `dt` (default 1/120 s; vessels substep at 1/480 s when stiff). The renderer interpolates between physics states.
- All randomness (spectral phases, spray) comes from a seeded PCG RNG stored in the experiment file, so the same file gives the same result in Reference mode.
- Snapshots of the full state every N seconds support rewind, scrubbing and branching ("what if I'd turned 20° earlier?").

### 3.3 GPU ↔ CPU coupling for ships (the hard problem)

The ocean surface lives on the GPU, but rigid-body dynamics needs stable, low-latency forces. The plan:

1. **Real-time mode:** each frame, a compute pass gathers a local displacement/velocity patch (e.g. 64×64 texels) around every vessel into a small buffer, which is read back asynchronously (1–2 frames of latency). The vessel worker interpolates in space and **extrapolates in time** using the known per-component phase speeds. The latency error is bounded, and a test measures it against Reference mode.
2. **Reference mode:** the CPU evaluates the field directly (spectral summation in float64 over the same components, or the CPU grid solver). It is slower, but exact with respect to the model.
3. **Future option:** move hull pressure integration onto the GPU (one triangle per thread with a parallel reduction), so that only 6 force/moment numbers per vessel are read back.

### 3.4 Monorepo layout

```
wave-laboratory/
├─ apps/
│  └─ lab/                 # the sandbox web app
├─ packages/
│  ├─ core/                # clock, RNG, units, math (Vec3, Quat, Mat3), events, snapshots
│  ├─ schema/              # Zod experiment schema + migrations
│  ├─ ocean/               # spectra, FFT cascades, analytic waves, OceanField impls
│  ├─ shallow/             # SWE & Boussinesq solvers, wavemakers, absorbing layers
│  ├─ vessel/              # rigid body, hull processing, force models, propulsion, control
│  ├─ instruments/         # probes, analysis (Welch PSD, zero-crossing stats, RAO)
│  ├─ render/              # WebGPU renderer, materials, LOD, post-processing
│  └─ gpu/                 # WebGPU device mgmt, buffer/texture pools, shader modules, FFT kernels
├─ assets/
│  ├─ hulls/               # benchmark & demo hull meshes + mass-property JSON
│  └─ presets/             # sea-state & experiment presets
├─ tools/
│  └─ validation/          # headless benchmark runner → markdown/HTML report
└─ docs/                   # theory notes, model validity, user guide
```

---

## 4. Physics: ocean wave models

Notation: g = 9.81 m/s², ρ = 1025 kg/m³ (seawater; editable for freshwater/other fluids), h = depth, k = wavenumber, ω = angular frequency.

### 4.1 Dispersion relation (shared by every linear model)

ω² = (g·k + (σ/ρ)·k³) · tanh(k·h)

This gravity–capillary relation with finite depth covers deep water (tanh → 1), shallow water (ω → k√(gh)) and capillary ripples (σ = 0.074 N/m). Ambient currents add a Doppler shift: ω_abs = ω + **k**·**U**.

### 4.2 Spectral random sea (the workhorse)

- **Method:** Tessendorf-style FFT synthesis on the GPU, using **3–4 cascades** (e.g. patch sizes of 1000 m, 250 m, 40 m and 6 m at 256² or 512² each) with non-overlapping wavenumber bands. This resolves ~1 km swells down to ~2 cm ripples without visible tiling.
- **Spectra (selectable, combinable):**
  - **JONSWAP**: S(ω) = α g² ω⁻⁵ exp(−5/4 (ω_p/ω)⁴) · γ^r, with r = exp(−(ω−ω_p)²/(2σ²ω_p²)), σ = 0.07 / 0.09. Users can set it either from (H_s, T_p, γ) or from (wind speed U₁₀, fetch F), using α = 0.076 (U²/Fg)^0.22 and ω_p = 22 (g²/UF)^(1/3).
  - **Pierson–Moskowitz** (fully developed sea).
  - **TMA** (JONSWAP × Kitaigorodskii depth factor) for finite depth.
  - **Bretschneider / ITTC two-parameter**, for comparison with naval-architecture literature.
  - **Ochi–Hubble** six-parameter (bimodal: wind sea + swell).
  - **Phillips**: for comparison with legacy graphics references only, and labeled that way.
- **Directional spreading:** cos²ˢ (Mitsuyasu, s depending on frequency), Donelan–Banner sech², and Hasselmann; plus a swell-only narrow-band option.
- **Amplitude synthesis:** ĥ₀(**k**) = (ξ_r + iξ_i)·√(S(**k**) Δk_x Δk_y / 2), with the correct Jacobian for converting S(ω,θ) to S(**k**). Using a Gaussian amplitude (not a fixed one) keeps realistic wave-group statistics, and a deterministic seed makes it repeatable.
- **Choppy (horizontal) displacement:** **D**(**x**) = −λ Σ i(**k**/k) ĥ(**k**,t) e^{i**k**·**x**}. λ = 1 matches first-order Lagrangian (Gerstner-type) kinematics. The UI exposes λ, but marks values other than 1 as "artistic."
- **Breaking / folding:** Jacobian J = (1+∂D_x/∂x)(1+∂D_y/∂y) − (∂D_x/∂y)(∂D_y/∂x). Where J < threshold, foam is generated and the crest is marked as breaking. A steepness-based dissipation term caps unphysical crests.
- **Diagnostics we check:** H_s = 4√m₀ from the synthesized field matches the requested H_s; the Welch PSD of a virtual gauge matches S(ω); crest/height distributions follow Rayleigh in the linear regime.

### 4.3 Deterministic & nonlinear wave components

These can be layered on top of, or used instead of, the random sea:

| Model                                      | Use                                            | Notes                                                                      |
| ------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Linear Airy wave                           | Teaching, RAO tests                            | Exact linear kinematics                                                    |
| Stokes 2nd/3rd/5th order                   | Steep regular waves                            | Fenton's 5th-order coefficients; warn when Ursell number Ur = HL²/h³ > ~26 |
| Gerstner (trochoidal)                      | Visual comparison                              | Labeled as rotational, not a physical ocean solution                       |
| Cnoidal waves                              | Shallow, long, nonlinear                       | Jacobi elliptic functions; valid for high Ursell number                    |
| Solitary wave                              | Tsunami/run-up demos                           | Boussinesq/KdV profile                                                     |
| **Focused wave group (NewWave)**           | Controlled rogue/extreme waves                 | Phases focused at (x_f, t_f); set crest height                             |
| **Peregrine breather**                     | Nonlinear rogue-wave demo                      | From the NLS equation, deep water                                          |
| Wave packets / groups                      | Group velocity demos                           | Shows c_g = c/2 in deep water and c_g → c in shallow water                 |
| **Second-order bound waves** (Sharma–Dean) | Realistic crest asymmetry for the spectral sea | Optional; adds set-down under groups                                       |

Validity guards: Miche breaking limit H/L ≤ 0.142·tanh(kh), depth-limited breaking H/h ≈ 0.78. When the user exceeds these, the lab clips the wave, flags it, or (when the grid solver is active) hands off to that solver.

### 4.4 Nearshore & wave-tank solvers (grid PDEs on GPU)

These are for problems where linear superposition breaks down: shoaling, refraction over bathymetry, breaking on beaches, run-up, harbor resonance, tsunamis and wave tanks.

- **Tier A — Nonlinear Shallow Water Equations (SWE):** a finite-volume, well-balanced, positivity-preserving **Kurganov–Petrova central-upwind** scheme with wet/dry fronts and Manning bottom friction. Time stepping is SSP-RK2/3 with an adaptive CFL limit: Δt ≤ C·Δx / max(|u| + √(gh)). Good for tsunamis, dam breaks, run-up and bores.
- **Tier B — Boussinesq-type (dispersive):** extended Boussinesq (Madsen–Sørensen or Nwogu) with a breaking eddy-viscosity model. Needed for intermediate-depth dispersion such as wave trains over a shoal, or harbor waves. Uses an implicit tridiagonal/Jacobi solve on the GPU.
- **Wavemakers:** piston and flap paddles driven through Biesel transfer functions, e.g. piston H/S = 2(cosh 2kh − 1)/(sinh 2kh + 2kh). They can replay any spectrum, so you get a true **numerical wave flume or basin**.
- **Boundaries:** absorbing sponge layers / PML, reflective walls, periodic boundaries, and internal source-function wave generation.
- **Coupling:** the grid region is embedded in the spectral far field. Incoming spectral waves are injected at the region's boundary, and the edges are cross-faded using a relaxation zone.
- **Structures:** breakwaters, piers, sea walls and islands as bathymetry or obstacle masks. Bathymetry can be painted, procedurally generated (slopes, bars, reefs, canyons) or imported (GeoTIFF/heightmap; GEBCO-derived samples as presets).

### 4.5 Wind, current and other environment

- Wind (U₁₀, direction, gustiness) drives the spectrum parameters and visuals (spray, whitecap fraction ≈ Monahan's 3.84×10⁻⁶ U₁₀^3.41), and adds windage force on vessel superstructure.
- Uniform or spatially varying currents (Doppler shift, wave–current interaction in the grid solvers, and drift force on vessels).
- Water properties: density, viscosity, surface tension (fresh vs salt, temperature). Default seawater is 1025 kg/m³.

---

## 5. Physics: vessel dynamics

### 5.1 Rigid-body core

- Full **6-DOF** Newton–Euler in the body frame, with quaternion orientation.
- Equation of motion, using Cummins' formulation when radiation memory is enabled:

  (M + A_∞)·ẍ(t) + ∫₀ᵗ K(t−τ)·ẋ(τ) dτ + C·x(t) = F_FK+hs(t) + F_diff(t) + F_visc + F_prop + F_rudder + F_wind + F_moor

  In the default **time-domain nonlinear mode**, hydrostatics and Froude–Krylov forces come from pressure integration over the instantaneous wetted hull (not linearized C·x), so large-angle behavior such as capsize and parametric roll emerges naturally.

- Integrator: semi-implicit (symplectic Euler) with substeps by default; RK4 in Reference mode. Added mass is included implicitly to avoid the well-known instability of explicit added-mass coupling.

### 5.2 Hull representation & force pipeline

1. **Hull input:** a watertight triangle mesh (glTF/OBJ/STL), or the **parametric hull generator** (Wigley, Series 60, box barge, catamaran/trimaran, planing V-hull). Mass properties come from a loading condition: displacement, KG, radii of gyration, and tank fill levels.
2. **Preprocessing:** check watertightness, compute volume/centroid, build the hydrostatic tables (GZ curve, KM, waterplane area), decimate to a physics LOD (~2–10k triangles), and keep the render mesh separate.
3. **Per-substep force integration** (CPU worker, SIMD-friendly structure-of-arrays):
   - Sample η at triangle vertices from the `OceanField`.
   - **Clip triangles at the instantaneous waterline** (the Kerner method).
   - Integrate pressure over the submerged area: **F** = −∫ p **n** dA, **M** = −∫ p (**r** × **n**) dA, where p is hydrostatic plus Froude–Krylov dynamic pressure (with depth attenuation cosh k(z+h)/cosh kh and Wheeler stretching).
   - **Viscous & drag:** ITTC-57 friction (C_f = 0.075/(log₁₀Re − 2)²) on the wetted area using the relative velocity; pressure drag and lift on flat-ish panels (a velocity-squared model with tunable coefficients).
   - **Slamming:** momentum-based water-entry impulse (a von Kármán/Wagner-type estimate) on panels with high relative normal velocity. These events are logged.
   - **Roll damping:** the Ikeda empirical components (friction, eddy, lift, wave, bilge keel), because potential theory alone badly under-predicts roll damping.
4. **Radiation & diffraction (fidelity levels):**
   - _L0:_ constant added mass plus linear damping estimated from strip theory (fast, robust; the default).
   - _L1:_ strip-theory frequency-dependent coefficients (Frank close-fit or Lewis forms), converted to a retardation kernel K(t) for the Cummins convolution, with a state-space approximation for speed.
   - _L2 (import):_ coefficients from external BEM codes (e.g. Capytaine / NEMOH / WAMIT output files) for users who want naval-architecture-grade inputs.

### 5.3 Propulsion, steering & control

- **Propeller:** Wageningen B-series open-water K_T/K_Q polynomials, with wake fraction and thrust deduction; engine torque/RPM limits; ventilation/emergence loss when the propeller leaves the water in heavy pitch.
- **Rudder:** lift/drag from aspect ratio and inflow (including propeller slipstream), with a stall angle.
- **Thrusters / waterjets / sails** as later add-ons.
- **Maneuvering:** optional MMG-style hull maneuvering coefficients for calm-water turning, combined with the seakeeping forces above (a unified approach).
- **Control:** manual (keyboard/gamepad telegraph and wheel), a PID heading autopilot with rudder rate limits, waypoint following, and speed hold. Scripts can control vessels too.

### 5.4 Extras

- **Mooring & towing:** quasi-static catenary lines, and lumped-mass lines later; fenders.
- **Multiple vessels:** contact between hulls using a convex decomposition (soft contact). Hydrodynamic interaction between hulls is out of scope for v1.
- **Floating debris & buoys:** a cheap spherical/box buoyancy model for hundreds of objects.
- **Free-surface (sloshing) tanks:** a GM-reduction model in v1, and a small internal SWE grid per tank later.
- **Ship-generated waves:** a Kelvin wake pattern (19.47° cusp angle) from a moving pressure source in linear mode; inside grid regions, the hull pushes water directly as a moving pressure disturbance.
- **Green water on deck & capsize detection:** deck-edge immersion, GZ < 0 under heel, events and alarms.

### 5.5 Built-in ship library (initial)

| Vessel                        | Why                                                  |
| ----------------------------- | ---------------------------------------------------- |
| Box barge                     | Analytic hydrostatics; the first validation target   |
| Wigley hull                   | Classic benchmark with published RAOs (Journée 1992) |
| KCS (KRISO Container Ship)    | Modern open benchmark (SIMMAN/Tokyo workshops)       |
| DTMB 5415 (destroyer)         | Open benchmark, roll/maneuvering data                |
| Fishing trawler               | Parametric roll / stability demo                     |
| Sailing yacht                 | Heel, windage, keel lift                             |
| RIB / planing boat            | High-speed slamming demo                             |
| Lifeboat / small craft        | Survival-conditions demo                             |
| Floating wind platform (spar) | Offshore engineering demo with mooring               |

---

## 6. Rendering (high definition)

### 6.1 Geometry

- **GPU clipmap / CDLOD** ocean mesh centered on the camera, with geometric morphing between LOD rings and the horizon extended to infinity. A projected-grid fallback is kept for low-end GPUs.
- Displacement comes from the FFT cascades plus the analytic components, and the grid-solver regions are blended in through masks.
- Mesh density adapts per frame to keep within the frame budget.

### 6.2 Water shading

- Fresnel (Schlick, with an exact-dielectric option), with roughness from the sub-pixel wave slope variance of the unresolved cascades (LEAN/LEADR-style filtering) so distant water does not alias.
- Subsurface scattering approximation for light passing through thin crests; depth-based absorption/scattering (Beer–Lambert with water-type presets such as Jerlov I–III).
- Reflections: sky environment map, plus screen-space reflections and planar/probe reflections for ships.
- Refraction with depth-aware absorption, visible seabed in shallow water, and caustics (projected or ray-marched).
- Physically based sky and atmosphere (Hosek–Wilkie or a Bruneton-style precomputed atmosphere), sun and moon, time of day, clouds and fog.

### 6.3 Foam, spray & effects

- Foam: Jacobian/breaking-driven foam accumulated in persistent textures with decay and advection, plus whitecap coverage tied to wind speed, ship wake foam and shoreline foam.
- GPU particle systems for spray, spindrift and bow splashes, emitted from slamming events and breaking crests.
- Underwater view: absorption fog, god rays, Snell's window, bubbles; a seamless transition across the waterline.
- Post-processing: HDR pipeline, TAA, bloom, exposure, filmic/ACES tone mapping, optional upscaling.

### 6.4 Scientific visualization modes (toggle overlays)

- Color the surface by: η, slope, steepness, Jacobian, orbital velocity, dynamic pressure, energy density, or breaking flag.
- Vector glyphs (surface velocity, current), wave rays/crests, group envelopes.
- Underwater cross-section plane showing orbital motion and the pressure field.
- Hull pressure heatmap, wetted-area outline, force/moment arrows, CoG/CoB/metacenter markers, GZ curve overlay.
- Split-screen comparisons, e.g. linear vs Stokes waves, or two loading conditions side by side.

### 6.5 Cameras

Orbit, free-fly, ship follow (chase), on-deck/bridge (with the ship's motion, optional motion damping for comfort), a fixed buoy cam, underwater, and a cinematic spline camera for recordings.

---

## 7. The sandbox (UX & features)

### 7.1 Main workspace

```
┌──────────────┬───────────────────────────────────────┬──────────────┐
│ Scene tree   │                                       │ Inspector    │
│  • Ocean     │                                       │ (selected    │
│   – Wind sea │            3D viewport                │  object's    │
│   – Swell 1  │                                       │  parameters, │
│  • Bathymetry│                                       │  validity    │
│  • Ships     │                                       │  warnings)   │
│  • Gauges    │                                       │              │
├──────────────┴───────────────────────────────────────┴──────────────┤
│ Timeline ▶ ❚❚ ⏭  speed ×0.1–×10  ·  rewind/scrub  ·  bookmarks      │
├─────────────────────────────────────────────────────────────────────┤
│ Data dock: live plots (η(t), spectra, ship motions, RAOs, events)   │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.2 Experiment building blocks

- **Sea state:** add/remove wave systems (spectrum or analytic). Each has its own direction, H_s/T_p or wind/fetch, spreading and seed. There are also quick sliders for the **Beaufort scale** and **WMO sea state codes**.
- **Domain:** open ocean, wave flume (2D-ish tank), wave basin (3D tank with wavemakers on one or more sides), coastline, harbor.
- **Bathymetry:** brush tools (raise, lower, smooth, slope), primitives (shoal, bar, reef, canyon), and heightmap import.
- **Ships:** drag from the library, set position, heading, speed and loading condition; give orders or attach an autopilot or script.
- **Instruments:** wave gauge (time series), directional buoy, current meter, ship IMU (6-DOF accelerations at any point on board), pressure taps on the hull, and a "camera probe" for recordings.
- **Events:** schedule changes over time (e.g. "wind rises from 10 to 25 m/s over 10 minutes", "release a focused wave at t = 120 s at x = 0").

### 7.3 Built-in presets (each with a short explanation card)

1. Calm harbor & ripples (capillary regime)
2. Beaufort 0 → 12 progression
3. North Sea winter storm (JONSWAP, H_s ≈ 8 m)
4. Southern Ocean long swell + local wind sea (bimodal)
5. **Draupner wave (1 Jan 1995)**: a focused-group reconstruction with H_max ≈ 25.6 m in H_s ≈ 12 m
6. Parametric roll of a container ship in head seas
7. Broaching of a small craft in following seas
8. Tsunami approaching a sloping beach (solitary wave + SWE run-up)
9. Wave refraction over a submerged shoal (the Berkhoff experiment, a classic benchmark)
10. Harbor seiche / resonance
11. Kelvin wake demo across Froude numbers
12. Wave tank: regular-wave RAO test of the Wigley hull

### 7.4 Measurement & analysis tools

- Live **Welch PSD**, zero-crossing analysis (H_s, H_max, T_z, T_1/3), crest/trough distributions, and exceedance plots vs Rayleigh.
- **Vessel metrics:** heave/pitch/roll amplitudes and statistics, accelerations at the bridge and bow, **motion sickness incidence (MSI, O'Hanlon & McCauley)**, slamming count, green-water events, propeller emergence, speed loss, and maximum heel / GZ margin.
- **Automatic RAO estimation:** run a regular-wave frequency sweep (or use the cross-spectrum from irregular seas) and plot the RAO with published reference curves overlaid for benchmark hulls.
- **Export:** CSV/JSON (plus Parquet later), PNG plots, a recorded video (WebCodecs), and the full experiment file.

### 7.5 Save, share, replay

- The experiment file is versioned JSON (Zod schema plus migrations), compressed and embeddable in a URL for small experiments.
- Replays are deterministic from the seed and inputs; user inputs are recorded as an event log.
- Branch from any snapshot.

### 7.6 Scripting & batch experiments

- A sandboxed JS/TS scripting API in a worker, for example:

  ```ts
  lab.ocean.add(jonswap({ hs: 6, tp: 11, gamma: 3.3, dir: 30 }));
  const ship = lab.ships.spawn('kcs', { heading: 0, speed: 8 });
  for (const heading of range(0, 180, 15)) {
    await lab.reset({ keepOcean: true });
    ship.setHeading(heading);
    await lab.run({ seconds: 600, mode: 'reference' });
    lab.report.add({ heading, rollRms: ship.stats.roll.rms });
  }
  ```

- A headless runner (Node + WebGPU via Dawn, or a CPU-only Reference mode) for parameter sweeps in CI or on a workstation.

---

## 8. Scientific validation plan

The checks that exist today live next to the code (`src/**/*.test.ts` and
`src/**/*.validation.ts`) and run locally with `pnpm test` and `pnpm validate`. They are not
started by GitHub. The table below is the target suite; not every row has an automated test
yet, and there is no generated validation report.

| #   | Test                                                                        | Reference                  | Pass criterion (initial)                    |
| --- | --------------------------------------------------------------------------- | -------------------------- | ------------------------------------------- |
| V1  | Dispersion relation: phase speed of single waves, deep/intermediate/shallow | Analytic                   | < 0.5 % error                               |
| V2  | Spectrum reproduction: H_s, T_p and PSD shape from virtual gauges           | Input spectrum             | H_s within 3 %; PSD within 95 % CI          |
| V3  | Wave statistics: crest/height distributions (linear sea)                    | Rayleigh                   | KS test p > 0.05                            |
| V4  | Stokes 5th-order profile                                                    | Fenton (1985)              | < 1 % of H                                  |
| V5  | Dam break (SWE)                                                             | Ritter analytic solution   | L1 error convergence order ≥ 1              |
| V6  | Solitary-wave run-up on a plane beach                                       | Synolakis (1987)           | Run-up within 5 %                           |
| V7  | Shoal refraction/diffraction (Boussinesq)                                   | Berkhoff et al. (1982)     | Matches the transect data                   |
| V8  | Wavemaker transfer function                                                 | Biesel analytic            | < 2 %                                       |
| V9  | Box barge hydrostatics: draft, GM, GZ curve                                 | Analytic                   | < 0.5 %                                     |
| V10 | Free heave/roll decay periods                                               | Analytic (with added mass) | < 3 %                                       |
| V11 | Wigley hull heave/pitch RAOs                                                | Journée (1992) experiments | Within experimental scatter for L1 fidelity |
| V12 | KCS calm-water resistance trend & motions                                   | SIMMAN / Tokyo 2015 data   | Trend agreement; documented deviations      |
| V13 | Kelvin wake angle                                                           | 19.47°                     | ±0.5°                                       |
| V14 | Energy conservation (inviscid, periodic domain)                             | —                          | Drift < 0.1 % per 1000 periods              |
| V15 | GPU vs CPU reference agreement                                              | Reference mode             | Max relative error < 1e-3 (float32 bound)   |
| V16 | Real-time readback latency error on ship motions                            | Reference mode             | < 2 % RMS difference                        |

Each model also gets a **"Theory & limits" doc page** covering equations, assumptions, validity range and references. The inspector links to these pages and shows a live validity indicator (e.g. a warning that the Ursell number is 40, so linear theory is unreliable and the user should switch to cnoidal waves or the Boussinesq solver).

---

## 9. Performance budget

Target hardware: RTX 3060 / Apple M2 Pro class at 1440p, 60 fps minimum, 120 fps goal. Laptop iGPU target: 1080p, 30–60 fps with reduced cascades.

| Stage                                                   | Budget (ms/frame)     |
| ------------------------------------------------------- | --------------------- |
| Spectral FFT (4 cascades × 256², 7 fields each)         | 0.8                   |
| Grid solver region (512², 2 substeps)                   | 1.5                   |
| Foam/derivatives/mip generation                         | 0.4                   |
| Ocean geometry + shading                                | 3.0                   |
| Ships, sky, particles, post-processing                  | 3.5                   |
| **GPU total**                                           | **≈ 9.2 (≈ 108 fps)** |
| Vessel physics, 4 ships × 5k tris × 4 substeps (worker) | 2.0 (off main thread) |
| UI + plots (main thread)                                | ≤ 2.0                 |

Quality presets (Low/Medium/High/Ultra/Reference) scale cascade resolution, mesh density, grid size and effects. A built-in **performance HUD** shows per-pass GPU timings using timestamp queries.

---

## 10. Phased roadmap

Durations assume roughly 1–2 dedicated engineers; they should be re-estimated after Phase 1. Each phase ends with a **demo build and exit criteria**.

### Phase 0: Foundations (≈ 2 weeks)

- Monorepo, TypeScript strict mode, lint/format, Vitest, Playwright, GitHub Actions CI, deploy previews (e.g. GitHub Pages / Cloudflare Pages).
- WebGPU device bootstrap with feature detection and a friendly unsupported-browser page.
- Core: math library, units, fixed-step clock, PCG RNG, event bus, Zod experiment schema v0.
- An empty 3D viewport with camera controls and a performance HUD.
- **Exit:** CI green, an empty scene at 144 fps, and the schema round-trips.

### Phase 1: Deep-water spectral ocean (≈ 4 weeks)

- CPU float64 reference implementation of spectra, dispersion and direct summation.
- GPU FFT (Stockham radix-4/8 in WGSL), multi-cascade synthesis, choppy displacement, normals, Jacobian.
- JONSWAP, PM, TMA, spreading functions; the wind/fetch parameterization.
- Basic water shading (Fresnel, sky reflection, absorption) and clipmap geometry.
- Wave gauge instrument plus a live PSD plot.
- **Exit:** V1, V2, V3 and V15 pass; a North Sea preset looks convincing at 120 fps.

### Phase 2: Vessel dynamics v1 (≈ 4 weeks)

- Rigid-body 6-DOF in a worker; hull import/preprocessing; the parametric box barge and Wigley hull.
- Waterline clipping + hydrostatic + Froude–Krylov pressure integration; L0 radiation; ITTC drag; Ikeda roll damping.
- GPU→CPU local patch readback with time extrapolation.
- Ship IMU instrument, motion plots, force arrows, CoG/CoB markers.
- **Exit:** V9, V10 and V16 pass; a barge and a Wigley hull ride the waves stably at 4× speed.

### Phase 3: The sandbox v1 (≈ 4 weeks)

- Scene tree, inspector, timeline (pause/step/speed/rewind via snapshots), drag-and-drop ships.
- Save/load/share experiments; the first 6 presets; CSV export; screenshots.
- Validity indicators and the "Theory & limits" pages for the implemented models.
- **Exit:** a new user can build and share a "ship in a storm" experiment in under 5 minutes (usability test with 3–5 people).

### Phase 4: Propulsion, steering & richer vessels (≈ 3 weeks)

- Propeller, rudder, engine, autopilot, manual helm controls.
- KCS, trawler, RIB and yacht; loading-condition editor with a GZ curve.
- Slamming, green water, capsize detection; vessel metrics panel (MSI etc.).
- **Exit:** a parametric-roll preset reproduces the phenomenon; turning circles look plausible.

### Phase 5: Advanced waves (≈ 4 weeks)

- Stokes 2nd–5th order, cnoidal, solitary, focused groups (NewWave), Peregrine breather, second-order bound waves.
- Event scheduler; the Draupner preset; an automatic RAO sweep tool.
- **Exit:** V4, V11 and V13 pass; the RAO tool reproduces Wigley reference curves.

### Phase 6: Nearshore & wave tanks (≈ 6 weeks)

- GPU SWE (Kurganov–Petrova) with wet/dry fronts; bathymetry editor and import.
- Wavemakers, absorbers, flume/basin domains, coupling with the spectral far field.
- Boussinesq solver with a breaking model.
- **Exit:** V5–V8 pass; tsunami-beach, Berkhoff shoal and harbor seiche presets work.

### Phase 7: Visual excellence (≈ 4 weeks, can overlap with Phases 5–6)

- Persistent foam, spray particles, LEAN/LEADR filtering, SSR, caustics, underwater view, atmosphere and time of day, TAA and quality presets.
- Kelvin wakes, bow waves, hull–water interaction effects.
- **Exit:** a side-by-side review against reference footage; GPU budget met on target hardware.

### Phase 8: Science tooling & scripting (≈ 3 weeks)

- Scripting API, headless batch runner, Reference mode end to end, auto-generated validation report, L1 strip-theory radiation with Cummins convolution, BEM coefficient import.
- **Exit:** a heading sweep script runs headless and produces a polar plot report; V12 is documented.

### Phase 9: Hardening & release (≈ 3 weeks)

- Performance profiling across GPUs/browsers, accessibility (keyboard navigation, color-blind-safe overlays), onboarding tutorial, user guide, example gallery.
- **Exit:** v1.0 release with a published validation report.

**Rough total: ~9–10 months** for a small team to reach a polished v1.0. A compelling public demo (Phases 0–3) is about **3 months** away.

---

## 11. Engineering practices

- **Every physical model has three deliverables:** a CPU reference implementation, a GPU implementation (when needed for speed), and a validation test plus a theory doc page.
- Units are SI everywhere internally; the UI can display knots, feet, °, Beaufort, etc. Branded number types (`Meters`, `Seconds`, …) in TypeScript catch unit mix-ups.
- Coordinate convention: right-handed, z-up world (x east, y north), with ship body axes following the ITTC/SNAME convention (x forward, y port, z up). One `frames.ts` module owns all transforms.
- WGSL shaders are unit-tested by running compute kernels in headless WebGPU (Dawn/Node) in CI.
- Performance regression tests: CI records GPU timings on a fixed reference scene and fails on more than 10 % regression (self-hosted GPU runner later).
- Golden-image tests for the renderer (tolerant diff) and golden-number tests for physics.
- Docs live next to the code; a docs site is built from `docs/` (e.g. VitePress).

---

## 12. Risks & mitigations

| Risk                                                | Impact                     | Mitigation                                                                                                                                                                               |
| --------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebGPU support gaps (Linux/Firefox/Safari versions) | Users can't run it         | Feature detection, a reduced-quality path, the Tauri desktop wrapper as a fallback, and a clear support matrix                                                                           |
| GPU→CPU latency destabilizes ships                  | Jittery or unstable motion | Time extrapolation, implicit added mass, substepping, Reference-mode comparison test V16, and the option to move force integration to the GPU                                            |
| float32 precision far from the origin               | Jitter over large domains  | Camera-relative rendering, floating origin, and periodic phase wrapping (mod 2π) for spectral time                                                                                       |
| Scope creep (CFD-level expectations)                | Never ships                | Clear fidelity statements; explicitly out of scope: full Navier–Stokes/VOF, wave–wave nonlinear energy transfer (WAM-style), ice, hull flexing. SPH/VOF is a possible "v2 research" item |
| Radiation/diffraction modeling is complex           | Inaccurate motions         | Ship L0 early; validate against Wigley; allow imported BEM coefficients for experts                                                                                                      |
| Breaking waves are hard to simulate physically      | Unrealistic crests         | Parameterized breaking (Jacobian/steepness criteria + dissipation) in spectral mode; physically based breaking only in the grid solvers                                                  |
| Performance on laptops                              | Poor experience            | Quality presets, dynamic resolution, lower cascade counts                                                                                                                                |

---

## 13. Out of scope for v1 (candidate v2 items)

- Full 3D Navier–Stokes / VOF / SPH for plunging breakers and detailed green water.
- Spectral wave evolution models (WAM/SWAN-style wind input and whitecapping source terms).
- Hydroelastic hulls (whipping/springing).
- Multiplayer / co-op shared labs.
- VR headset support (WebXR); this would be a cheap add-on once the renderer is stable.
- Real-world data ingestion (live NOAA/Copernicus buoy spectra to recreate today's sea state). This is high value and a strong v1.1 candidate.

---

## 14. Key references

- Tessendorf, J. (2001). _Simulating Ocean Water._ SIGGRAPH course notes.
- Hasselmann, K. et al. (1973). JONSWAP. _Dtsch. Hydrogr. Z._
- Holthuijsen, L. (2007). _Waves in Oceanic and Coastal Waters._ Cambridge.
- Dean, R. & Dalrymple, R. (1991). _Water Wave Mechanics for Engineers and Scientists._
- Fenton, J. (1985). A fifth-order Stokes theory for steady waves. _J. Waterway, Port, Coastal, Ocean Eng._
- Kurganov, A. & Petrova, G. (2007). A second-order well-balanced positivity preserving central-upwind scheme for the Saint-Venant system.
- Madsen, P. & Sørensen, O. (1992). A new form of the Boussinesq equations with improved linear dispersion characteristics.
- Faltinsen, O. (1990). _Sea Loads on Ships and Offshore Structures._ Cambridge.
- Journée, J. (1992). Experiments and calculations on four Wigley hull forms. TU Delft Report 909.
- Cummins, W. (1962). The impulse response function and ship motions.
- Ikeda, Y. et al. (1978). Prediction of ship roll damping.
- Fossen, T. (2021). _Handbook of Marine Craft Hydrodynamics and Motion Control._ Wiley.
- Kerner, J. (2015). Water interaction model for boats in video games (Gamasutra).
- Bruneton, E. & Neyret, F. (2008). Precomputed atmospheric scattering.
- Berkhoff, J. et al. (1982). Verification computations with linear wave propagation models.
- Synolakis, C. (1987). The runup of solitary waves. _J. Fluid Mech._

---

## 15. Open questions for the team

1. **Primary audience:** education/enthusiasts, naval-architecture students, or professional engineers? This decides how far we invest in L2 radiation/diffraction and data export versus visuals and onboarding.
2. **Platform:** is browser-first acceptable, or is a native desktop build required on day one?
3. **Target hardware floor:** must it run on integrated laptop GPUs or tablets?
4. **Vessel priorities:** which ship types matter most (merchant, naval, small craft, sailing, offshore platforms)?
5. **Licensing:** open source (e.g. MPL-2.0/Apache-2.0) or closed? This affects which benchmark hull data and third-party code we can bundle.
6. **Team & timeline:** how many contributors, and is there a target date for a first public demo?

---

## 16. Immediate next steps

1. Agree on the answers to §15 (especially audience and platform).
2. Scaffold Phase 0: monorepo, CI, WebGPU bootstrap, core math/clock/RNG, schema v0.
3. Write the CPU reference spectral ocean and tests V1–V3 **before** writing any GPU code, so the GPU path has an oracle from day one.
4. Prototype the GPU FFT and benchmark cascade configurations on target hardware.
5. Spike (time-boxed to 3 days) the GPU→CPU patch readback and measure the ship-stability impact. This is the riskiest architectural assumption.
