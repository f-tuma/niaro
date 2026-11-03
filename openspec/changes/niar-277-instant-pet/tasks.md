# Tasks

## 1. Find the empty time

- [x] 1.1 Record cold starts and tab switches on the emulator, fast and throttled, and cut them into frames; list each cause with its evidence (design, Causes found).
- [x] 1.2 Trace the recording start for anything that waits for the pet (design D6).

## 2. Always a stand-in (NIAR-277)

- [x] 2.1 Still lookup by body: exact frame, same body in the same or another state, bundled still; file names carry the body and state; the cache folder is read once.
- [x] 2.2 The vector drawing stands in from the first frame when there is no picture, and under a picture until it is decoded; a late picture cross-fades over it.
- [x] 2.3 Nothing draws before the shader is finished; the stand-in leaves only after the GL thread has drawn the first frame; a hidden pet draws its first frame.
- [x] 2.4 The last look is remembered for the next start; the first screen waits for the pet's still (at most 400 ms).

## 3. One pet for the app run (NIAR-276)

- [x] 3.1 `PetStage` at the app root creates the only live pet while the app starts; `PetSlot` places it; the newest slot holds it.
- [x] 3.2 UI-thread following with translations only; clipping to the scrolling area with two layers; shown once measured.
- [x] 3.3 Touch and accessibility through the slot; the drawn pet is hidden from both.
- [x] 3.4 Slots for Home (both), the chat top bar, the pet profile and its strip, and the voice sheet; the appearance preview stays its own pet.
- [x] 3.5 Pet screens fade in without the native-driven slide.
- [x] 3.6 `[pet-perf]` stage lines with the session's GL context count.

## 4. Recording

- [x] 4.1 The voice sheet's pet is a slot: no GL view is made while the microphone starts; test that "Listening" follows the microphone alone.

## 5. Verification

- [x] 5.1 Jest: stage, placement and remembered look, PetView stand-ins and compile gate, still lookup, listening.
- [x] 5.2 `npm run lint`, `npm run typecheck`, `npm test`.
- [x] 5.3 Emulator: throttled cold start without an empty pet frame; tab switch with one GL context; custom look first launch, changed ink.
- [ ] 5.4 Real slow phone, paired: tour Home → chat → profile → voice with `GL contexts this session 1`; scrolling the profile; strokes and taps through the slot; TalkBack order; a release build.
