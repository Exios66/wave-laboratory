# Wave Laboratory: Visuals, Performance & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Native; the user asked for no subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up the repo. Remove the box-built offshore rigs and turbines the user flagged. Make the app load and measure faster, close the security gaps, then add TAA, shoreline surf, storm visuals and a UI layout pass. Finally, give the aircraft painted, textured airframes and turn the Plane view into a proper flight experience.

**Architecture:** Every change lands on `claude/hopeful-shannon-f2xayr` and reaches `main` through one PR per phase (A–D), merged as a merge commit. Each phase ends with `pnpm deploy:pages`. Pure logic goes in small, separately tested TypeScript modules: `src/core/csp.ts`, `src/render/post/taa.ts`, `src/render/gpuTimer.ts` sections, `src/render/scenery/surf.ts`. GPU work plugs into the existing `PostStack` and the ocean shader.

**Tech Stack:** TypeScript 5.9, React 19, three 0.186 (WebGL 2), Vite 8, vitest 4, Playwright 1.56 (SwiftShader), pnpm 10.

**Spec:** The user's brief: "complement, expand, improve, harden, secure, and optimize". Their selections: all four visual items, one plan, , "REMOVE THE STRANGE LOOMING UNTEXTURED STRUCTURES STICKING OUT OF THE WATER", and the follow-up "further enhance the airplane view & user experience … appropriately rendered airplane model textures". The audit evidence is in each task. This file is saved to `docs/superpowers/plans/2026-11-12-visuals-performance-hardening.md` in Task 0.

## Global Constraints

- Commit author `Jack J Burleson // LJM <exios4@protonmail.com>` (already in git config). Commits carry no Co-Authored-By or Claude-Session trailers, PR bodies carry no Claude footer, and nothing pushed names a model.
- Push only to `claude/hopeful-shannon-f2xayr`. Plain pushes only, with no amend and no force. The one exception is restarting the branch from `main` after a merge, which is a fast-forward.
- Merge PRs with `merge_method=merge`, and only when GitGuardian is green and no review threads are open. CodeRabbit "rate limited" (neutral) is acceptable.
- No subagents.
- Every phase must pass `pnpm run check` and `pnpm test:e2e --trace off` before its PR opens.
- New unit tests are `src/**/*.test.ts` (Node environment). New browser tests go in `e2e/*.spec.ts`.
- Saved-setting keys stay backward compatible. Old localStorage values must still parse (see `sanitizeAmbience` and `sanitizeDisplay` in `src/ui/store.ts` and `src/ui/deviceProfile.ts`).

## Review Focus

1. **Stale chunk after a redeploy.** A user with the old `index.html` cached requests a lazy chunk that no longer exists. The panel must show a recoverable error, not a white screen. Tested in Task 5.
2. **CSP blocks something only some paths load:** the meshopt WebAssembly decoder (`src/render/scenery/models.ts:100`), the module worker (`src/sim/SimClient.ts:32`), blob downloads (`src/ui/fileOps.ts:12`). Expected: no `securitypolicyviolation` events across load, model fetch, save and the underwater camera. Tested in Task 4.
3. **TAA ghosting on moving waves and camera cuts.** Switching camera mode or teleporting must not smear the last frame. History resets on a cut. Tested in Task 7.
4. **Old saved ambience with `structures: true`** from before the rigs were removed must still load and must mean "buoys on". Tested in Task 1.
5. **Detaching the view before the lazy renderer resolves** (React StrictMode double-mount). There must be no orphaned WebGL context and no double render loop. Tested in Task 2.

---

### Task 0: Housekeeping (merged branches, plan file)

**Files:** Create: `docs/superpowers/plans/2026-11-12-visuals-performance-hardening.md` (a copy of this plan)

- [ ] **Step 1:** Delete the 11 merged head branches. All 11 PRs show `merged: true`. Check this again just before deleting.
  ```bash
  for b in 01-water 02-sloop-rig 03-underwater-look 04-marine-life 05-traffic 06-submarine 07-sky-lighting 08-vessel-detail 09-scenery-models 10-sailors; do gh api -X DELETE repos/Exios66/wave-laboratory/git/refs/heads/claude/hopeful-shannon-f2xayr-$b; done
  gh api -X DELETE repos/Exios66/wave-laboratory/git/refs/heads/dependabot/npm_and_yarn/npm_and_yarn-2548c40aa2
  ```
  If the session proxy refuses ref deletion, give the user the `git push origin --delete …` commands to run themselves. Expected result: `git ls-remote origin 'refs/heads/claude/hopeful-shannon-f2xayr-*'` prints nothing.
- [ ] **Step 2:** Copy the plan into `docs/superpowers/plans/` and commit it: "Add the visuals, performance and hardening plan".

### Task 1: Remove the box-built oil rigs and wind turbines (Phase A)

The evidence is in `src/render/scenery/traffic.ts:912-965`. Rigs (28 m legs and a 38 m derrick) and turbines (74 m towers with frozen box blades) are vertex-coloured `appendBox` stacks with no texture. They sit on a hash grid offshore, which matches what the user saw. Sea buoys use the real `buoy.glb` model and stay.

**Files:**

- Modify: `src/render/scenery/traffic.ts`:
  - `StructureKind` becomes `'buoy'` only.
  - `structuresInCell` yields buoy marks only (keep one cardinal buoy per former rig or farm cell, at the same seed, so the traffic keep-clear logic is unchanged).
  - Delete the rig and turbine geometry, the beacon and flare code, and the night-light entries.
  - `STRUCTURE_KINDS` becomes `['buoy']`.
- Modify: `src/ui/components/Dialogs.tsx:284`: label changes to "Navigation buoys".
- Modify: `docs/AMBIENCE.md:11`, `docs/ARCHITECTURE.md:78`, and the header comment of `traffic.ts`.
- Test: `src/render/scenery/traffic.test.ts`, `src/render/scenery/budget.test.ts`, `src/ui/store.test.ts`, `e2e/app.spec.ts:693` (label).

**Interfaces:** Produces `type StructureKind = 'buoy'`. `structuresNear(x, y, tier)` keeps its signature. The ambience key stays `structures: boolean` for saved-setting compatibility.

- [ ] **Step 1: Failing tests.** In `traffic.test.ts`, inside `describe('offshore static structures')`:
  ```ts
  it('places only navigation buoys', () => {
    for (let ix = -40; ix <= 40; ix++)
      for (let iy = -40; iy <= 40; iy++) {
        for (const s of structuresInCell(ix, iy)?.items ?? []) expect(s.kind).toBe('buoy');
      }
  });
  ```
  In `budget.test.ts`, add: with `structures: true`, the layer's children contain no mesh named `structure-oil-rig` or `structure-wind-turbine`.
  In `store.test.ts`, add: a saved `{ structures: true }` sanitizes to `structures: true`.
- [ ] **Step 2:** Run `pnpm vitest run src/render/scenery`. Expected: FAIL (oil-rig and wind-turbine kinds are still present).
- [ ] **Step 3:** Remove the rig and turbine code as listed under Files, then update the remaining existing assertions that count rig cells (`STRUCTURE_BUDGET` stays as the buoy-cell cap).
- [ ] **Step 4:** Run `pnpm vitest run src/render/scenery src/ui`. Expected: PASS.
- [ ] **Step 5: Visual check.** Run a Playwright script at `?gfx=full`, 960×540: Orbit camera pitched to the horizon, plus Bridge. Take one screenshot at deviceScaleFactor 2 and show it to the user to confirm the structures they meant are gone. If they meant something else (for example the flat-shaded island cones), stop and ask before continuing.
- [ ] **Step 6:** Commit: "Remove the box-built offshore rigs and wind turbines; keep navigation buoys".

### Task 2: Load the renderer and charts on demand (Phase A)

Today `dist/assets/index-*.js` is 1.56 MB: three.js, every scenery layer and uPlot all load before the first paint. The code has no `import()` anywhere.

**Files:**

- Modify: `src/ui/runtime.ts:173`. `attach` accepts an async factory.
- Modify: `src/ui/components/Viewport.tsx:3,40`. Use `import('../../render/LabRenderer')`.
- Modify: `src/ui/components/Dock.tsx:13`. `const Chart = lazy(() => import('./Chart'))` inside `<Suspense fallback={<p className="dock__loading">Loading chart…</p>}>`. Change `Chart.tsx` to a default export plus the named `ChartSeries` type.
- Test: `src/ui/runtime.test.ts`.

**Interfaces:**

- Produces `attach(canvas: HTMLCanvasElement, createRenderer: (c: HTMLCanvasElement) => LabRendererApi | Promise<LabRendererApi>): Promise<void>`. Every caller already ignores the return value.
- The store stays `status: 'loading'` until the renderer resolves.

- [ ] **Step 1: Failing tests** in `runtime.test.ts`:
  - `it('attaches an async renderer once it resolves')`: a factory returns `Promise.resolve(fake)`; after `await rt.attach(...)`, `fake.setQuality` has been called once.
  - `it('disposes a renderer that resolves after detach')`: call attach with a deferred promise, call `rt.detach()`, then resolve. Expect `fake.dispose` called once and `rt.rendererApi` to be null.
  - `it('reports a rejected renderer import as unsupported')`: a factory returns `Promise.reject(new Error('chunk'))`. Expect `useLab.getState().status` to be the unsupported state with the message `'chunk'`.
- [ ] **Step 2:** Run `pnpm vitest run src/ui/runtime.test.ts`. Expected: 3 FAIL.
- [ ] **Step 3: Implement.** Use an attach generation counter. `detach()` bumps it, and a renderer that resolves under a stale generation is disposed instead of wired up. Keep the existing try/catch path for both sync throws and rejections.
- [ ] **Step 4:** Run the same tests. Expected: PASS. Then `pnpm build`. Expected: separate `LabRenderer-*.js` and `Chart-*.js` chunks, and an entry chunk under 450 kB raw.
- [ ] **Step 5:** Commit: "Load the 3D renderer and charts as separate chunks".

### Task 3: Bundle budget and per-pass GPU timings (Phase A)

PLAN.md §9 promises per-pass GPU timings in the HUD, but `GpuTimer` only measures the whole frame (`LabRenderer.ts:1383,1413`).

**Files:**

- Create: `scripts/check-bundle.mjs`, wired in as the last step of `check` in `package.json`.
- Modify: `src/render/gpuTimer.ts`, `src/render/api.ts:62` (`RendererStats`), `src/render/LabRenderer.ts` around render(), `src/ui/components/Dock.tsx:185`.
- Create: `src/render/gpuTimer.test.ts`.

**Interfaces:**

- Produces `type GpuPass = 'ocean' | 'prepass' | 'scene' | 'post'`.
- Produces `GpuTimer.begin(pass: GpuPass)`, `GpuTimer.end()` and `GpuTimer.passes: Partial<Record<GpuPass, number>> | null`. Each pass is smoothed with the same EMA as `ms`. `ms` becomes the sum of the passes.
- Produces `RendererStats.gpuPasses: Partial<Record<GpuPass, number>> | null`.

- [ ] **Step 1: Failing test** `gpuTimer.test.ts`. Use a fake `WebGL2RenderingContext` whose extension exists and whose queries report fixed `QUERY_RESULT` values of 2 ms for 'ocean' and 5 ms for 'scene'. After enough frames for results to arrive:
  ```ts
  expect(t.passes?.ocean).toBeCloseTo(2, 1);
  expect(t.passes?.scene).toBeCloseTo(5, 1);
  expect(t.ms).toBeCloseTo(7, 1);
  ```
  Add a second test: without the extension, `passes` and `ms` are both `null`.
- [ ] **Step 2:** Run `pnpm vitest run src/render/gpuTimer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Timer queries cannot nest, so wrap the four sequential stages of render() (ocean FFT update, `drawPrepass`, scene draw, post). The Dock readout becomes `"<fps> fps · GPU 7.1 ms"`, with a `title` tooltip listing the per-pass times.
- [ ] **Step 4: `check-bundle.mjs`.** Read `dist/index.html`, find the `<script type="module" src>` entry, and fail if `statSync(entry).size > ENTRY_BUDGET`. Set `ENTRY_BUDGET` to the Task 2 build size + 10 %, rounded up to 10 kB, with a comment giving the measured size. Print `entry <name>: <kB> / <budget kB>`.
- [ ] **Step 5:** Run `pnpm run check`. Expected: PASS, and the bundle line is printed.
- [ ] **Step 6:** Commit. Then open Phase A PR "Remove offshore box structures, split the bundle, per-pass GPU timings" and merge it under the Global Constraints. Then run `pnpm deploy:pages` on the restarted branch and land that through a deploy PR, exactly as with #70.

### Task 4: Content-Security-Policy and dependency alerts (Phase B)

GitHub Pages cannot set response headers, so the policy ships as a `<meta>` tag, injected only into the production build (Vite's dev server needs inline scripts for HMR). `pnpm audit` reports @vitest/mocker < 4.1.12 (moderate, twice) and minimatch < 11.0.1 (moderate, via typescript-eslint). GitHub reports 4 alerts, 1 of them high.

**Files:**

- Create: `src/core/csp.ts`, `src/core/csp.test.ts`.
- Modify: `vite.config.ts` (plugin), `package.json` (`vitest` → `~4.1.12`; `pnpm.overrides` `"minimatch@>=7.0.0 <11.0.1": "^11.0.1"`), `pnpm-lock.yaml`.
- Test: `e2e/app.spec.ts` (new test).

**Interfaces:**

- Produces `export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>>`.
- Produces `export function cspContent(d = CSP_DIRECTIVES): string`.
- Produces `export function cspMetaTag(): string`.

- [ ] **Step 1: Failing unit test.**
  ```ts
  expect(cspContent()).toBe(
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'",
  );
  expect(cspMetaTag()).toMatch(
    /^<meta http-equiv="Content-Security-Policy" content="default-src 'self';/,
  );
  ```
  `'wasm-unsafe-eval'` is there for the meshopt decoder. `'unsafe-inline'` styles are there for React `style` props and the uPlot CSS.
- [ ] **Step 2:** Run `pnpm vitest run src/core/csp.test.ts`. Expected: FAIL. Then implement.
- [ ] **Step 3:** Add the plugin to `vite.config.ts`: `{ name: 'csp-meta', apply: 'build', transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" />\n    ' + cspMetaTag()) }`. Also add `<meta name="referrer" content="no-referrer" />` to `index.html`.
- [ ] **Step 4: Failing e2e test** `test('production build runs under its Content-Security-Policy')`. Use `page.addInitScript` to collect `securitypolicyviolation` events. Load the app, wait for the clock to advance, switch to the Underwater camera, open the Spectrum tab, and wait for `models/buoy.glb` to return 200. Assert that the meta tag is present and that the collected violations are `[]`. The e2e server is `vite preview`, which serves the build, so the meta tag is live.
- [ ] **Step 5:** Bump the dependencies: `pnpm up vitest@~4.1.12 @vitest/mocker`, add the override, run `pnpm install`. Expected: `pnpm audit` reports 0 moderate and 0 high. Ask the user to name the high-severity GitHub alert if `pnpm audit` doesn't show it (the alerts API returns 403 to this session).
- [ ] **Step 6:** Run `pnpm run check && pnpm test:e2e --trace off`. Expected: PASS. Commit: "Ship a Content-Security-Policy and clear the dependency advisories".

### Task 5: Recoverable error boundaries (Phase B)

The code has no `ErrorBoundary`. Since Task 2, chunk loads can fail after a redeploy.

**Files:**

- Create: `src/ui/components/ErrorBoundary.tsx`, `src/ui/errorText.ts`, `src/ui/errorText.test.ts`.
- Modify: `src/ui/App.tsx` (wrap the viewport, dock, inspector and scene panel separately).
- Test: `e2e/app.spec.ts`.

**Interfaces:**

- Produces `<ErrorBoundary area="charts" | "viewport" | "inspector" | "scene">`. Its fallback is a `role="alert"` panel with the text from `errorText(err)` and a "Reload" button. Reload does a full page reload when `isChunkLoadError(err)`, and otherwise resets the boundary.
- Produces `errorText(err: unknown): string` and `isChunkLoadError(err: unknown): boolean`. The latter matches the Vite and Chrome messages "Failed to fetch dynamically imported module", "Importing a module script failed" and "error loading dynamically imported module".

- [ ] **Step 1: Failing unit tests.**
  - `isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: x'))` → true.
  - `isChunkLoadError(new Error('boom'))` → false.
  - `errorText('str')` → `'str'`.
  - For a chunk error, `errorText` → `'A newer version of Wave Laboratory was published. Reload to continue.'`
- [ ] **Step 2:** Run the tests and watch them fail. Implement. Run them again. Expected: PASS.
- [ ] **Step 3: Failing e2e test** `test('a missing chart chunk degrades to a reload notice; the 3D view keeps running')`. Abort `**/assets/Chart-*.js` with `page.route`. Open the Spectrum tab. Expect `getByRole('alert')` to contain "Reload", and expect the clock text to still advance.
- [ ] **Step 4:** Implement the boundary and wrap the four areas. Run the e2e test. Expected: PASS. Then run `pnpm run check`.
- [ ] **Step 5:** Commit. Open and merge the Phase B PR "Content-Security-Policy, dependency fixes, error boundaries", then deploy (as in Task 3, Step 6).

### Task 6: UI layout pass at medium widths (Phase C)

The screenshots at 960×540 (`$S/bridge.png`) show four problems:

- the Dock tab labels wrap onto two lines;
- the perf readout is clipped ("61.6 ms" cut off);
- the theme select runs off the top bar;
- the chart overlay covers half the viewport.

The design tokens and light/dark themes already exist in `src/ui/styles.css:4-80`, so this pass fixes layout, not palette.

**Files:**

- Modify: `src/ui/styles.css`, `src/ui/components/TopBar.tsx`, `src/ui/components/Minimap.tsx:33-45`, `src/ui/components/Dock.tsx`.
- Test: `e2e/mobile.spec.ts` (new `describe('medium width 960×540')`).

**Interfaces:** Produces the token `--bp-compact: 1100px`. Below it, the Graphics and Theme selects move into the existing settings dialog (`Dialogs.tsx`, the display section) and are removed from the top bar.

- [ ] **Step 1: Failing e2e tests** at viewport 960×540:
  - every `role=tab` in the dock has the same `boundingBox().height`, which means no wrapping;
  - `header` has `scrollWidth <= clientWidth`;
  - the perf readout's `scrollWidth <= clientWidth`;
  - the minimap starts folded when the viewport element is narrower than 700 px (change the `readPrefs` check at `Minimap.tsx:35` from `window.innerWidth` to the viewport element's width).
- [ ] **Step 2:** Run `pnpm test:e2e e2e/mobile.spec.ts --trace off`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Dock tabs: `white-space: nowrap`, with the tab list set to `overflow-x: auto`.
  - Perf readout: shorten to `"62 fps · 7.1 ms"` with a tooltip; `min-width: 0` and `text-overflow: ellipsis`.
  - Top bar: hide the selects under `--bp-compact` and expose them in the settings dialog.
  - Minimap: change the measure as described in Step 1.
- [ ] **Step 4:** Run the e2e test plus the axe checks already in the suite. Expected: PASS. Commit: "Fit the top bar, dock and chart at medium widths".

### Task 7: Temporal antialiasing (Phase C)

MSAA (`PostStack.ts:158-161`) smooths geometry edges, but the sub-pixel glints and foam on distant water still shimmer from frame to frame.

**Files:**

- Create: `src/render/post/taa.ts` (pure helpers), `src/render/post/taa.test.ts`, `src/render/post/TaaPass.ts` (a three.js `Pass`).
- Modify:
  - `src/render/post/PostStack.ts`: insert TAA after the scene and underwater passes, before bloom.
  - `src/render/api.ts:15`: add `PostSettings.taa: boolean`.
  - `src/ui/deviceProfile.ts`: add `DisplaySettings.taa: 'auto' | 'on' | 'off'`, where auto means on for the 'full' tier only. Add it to `sanitizeDisplay` and `resolvePostSettings`.
  - `src/render/LabRenderer.ts`: apply the jitter to the camera projection every frame, and reset history on a cut.
  - `Dialogs.tsx`: add a "Temporal antialiasing" display control.

**Interfaces:**

- Produces `halton(index: number, base: number): number`.
- Produces `jitterOffset(frame: number, width: number, height: number): [number, number]` in clip space. It uses an 8-sample Halton(2,3) sequence, centred so the mean is 0.
- Produces `isCameraCut(prev: THREE.Matrix4, next: THREE.Matrix4, threshold = 0.05): boolean`. A cut is any change in view-projection larger than the threshold (Frobenius norm of the difference over the norm of `prev`), or any camera-mode change.
- Produces `TaaPass.reset(): void` and `TaaPass.setMatrices(prevViewProj, invViewProj)`.

- [ ] **Step 1: Failing unit tests.**
  - `halton(1,2) === 0.5`, `halton(2,3)` ≈ `2/3`.
  - The mean of `jitterOffset(0..7, 1920, 1080)` is ≈ 0, within 1e-3 of a pixel.
  - Every offset is ≤ 1 px in magnitude.
  - `isCameraCut(m, m)` is false; a 30° yaw gives true; a 0.1° orbit step gives false.
  - `sanitizeDisplay({})` gives `taa: 'auto'`.
- [ ] **Step 2:** Run the tests. Expected: FAIL. Implement `taa.ts`. Run again. Expected: PASS.
- [ ] **Step 3: Implement `TaaPass`.**
  - It holds a pair of ping-pong half-float history targets.
  - Reprojection runs from the scene depth texture through `invViewProj` → `prevViewProj` (camera-only motion).
  - Neighbourhood clamping uses a YCoCg 3×3 min/max box to limit ghosting on moving water.
  - The blend factor is 0.1. It becomes 1.0 for the first frame after `reset()` and for any history UV off-screen.
  - The pass is disabled entirely when `PostSettings.taa` is false, so there is zero cost.
- [ ] **Step 4: Failing e2e test** in `graphics.spec.ts`: `test('TAA on: renders, survives a camera cut, no console errors')`. Use `?gfx=full`, display TAA on, switch Orbit → Bridge → Orbit. Expect the canvas to be non-blank (sampled pixel variance > 0) and no `console.error`.
- [ ] **Step 5:** Run `pnpm test:e2e e2e/graphics.spec.ts --trace off`. Expected: PASS. Take before/after crops of the distant water (two frames 1/60 s apart, then a pixel diff). Expected: the TAA frame-to-frame diff is lower than without TAA. Commit: "Temporal antialiasing on the full tier".

### Task 8: Surf around rocks and buoys, sized by sea state (Phase D)

Islands already draw a swash foam band (`islands.ts:945-962`). That band ignores the sea state, and nothing else in the water gets surf.

**Files:**

- Create: `src/render/scenery/surf.ts` and `surf.test.ts` (pure sizing).
- Modify: `src/render/scenery/islands.ts` (feed `surfWidth` and `surfIntensity` into the existing `uFoam` shader through two new uniforms `uSurfWidth` and `uSurfStrength`).
- Modify: `src/render/scenery/models.ts` / `traffic.ts`: add one instanced foam-ring decal per rock-a, rock-b and buoy instance, using the same shader idea, in one draw call.

**Interfaces:**

- Produces `surfBand(hs: number, tp: number): { width: number; strength: number }`.
  - Width is in metres: `clamp(0.8 * hs, 0.5, 8)`.
  - Strength is in [0, 1]: `smoothstep(0.2, 2.5, hs)`. Calm water gets a faint lap; Hs ≥ 2.5 m gets full surf.
  - The swash period follows `tp`, so the shader phase speed is `2π / tp`, replacing the fixed 0.8 rad/s.

- [ ] **Step 1: Failing tests.**
  - `surfBand(0, 8)` → `{ width: 0.5, strength: 0 }`.
  - `surfBand(2.5, 9).strength` → 1.
  - `surfBand(20, 12).width` → 8.
  - `surfBand` is monotone in `hs`: check 50 random pairs.
- [ ] **Step 2:** Run the tests, implement, run again. Expected: PASS.
- [ ] **Step 3:** Wire up the uniforms and the ring decals. Extend `budget.test.ts`: with structures and islands on, the foam rings add exactly 1 draw call.
- [ ] **Step 4:** Visual check: screenshots of an island and a rock at Hs 0.5 m and Hs 4 m, shown to the user. Commit: "Sea-state surf around islands, rocks and buoys".

### Task 9: Storm visuals: distant rain curtains and a wet lens (Phase D)

Rain streaks, rain ripples, spindrift, overcast and lightning already exist (`particles.ts`, `shaders.ts:491,840,212`). What's missing is precipitation visible at a distance, and the camera getting wet.

**Files:**

- Create: `src/render/sky/rainCurtains.ts` and `rainCurtains.test.ts`.
- Create: `src/render/post/LensPass.ts`, and add its pure part, `lensDropletRate`, to `rainCurtains.ts`.
- Modify: `src/render/LabRenderer.ts` (`updateWeather`), `src/render/post/PostStack.ts`, `src/ui/deviceProfile.ts` (`DisplaySettings.lensDroplets: boolean`, default true).

**Interfaces:**

- Produces `curtainCount(rainMmH: number, tier: SceneryTier): number`.
  - 0 when rain < 2.
  - Otherwise `min(cap, round(rain / 4))`, with cap full = 8, mid = 5, light = 0.
- Produces `curtainPlacement(seed: number, i: number, windDirRad: number): { bearing: number; distanceM: number; widthM: number }`.
  - Distance is in [2000, 8000] and width in [400, 1500].
  - The bearing clusters within ±60° upwind.
- Produces `lensDropletRate(rainMmH: number, sprayRate: number, camera: CameraMode): number` in drops/s.
  - Non-zero only for 'bridge', 'follow' and 'orbit' while the camera is above water.
  - Underwater returns 0.

- [ ] **Step 1: Failing tests.** Check each bound and cap listed above, plus:
  - placement is deterministic for the same seed;
  - `lensDropletRate(30, 0, 'underwater') === 0`;
  - `lensDropletRate(0, 0, 'bridge') === 0`.
- [ ] **Step 2:** Run the tests, implement the pure functions, run again. Expected: PASS.
- [ ] **Step 3: Rendering.**
  - Curtains: vertical, soft-edged, additive-free alpha billboards (one `InstancedMesh`) that fade with fog. They are lit by `daylight()`.
  - `LensPass`: a refraction-offset droplet layer that lives up to 4 s per droplet. It is skipped when the rate is 0, and its texture is generated once on the CPU.
  - Both are off on the 'light' tier.
- [ ] **Step 4:** Add an e2e test in `graphics.spec.ts`: a storm preset at `?gfx=full` on the Bridge camera with no console errors. Take a screenshot for the user. Commit: "Distant rain curtains and a wet lens in storms". Open and merge the Phase D PR (Phase C's PR goes up after Task 7 the same way), then deploy.

### Task 10: Textured, properly shaded aircraft (Phase E)

The evidence is in `src/render/scenery/planes.ts:582-740,833`. The airframes are boxes and 8-sided tubes. `merge()` strips the UVs, and every aircraft shares one flat-shaded grey `MeshLambertMaterial` at 0.9 opacity. Up close in the Plane view this looks crude.

No CC0 aircraft models exist on Poly Haven (`scripts/fetch-models.mjs`), so the textures are painted procedurally at runtime. That keeps it free of licensing questions and adds no download.

**Files:**

- Create: `src/render/scenery/aircraftLivery.ts` and `aircraftLivery.test.ts` (pure painting into `Uint8Array`s).
- Modify: `src/render/scenery/planes.ts`:
  - `merge()` keeps UVs, remapped into atlas regions, and keeps two groups: body and glass.
  - Tubes go to 16 segments with tapered nose and tail cones.
  - `MeshStandardMaterial` with smooth shading, plus a glass material.
  - Add a prop-blur disc.

**Liveries.** These are generic, with no airline logos.

| Aircraft | Paint                                                                                                                    | Markings                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Avenger  | 1945 US Navy tri-colour: sea blue `#1f2f4a` on top, intermediate blue `#4a5d7a` on the sides, white `#e8eaec` underneath | star-and-bar insignia; tail code `FT-28`   |
| Mariner  | glossy sea blue `#1c2a44` overall                                                                                        | star-and-bar insignia                      |
| DC-3     | polished aluminium `#c9ced3`                                                                                             | dark-blue cheatline `#1e3a5f`              |
| Tudor    | silver `#bfc5cb`                                                                                                         | dark-blue cheatline; registration `G-AHNP` |

Every aircraft also gets:

- panel lines every 1.2 m along the fuselage;
- rivet rows, painted into the height map;
- exhaust staining behind each engine;
- a roughness map (0.35–0.6 for paint, 0.25 for aluminium).

**Interfaces:**

- Produces `type AtlasRegion = 'fuselage' | 'wingTop' | 'wingBottom' | 'tail' | 'engine'`.
- Produces `ATLAS_RECTS: Record<AtlasRegion, { u0: number; v0: number; u1: number; v1: number }>`, a fixed layout shared by every kind.
- Produces `interface Livery { kind: AircraftKind; base: number; upper: number; lower: number; cheatline: number | null; insignia: 'usn-star' | null; code: string | null; metal: boolean }`.
- Produces `liveryFor(kind: AircraftKind): Livery`.
- Produces `paintAtlas(livery: Livery, size: 256 | 512): { albedo: Uint8Array; roughness: Uint8Array; normal: Uint8Array }`.
  - `albedo` is RGBA in sRGB; `roughness` holds the R channel; `normal` is a tangent-space RGB normal map derived from the height map with a Sobel filter.
  - The size is 512 on the full tier and 256 on the others. Textures are generated lazily, the first time a kind is shown, and cached per kind.
- Produces `remapUv(geo: THREE.BufferGeometry, region: AtlasRegion): THREE.BufferGeometry`.
- Ghost lore stays:
  - fade-in, fade-out, shimmer, flicker and the laggard are unchanged;
  - steady opacity becomes 1;
  - a desaturation `ghost ∈ [0,1]` tints `material.color` from white toward `GHOST_COLOR`: 0.35 for sky crossings, 0 for the ridden aircraft.

- [ ] **Step 1: Failing tests** in `aircraftLivery.test.ts`:
  - `paintAtlas(liveryFor('avenger'), 256)` is deterministic: two calls give byte-identical buffers.
  - The pixel at the centre of `ATLAS_RECTS.wingBottom` is within ΔE 3 of `#e8eaec`.
  - The insignia centre pixel on the fuselage is white and its surrounding disc is blue `#1f2f4a`.
  - All roughness bytes are in [0.2·255, 0.7·255].
  - The normal map's z component is ≥ 0.7 everywhere (unit vectors pointing out of the surface).
  - The DC-3 livery has `metal: true` and no insignia.
  - `remapUv` keeps every UV inside its region's rect.
  - In `planes.test.ts`: every built airframe has a `uv` attribute and exactly 2 groups.
- [ ] **Step 2:** Run `pnpm vitest run src/render/scenery/aircraftLivery.test.ts src/render/scenery/planes.test.ts`. Expected: FAIL. Implement. Run again. Expected: PASS.
- [ ] **Step 3: Wire up the materials.**
  - `MeshStandardMaterial({ map, roughnessMap, normalMap, metalness: livery.metal ? 0.8 : 0.1 })`. Set `map.colorSpace = SRGBColorSpace` and anisotropy 4 on the full tier. Keep `fog: false` (as today).
  - Canopy glass: roughness 0.05, metalness 0, opacity 0.55, reflecting the sky through `scene.environment`.
  - The prop disc is a radial-alpha texture spinning at 1 rad per frame.
  - Dispose of all textures in `PlaneLayer.dispose()`.
  - Extend `budget.test.ts`: the plane layer still uses ≤ 3 draw calls per aircraft.
- [ ] **Step 4:** Take screenshots of each kind in the Plane view at `?gfx=full` and show them to the user. Commit: "Textured, smooth-shaded aircraft with period liveries".

### Task 11: Plane view camera modes and smoother flight (Phase E)

Today the Plane view has one chase camera (`LabRenderer.ts:316-328,1748-1790,2221`) that stays level while the aircraft banks about 30° (`crossingPose`, `planes.ts:420`).

**Files:**

- Create: `src/render/rideCamera.ts` and `rideCamera.test.ts` (pure).
- Modify: `src/render/LabRenderer.ts` (use it), `src/render/api.ts` (new API), `src/render/scenery/planes.ts` (`planRide(..., kind?: AircraftKind)` to force a kind; `nextRide()` in `PlaneLayer`).

**Interfaces:**

- Produces `type RideView = 'chase' | 'cockpit' | 'wing' | 'flyby'`.
- Produces `RIDE_VIEWS: readonly RideView[]` in that order.
- Produces `rideCameraPose(view: RideView, pose: PlanePose, kind: AircraftKind, look: { yaw: number; dip: number; chase: number }, t: number, out: { pos: THREE.Vector3; target: THREE.Vector3; roll: number }): void`.
  - `chase`: the current placement, rolled by `0.5·bank`.
  - `cockpit`: the eye at the pilot seat. The offset comes from a per-kind table in `rideCamera.ts`; Avenger is (2.0, 1.25, 0) in model space × `AIRCRAFT_DRAW_SCALE`. Roll equals `bank`. Yaw and dip are look-around, clamped to ±100° and ±60°.
  - `wing`: the eye 0.8 × half-span out on the starboard wing, looking forward and inboard. Roll equals `bank`.
  - `flyby`: a fixed point 400 m ahead on the circuit, 30 m below the flight path. It is re-placed each time the aircraft passes within 60 m, and it always looks at the aircraft. Roll is 0.
- Produces `dampVec(current: THREE.Vector3, target: THREE.Vector3, halfLifeS: number, dt: number): void`. This is frame-rate-independent exponential smoothing for the chase eye; the half-life is 0.25 s.
- Produces `LabRendererApi.setRideView(view: RideView): void` and `LabRendererApi.nextRide(): void`. `nextRide` switches to the next kind in `KINDS` order, dissolves the old flight over the existing fade, and joins the new one at the same circuit bearing.

- [ ] **Step 1: Failing tests:**
  - The cockpit eye lies within 0.6 × fuselage radius of the fuselage axis and ahead of the wing's leading edge.
  - The wing eye is on the starboard side at 0.8 × half-span (±0.5 m).
  - Roll equals `bank` for cockpit and wing, `0.5·bank` for chase, and `0` for flyby.
  - For flyby, the distance to the aircraft never exceeds 450 m during a 60 s circuit sampled at 10 Hz, and the eye is re-placed at least once.
  - `dampVec` with dt = halfLife moves halfway, and its result does not depend on splitting dt into 4 steps (1e-6 tolerance).
  - `planRide(rng, c, 0, 1, 0, 0, 'dc3').kind === 'dc3'`.
- [ ] **Step 2:** Run the tests. Expected: FAIL. Implement. Run again. Expected: PASS.
- [ ] **Step 3: Wire up the renderer.**
  - Apply the roll by rotating `camera.up` about the view axis.
  - The near plane is 0.15 m in the cockpit, so the canopy frame is visible without clipping.
  - Switching view resets TAA history (Task 7 `TaaPass.reset()`).
- [ ] **Step 4:** Commit: "Plane view: cockpit, wing and fly-by cameras with banked, damped flight".

### Task 12: Plane view HUD and controls (Phase E)

`RideCaption` (`Viewport.tsx:278-290`) shows only "Riding with …" plus a tip.

**Files:**

- Modify: `src/ui/components/Viewport.tsx`, `src/ui/store.ts` (`rideView: RideView`, persisted like the other viewer preferences, defaulting to `'chase'` and sanitized against `RIDE_VIEWS`), `src/ui/App.tsx` (keys), `src/ui/components/Dialogs.tsx:60-66` (shortcut list), `src/ui/styles.css`.
- Modify: `src/render/api.ts`: replace `planeRide(): string | null` with `planeTelemetry(): RideTelemetry | null`.
- Test: `src/ui/store.test.ts`, `e2e/app.spec.ts` and `e2e/mobile.spec.ts`.

**Interfaces:**

- Produces `interface RideTelemetry { label: string; kind: AircraftKind; altitudeM: number; speedMs: number; headingDeg: number; bankDeg: number }`.
- Keys (Plane view only; ignored while typing in inputs):
  - `C` cycles the camera through `RIDE_VIEWS`;
  - `N` switches to the next aircraft;
  - `Esc` lands, i.e. returns to the ground camera (`store.ts:371` `groundCamera`). The existing Esc clear-selection still applies outside Plane view.
- HUD card layout:
  - the label;
  - a segmented control (Chase · Cockpit · Wing · Fly-by) as a `role="radiogroup"` with roving tabindex, following the same pattern as the camera buttons (`Viewport.tsx:190`);
  - a "Next aircraft" button;
  - a monospace line, refreshed every 250 ms: `ALT 312 m · 1,024 ft · IAS 132 kn · HDG 274° · BANK 31° R` (negative bank = left). Formatting goes through `fmt` (`fields.tsx`) and `src/core/units.ts`.
  - On screens under 640 px wide the telemetry line wraps onto a second row and the tip is hidden.

- [ ] **Step 1: Failing tests.**
  - Unit: `sanitize` on `{ rideView: 'barrel-roll' }` gives `'chase'`.
  - Unit: `formatRideTelemetry({ altitudeM: 312, speedMs: 68, headingDeg: 274.4, bankDeg: -30.6 })` gives `'ALT 312 m · 1,024 ft · IAS 132 kn · HDG 274° · BANK 31° L'`. Put this function in `src/ui/components/rideHud.ts` and export it.
  - e2e `test('plane view: switch cameras, change aircraft, read telemetry')`:
    - click Plane;
    - expect `/Riding with/`;
    - press `C` three times; the radio checked state cycles Chase → Cockpit → Wing → Fly-by;
    - click "Next aircraft"; the label changes within 15 s;
    - the telemetry line matches `/ALT \d+ m/`;
    - press `Esc`; the Plane button reads "Plane" again;
    - no console errors.
  - e2e mobile at 390×844: the HUD card has no horizontal overflow and the segmented control buttons are ≥ 44 px tall.
- [ ] **Step 2:** Run the tests. Expected: FAIL. Implement. Run again. Expected: PASS. Then run `pnpm run check`.
- [ ] **Step 3:** Commit: "Plane view HUD: camera modes, next aircraft, flight telemetry". Open and merge the Phase E PR, then deploy, as before.

---

## Verification (end to end)

- After each phase: `pnpm run check` (format, lint, typecheck, unit and validation tests, build, bundle budget) and `pnpm test:e2e --trace off` all pass.
- `pnpm audit` reports no moderate or high advisories. The user confirms the GitHub Dependabot count.
- After each phase deploy:
  - the `github-pages` deployment for the merge SHA reports `success`;
  - the live site's entry script matches `docs/assets/` on `main`, `models/buoy.glb` returns 200, and the CSP meta tag is present in the live HTML;
  - a Playwright smoke run against the live URL shows a canvas, an advancing clock, no console errors and no CSP violations.
- The user sees horizon screenshots confirming the looming structures are gone (Task 1, Step 5).

## Execution

Native, as the user requested: I implement every task inline, in order 0 → 9, with one PR plus a deploy PR per phase.

- Phase A: Tasks 1–3.
- Phase B: Tasks 4–5.
- Phase C: Tasks 6–7.
- Phase D: Tasks 8–9.
- Phase E: Tasks 10–12, the aircraft and Plane view. Phase E depends only on Task 7's `TaaPass.reset()`, and only if TAA has already shipped. It can move ahead of Phase D if the user wants it sooner.

A final self-review of the whole branch happens before each phase PR.
