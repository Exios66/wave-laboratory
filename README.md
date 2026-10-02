# Wave Laboratory

A real-time, scientifically grounded **3D ocean-wave sandbox**. Build a sea state from
oceanographic wave spectra, drop ships into it, and measure how they handle the waves.

**Live demo:** [https://exios66.github.io/wave-laboratory/](https://exios66.github.io/wave-laboratory/)

- **Waves:** JONSWAP, Pierson–Moskowitz and Bretschneider spectra, the TMA finite-depth
  correction, fetch-limited wind seas (Hasselmann et al. 1973) and regular Airy waves.
  Directional spreading is Mitsuyasu, cos-2s or Donelan–Banner. The dispersion relation
  includes finite depth and surface tension. The surface is synthesised from four FFT
  cascades (1 km swells down to centimetre ripples) with choppy (Lagrangian) displacement.
- **Ships:** 6-DOF rigid-body dynamics. Forces come from pressure integration over the
  instantaneous wetted hull (hydrostatics + Froude–Krylov), sampled on up to 280 water
  columns, plus added mass, radiation and viscous damping, propulsion, rudder and autopilot.
  Slamming, green water and capsize are detected. The hull you see is lofted more finely than
  the physics mesh, with antifouling below the waterline, deck cargo and a foam wake that
  does not feed back into the forces.
- **Instruments:** wave gauges, vessel motion recorders, Welch spectra, zero-crossing
  statistics, motion-sickness incidence and CSV export.
- **What you see is what the ships feel.** The GPU renderer inverse-FFTs the same h₀ amplitudes
  the CPU physics uses. On each new sea it compares a texel with the CPU transform and logs an
  error if they disagree; the browser tests fail when that error appears.
- **View:** orbit, top, follow and bridge cameras. Drag to orbit and scroll or pinch to zoom.
  Overlays colour the surface by elevation, slope, or breaking and foam.
- **Phones:** the 3D view fills the top half in portrait (side by side in landscape). A Scene /
  Inspector / Data switcher shows one panel at a time. The header keeps Presets and a More menu
  for the rest. Touch targets are at least 44 px, except the camera controls drawn on top of the
  view, which stay shorter so they do not cover the sea.
- **Accessible:** keyboard operable throughout, screen-reader labelled, WCAG 2.2 AA contrast,
  light and dark themes, reduced-motion aware. Accessibility is checked with axe on desktop and
  phone-sized viewports.

## Getting started

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

Requires Node ≥ 22 and a browser with WebGL 2.

| Command                                        | What it does                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm dev`                                     | Development server with hot reload                                                 |
| `pnpm build`                                   | Type-check and build to `dist/`                                                    |
| `pnpm test`                                    | Unit tests (physics, analysis, schema, simulation)                                 |
| `pnpm validate`                                | Longer statistical physics validation suite                                        |
| `pnpm test:e2e`                                | Browser tests on desktop, Pixel 7 and iPhone 14 viewports (run `pnpm build` first) |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Code quality                                                                       |
| `pnpm check`                                   | Format, lint, typecheck, unit tests and build in one go                            |
| `pnpm deploy:pages`                            | Build the site into `docs/` and commit it (Pages serves `main` / `docs`)           |

## Deploying the live demo (from `main`, no Actions)

There are no GitHub Actions workflows. Quality checks run locally (`pnpm check`, `pnpm test:e2e`).
The demo is the production build committed into [`docs/`](docs/) on **`main`**, next to the
markdown notes. GitHub Pages serves that folder directly.

1. `pnpm deploy:pages` builds the app and commits it into `docs/` on the current branch. Use
   `--dry-run` to update the folder without committing. Merge that commit to `main`.
2. Pages source: **Settings → Pages → Build and deployment → Deploy from a branch → `main` →
   `/docs`**.

The site is served at `https://exios66.github.io/wave-laboratory/`. The build uses relative
paths, so it also works from any other static host or sub-folder.

## Using the lab

1. Pick a **preset** or start a **new** experiment. The built-in presets are: moderate sea with
   a container ship, North Sea winter storm, Southern Ocean swell plus wind sea, a Wigley hull
   in a regular-wave tank, a box barge in beam seas, TMA swell in shallow water, and calm
   harbour ripples.
2. In the **Scene** panel, add wave systems, vessels and wave gauges. Select anything to edit
   it in the **Inspector**. The inspector shows the WMO sea state (from Hs rounded to the
   nearest centimetre), Beaufort wind, and model-validity warnings. Tapping a vessel or gauge
   on a phone opens the inspector.
3. Use the **dock** to play, pause, step or change speed, and to view time series, spectra and
   statistics. Chart legends sit under each plot. Statistics can be exported as CSV.
4. **Save** the experiment as JSON, or **share** it as a link. Experiments are deterministic:
   the same file always produces the same sea. Theme and graphics quality are in **Settings**
   (also under the phone More menu).

Press <kbd>?</kbd> in the app for all keyboard shortcuts. On a phone, drag with one finger to
orbit and pinch with two fingers to zoom.

## Project layout

```
src/
  core/         maths, RNG, fixed-step clock, units
  schema/       versioned experiment format (Zod) and presets
  ocean/        dispersion, spectra, spreading, cascades, CPU FFT field
  vessel/       hull geometry, hydrostatics, hydrodynamics, propulsion, control
  instruments/  signal analysis (PSD, statistics, MSI)
  sim/          simulation kernel, Web Worker, client
  render/       Three.js/WebGL 2 renderer (GPU FFT ocean in render/ocean, vessels, cameras)
  ui/           React application
docs/           plan, physics reference, architecture
e2e/            Playwright browser tests
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/PHYSICS.md`](docs/PHYSICS.md) and
[`docs/PLAN.md`](docs/PLAN.md).
