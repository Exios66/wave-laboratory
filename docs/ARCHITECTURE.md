# Architecture

```
                    ┌──────────────────────── main thread ────────────────────────┐
  experiment JSON ─▶│ ui/store (Zustand) ──revision──▶ ui/runtime ──▶ SimClient   │
                    │      ▲    ▲                         │  ▲            │        │
                    │      │    └── frame / telemetry ────┘  │ postMessage│        │
                    │  React UI                    render/LabRenderer ◀───┘        │
                    └───────────────────────────────────────────┬─────────────────┘
                                                               │ load / advance / command
                    ┌──────────────────────── sim worker ───────▼─────────────────┐
                    │ sim/Simulation ── ocean/OceanField (CPU FFT, 128² × 3)       │
                    │                 ├─ vessel/* (6-DOF, pressure integration)    │
                    │                 └─ Recorder (fixed-rate samples)             │
                    └──────────────────────────────────────────────────────────────┘
```

## Principles

- **One source of truth for the sea.** `ocean/cascades.ts` generates the spectral amplitudes
  h₀(k) deterministically from the experiment (seeded per cell). The worker evaluates them on
  the CPU for physics, and sends the same amplitudes to the GPU (`ocean/gpuData.ts`).
  `render/ocean/GpuOcean.ts` evolves and inverse-FFTs them with the same sign and normalisation
  as `ocean/fft.ts` (`render/ocean/ifftPasses.ts` is the CPU mirror of those passes). On each
  new sea the renderer reads one texel back and compares it with the CPU transform; a mismatch
  is `console.error`, which `e2e/app.spec.ts` fails on. Devices without 32-bit float render
  targets use 16-bit half-float and skip that readback.
- **Fixed timestep, deterministic.** Physics advances in exact steps of `experiment.timestep`.
  The main thread only says how much simulated time should pass. The `SimClient` keeps at most
  one request in flight, so a slow machine runs slower than real time (and says so) instead of
  queueing up work.
- **The renderer draws the physics state.** Each `SimFrame` carries its time `t`. The GPU ocean
  is evaluated at that `t`, so the vessels sit on exactly the waves that move them. Bow spray
  and the foam wake are visual only; they are not added back into the hull forces.
- **Edits are documents.** Every change goes through `store.updateExperiment`. It validates
  against the Zod schema, records undo history and, for structural changes, bumps the
  `revision`, which reloads the worker. Live orders (heading, speed, helm) go straight to the
  worker as commands.
- **Contracts between modules** are plain TypeScript interfaces: `vessel/api.ts`,
  `render/api.ts` and `sim/types.ts`. Only `src/render` imports Three.js.
- **The 3D view.** `render/LabRenderer.ts` owns cameras (orbit, top, follow, bridge), vessel
  meshes, gauge buoys, picking, and one-finger orbit / two-finger pinch. A lost WebGL context
  (a phone tab sent to the background) is rebuilt in `GpuOcean.restore()`. Phone-sized screens
  and software GPUs use a coarser ocean mesh; visual FFT resolution still comes from
  `ui/deviceProfile.ts` and does not change the physics grid.

## Performance budget (defaults)

| Work                                             | Where          | Cost              |
| ------------------------------------------------ | -------------- | ----------------- |
| CPU ocean snapshot (3 cascades × 6 FFTs of 128²) | worker, 20 Hz  | ~15 ms            |
| Vessel step incl. water sampling                 | worker, 120 Hz | < 1 ms per vessel |
| GPU FFT (4 cascades, 256²) + ocean shading       | GPU            | a few ms          |
| UI + charts (throttled to 4 Hz)                  | main           | < 2 ms            |

## Accessibility

- Landmarks: header, scene navigation, main (3D view), complementary (inspector) and the
  playback/data region; plus skip links.
- All controls have programmatic labels and units. Numeric inputs pair a slider with a text
  box. Invalid input is announced with `role="alert"`.
- Composite widgets follow the WAI-ARIA Authoring Practices: tabs, radio groups, menu buttons
  and modal dialogs on native `<dialog>`.
- The 3D view is keyboard operable (arrow keys, + and −, Home). Everything it shows is also
  available as text (inspector readouts, statistics tables).
- Colour tokens meet WCAG 2.2 AA in both themes. Chart and overlay palettes are colour-blind
  safe. `prefers-reduced-motion` disables UI animation.
- Scrollable scene, inspector and chart panes are keyboard-focusable.
- On viewports under 900 px the scene, inspector and dock share one grid cell. Only the panel
  named by `data-mobile-panel` is shown. `e2e/mobile.spec.ts` covers a Pixel 7 and an iPhone 14
  (portrait and landscape): no horizontal overflow, touch editing, the More menu, and axe.
- `e2e/app.spec.ts` runs axe-core (WCAG 2.0/2.1/2.2 A and AA) on the live desktop app, in both
  themes and with a dialog open. Tests pin `locale: 'en-US'` because headless Chromium can
  report `en-US@posix`, which `Intl.NumberFormat` rejects; `src/main.tsx` also falls back to
  `en-US` if that happens.
- There is no GitHub Actions workflow. `pnpm test`, `pnpm validate` and `pnpm test:e2e` run
  locally. Playwright uses SwiftShader so the WebGL 2 ocean runs without a GPU.
