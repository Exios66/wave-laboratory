# Wave Laboratory: Sky Light & Hull Contact (Phase F) Design and Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (no subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three visual upgrades the user chose after the hardening plan (`2026-11-12-visuals-performance-hardening.md`, Tasks 0–13, all merged and deployed): lit volumetric clouds with their shadows on the sea, sun shafts, and hull–water contact (a wet band on hulls and a foam collar and bow cushion where hulls cut the water).

**Architecture:** As in the previous plan. Work lands on `claude/hopeful-shannon-f2xayr`, reaches `main` through one PR with a merge commit, and is deployed with `pnpm deploy:pages`. The pure logic goes in small, separately tested modules (`src/render/sky/clouds.ts`, `src/render/post/sunShafts.ts`, `src/render/vessel/hullWetting.ts`). The GPU work extends the existing shared `SKY` GLSL, `PostStack` and `WAKE_GLSL` code, plus a hull-material hook.

**Global constraints:** the same as the previous plan. In short: commit author `Jack J Burleson // LJM`, no trailers, plain pushes only, merge only on green checks with no open threads, `pnpm run check` and `pnpm test:e2e --trace off` before the PR, and saved settings stay backward compatible.

---

## Handoff (2026-11-14) — start here

**Tracker:** [Exios66/wave-laboratory#81](https://github.com/Exios66/wave-laboratory/issues/81) (master tracker: roadmap status and agent handoff). Update it at every handoff.

**Branch:** `claude/hopeful-shannon-f2xayr`, pushed. It is ahead of `main` (261979b, after PR #80) by the Phase F commits below. There is no Phase F PR yet. `pnpm vitest run` gives 933 passed at 5dbc20f, and lint and typecheck are clean.

| Task                  | State   | Commit  | Notes                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 Volumetric clouds  | ✅ done | 90868c2 | See the deviation below (baked coverage map). Screenshots looked right at noon (40–45 %) and at golden hour (50 %).                                                                                                                                                                                                                           |
| F2 Sun shafts         | ✅ done | ec1f61c | Tuned (mask 2–5, radius 0.35, decay 0.95, gain 0.55) and e2e added. Screenshot `docs/screenshots/sun-shafts-golden-hour.jpg`. The wash in the first Bridge shot was the golden-hour fog and glow, not the shafts.                                                                                                                             |
| F3 Hull–water contact | ✅ done | 8b02efc | Pure `hullWetting.ts`, material hook, `OCEAN_DISPLACEMENT_GLSL` chunk, collar, bow cushion and crest in `WAKE_GLSL`, `ship.z` contact, reach growth. Draw calls unchanged. Screenshots `docs/screenshots/hull-contact-*.jpg`. A 0 kn vs 18 kn pair was not taken: under SwiftShader the sim runs too slowly for a speed order to take effect. |
| F4 Docs, PR, deploy   | ⏳ todo | —       | The F1 Step 4 storm-preset and Plane-through-a-deck screenshots are still owed.                                                                                                                                                                                                                                                               |

**F3 note:** `hullHalfWidth` starts its bow curve at the stem (`smoothstep(0, 0.3L, s)`) rather than at −0.02 L, so the half-width is 0 at the stem as the Step 1 test requires. The GLSL mirror uses the live bow-to-stern segment length for L.

**Deviation from §3.1 (already implemented in F1):** the march reads the deck coverage from a **baked, world-anchored map** (`src/render/sky/cloudMap.ts`: 1024², 72 km, RGBA8 with mipmaps). It does not evaluate noise per sample. The per-sample noise version stalled SwiftShader at High from the Bridge camera. The map stores the raw fractal noise, and the cover threshold is applied at sampling, so a change of cover needs no redraw. The map redraws only when the eye (in the drifting frame) moves more than 9 km, snapped to texels. The sky-environment cube is now drawn from the camera position (`SkyEnvironmentKey.eye`).

**Screenshot recipe:** a Playwright script at 960×540, `?gfx=full`, `wave-lab:performance` set to `medium`, and `wave-lab:ambience.startHour` set to the hour you want. Set the cloud cover through Weather → "Cloud cover", choose the Bridge radio, then click "Enlarge view" (with `force`, and a long timeout). At High or Ultra under SwiftShader the page can be too slow to click.

---

## 1. Requirements

### Functional

| #   | Requirement                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Clouds have volume. Tops lit toward the sun, darker bases as the deck thickens, bright silver edges when the sun is behind them, warm tops at golden hour. At night they stay dark and lightning still lights them from inside.                                        |
| F2  | Clouds are anchored to the world, not the camera. A camera that flies (the Plane view reaches 1.5 km) moves past them, and can enter or climb above a low deck.                                                                                                        |
| F3  | Cloud shadows drift over the sea. They dim the sun glint and the direct sunlight on the water, use the same cloud field the sky shows, and move with the wind.                                                                                                         |
| F4  | Sun shafts (crepuscular rays) stream from the sun's screen position through gaps in clouds and past masts, islands and hulls. They are strongest in hazy air with broken cloud, and absent underwater, at night, under full overcast, or with the sun well off screen. |
| F5  | Hulls show a wet band above the moving waterline. It is darker and glossier, its height grows with sea state, roll and speed, it rises higher at the bow, and it has drip streaks. A thin line of foam clings to the hull at the water.                                |
| F6  | The water has a foam collar hugging each surface hull and a bow cushion and bow-wave crest ahead of the stem. Both grow with speed (Froude number) and sea state, and there is a gentle collar even when the hull is stopped.                                          |

### Non-functional

- **GPU budget** (PLAN §9: about 3.5 ms for sky, particles and post): the new clouds cost ≤ 0.6 ms at 1440p on the `ultra` quality, shafts ≤ 0.4 ms (quarter-resolution march), hull wetting ≤ 0.05 ms, collar ≤ 0.1 ms.
- **Tiers.** `low` quality keeps today's flat cloud deck (0 march steps). Shafts run only on the `full` device tier with HDR targets. Wetting and the collar are cheap enough to run everywhere.
- **Determinism.** Purely visual. Nothing feeds back into the forces, so there is no schema change and no change to the simulation.
- **Compatibility.** The new display toggle `sunShafts` reads as `'auto'` for settings saved before it existed. Old experiments load unchanged.
- **Testability.** All parameter maths (deck geometry, marching weights, phase function, shaft strength, sun-on-screen fade, wet-height envelope) is pure TypeScript with Node unit tests. The GLSL mirrors it, the way `foamSim.ts` mirrors `FOAM_GLSL`.

### Constraints

- WebGL 2 through three 0.186. No compute shaders and no 3D textures in the sky path (the existing 2D value noise is kept).
- SwiftShader e2e: shaders must compile there and the frame must stay free of console errors.
- The sky GLSL is shared by the dome, the 64 px sky-environment cube, and the water's reflection lookup. The water calls it once per water pixel, so the reflection path needs a cheap mode.

## 2. High-level design

```
                    ┌──────────────── LabRenderer.frame() ─────────────────┐
 weather, wind ───► │ cloudDeck(cover) ─► uCloudDeck (base, top, steps)    │
 quality budget ──► │ wetting.step(vessel motion, Hs) ─► per-hull uWet     │
 camera, sun   ───► │ shaftParams(sun, camera, cloud, fog) ─► PostStack    │
                    └───────┬──────────────────┬──────────────────┬────────┘
                            ▼                  ▼                  ▼
   SKY GLSL (shared)                     hull material hook   PostStack
   cloudMarch(ro, dir, steps)            (onBeforeCompile)    RenderPass → marker(records
     ├─ sky dome: N steps                 vertex: η from the    scene depth) → underwater →
     ├─ sky cube (IBL): N steps           ocean's cascade      TAA → SunShaftPass(mask ¼ →
     └─ water reflection: 1 step          textures + regular   radial march ¼ → add) → lens
   cloudShadow(worldPos) ─► ocean frag    waves (shared        → bloom → grade → output
     (dims glitter + direct sun)          uniforms)
   WAKE_GLSL per vessel: + collar,        frag: darken, gloss,
     bow cushion, bow-wave crest          drips, foam line
```

**Data flow.** Every input already exists on the render side: cloud cover, wind drift, sun and moon directions, fog density, the ocean's cascade textures and regular-wave uniforms, the vessel poses, and the wake sources. No new data crosses from the simulation worker.

## 3. Deep dive

### 3.1 Volumetric clouds (`src/render/sky/clouds.ts` + `SKY` GLSL)

**Deck geometry** (pure, unit tested): `cloudDeck(cover)` returns `{ baseKm, topKm }`.

- The base sits at 1.2 km (fair-weather cumulus) and drops to 0.6 km in storms (cover ≥ 0.85), so storm decks sit low and heavy.
- The thickness is 0.35 km at cover 0.1, rising to 2.4 km at cover 1.
- Constraints: base < top, and both are monotone in cover.

**Coverage field.** The existing 2D fbm `f(p)` on the deck plane, with `p` in km and world-anchored: `p = (cameraXZ + dir.xz · t) / 1000 + drift`. Cloud is present where `f > 1 − cover`. Its local column height is `colH = smoothstep(thr, thr + 0.35, f)`, so thicker parts tower: cumulus domes with flat bases. The density at height fraction `h` is `smoothstep(0, 0.08, h) · (1 − smoothstep(colH − 0.2, colH, h)) · ρ(cover)`.

**March.** Intersect the ray from the camera (Three.js y = height) with the slab `[base, top]`. Accept entry distance `t0 ≥ 0`, and cap the path at 8 km so near-horizon rays stay bounded; beyond the cap the far deck is extended with the flat single-sample estimate, faded with distance. Take N steps at the step midpoints, with a per-pixel blue-noise-free hash offset (TAA smooths it, and no texture is needed).

- **Light at a sample:** 2 samples toward the sun at 0.12 km and 0.4 km, using 2-octave noise. Their optical depth τ_L gives `sunT = exp(−τ_L)·(1 − exp(−2τ_L))·2` (Beer–Lambert with the "powder" term, normalised so a thin edge isn't black).
- **Phase:** a two-lobe Henyey–Greenstein phase, `0.7·HG(0.6) + 0.3·HG(−0.25)`, which gives silver linings toward the sun.
- **Ambient:** sky ambient times `mix(0.45, 1.0, h)`, so the bases are darker.
- **Accumulation:** standard front-to-back. Exit early when T < 0.02.

**Output.** `vec4(premultiplied colour, 1 − T)`. It replaces `mix(col, cloudColor(...), d·0.92)` in `skyColorExt`. The sun disc and stars are hidden by `1 − T`, as `d` hides them today.

**Modes.** `skyColorExt(dir, sun, discs)` keeps its signature. A uniform `uCloudSteps` selects the march (0 means the legacy flat deck). The water's reflection lookup calls a new `skyColorRefl` that uses a single mid-deck sample with the same lighting model. It is consistent in colour, and it is what rough water blurs anyway. `skyBlurred` stays as it is.

**Night and lightning.** The sun term is multiplied by `daylight()`. A moonlit term uses `uMoonDir` at 0.06 intensity. `uFlash` lights the volume as `0.8 · flash · (1 − T)` from inside.

**Shadows on the sea** (`cloudShadow(worldPos)` in the ocean frag): one coverage sample where the sun ray from the water point meets mid-deck, at `p = (pos.xz + sun.xz / sun.y · midHeight) / 1000 + drift`. Shadow = `1 − 0.75 · density · smoothstep(0.05, 0.2, sun.y)`. Under full overcast the direct sun is already gone, so the term is faded out by `overcastAmount()`. It multiplies the glitter, the direct-sun diffuse and the subsurface terms, but not the sky reflection.

**IBL cube.** `SkyEnvironment` renders the dome material, so the cube automatically gets volumetric clouds. Its camera sits at the origin, so its clouds are offset by the camera position. That's negligible after the PMREM blur, so it is left as is.

**Budgets.** Steps: low 0, medium 4, high 6, ultra 8. These go in `BUDGET[quality].cloudSteps`.

### 3.2 Sun shafts (`src/render/post/sunShafts.ts` + `SunShaftPass`)

**Pure functions:**

- `sunScreen(sunDirWorld, camera) → { x, y, facing }`: the sun projected at infinity, in uv.
- `shaftStrength({ sunY, cloud, fogDensity, night, facing, x, y })`:
  - It is zero when `facing ≤ 0`, the sun is below the horizon, at night, or underwater.
  - Broken cloud is favoured: the strength peaks at cover ≈ 0.5 and falls toward 0 and toward 0.95.
  - Haze (higher fog density) makes it stronger.
  - It fades as the sun moves more than 0.35 of the view outside the frame.
  - Output is clamped to [0, 1].

**Pass (GPU Gems 3, ch. 13, after Mitchell).** The pass runs after TAA, so its noise doesn't enter the TAA history and it reads a stable image.

1. **Mask**, at ¼ resolution: sky pixels only (scene depth at the far plane), luminance above 0.9× the threshold, weighted by `pow(max(dot(viewDir, sun), 0), 6)`. The scene depth is recorded by the scene-done marker (`MarkerPass` remembers `readBuffer.depthTexture`), because TAA swaps the buffers.
2. **Radial march**, at ¼ resolution: 40 samples from each pixel toward the sun's uv, with decay 0.965 per sample and a per-pixel jitter.
3. **Composite**, at full resolution: `colour += shafts · sunTint · strength · 0.9`, upsampled bilinearly.

**Gating.** A new display preference `sunShafts: 'auto' | 'on' | 'off'`, where `auto` means the `full` tier only. The `PostStack` runs the pass when `shaftsRunning`: supported, enabled, not underwater, and strength > 0.01. On its own it never forces the chain active unless strength is above zero.

### 3.3 Hull–water contact

#### 3.3.1 Wet band (`src/render/vessel/hullWetting.ts` + material hook)

**Pure model.** `wetTarget({ hs, rollAmp, heaveAmp, pitchAmp, speed, length, beam })` returns the target wet height above the waterline [m]:
`0.15 + 0.32·Hs + 0.5·B·|sin roll| + heaveAmp + min(U²/(2g), 0.08·L)·bowOnly`.
It returns `{ side, bow }`, both clamped to [0.1, 6].

`stepWetEnvelope(current, target, dt)` is asymmetric. It rises with a time constant of 0.4 s (water climbs fast) and falls with a time constant of 25 s (the hull dries slowly).

The motion amplitudes are envelopes of the pose: |roll|, and |heave − mean| tracked with a 6 s window, using the same asymmetric stepping.

**Material hook.** `applyHullWetting(mat, oceanUniforms)` uses `onBeforeCompile` with its own `customProgramCacheKey`, chained after any existing hook.

- **Vertex:** compute the world position, then η at its (x, −z) − drift from the cascade textures (`textureLod` at lod 1.5, which low-passes ripples) plus the regular waves (the ocean's own `regularSample` code, shared by extracting it into a GLSL chunk). Pass `vWetS = worldY − η` and `vWetBow` (the body-frame forward fraction from the local position) as varyings.
- **Fragment:**
  - `top = mix(uWet.x, uWet.y, smoothstep(0.55, 0.95, vWetBow))`.
  - Drip streaks: `top += (vnoise(vec2(localAlongHull · 6, worldY · 0.6)) − 0.5) · 0.35 · top`.
  - `wet = 1 − smoothstep(top − 0.1, top + 0.15, vWetS)`.
  - `diffuseColor.rgb *= mix(1, 0.6, wet)` and `roughnessFactor = mix(r, 0.1, wet)`.
  - Foam line: `line = (1 − smoothstep(0.0, 0.12 + 0.05·Hs, abs(vWetS − 0.03))) · noise`, mixed toward foam white (0.9) at up to 0.7.
- **Applied to:** the hull material of every built vessel (`buildVessel`). Traffic GLB ships are a later item.

#### 3.3.2 Collar, bow cushion and bow wave (in `WAKE_GLSL`)

**Inputs.** `ship.z` (unused today) carries the contact strength `c ∈ [0, 1]`: 1 for a surface hull, 0 for a submerged submarine or an airborne object. `WakeSource.contact?: number` defaults to 1.

**Footprint.** Segment 0–1 of the track is the live bow → stern. With `s` the distance aft of the bow along the track and `lat` the lateral distance, the half-width is `hw(s) = 0.5·B·pow(smoothstep(−0.02L, 0.3L, s), 0.6)·(1 − 0.25·smoothstep(0.8L, L, s))`, which mirrors `hullHalfWidth()` in `wakes.ts`.

**Collar.** It applies for `s ∈ [−0.03L, 1.02L]`:

- Band: `band = 1 − smoothstep(0, w, lat − hw)` with `w = 0.35 + 0.04B + 0.12U + 0.2Hs`, gated by `lat > hw − 0.3`.
- Breakup: `smoothstep(0.35, 0.75, vnoise(…))`, fixed to the water frame.
- Intensity: `(0.3 + 0.35·go + 0.25·min(Hs/3, 1)) · c`.

**Bow cushion and crest.** Ahead of the stem (s < 0) the main loop skips points. A separate check near point 0 handles this:

- Cushion: a disc of radius `0.4B·(0.4 + fn)`, but only with `fn > 0.05`.
- Bow-wave crest: a band along `lat ≈ hw(s) + 0.15B·fn` for `s < 0.25L`, with intensity `smoothstep(0.08, 0.3, fn)`.

**Box.** The wake bounding box (`reach`) already covers beam + 2 m around the bow and stern. `reach` grows to cover `w`.

## 4. Scale and performance

| Effect                  | Cost driver                                                                                                                                                                                       | Mitigation                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Cloud march             | sky pixels × steps × (1 + 2 light) noise evaluations. At 1440p with 40 % sky that's ≈ 1.5 M px × 8 × 3 ≈ 36 M fbm evaluations (5 octaves primary, 2 light): about 0.5 ms on an RTX 3060 class GPU | Step budgets by quality; early exit at T < 0.02; empty columns skipped by coverage |
| Reflection clouds       | water pixels × 1 sample                                                                                                                                                                           | Single-sample mode                                                                 |
| Shafts                  | ¼-resolution mask + 40-tap march; full-resolution add                                                                                                                                             | Skipped when strength = 0 (most frames at night, overcast, sun behind the camera)  |
| Wetting vertex sampling | hull vertices × (4 cascades + regular waves)                                                                                                                                                      | A few thousand vertices per hull                                                   |
| Collar                  | inside the existing per-vessel wake loop, which is already box-culled                                                                                                                             | Only the pixels inside a vessel's box pay                                          |

The new GPU-timer passes need no new bucket: shafts fall in 'post' and clouds in 'scene'.

## 5. Trade-offs

| Decision                          | Chosen                                              | Alternative                                           | Why                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud volume source               | 2D coverage field × analytic vertical profile       | 3D Worley/Perlin texture (Schneider 2015)             | No 3D-texture bake or memory, it reuses the existing deck noise, and the sky stays matched to today's drift and squall timing. The cost is less detailed wisps. |
| March every frame vs a cached sky | Every frame                                         | Render the sky to a half-resolution target, reproject | Simpler, TAA cleans the noise, and it is within budget. Revisit if the sky shows up in the GPU timings.                                                         |
| Shafts                            | Screen-space radial blur                            | Ray-marched shadowed air (froxels)                    | Cheap, and good enough for a single dominant light. It can't show shafts with the sun behind the camera, which is accepted.                                     |
| Wet band memory                   | One per-vessel envelope height                      | A per-texel wetness map on the hull UVs               | Built hulls have no UVs. An envelope reads correctly because wetting is driven by the largest recent excursions.                                                |
| η on the hull                     | Sample the GPU cascades in the hull's vertex shader | CPU evaluation of the ocean field per vertex          | The render side has no CPU ocean. The GPU textures are already the drawn sea, so the wet line matches what the user sees.                                       |
| Bow wave                          | Foam crest and cushion only                         | Vertex displacement of the sea near the bow           | Displacement can poke water through hollow hull interiors and it isn't in the physics. Deferred.                                                                |

## 6. What to revisit as the system grows

- Cache the cloud layer in a half-resolution sky target if the sky passes 0.6 ms, or if a WebGPU backend lands (it could then use a 3D noise volume).
- Use a true per-texel hull wetness map once hull meshes carry UVs, and apply wetting to the traffic GLB ships.
- Displace the sea for the bow wave together with the planned grid-solver hull pressure source (PLAN §5.4).
- Bring shafts underwater into the existing underwater god rays, sharing one radial pass.

---

## Tasks

### Task F1: Volumetric clouds and cloud shadows

**Files:** Create `src/render/sky/clouds.ts` and `src/render/sky/clouds.test.ts`. Modify `src/render/ocean/shaders.ts` (SKY, OCEAN_FRAG) and `src/render/LabRenderer.ts` (uniforms, BUDGET.cloudSteps, the dome's camera-height uniform).

- [x] **Step 1: Failing tests.** `cloudDeck`: base < top, top rises and base falls with cover, and the values match the spec at cover 0.1 and 1. `hgPhase` integrates to about 1 over the sphere, and forward scattering is greater than back scattering for g > 0. `powderSun(τ)` is 0 at τ = 0 only through the powder term, peaks, and then decays. `slabSpan(camY, dirY, base, top, cap)`: below the deck looking up, inside the deck, above the deck looking down, and parallel rays.
- [x] **Step 2:** Watch them fail (RED). Implement. Watch them pass (GREEN).
- [x] **Step 3: GLSL.** Add `cloudMarch` and the single-sample reflection mode, mirroring the TypeScript. Add `uCloudSteps` and `uCloudDeck` (vec2: base, top km), and the camera position (the built-in `cameraPosition`). Add `cloudShadow` in the ocean frag on the direct sun terms.
- [ ] **Step 4:** Run `pnpm run check`. Take screenshots at `?gfx=full` for cover 0.3 at noon, cover 0.5 at golden hour, the storm preset, and the Plane view at altitude. Show them to the user. _(Partial: the noon 40–45 % and golden-hour 50 % shots are done. **Still to do:** the storm preset, and the Plane view climbing through or above a low deck. Do these during F4.)_
- [x] **Step 5:** Commit: "Lit volumetric clouds anchored to the world, with their shadows on the sea".

### Task F2: Sun shafts

**Files:** Create `src/render/post/sunShafts.ts`, `sunShafts.test.ts` and `SunShaftPass.ts`. Modify `PostStack.ts` (the marker records depth, the pass order, `shaftsRunning`), `PostStack.test.ts`, `api.ts` (`PostSettings.shafts`), `src/ui/deviceProfile.ts` (and its test), `Dialogs.tsx` (the toggle) and `LabRenderer.ts`.

- [x] **Step 1: Failing tests.** `sunScreen` gives the centre for a sun straight ahead and `facing ≤ 0` behind the camera. `shaftStrength` is 0 at night, with the sun behind, with the sun below the horizon, and at cover 1; it peaks near cover 0.5; it rises with fog density; it fades off screen. The display sanitiser reads missing `sunShafts` as `'auto'` and resolves `auto` to on only on the full tier. The `PostStack.active` truth table covers shafts with strength 0 and > 0.
- [x] **Step 2:** RED, implement, GREEN.
- [x] **Step 3:** Write the pass (mask → march → composite) and wire it up.
- [x] **Step 4:** Add the e2e test `test('sun shafts: renders toward a low sun, no console errors')` in `graphics.spec.ts`. Take a screenshot of the sun behind broken cloud and the sloop's rig.
- [x] **Step 5:** Commit: "Sun shafts through broken cloud and past rigging".

### Task F3: Hull–water contact

**Files:** Create `src/render/vessel/hullWetting.ts`, `hullWetting.test.ts` and `hullWettingMaterial.ts`. Modify `shaders.ts` (extract the regular-wave chunk, add collar and bow terms to `WAKE_GLSL`), `scene/wakes.ts` (contact, `hullHalfWidth`, reach), `scene/wakes.test.ts` and `LabRenderer.ts`.

- [x] **Step 1: Failing tests.** `wetTarget` rises with Hs, roll and speed; the bow is at least the side; the clamps hold. `stepWetEnvelope` rises fast and decays slowly (within 0.4 s and 25 s time constants, ±10 %). `hullHalfWidth` is 0 at the stem, B/2 amidships, and narrower at the transom. The wake upload writes contact into `ship.z` (default 1) and grows the box by the collar width.
- [x] **Step 2:** RED, implement, GREEN.
- [x] **Step 3:** Write the material hook and the collar GLSL. Check that `budget.test.ts` draw calls are unchanged (no new draws).
- [x] **Step 4:** Take screenshots: a ship at 0 kn and at 18 kn in Hs 1 m and 4 m (Bridge and Orbit views). Show them to the user.
- [x] **Step 5:** Commit: "Hull–water contact: wet bands, foam collars and bow cushions".

### Task F4: Integrate, review, ship

- [ ] Update `docs/ARCHITECTURE.md` (sky, post chain, hull contact) and the PLAN.md §0 table (Phase 7 rows).
- [ ] Run `pnpm run check && pnpm test:e2e --trace off`.
- [ ] Open the PR "Volumetric clouds, sun shafts and hull–water contact" and merge it under the constraints. Then `pnpm deploy:pages` and a deploy PR, as before.
