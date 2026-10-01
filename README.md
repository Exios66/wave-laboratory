# Wave Laboratory

A real-time, scientifically grounded **3D ocean-wave sandbox**. Build a sea state from
oceanographic wave spectra, drop ships into it, and measure how they handle the waves.

- **Waves:** JONSWAP, Pierson–Moskowitz and Bretschneider spectra, the TMA finite-depth
  correction, fetch-limited wind seas (Hasselmann et al. 1973) and regular Airy waves.
  Directional spreading is Mitsuyasu, cos-2s or Donelan–Banner. The dispersion relation
  includes finite depth and surface tension. The surface is synthesised from four FFT
  cascades (1 km swells down to centimetre ripples) with choppy (Lagrangian) displacement.
- **Ships:** 6-DOF rigid-body dynamics. Forces come from pressure integration over the
  instantaneous wetted hull (hydrostatics + Froude–Krylov), plus added mass, radiation and
  viscous damping, propulsion, rudder and autopilot. Slamming, green water and capsize are
  detected.
- **Instruments:** wave gauges, vessel motion recorders, Welch spectra, zero-crossing
  statistics, motion-sickness incidence and CSV export.
- **What you see is what the ships feel.** The GPU renderer and the CPU physics use exactly
  the same wave components, and a browser test checks that they agree.
- **Accessible:** keyboard operable throughout, screen-reader labelled, WCAG 2.2 AA contrast,
  light and dark themes, reduced-motion aware. Accessibility is checked automatically with axe.

## Getting started

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

Requires Node ≥ 22 and a browser with WebGL 2.

| Command                                        | What it does                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm dev`                                     | Development server with hot reload                                                    |
| `pnpm build`                                   | Type-check and build to `dist/`                                                       |
| `pnpm test`                                    | Unit tests (physics, analysis, schema, simulation)                                    |
| `pnpm validate`                                | Longer statistical physics validation suite                                           |
| `pnpm test:e2e`                                | Browser tests: rendering, GPU↔CPU consistency, accessibility (run `pnpm build` first) |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Code quality                                                                          |
| `pnpm check`                                   | Format, lint, typecheck, unit tests and build in one go                               |
| `pnpm deploy:pages`                            | Build and publish the live demo to the `gh-pages` branch                              |

## Deploying the live demo (GitHub Pages, no Actions)

The demo is a static site, so it is published by committing the built files to a `gh-pages`
branch. No GitHub Actions are involved.

1. `pnpm deploy:pages` builds the app, verifies it, and pushes `dist/` to `gh-pages`. Use
   `--dry-run` to prepare the branch without pushing.
2. One-time setup: **Settings → Pages → Build and deployment → Source: Deploy from a branch →
   `gh-pages` / `(root)`**.

The site is then served at `https://exios66.github.io/wave-laboratory/`. The build uses
relative paths, so it also works from any other static host or sub-folder.

## Using the lab

1. Pick a **preset** or start a **new** experiment.
2. In the **Scene** panel, add wave systems, vessels and wave gauges. Select anything to edit
   it in the **Inspector**. The inspector also shows sea-state diagnostics and model-validity
   warnings.
3. Use the **dock** to play, pause, step or change speed, and to view time series, spectra and
   statistics.
4. **Save** the experiment as JSON, or **share** it as a link. Experiments are deterministic:
   the same file always produces the same sea.

Press <kbd>?</kbd> in the app for all keyboard shortcuts.

## Project layout

```
src/
  core/         maths, RNG, fixed-step clock, units
  schema/       versioned experiment format (Zod) and presets
  ocean/        dispersion, spectra, spreading, cascades, CPU FFT field
  vessel/       hull geometry, hydrostatics, hydrodynamics, propulsion, control
  instruments/  signal analysis (PSD, statistics, MSI)
  sim/          simulation kernel, Web Worker, client
  render/       Three.js/WebGL 2 renderer (GPU FFT ocean, water shading, vessels)
  ui/           React application
docs/           plan, physics reference, architecture
e2e/            Playwright browser tests
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/PHYSICS.md`](docs/PHYSICS.md) and
[`docs/PLAN.md`](docs/PLAN.md).
