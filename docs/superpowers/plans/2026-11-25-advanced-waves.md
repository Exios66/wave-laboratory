# Advanced regular waves: Stokes 5, cnoidal, solitary (Phase 5, part 1)

Goal: add nonlinear steady waves to the deterministic wave systems (PLAN §4.3, validation V4):
Stokes fifth-order (Fenton 1985), cnoidal (KdV, Jacobi cn²) and solitary (Boussinesq sech²).
CPU physics (worker) and GPU drawing agree; vessels feel them through the same field.

## Design

- `regular` wave systems gain `theory: 'airy' | 'stokes2' | 'stokes5' | 'cnoidal'`, default
  `'stokes2'`, which is exactly today's behaviour (Airy plus the second-order term, gated by
  choppiness). Every saved experiment and share link parses unchanged.
- New `kind: 'solitary'` (height H, spacing between humps, direction, phase).
- `src/ocean/elliptic.ts`: K, E, Jacobi sn/cn/dn by the AGM / descending Landen method.
- `src/ocean/nonlinear.ts`: parameter solvers and profiles.
  - Stokes 5: Fenton's Y (surface) coefficients and C0/C2/C4 speed coefficients, transcribed from
    the published STOKES program (johndfenton.com/Steady-waves, Stokes.zip), which implements the
    1985 paper. k is solved from T, H, h (ω = k c). Stokes' first definition of wave speed: zero
    mean Eulerian current, so no return flow and a net forward mass transport.
  - Cnoidal: Wiegel/Svendsen first-order KdV; m solved from H, T, h; profile as a Fourier series of
    η = η_t + H cn²(2K ξ/L | m) (mean level zero) with 24 harmonics, truncation error reported.
  - Solitary: η = H sech²(κ ξ), κ = sqrt(3H / (4 h² (h+H))), c = sqrt(g (h+H)); humps repeat every
    `spacing` metres (analytic nearest-image evaluation, so no Fourier truncation).
  - All harmonic waves use the per-harmonic linear kinematics: harmonic n has wavenumber nk,
    frequency nω, horizontal/vertical orbital ratio coth(nkh).
- Limits: Miche H/L ≤ 0.142 tanh(kh) for Stokes 5 (height clamped, notice); H/h ≤ 0.78 for cnoidal
  and solitary (clamped, notice); Stokes–Ursell and Ursell notes in diagnostics.
- `ResolvedSea.nonlinear` holds these; `OceanField` sums them in surface/fluid/column.
- GPU: a separate `nonlinearSample` section next to `regularSample` (MAX_NONLINEAR = 4 waves,
  24 harmonics each), a CPU mirror of the GLSL in `src/render/ocean/nonlinearMirror.ts` is tested
  against the CPU field.

## Files

elliptic.ts(+test), nonlinear.ts(+test, +V4 reference test with a numerical stream-function
solver in `src/test/fentonReference.ts`), systems.ts, oceanField.ts(+test), schema/experiment.ts
(+test), schema/presets.ts, gpuData.ts, GpuOcean.ts, shaders.ts, nonlinearMirror.ts(+test),
sim/diagnostics.ts, ui Inspector/factories/ScenePanel, docs.

## Tasks

- [ ] Elliptic functions with tests against known values
- [ ] Stokes 5 solver; V4 test against an independent numerical Fourier solution and Fenton's tables
- [ ] Cnoidal solver and Fourier profile; compare with the numerical solution (long waves)
- [ ] Solitary profile; compare with the numerical solution at small H/h
- [ ] Schema (backward compatible), systems resolution, clamps and notices
- [ ] OceanField integration; vessel in Stokes-5 sea stays finite and stable
- [ ] GPU uniforms, shader, CPU mirror test
- [ ] Presets, UI controls, diagnostics, docs
- [ ] `pnpm run check`, e2e

## Validation

V4: Stokes-5 profile within 1 % of H of the numerical Fourier solution and of Fenton's published
cases. Mirror: CPU field and GLSL mirror agree on elevation and horizontal displacement.

## Later (out of scope)

Second-order bound waves for spectra (Sharma-Dean), Peregrine breather, event scheduler, RAO sweep
tool, Wigley V11, Kelvin V13. Fenton (1972) higher-order solitary profile. True Stokes-5 / cnoidal
rotational kinematics (currently per-harmonic linear).
