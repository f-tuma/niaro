# Proposal

Tracker: **NIAR-275**

## Why

On the phone the pet takes a second or more to appear, and it happens often: every return to the chat tab, every keyboard open and close on Home, every step through the pet profile. Each time a new GL context compiles the 49 KB ray-marching shader (1.3 s on a desktop GPU, likely slower on phones), and while it does, expo-gl's status and uniform queries hold the JS thread, so the whole app stalls. Until the first frame the pet is invisible, and every rebuilt pet starts its motion from the beginning. (Research: `pet-perf/report.md`, 2026-11-02.)

## What Changes

- **Measured.** In development builds each pet logs one `[pet-perf]` line: mount to GL context, compiled (and how long JS waited), first frame, whether a still was shown or saved, whether the motion was kept, and the count of GL contexts created this session.
- **Compiled without freezing.** The shader's compile and link are only queued and handed to expo-gl's GL thread; the result and uniform locations are read once that thread has finished. A compile error still shows the still drawing. The browser polls KHR_parallel_shader_compile where it has it.
- **Snapshot first.** The first live frame of a new pet depends only on its look, the card behind it, rest or not, and its drawing size, so a still of it, saved once per such key in the app cache, is shown the moment a pet mounts and fades into the live pet. A bundled still covers the default pet before pairing and before the profile arrives.
- **Continues.** Home and the pet profile name their placement; a rebuilt view of the same placement continues the kept motion (clock, sleep, breathing, ink, idle timing). Two pets on screen never share one.
- **No size rebuilds.** Home keeps one pet and only shrinks it when the keyboard opens; a pet keeps its drawing buffer when its size changes and scales it; the profile pet waits for its measured box and draws at the stage's largest size.
- **Slimmer shader.** One `emote()` call site, and the gradient samples, the three refraction channels and the four normal samples each in a loop, so their bodies are compiled once: compile time about halves, the look stays the same (at most one level of one channel on 0.004% of pixels).

## Non-goals

- One persistent pet at the app root (NIAR-276, after the App.tsx chat split). The chat top bar pet and leaving the chat tab still build a new view; they now show the still at once and compile without freezing.
- Sharing one GL context between pets, or the unused depth and stencil buffers expo-gl requests (native code).
- The web administration pet (`apps/server-admin`), which has its own view.

## Risk

- The GL-thread fence is a one-pixel snapshot, the only expo-gl call that settles a promise on that thread. If a device's snapshot fails, the pet compiles as before (JS waits), and no still is saved.
- A still that differs from the live first frame (a different GPU, a kept motion) shows as a 220 ms cross-fade, not a jump.
- The bundled still is valid only for the shader it was rendered from; a test fails until `scripts/render-pet-still.ts` renders it again.
