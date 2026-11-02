# Design

## Context

`packages/ui/PetView.tsx` draws every pet with expo-gl (`GLView`, one GL context and GL thread per view) and `packages/ui/pet-shader.ts`. expo-gl queues GL calls from JS and runs them on its GL thread; any call that returns a value (`getShaderParameter`, `getProgramParameter`, `getUniformLocation`, …) blocks JS until the thread has run everything before it (`EXGLNativeContext.cpp` `addBlockingToNextBatch`). Queued calls reach the thread only when a batch ends (`endFrameEXP`). A new view is built on every return to the chat tab (`App.tsx` keys section content), on every keyboard toggle on Home (two different pets, 220 and 140 pt), on every pet profile step, and whenever a pet's size changes (`<Surface key={pixels}>`).

## Decisions

### D1. Measurement (`pet-perf.ts`)

`petPerf(label)` returns null outside `__DEV__` and under Jest, so release builds pay nothing. Each `PetView` marks: `context` (GL context created, also counted for the session), `compiled` (with how long JS waited in `finish()`), `first frame`, `still saved`; one line is printed after the first frame (or after the still is saved):

```
[pet-perf] home 220pt: context 41ms, compiled 702ms (JS waited 9ms), first frame 731ms, still saved 760ms; motion new, still shown; GL contexts this session 3
```

On a phone: `npx expo start --dev-client` shows it in the Metro terminal; with a USB phone, `adb logcat -s ReactNativeJS:V | grep pet-perf`.

### D2. Compile off the JS thread

`createPetShader(gl, background, defer)` with `defer` only queues create/source/compile/attach/link and asks nothing. `PetView` then calls `gl.endFrameEXP()` to hand the batch to the GL thread and awaits `glSettled(gl)`:

- native (`pet-snapshot-io.ts`): `GLView.takeSnapshotAsync` of a 1×1 rect. It is the only expo-gl promise that settles on the GL thread after the queued work (`GLContext.takeSnapshot`: `flush()`, then `runAsync`), so it resolves once the compile is done without blocking JS; the tiny file is deleted at once.
- web (`pet-snapshot-io.web.ts`): polls `compiling()` once a frame, which reads `COMPLETION_STATUS_KHR` when the browser has KHR_parallel_shader_compile (enabled before compiling); without it, it continues on the next frame and the first query waits once, as before.

`finish()` then checks compile and link status (throwing, after disposing, on failure: `PetView` shows the still drawing), looks up the 43 uniforms (each a short round trip now that the thread is idle) and sets the defaults. `draw()` does nothing before it. Without `defer` everything happens at once, as before (`apps/server-admin` and the shader tests use that path).

Rejected: polling the status on the next frame (it blocks for the rest of the compile); `gl.flush()` (only queues).

### D3. Snapshot first (`pet-snapshot.ts`)

A new pet's first frame is drawn at clock 2 with a zero step, no touch, no morph and no level, so it depends only on: shader source, shape, tint, ink counts, card colour, idle or resting, drawing pixels. `petSnapshotKey` joins exactly those (the shader as an FNV-1a hash of its source, so a changed renderer never shows an old frame); busy states (listening, working, speaking, whose first frame follows live input) and reduced motion are not kept.

- After a new pet's first frame, if the key has no saved still and the motion is still at clock 2 (not a kept motion, D4), `PetView` saves it with `takeSnapshotAsync` (PNG), drawing nothing in between so the snapshot is that frame. Native moves the file to `cache/pet-snapshots/pet-<hash>.png` (newest 24 kept), so a cold start finds it; web keeps a blob URL for the session.
- On mount, `petSnapshot(key)` returns a still from memory, then the cache folder, then the bundled still. It is shown as an `Image` (no Android fade) above the hidden surface; when the live pet draws, it fades out over `t.motion.stateTransition` and the live pet appears without its scale-in. With a still, the 1.2 s fallback drawing never shows.
- The bundled still (`packages/ui/assets/pet-still.png`, 300 px, 75 KB) is the default look on the app's card at idle, which is the pet before pairing and before the profile arrives; it matches that look at any drawing size. `scripts/render-pet-still.ts` records the renderer's GL calls in Node and replays them in headless Chrome on SwiftShader, so it does not depend on a GPU; it stamps `BUNDLED_STILL_VERSION`, and a test fails when the shader changes until it is run again.

**Interaction with D4.** A kept motion continues at a later clock, so its first frame is not the keyed one. Options: (a) snapshot on unmount: expo-gl destroys the context on unmount, the snapshot races that teardown and is unverified on devices; (b) continue only face and timers: the play state stores absolute clock times throughout, so rewinding the clock means rebasing every one of them; (c) keep stills only for new pets and cross-fade. Chosen (c), the simplest correct one: a still is only ever saved from a new pet, so it is exactly that pet's first frame; a kept pet shows the still of its look and fades into its own pose (the ink clouds shift softly for 220 ms). A kept motion never saves a still.

### D4. Kept motion (`pet-store.ts`)

`PetView` takes an optional `motionKey` (read at mount). A layout effect claims the kept motion for the key before the effects that read it; its cleanup keeps the motion for the next view (layout cleanups of the old view run before layout effects of the new one in the same commit, so a section swap hands it over). One owner per key: a second view mounted under a key in use gets a new motion and never keeps it. Keeping ends any touch reaction (`resetPetInteraction`, as every lifecycle change already did) and clears the remembered look, so today's look is applied as a first appearance, never a morph. Keys: `home` (Home, typing included) and `profile` (the profile overview and the section strip, never on screen together). The appearance sheet's preview has no key, so it never shares the overview's motion. The chat top bar pet (`App.tsx`) is unchanged here (another change owns that file).

### D5. No rebuilds for size

- `PetView` keeps the drawing buffer it started with (`drawingSize`, default: the first `size`); a new `size` only changes the scale of the surface. Only a view that needs more than 1.34× its pixels gets a new buffer (and context).
- Home renders one pet for both states: `size` 220 or 140 (keyboard open), `drawingSize` 220, `motionKey` `home`; the stage keeps its test IDs (`home-pet-stage` / `home-pet-compact`), loses the headline while typing, and ignores layout while compact as before. Touch and microphone level stay off while typing, as before.
- The profile pet waits for its box's first layout (no pet at a guessed size) and draws at the stage's largest size (`petMax`), so the page measuring the room it fills only scales it.

### D6. Slimmer shader

Compile time follows how much code the driver inlines. Changes, each kept only if it rendered the same frames as the approved renderer (main `1f93f2a`):

1. The body's shading moved into `water()`, called once, so `main()` has a single `emote()` call site (the early return for background pixels inlined a second copy). Pixel-identical.
2. `emote()`'s field and its two gradient samples come from one 3-pass loop (the field `emoteD` is compiled once). Pixel-identical.
3. The three refraction channels (`through()`, each with the studio `backdrop()`) come from a 3-pass loop. Pixel-identical.
4. `normalAt()`'s four samples come from a 4-pass loop (each sample inlined the whole body). Up to one level in one channel on about 0.004% of pixels (floating-point order), well under the shader's own ±0.5-level dither.

Harness (scratchpad, not shipped): esbuild bundles of both renderers in headless Chromium 1243, ANGLE on an NVIDIA RTX 5070 Ti, and SwiftShader as a CPU stand-in for a slow GPU; cold compile measured in a fresh browser per run with shader caches off.

| | Approved (main) | NIAR-275 |
| --- | --- | --- |
| Compile + link, GPU, median of 5 cold runs | 1261 ms | 607 ms |
| First frame, SwiftShader (compiles at first draw), median of 3 | 1088 ms | 664 ms |
| Steady frame, SwiftShader | 28.8 ms | 21.5 ms |
| Steady frame, GPU | 0.2 ms | 0.2 ms |

Pixel comparison, 330 px and 84 px canvases, 586 frames each: default look on the dark and the light card through 40 s of taps, hugs, strokes, keys and typing (signs in 54 frames), a custom look, all ten shapes, resting, listening, working, speaking, reduced motion and a morph. 330 px: every frame within one level; 2,703 differing pixels of 64 million (84 px: also within one level). The relative gain on phones is expected to be similar but must be measured there (D1).

## Verification

- Jest: `tests/pet-store.test.ts`, `tests/pet-snapshot.test.ts` (keying, bundled still version), `tests/pet-view-speed.test.tsx` (deferred compile, compile failure, first-frame still, kept still, kept motion, size), `tests/home-pet-single.test.tsx`, `tests/pet-profile-pet-layout.test.tsx`; existing pet suites unchanged except the stall-fallback test (now a look without a still) and one profile test that measures the pet's box.
- Real phone (not done here): the `[pet-perf]` lines for a cold start, return to chat, keyboard toggle and profile steps; that the still is upright and matches the live pet (Android snapshot orientation); that the app does not stall while a pet compiles; the cross-fade on a kept pet.
