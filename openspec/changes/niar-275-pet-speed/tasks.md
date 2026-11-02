# Tasks

## 1. Measure

- [x] 1.1 `[pet-perf]` line per pet in development builds: context, compiled (JS wait), first frame, still, kept motion, GL contexts this session.
- [ ] 1.2 Read the lines on a real phone: cold start, return to chat, keyboard on Home, profile overview ↔ section.

## 2. Compile without freezing

- [x] 2.1 `createPetShader(..., defer)`: queue compile and link; `finish()` reads status and uniforms; `draw()` waits for it; failures still dispose and fall back.
- [x] 2.2 Native fence: a 1×1 `takeSnapshotAsync` after `endFrameEXP()`; web: KHR_parallel_shader_compile polled once a frame.
- [ ] 2.3 Phone: no stall while a pet compiles (scroll or type during a cold start).

## 3. Snapshot first

- [x] 3.1 Snapshot key of the first frame; busy states and reduced motion excluded.
- [x] 3.2 Save a new pet's first frame once per key (cache folder, newest 24); show a kept still at mount and fade into the live pet.
- [x] 3.3 Bundled still for the default pet, its renderer script and version test.
- [ ] 3.4 Phone: the still is upright and matches the live pet; cold start shows it at once.

## 4. Continue

- [x] 4.1 `pet-store`: one owner per key; keeping ends touch reactions and resets the remembered look.
- [x] 4.2 Home `home`, profile overview and strip `profile`; the appearance preview never shares.

## 5. No size rebuilds

- [x] 5.1 `PetView` keeps its drawing buffer (`drawingSize`), rebuilding only past 1.34× its pixels.
- [x] 5.2 One Home pet for both keyboard states.
- [x] 5.3 The profile pet waits for its box and draws at the stage's largest size.

## 6. Slimmer shader

- [x] 6.1 Single `emote()` call; loops for the emote field, the refraction channels and the normal; compile and pixel comparison against main `1f93f2a` (design D6).

## 7. Verification

- [x] 7.1 Jest suites for the store, snapshot keying, PetView start, the single Home pet and the profile pet; existing pet suites green.
- [x] 7.2 `npm run lint`, `npm run typecheck`, `npm test`.
