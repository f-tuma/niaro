# Design

## Context

NIAR-275 (`openspec/changes/niar-275-pet-speed`, D1 to D6) made one pet start faster: a deferred compile, a still of its first frame, kept motion, no rebuilds for size. Every screen still built its own `PetView` (Home, chat top bar, pet profile and strip, voice sheet), each with a new expo-gl context. NIAR-277 asks for no empty pet frame ever and for recording not to wait for the pet; NIAR-276 for one persistent pet, now possible after the App.tsx chat split (NIAR-268).

## Causes found (emulator, dev client, 2026-11-03)

Measured with `[pet-perf]` lines and screen recordings cut into 30 fps frames (scratchpad `niar-277/`); "throttled" means the emulator's process limited to two host cores (`taskset`), a stand-in for a slow phone.

| Cause | Evidence | Status |
| --- | --- | --- |
| A new GL view per screen: context 100 to 330 ms, 650 to 1400 ms throttled, before the compile | `context …ms` per pet, GL contexts counted up per screen | confirmed |
| No still for a new look, changed ink (the profile's look weights are continuous and change), another size (44 pt top bar) or a busy state (the voice sheet's "listening" pet) | `stood in by` / `still none`; snapshot keys include all of them | confirmed in code, seen with a custom look |
| A still is an `Image` decoded off the UI thread: the box is empty until it arrives | throttled cold start, default look, bundled still: 8 frames (267 ms) of empty box after the screen is up (`before-cold-slow`) | confirmed |
| A prop change during the compile woke the draw loop; `draw()` ran before `finish()` (drawing nothing) and marked the first frame, so the still faded onto an empty surface | `first frame` logged without `compiled`, 18 empty frames (600 ms) (`after3-cold-slow`) | confirmed, also in main |
| "First frame" meant queued by JS; the GL thread drew it later under load | `first frame 3025ms, drawn 3214ms` | confirmed |
| Recording mounted a second GL pet (voice sheet) in the same commit that starts the microphone; expo-gl's context creation and `getExtension` block the JS thread, so the microphone-start continuations queue behind it | expo-gl sources (`GLContext.java` `EXGLContextPrepare` on the JS queue, `addBlockingToNextBatch`) | confirmed in code; not timed on a device (needs a paired app) |
| Native-driven entrance slides are invisible to `measure` until they end | the stage's pet 14 px low for 230 ms, then a step (`exp-custom-near`) | confirmed (found while building the stage) |

## Decisions

### D1. One pet, drawn over slots (`PetStage`, `PetSlot`)

`PetStage` wraps the app root (outside `Workspace`, which is keyed by the connection). It mounts one `PetView` (220 pt, drawing buffer fixed, never rebuilt) as soon as the remembered look is read (D5), before the startup gate opens, so the GL context and compile overlap AsyncStorage, the vault and fonts. Screens render `PetSlot` where a pet stands: an empty box of the pet's size that registers its props. The newest slot holds the pet; when it closes, the one under it gets the pet back (the voice sheet over Home). With no slot the pet is hidden and stops drawing.

The slot keeps touch and accessibility in the screen's own place and order: it carries the role, label and state, and forwards responder and accessibility events to the pet's handlers (`PetView` `controls`), with touch coordinates scaled from the slot's size to the pet's. The drawn pet has `pointerEvents="none"` and is hidden from accessibility, so a drag starting on the pet still scrolls the screen as before.

Without a stage (the browser, Storybook, tests of single screens), `PetSlot` renders a `PetView`, so the web keeps its per-screen pets; the stage is native only (`enabled`).

Rejected (research, NIAR-275 report): moving the native GL view between parents (no supported reparenting in React Native; a native module would be needed), keeping screens mounted in an activity (keeps one pet per screen), a different renderer (Rive: another look).

### D2. Following on the UI thread (`pet-stage-follow.tsx`, `pet-stage-place.ts`)

A Reanimated frame callback measures the slot, the stage and the slot's scrolling area every frame and sets translations, a scale and an opacity only: those apply in the frame they are set, while a size (a layout prop) waits for a layout pass and, with JS busy at startup, arrived 700 ms late on the throttled emulator. Clipping to the scrolling area without sizes: two clipping layers the stage's own size, the outer translated to the area's top-left, the inner to end at its bottom-right; what both let through is the area (`petPlacement`, unit-tested). The pet is shown only once its slot is measured; the stage activates in a layout effect, so the pet is placed in the frame its slot first shows.

`measure` reads the shadow tree, which holds a native-driven transform's starting value until the animation ends. The two `Entrance` wrappers around a screen slide its content 7 px each that way; on screens with the big pet (Home, pet profile) they now only fade (`distance 0`, as the profile's own entrance already did).

Slots in the main scroll view are `clipped` to it (`usePetClip` on the scroll view's ref); the top bar and voice sheet slots are not. Overlays drawn inside the app hide the pet through the slot's `visible`, the signals App.tsx already computed (menu, history, processes, voice settings, mentions, scroll visibility). Native modals (the appearance sheet, the chat options) are above the stage anyway.

### D3. Always a stand-in (`PetView`)

Until the live pet has drawn, `PetView` shows, from its first frame:

1. the still of its exact first frame (NIAR-275 D3);
2. else the newest still of the same body: renderer, shape, colour and card, any ink, size or state (same state preferred). Files are now named `pet-<body>-<state>-<frame>.png`; the cache folder is listed once, synchronously, at the first pet;
3. else the bundled still, which covers the default body at any ink and size;
4. else, and underneath any image until it is decoded, the vector drawing of the look (`PetFallback`), which needs no file, decoding or GL, so it is on screen in the same frame.

An image decoded within 120 ms simply shows; a later one is hidden until decoded and cross-fades over the drawing. The live pet fades in under the stand-in: 220 ms for its exact frame, 280 ms otherwise. Bundling every look was rejected: colour is one of 8, shape one of 10 and the ink is continuous, so the exact frame cannot be bundled, and 160 stills would add megabytes; a tinted base still cannot reproduce the refraction.

### D4. Live only when really drawn

`draw()` does nothing until `finish()` has read the compiled shader, whatever wakes it. After the first frame the stand-in leaves only when the GL thread has run it: the still save (NIAR-275) or the same one-pixel fence (`glSettled`) resolves. A hidden pet draws its first frame anyway (the driver's own work happens then, and the still is saved) and then waits; the stage's pet is therefore usually live before any screen shows it.

### D5. Known look at start, first screen with its pet

The look shown last is kept in AsyncStorage (`niaro.petLook`) and read first at start; the stage's pet is created in it, and screens use it until the profile is back (no default pet first, then the person's). `App` holds its first screen until the stage's stand-in is on screen (its still decoded), at most 400 ms, which normally overlaps the existing startup gate.

### D6. Recording

The voice sheet's pet is a slot: opening voice moves the one pet there (state `listening`); no GL view is created or destroyed, so nothing blocks the JS thread while the microphone starts, and "Listening" follows the microphone start alone (`VoiceDraft` stage). The order (microphone started, then listening) is unchanged.

## Measurements

Emulator `emulator-5554` (Pixel-class, 1080×2400, 420 dpi), dev client from this branch, unpaired app (the dev server was down, so the paired screens could not be toured): Home's pet before pairing. Custom looks were checked with a temporary local patch giving that pet a look (not committed).

| | Before (main) | After |
| --- | --- | --- |
| Cold start, throttled, default look: frames with the screen up and the pet box empty | 8 (267 ms) | 0 |
| Cold start, custom look never drawn, no stills | empty until first frame (main has no still for it) | vector drawing in the first frame, cross-fade to live |
| Cold start, custom look with other ink | empty until first frame | nearest still in the first frame, ink cross-fades in place |
| Tab switch Chat → Library → Chat | new GL context (`GL contexts this session 2`), bundled still | `GL contexts this session 1`, live pet at once |

## Verification

- Jest: `tests/pet-stage.test.tsx` (one GL surface across Home, chat, profile and back; newest slot; slot accessibility; no stage on web; listening as soon as the microphone starts while the pet never got a context), `tests/pet-stage-place.test.ts` (placement, clipping, remembered look), `tests/pet-view-speed.test.tsx` (no draw before the compile even when woken, stand-in until the GL thread drew, hidden first frame, nearest still), `tests/pet-view-appear.test.tsx` (drawing from the first frame, bundled still), `tests/pet-snapshot.test.ts` (body lookup).
- Still to check on a real slow phone, paired: the tour Home → chat → pet profile → voice (one GL context in `[pet-perf]`), scrolling the profile with the pet clipped under the top bar, touch and stroke gestures through the slot, TalkBack order, and a release build (bundled still from resources, not Metro).
