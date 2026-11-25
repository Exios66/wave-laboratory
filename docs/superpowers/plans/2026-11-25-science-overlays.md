# Scientific surface overlays (PLAN.md 6.4)

Goal: four new surface overlays next to height / slope / foam, each physically correct for the linear
spectral sea plus the regular and focused components, each with an accessible legend.

| Mode       | Quantity                                                                                  | Unit            |
| ---------- | ----------------------------------------------------------------------------------------- | --------------- |
| `jacobian` | Jacobian J of the horizontal displacement map; J below a threshold is flagged as breaking | -               |
| `velocity` | surface orbital speed sqrt(u_h^2 + w^2) =                                                 | d(Dx,Dy,eta)/dt |     | m/s |
| `pressure` | dynamic pressure rho g eta cosh(k(z+h))/cosh(kh) at a chosen depth (default 0 m)          | kPa             |
| `energy`   | instantaneous potential energy density 1/2 rho g eta^2 (not a local mean)                 | J/m2            |

## Design

- Jacobian: the fragment shader already has `jacobian = (1+dDx/dx)(1+dDy/dy)` (spectral slopes + regular
  waves). The overlay shows J on a diverging ramp (stretching to folding) and hatches J < 0.3 (flag).
  Geometric folding is J < 0; 0.3 is where the foam model starts injecting, so it is the "breaking onset".
- Velocity and pressure-at-depth are not in the cascade textures (displacement and slope only). Per live
  cascade, only while one of the two overlays is on, two more spectrum fields are inverse-FFT'd:
  `(Vx + i Vy)` with V = d/dt of the unit-choppiness displacement (i k_hat coth(kh) d(h)/dt), and
  `(w + i eta_att)` with w = d(h)/dt and eta_att the spectrum times cosh(k(h-d))/cosh(kh). The result is
  one RGBA texture per cascade (ux, uy, w, eta_att) with mips. d(h)/dt = -i w e1 + i w e2.
  GPU cost while on: 2 extra spectrum blits + 2 inverse FFTs (2 log2 N + 2 passes each) + 1 combine per
  live cascade per refresh. Zero cost when off.
- The textures are sampled in the VERTEX shader (vertex units are free; the fragment stage is at the
  16-sampler limit) and passed as varyings; regular and focused components are summed analytically there in
  a new function next to `seaDisplacement` (regularSample is untouched).
- Ranges scale with Hs (shared TS helper `src/ocean/overlays.ts`, used by renderer and legend).
- Depth is UI state (`overlayDepth`, not saved in experiments), default 0 m.

## Files

`src/ocean/overlays.ts` (+test): constants, ranges, CPU mirror of the regular-wave shader maths.
`src/render/ocean/evolve.ts` (+test): `evolveVelocitySpectra` mirror of the new spectrum fields.
`src/render/ocean/shaders.ts`, `GpuOcean.ts`, `LabRenderer.ts`, `api.ts`: modes, textures, uniforms.
`src/ui/store.ts`, `Viewport.tsx`, `App.tsx`: modes, depth input, legends.
`e2e/overlays.spec.ts`: each new mode renders without console errors.
Docs: ARCHITECTURE.md, PLAN.md status table.

## Tasks (TDD)

- [x] 1. `overlays.ts`: regular-wave velocity / dynamic pressure / energy / range helpers vs `OceanField`
- [x] 2. `evolveVelocitySpectra` vs finite differences of `evolveSpectra` and vs `OceanField` rms
- [x] 3. GPU: spectrum fields 2 and 3, velocity targets, shaders, uniforms
- [x] 4. Renderer API, store, UI select, legends, depth input, `O` key cycle
- [x] 5. e2e per mode, docs, full check

## Later tasks (out of scope here)

Vector glyphs, underwater cross-section plane, hull pressure heatmap, split screen.
Local-mean (time-averaged) energy density.
