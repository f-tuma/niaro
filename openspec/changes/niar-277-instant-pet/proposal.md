# Proposal

Tracker: **NIAR-277** (instant pet), **NIAR-276** (one pet for the whole app run)

## Why

After NIAR-275 the pet still left an empty space for up to a second on slower phones, and starting a recording waited for it before the app said it was listening. Measured on the Android emulator (dev client, emulator limited to two host cores as a stand-in for a slow phone):

- Each screen that shows a pet built a new GL view: about 0.2 s (fast) to 1.3 s (throttled) to get a GL context, then the compile. A recording built one more (the voice sheet's pet) while the old one was torn down, and expo-gl creates a context with calls that block the JS thread, in the middle of starting the microphone.
- A still existed only for a look, card, size and state the device had already drawn: a new or changed look (the pet's ink follows the person's work, so it changes), another size (chat top bar), a busy state (listening) or a first launch had none, so the box stayed empty until the first frame.
- Even a still that existed was an image loaded and decoded asynchronously: 8 frames (270 ms) of empty box on the throttled emulator with the bundled default still.
- A prop change while the shader compiled (a screen opening, the profile arriving) woke the draw loop, which marked the pet "drawn" before anything was drawn: the still faded out onto an empty surface (600 ms observed).
- "Drawn" meant JS had queued the frame; under load the GL thread drew it hundreds of milliseconds later.

## What Changes

- **One pet for the app run (NIAR-276).** A stage near the app root creates the only live pet as the app starts, while settings, the vault and fonts load. Screens place empty slots (Home, the chat top bar, the pet profile and its strip, the voice sheet); the stage draws the pet over the newest slot and follows it on the UI thread every frame (Reanimated), clipped to the screen's scrolling area. The slot is what the person touches and what a screen reader reads. The pet is hidden whenever its slot is hidden (sheets, the menu, history, processes, mentions; the same signals the screens already used). The GL context count stays 1 for the whole run; the appearance sheet's 120 pt preview (in a native modal) remains a second pet while it is open.
- **Never an empty box (NIAR-277).** Until the live pet draws, something always stands in from the first frame: the still of its exact first frame; else the nearest still of the same body (shape, colour, card) in any ink, size or state; else the bundled default still; else the vector drawing of its look, which needs no file and no decoding. A still that decodes late is covered by the drawing and cross-fades over it. The live pet takes over only once the GL thread has really drawn its first frame, and never before the shader is finished. The look is remembered from the last run, so the pet is created in its own look before the profile is back. The first screen waits for the pet's still to be decoded, at most 400 ms.
- **Recording does not wait for the pet.** Opening voice moves the one pet into the sheet; no GL view is created, and "Listening" appears as soon as the microphone has started.
- **Screens with the big pet fade in without the 7 px slide** (Home, pet profile): a native-driven slide is invisible to the stage until it ends, so the pet would sit 14 px off for the entrance and then jump.

## Non-goals

- The web administration pet (`apps/server-admin`) and the phone app in a browser: no stage there, each slot is its own pet as before.
- The one blocking step left in the shader start (reading uniform locations after the compile: 300 to 800 ms of JS on the throttled emulator, once per run now).
- The `voice` capabilities request made on every recording start (a network round trip before the microphone opens; not pet-related).

## Risk

- The pet is drawn over the screen, not inside it: an in-screen overlay that covers a pet slot must hide the slot (`visible`), as the existing sheets do. Native modals and the keyboard are above it anyway.
- The stage follows a native view per frame with Reanimated's `measure`; transforms a screen animates with React Native's native driver are seen only when they end (hence no slide on pet screens).
- The vector drawing is close to, not identical with, the rendered pet; it shows only on a look the device has never drawn and cross-fades into it.
