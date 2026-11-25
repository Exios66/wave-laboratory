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
- **Nonlinear steady waves follow the same rule.** `ocean/nonlinear.ts` solves Fenton Stokes 5,
  cnoidal and solitary waves; `ocean/nonlinearEval.ts` samples them on the CPU (surface, pressure,
  velocity, vessel columns) and `render/ocean/nonlinearMirror.ts` packs them into the
  `uNlA/uNlB/uNlH` uniforms read by `nonlinearSample` in the ocean shader (up to 4 waves, 24
  harmonics each). The same file holds a CPU mirror of the GLSL; its unit test checks elevation,
  horizontal displacement and slopes against the CPU field.
- **Fixed timestep, deterministic.** Physics advances in exact steps of `experiment.timestep`.
  The main thread only says how much simulated time should pass. The `SimClient` keeps at most
  one request in flight, so a slow machine runs slower than real time (and says so) instead of
  queueing up work.
- **The renderer draws the physics state.** Each `SimFrame` carries its time `t`. The GPU ocean
  is evaluated at that `t`, so the vessels sit on exactly the waves that move them. Bow spray
  (GPU particles, flight evaluated in the vertex shader) and the foam wake are visual only; they are not added back into the hull forces.
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
- **Post chain.** `render/post/PostStack.ts` draws the scene into a half-float target (with a
  depth texture for later passes), then runs bloom (threshold 1.2, so only the sun disc, the sharp
  sun glint and lightning glow), an optional vignette and film grain pass, and a final output pass
  that applies exposure, ACES filmic tone mapping and sRGB once. The `uSunHdr` uniform lifts those
  highlights above 1.0 only while bloom is on. With every effect off, or without half-float
  colour buffers, the renderer draws straight to the canvas as before. On the full tier the HDR
  target is multisampled (up to 4x), because the canvas MSAA does not reach off-screen targets;
  the light tier (phones, software GPUs) has no MSAA either way. The settings are display
  preferences (`wave-lab:display`), resolved against the device and quality in
  `resolvePostSettings`, not part of the experiment.
- **Sky and clouds.** The sky GLSL in `render/ocean/shaders.ts` is shared by the dome, the 64 px
  sky-environment cube (drawn from the camera position) and the water's reflection. Clouds are a
  world-anchored deck: `render/sky/cloudMap.ts` bakes the raw fractal coverage into a 1024² map
  covering 72 km, redrawn only when the eye moves more than 9 km, and the cover threshold is applied
  at sampling, so a weather change needs no redraw. The dome marches the deck (`cloudSteps` 0/4/6/8
  for low/medium/high/ultra; 0 keeps the flat deck), so the Plane view can climb into or above
  it. The water reflection and the underwater Snell window march from the water surface, not the
  camera, and take a single cloud sample, and the water
  darkens under the same map (cloud shadows). `render/sky/clouds.ts` holds the pure TypeScript
  mirror (slab span, phase function, march weights) that the unit tests check.
- **Sun shafts.** `render/post/SunShaftPass.ts` runs after the scene marker in `PostStack`: a
  quarter-resolution mask of bright sky from the depth texture, a radial march toward the sun's
  screen position, and an additive composite tinted by the sunlight. `post/sunShafts.ts` decides
  the strength each frame (0 at night, with the sun behind the camera or well off screen, and under
  full overcast; strongest in haze with broken cloud). The pass is enabled only when it would draw
  (bloom on, since the mask keys on the HDR sun; not underwater; not on the light tier;
  display setting `sunShafts` `auto|on|off`).
- **Hull–water contact.** `render/vessel/hullWettingMaterial.ts` hooks each hull's material
  (`onBeforeCompile`, its own program cache key) and evaluates the sea surface per vertex with the
  same `OCEAN_DISPLACEMENT_GLSL` the ocean uses, so the darker, glossier wet band, drip streaks and
  foam line follow the real waterline. `vessel/hullWetting.ts` steps the band's height envelope
  (fast rise, slow fall) from heave, roll, speed and Hs. The foam collar, bow cushion and bow-wave
  crest are terms in the existing wake shader, driven by `WakeSource.contact` (1 for surface hulls,
  0 for a submerged submarine), so they add no draw calls.
- **Underwater view.** The renderer has no CPU ocean height, so the main thread sends the camera
  position with each `advance`/`step` message (`cameraProbe`, only while the camera is low enough
  to matter) and the worker answers with `SimFrame.cameraSurface` (`OceanField.surface`: η and
  its rate), which the renderer carries forward by `etaT · dt`. `render/underwater/optics.ts`
  holds the pure helpers (Snell angle, per-channel attenuation, in-scatter colour, hysteresis,
  clamp, depth linearisation). After the camera update `LabRenderer` decides `underwater` for
  every camera mode, then (after `updateWeather`, which resets fog each frame) applies it: the
  ocean shader shades the underside (`uUnderwater`: refraction into Snell's window, total
  internal reflection outside it, dark foam), `UnderwaterPass` in `PostStack` applies
  `c·e^(−K_d·d) + inscatter·(1 − e^(−K_d·d))` from the depth texture and forces the chain on even
  with every effect off, and the scene fog and rain are switched off. Without half-float targets
  it falls back to a scalar `FogExp2` from the green-channel K_d.
- **Ambient world.** Decorative scenery is a stack of `SceneryLayer`s updated once per frame with
  a read-only `SceneryFrame` (`calm`, `daylight`, `hs`, vessel positions, `underwater`,
  `waterType`, `tier`); nothing a layer does feeds back into the ocean or the hull forces.
  Placement is a seeded hash grid, so islands, fishing grounds, shipping lanes, navigation
  buoys, kelp patches and wrecks are the same wherever you look from and are unit-tested without
  WebGL (`traffic.test.ts`, `scenery.test.ts`, `islands.test.ts`). `traffic.ts` exports its live
  hulls as `WakeSource`s (so a passing trawler leaves a Kelvin wake) and as `WildVessel`s (so
  dolphins bow-ride it and gulls trail its stern); underwater, `underwater/scenery.ts` adds a
  pooled seabed, instanced kelp/coral, wrecks and marine snow in 1–4 draw calls by tier.
  Budgets are per tier (`SceneryTier`, resolved from the device-capped quality) and live with the
  module that enforces them: `TRAFFIC_BUDGET` / `STRUCTURE_BUDGET` in `traffic.ts`,
  `UNDERWATER_BUDGET` in `underwater/scenery.ts`. Pirates and low recon passes exist but are
  opt-in (`AmbienceSettings.hostiles`, default off) and hard-despawn beyond 500 m. See
  `docs/AMBIENCE.md`.

## Performance budget (defaults)

| Work                                             | Where          | Cost              |
| ------------------------------------------------ | -------------- | ----------------- |
| CPU ocean snapshot (3 cascades × 6 FFTs of 128²) | worker, 20 Hz  | ~15 ms            |
| Vessel step incl. water sampling                 | worker, 120 Hz | < 1 ms per vessel |
| GPU FFT (4 cascades, 256²) + ocean shading       | GPU            | a few ms          |
| UI + charts (throttled to 4 Hz)                  | main           | < 2 ms            |

## Performance on every device

- **Tier and resolution:** `deviceProfile.ts` picks a quality tier and pixel-ratio cap from the GPU
  string, core count, memory and touch; software renderers get the lightest settings. A dynamic
  resolution governor lowers the render scale when frames run long and restores it slowly.
- **Frame pacing (`framePacing.ts`):** the runtime stops simulating and drawing while the tab is hidden
  or the canvas is scrolled off-screen (a `visibilitychange` listener restarts the frame clock, so a
  returning tab never advances the sim by the gap), and caps drawing at 30 fps
  on software renderers, Save-Data connections and a low (<= 20 %) unplugged battery. The governor's
  fps target follows the cap so a deliberate cap never reads as slowness.
- **Tier governor (auto only):** when the render scale is already at its floor and frames are still
  below ~85 % of the target for two seconds in a row, `ResolutionGovernor` steps the quality tier down
  one level (down to `low`); it steps back up only after a long run of windows at 90 % of the target or better
  (the looser bar lets a capped stream that drops the odd frame recover; 20 s, doubling to 160 s whenever a step up is followed by a step down within 25 s, so a device
  between two tiers settles on the lower one). An explicit Low/Medium/High/Ultra choice keeps its tier;
  `?gfx=full` (the e2e suite) disables tier steps so runs are deterministic. The Dock fps readout's
  tooltip shows the current adaptation.
- **Capabilities (`render/capabilities.ts`):** `decideCapabilities` turns `EXT_color_buffer_float`,
  `EXT_color_buffer_half_float` and `MAX_TEXTURE_SIZE` into two decisions: float or half-float ocean
  textures, and a quality ceiling (the texture limit must be at least `visualGridSize(tier) x 4`).
  The renderer clamps `setQuality` to the ceiling and exposes it as `maxQuality`; the runtime
  sends the worker the clamped tier, so no FFT data larger than the GPU can draw is built.
  iOS Safari and older Android therefore degrade rather than fail.
- **Context loss:** the renderer restores ocean and post resources on `webglcontextrestored`.
- **Diagnostics:** `?gfx=full` or `?perf` exposes `window.__waveLab.stats()` (fps, draw calls,
  geometry and texture counts, plus a `frames` render counter: the counts refresh only when a frame
  is rendered, so tests wait on it, not on animation frames) and `.governor()`; `e2e/resources.spec.ts` uses it to check that GPU
  object counts return to baseline after adding/removing a vessel and changing quality.

Measured under SwiftShader (software GL, 960x540, 20 s windows, CDP `Performance.getMetrics` and the
V8 sampling heap profiler): JS heap flat at 13-17 MB, sampled allocation 0.1-0.3 MB per 20 s, script
time 1-4 % of the main thread. The main thread is bound by software rasterisation (0.2-2.7 fps), not
by JavaScript, so there are no per-frame allocation hot spots worth touching. Draw calls / geometries
/ textures: default scene 55/57/35 (low), 121/74/79 (medium), 123/74/85 (high); three-vessel gale
110/102/35 (low), 233/121/80 (medium).

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
