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
  the CPU for physics, and sends the same amplitudes to the GPU (`ocean/gpuData.ts`), which
  evolves and transforms them identically. `e2e/gpu-consistency.spec.ts` checks the two
  implementations against each other.
- **Fixed timestep, deterministic.** Physics advances in exact steps of `experiment.timestep`.
  The main thread only says how much simulated time should pass. The `SimClient` keeps at most
  one request in flight, so a slow machine runs slower than real time (and says so) instead of
  queueing up work.
- **The renderer draws the physics state.** Each `SimFrame` carries its time `t`. The GPU ocean
  is evaluated at that `t`, so the vessels sit on exactly the waves that move them.
- **Edits are documents.** Every change goes through `store.updateExperiment`. It validates
  against the Zod schema, records undo history and, for structural changes, bumps the
  `revision`, which reloads the worker. Live orders (heading, speed, helm) go straight to the
  worker as commands.
- **Contracts between modules** are plain TypeScript interfaces: `vessel/api.ts`,
  `render/api.ts` and `sim/types.ts`. Only `src/render` imports Three.js.

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
- `e2e/app.spec.ts` runs axe-core (WCAG 2.0/2.1/2.2 A and AA) on the live app.
