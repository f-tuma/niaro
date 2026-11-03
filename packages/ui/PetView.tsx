import {
  type PetAppearance,
  createPetCadence,
  petCadenceDue,
  advancePetMotion,
  petFrame,
  resetPetInteraction,
  pressPet,
  movePet,
  releasePet,
  petContactPoint,
  setPetAppearance,
  petGeometry,
  petRenderSize,
  type PetMotion,
  type PetState,
} from "./pet-motion";
import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  PixelRatio,
  Platform,
  Animated,
  Easing,
  Image,
  View,
  type GestureResponderEvent,
  type NativeSyntheticEvent,
  type TargetedEvent,
} from "react-native";
import type { ExpoWebGLRenderingContext } from "expo-gl";
import { tokens as t } from "../design-tokens";
import { GLBoundary, supportedGLView } from "./gl-surface";
import { useReducedMotion } from "./motion";
import { createPetShader } from "./pet-shader";
import { PetFallback } from "./PetFallback";
import { petPerf } from "./pet-perf";
import {
  keepPetSnapshot,
  keptPetSnapshot,
  petSnapshotFile,
  petSnapshotKey,
  petStill,
  type PetSnapshot,
} from "./pet-snapshot";
import {
  canSavePetSnapshot,
  glSettled,
  savePetSnapshot,
} from "./pet-snapshot-io";
import { claimPetMotion, createPetMotion, releasePetMotion } from "./pet-store";
import {
  focusPetPlay,
  keyPetPlay,
  typePetPlay,
  hoverPetPlay,
  PET_FACES,
  petPlayBusy,
  updatePetPlay,
  type PetFace,
  type PetSignName,
} from "./pet-interaction";

export type PetViewProps = {
  size?: number;
  appearance?: PetAppearance;
  animate?: boolean;
  background?: string;
  state?: PetState;
  /** Actual microphone envelope, 0–1; never drives colour or time. */
  level?: Animated.Value;
  label?: string;
  testID?: string;
  /** Local hero touch feedback. Never implies a microphone or network action. */
  interactive?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  /** Suppresses idle glances while the person is composing. */
  occupied?: boolean;
  /** Native screen owner visibility; web also observes its actual viewport. */
  visible?: boolean;
  /** Bumped as the person types to it; the pet glances at their words. */
  typed?: number;
  /**
   * A placement's name (one view at a time): a rebuilt view under the same name continues the
   * pet's motion instead of starting it again. Read once, at mount.
   */
  motionKey?: string;
  /**
   * The drawing buffer's size in points, kept for the life of the view: a changed `size` only
   * scales the drawing. A view that needs a third more pixels than it has draws anew. Defaults
   * to the first `size`.
   */
  drawingSize?: number;
  /**
   * For a pet drawn somewhere other than where it is touched (the app's one pet, `PetStage`):
   * this view only draws, and its touch, keyboard and accessibility handlers are handed here
   * for the place on screen it stands in, which the person touches and reads instead.
   */
  controls?: { current: PetControls | null };
  /** Called once its best stand-in is on screen: a still decoded, or none to wait for. */
  onStandIn?: () => void;
};
export type { PetState } from "./pet-motion";
/** A pet's touch, keyboard and accessibility handlers, for a placeholder to carry (`controls`). */
export type PetControls = {
  /** The pet's own size in points: touches arrive in it. */
  size: number;
  /**
   * Whether what it shows is drawn on its current card (`background`): just after the card
   * changes, the live pet still shows its last frame, drawn on the old one.
   */
  upToDate: () => boolean;
  handlers: Partial<React.ComponentProps<typeof View>> &
    Record<string, unknown>;
};

/** A single companion, with no recording, backend, or profile side effects. */
export const PetView = memo(function PetView({
  size = 156,
  appearance,
  animate = true,
  background = t.color.background,
  state = "idle",
  level,
  label = "Niaro",
  testID = "niaro-pet",
  onPress,
  interactive = false,
  disabled = false,
  occupied = false,
  visible: ownerVisible = true,
  typed = 0,
  motionKey,
  drawingSize,
  controls,
  onStandIn,
}: PetViewProps) {
  const systemReduced = useReducedMotion();
  const reduced = systemReduced || !animate;
  const [Surface] = useState(supportedGLView);
  const [perf] = useState(() => petPerf(`${motionKey ?? testID} ${size}pt`));
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const host = useRef<View>(null);
  const gesture = useRef<{
    x: number;
    y: number;
    distance: number;
    started: number;
  } | null>(null);
  const fallbackScale = useRef(new Animated.ValueXY({ x: 1, y: 1 })).current;
  const fallbackTilt = useRef(new Animated.Value(0)).current;
  const fallbackPose = useRef({ stretch: 0, tilt: 0 });
  const [expression, setExpression] = useState<{
    face: PetFace;
    sign: PetSignName | null;
    stir: boolean;
    geometry?: ReturnType<typeof petGeometry>;
  }>({ face: PET_FACES.neutral, sign: null, stir: false });
  const semantic = useRef("");
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const playGeneration = useRef(0);
  const alive = useRef(true);
  const actionable = interactive || !!onPress;
  const enabled =
    actionable &&
    !disabled &&
    ownerVisible &&
    (state === "idle" || state === "resting");

  const density = Math.max(1, PixelRatio.get());
  const dimensions = petRenderSize(size, density);
  // The drawing buffer outlives size changes (the keyboard, a measured box): a new one means a new
  // GL context and a new compile, so it is replaced only when it would visibly blur.
  const needed = petRenderSize(drawingSize ?? size, density).pixels;
  const [pixels, setPixels] = useState(needed);
  if (needed > pixels * 1.34) setPixels(needed);
  const surface = pixels / density;
  // Until the live pet draws, something always stands in for it from the very first frame: a
  // still of its first frame (or of the nearest look), else the vector drawing of its look, which
  // needs no file, decoding or GL. The live pet fades in under it. A replaced drawing buffer gets
  // the stand-in again until its own first frame.
  const [standInGone, setStandInGone] = useState(false);
  const standInFade = useRef(new Animated.Value(1)).current;
  const firstPixels = useRef(pixels);
  useEffect(() => {
    if (firstPixels.current === pixels) return;
    firstPixels.current = pixels;
    setReady(false);
    setStandInGone(false);
    standInFade.setValue(1);
  }, [pixels, standInFade]);
  const snapshotKey = petSnapshotKey({
    appearance,
    background,
    state,
    pixels,
    reduced,
  });
  const still = useMemo(
    () =>
      Surface && !failed
        ? petStill({ appearance, background, state, pixels, reduced })
        : null,
    [appearance, background, state, pixels, reduced, Surface, failed],
  );
  const snapshot = still?.source ?? null;
  // An image appears once decoded; the drawing covers that wait, so no frame is empty.
  const [decoded, setDecoded] = useState<PetSnapshot | null>(null);
  const standIn = !standInGone && !!Surface && !failed;
  const exact = !!still?.exact && decoded === still.source;
  // A still decoded at once simply shows; one still decoding after a few frames is hidden until
  // then and cross-fades over the drawing, never cutting from one picture to the other.
  const stillFade = useRef(new Animated.Value(1)).current;
  const late = useRef<{ timer?: ReturnType<typeof setTimeout>; late: boolean }>(
    { late: false },
  );
  useEffect(() => {
    if (snapshot === null) return;
    const wait = late.current;
    wait.late = false;
    stillFade.setValue(1);
    wait.timer = setTimeout(() => {
      wait.late = true;
      stillFade.setValue(0);
    }, LATE_STILL_MS);
    return () => clearTimeout(wait.timer);
  }, [snapshot, stillFade]);
  const stillDecoded = (source: PetSnapshot) => {
    clearTimeout(late.current.timer);
    if (!late.current.late) {
      setDecoded(source);
      return;
    }
    Animated.timing(stillFade, {
      toValue: 1,
      duration: t.motion.stateTransition,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== "web",
    }).start(({ finished }) => {
      if (finished && alive.current) setDecoded(source);
    });
  };
  // Once the best stand-in is on screen (its image decoded, or none to decode, or the live pet).
  const onStandInRef = useRef(onStandIn);
  onStandInRef.current = onStandIn;
  const standInReady =
    ready || !Surface || failed || snapshot === null || decoded === snapshot;
  useEffect(() => {
    if (standInReady) onStandInRef.current?.();
  }, [standInReady]);
  useEffect(() => {
    if (!ready || standInGone) return;
    // The same frame underneath fades unseen; a near still or the drawing cross-fades softly.
    const run = Animated.timing(standInFade, {
      toValue: 0,
      duration: exact ? t.motion.stateTransition : t.motion.sheetEnter,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== "web",
    });
    run.start(({ finished }) => {
      if (finished) setStandInGone(true);
    });
    return () => run.stop();
    // Started once per first frame; a still decoded meanwhile does not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, standInGone, standInFade]);
  const latest = useRef({
    state,
    reduced,
    background,
    level: 0,
    active:
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
    visible: true,
    ownerVisible,
    enabled,
    occupied,
    snapshotKey,
    still: still ? (still.exact ? "exact" : "near") : "drawing",
  });
  // The card of the last frame drawn live.
  const drawnCard = useRef<string | null>(null);
  const [initialMotion] = useState(() => createPetMotion(state));
  const motion = useRef<PetMotion>(initialMotion);
  const restored = useRef(false);
  const control = useRef<{
    wake: (immediate?: boolean) => void;
    stop: () => void;
  } | null>(null);
  // Before the effects below read motion: a kept pet for this placement replaces the new one.
  useLayoutEffect(() => {
    if (!motionKey) return;
    const claim = claimPetMotion(motionKey, motion.current);
    motion.current = claim.motion;
    restored.current = claim.motion !== initialMotion;
    return () => releasePetMotion(motionKey, motion.current);
  }, [motionKey, initialMotion]);
  useLayoutEffect(() => {
    setPetAppearance(motion.current, appearance, reduced || !Surface || failed);
    latest.current.enabled = enabled;
    latest.current.ownerVisible = ownerVisible;
    gesture.current = null;
    resetPetInteraction(motion.current);
    clearPlayTimers();
    syncFallback();
    latest.current.state = state;
    latest.current.occupied = occupied;
    latest.current.reduced = reduced;
    latest.current.background = background;
    latest.current.snapshotKey = snapshotKey;
    latest.current.still = still ? (still.exact ? "exact" : "near") : "drawing";
    control.current?.wake();
  }, [
    state,
    reduced,
    size,
    background,
    enabled,
    occupied,
    ownerVisible,
    appearance,
    Surface,
    failed,
    snapshotKey,
    still,
  ]);
  useEffect(() => {
    latest.current.level = 0;
    if (!level) return;
    const listener = level.addListener(({ value }) => {
      latest.current.level = value;
    });
    return () => level.removeListener(listener);
  }, [level]);
  useEffect(() => {
    alive.current = true;
    const ownedMotion = motion.current;
    const app = AppState.addEventListener("change", (next) => {
      latest.current.active = next === "active";
      if (!latest.current.active) {
        gesture.current = null;
        resetPetInteraction(motion.current);
        clearPlayTimers();
        syncFallback();
      }
      control.current?.wake();
    });
    let observer: IntersectionObserver | undefined;
    const visibility = () => {
      latest.current.active = document.visibilityState !== "hidden";
      if (!latest.current.active) {
        gesture.current = null;
        resetPetInteraction(motion.current);
        clearPlayTimers();
        syncFallback();
      }
      control.current?.wake();
    };
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", visibility);
      visibility();
      if (typeof IntersectionObserver !== "undefined" && host.current) {
        observer = new IntersectionObserver(([entry]) => {
          latest.current.visible = entry?.isIntersecting ?? true;
          if (!latest.current.visible || !latest.current.ownerVisible) {
            gesture.current = null;
            resetPetInteraction(motion.current);
            clearPlayTimers();
            syncFallback();
          }
          control.current?.wake();
        });
        observer.observe(host.current as unknown as Element);
      }
    }
    return () => {
      alive.current = false;
      clearPlayTimers();
      gesture.current = null;
      resetPetInteraction(ownedMotion);
      app.remove();
      observer?.disconnect();
      if (Platform.OS === "web" && typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visibility);
      control.current?.stop();
      control.current = null;
    };
  }, []);
  const failRenderer = useCallback(() => {
    control.current?.stop();
    control.current = null;
    gesture.current = null;
    clearPlayTimers();
    resetPetInteraction(motion.current);
    updatePetPlay(
      motion.current.interaction!.play,
      0,
      latest.current.reduced ? performance.now() / 1000 : motion.current.time,
      latest.current.state,
      latest.current.reduced,
      latest.current.occupied,
    );
    fallbackScale.setValue({ x: 1, y: 1 });
    fallbackTilt.setValue(0);
    fallbackPose.current = { stretch: 0, tilt: 0 };
    if (!alive.current) return;
    setPetAppearance(motion.current, motion.current.appearance, true);
    syncFallback();
    setFailed(true);
  }, [fallbackScale, fallbackTilt]);
  const create = useCallback(
    (gl?: ExpoWebGLRenderingContext) => {
      if (!alive.current) return;
      control.current?.stop();
      let renderer: ReturnType<typeof createPetShader> | undefined;
      let frame = 0,
        last = 0,
        stopped = false,
        rendered = false,
        // Nothing draws before the shader is finished: a prop change may wake the loop earlier.
        compiled = false,
        // While the first frame is saved as a still, nothing else may draw over it.
        saving = false;
      let cadence = createPetCadence(),
        forceDraw = true;
      const canvas = Platform.OS === "web" ? gl?.canvas : undefined;
      const lost = (event: Event) => {
        event.preventDefault();
        stop();
        failRenderer();
      };
      const stop = () => {
        stopped = true;
        cancelAnimationFrame(frame);
        if (canvas && "removeEventListener" in canvas)
          canvas.removeEventListener("webglcontextlost", lost);
        try {
          renderer?.dispose();
        } catch {
          /* Context may already be gone. */
        }
      };
      // A hidden pet still draws its first frame: the driver finishes the shader then, the still
      // is saved, and the pet is ready the moment it is shown (the app's one pet starts hidden).
      const hidden = () =>
        rendered && (!latest.current.visible || !latest.current.ownerVisible);
      const draw = (now: number) => {
        frame = 0;
        if (
          stopped ||
          saving ||
          !latest.current.active ||
          hidden() ||
          (renderer && !compiled)
        ) {
          last = 0;
          return;
        }
        const play = motion.current.interaction!.play;
        const fps =
          play.ch.doze.t === 1 && play.ch.doze.x > 0.98
            ? 15
            : (latest.current.state === "resting" && play.ch.sleep.x > 0.99) ||
                play.now - play.ch.lastInput > 60
              ? 20
              : 30;
        if (
          !latest.current.reduced &&
          !petCadenceDue(cadence, now, fps, forceDraw)
        ) {
          frame = requestAnimationFrame(draw);
          return;
        }
        forceDraw = false;
        const dt = last ? (now - last) / 1000 : 0;
        last = now;
        try {
          if (!renderer || latest.current.reduced)
            setPetAppearance(motion.current, motion.current.appearance, true);
          advancePetMotion(
            motion.current,
            latest.current.reduced ? 0 : dt,
            latest.current.state,
            latest.current.level,
            latest.current.reduced ? now / 1000 : undefined,
            latest.current.reduced,
            latest.current.occupied,
          );
          syncFallback();
          renderer?.draw(
            motion.current,
            latest.current.state,
            latest.current.reduced,
            latest.current.background,
          );
          gl?.endFrameEXP();
          if (renderer) drawnCard.current = latest.current.background;
          if (!renderer) {
            const settled =
              motion.current.touch < 0.001 &&
              !petPlayBusy(motion.current.interaction!.play);
            const pose = petFrame(
              motion.current,
              latest.current.state,
              latest.current.reduced || settled,
            );
            if (fallbackPose.current.stretch !== pose.stretch) {
              fallbackScale.setValue({
                x: 1 / Math.sqrt(1 + pose.stretch),
                y: 1 + pose.stretch,
              });
            }
            if (fallbackPose.current.tilt !== pose.tilt)
              fallbackTilt.setValue(pose.tilt);
            fallbackPose.current = { stretch: pose.stretch, tilt: pose.tilt };
          }
          if (!rendered && renderer) {
            rendered = true;
            perf?.mark("first frame");
            // The stand-in leaves only once the GL thread has really drawn this frame (under load
            // that can be long after JS asked for it), so the surface is never shown empty.
            const reveal = () => {
              if (stopped || !alive.current) return;
              perf?.mark("drawn");
              setReady(true);
            };
            const key = latest.current.snapshotKey;
            const note = `motion ${restored.current ? "kept" : "new"}, stood in by ${latest.current.still}${latest.current.ownerVisible && latest.current.visible ? "" : ", drawn while hidden"}`;
            const play = motion.current.interaction!.play;
            // Only a pet that has not moved yet is the frame its key promises.
            if (
              gl &&
              key &&
              canSavePetSnapshot() &&
              !keptPetSnapshot(key) &&
              motion.current.time === 2 &&
              motion.current.touch === 0 &&
              !motion.current.appearanceTransition &&
              !petPlayBusy(play)
            ) {
              saving = true;
              savePetSnapshot(gl, petSnapshotFile(key))
                .then((uri) => {
                  if (uri) keepPetSnapshot(key, uri);
                  perf?.mark("still saved");
                })
                .catch(() => perf?.mark("still not saved"))
                .finally(() => {
                  saving = false;
                  reveal();
                  perf?.done(note);
                  wake();
                });
            } else if (gl)
              void glSettled(gl, renderer).then(() => {
                reveal();
                perf?.done(note);
              });
            else {
              reveal();
              perf?.done(note);
            }
          }
          if (
            !saving &&
            !latest.current.reduced &&
            (renderer ||
              motion.current.touch > 0.001 ||
              petPlayBusy(motion.current.interaction!.play) ||
              (motion.current.interaction?.acknowledgement ?? 0) > 0.001)
          )
            frame = requestAnimationFrame(draw);
        } catch {
          stop();
          failRenderer();
        }
      };
      const wake = (immediate = false) => {
        forceDraw ||= immediate;
        if (saving) return;
        if (stopped || !latest.current.active || hidden()) {
          cancelAnimationFrame(frame);
          frame = 0;
          last = 0;
          return;
        }
        if (!frame) {
          last = 0;
          cadence = createPetCadence();
          forceDraw = true;
          frame = requestAnimationFrame(draw);
        }
      };
      control.current = { wake, stop };
      try {
        if (gl) {
          perf?.context();
          // Queued only: the GL thread compiles while JS goes on.
          renderer = createPetShader(gl, latest.current.background, true);
        }
        if (canvas && "addEventListener" in canvas)
          canvas.addEventListener("webglcontextlost", lost);
        const pending = renderer;
        if (gl && pending?.finish) {
          gl.endFrameEXP();
          void glSettled(gl, pending).then(() => {
            if (stopped) return;
            try {
              const asked = performance.now();
              pending.finish();
              compiled = true;
              perf?.mark(
                "compiled",
                `JS waited ${Math.round(performance.now() - asked)}ms`,
              );
              wake();
            } catch {
              stop();
              failRenderer();
            }
          });
        } else if (gl) {
          compiled = true;
          wake();
        }
      } catch {
        stop();
        failRenderer();
      }
    },
    [fallbackScale, fallbackTilt, failRenderer, perf],
  );
  useEffect(() => {
    if (!Surface || failed) create();
  }, [Surface, failed, create]);
  const clockNow = () =>
    latest.current.reduced ? performance.now() / 1000 : motion.current.time;
  const seenTyping = useRef({ typed, at: -Infinity });
  useEffect(() => {
    const seen = seenTyping.current;
    if (seen.typed === typed) return;
    seen.typed = typed;
    const now = motion.current.time;
    // One glance per short burst of keys, not one per letter.
    if (now - seen.at < 0.35) return;
    seen.at = now;
    typePetPlay(motion.current.interaction!.play, now, latest.current.reduced);
    control.current?.wake();
  }, [typed]);
  // Gesture velocity uses each native sample, not the quantized rendered pose clock.
  const sampleNow = (event: GestureResponderEvent) =>
    Number.isFinite(event.nativeEvent.timestamp)
      ? event.nativeEvent.timestamp / 1000
      : performance.now() / 1000;
  function clearPlayTimers() {
    playGeneration.current++;
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
  }
  function syncFallback() {
    if (!alive.current) return;
    const play = motion.current.interaction!.play;
    const sign = play.sign && play.now >= play.sign.at ? play.sign.name : null;
    const key = `${motion.current.appearance?.shape}:${motion.current.appearanceTransition?.progress}:${latest.current.state}:${play.faceName}:${play.target.wink}:${play.pressed}:${play.hug}:${sign}`;
    if (key !== semantic.current) {
      semantic.current = key;
      setExpression({
        face: { ...play.target },
        sign,
        stir: play.faceName === "stir",
        geometry: petGeometry(motion.current),
      });
    }
  }
  function scheduleStill(delay: number) {
    const generation = playGeneration.current;
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      if (
        generation !== playGeneration.current ||
        !alive.current ||
        !latest.current.active ||
        !latest.current.enabled
      )
        return;
      updatePetPlay(
        motion.current.interaction!.play,
        0,
        clockNow(),
        latest.current.state,
        true,
        latest.current.occupied,
      );
      syncFallback();
      control.current?.wake();
    }, delay);
    timers.current.add(timer);
  }
  const cancel = () => {
    gesture.current = null;
    clearPlayTimers();
    resetPetInteraction(motion.current);
    syncFallback();
    control.current?.wake();
  };
  const acknowledge = () => {
    if (!latest.current.enabled || !latest.current.active) return;
    clearPlayTimers();
    const now = clockNow();
    pressPet(
      motion.current,
      dimensions.logical / 2,
      dimensions.logical / 2,
      dimensions.logical,
      now - 0.1,
      latest.current.state,
      latest.current.reduced,
    );
    releasePet(motion.current, now, false, latest.current.reduced);
    updatePetPlay(
      motion.current.interaction!.play,
      0,
      now,
      latest.current.state,
      latest.current.reduced,
      latest.current.occupied,
    );
    syncFallback();
    control.current?.wake();
    if (latest.current.reduced) scheduleStill(1420);
    onPress?.();
  };
  const start = (event: GestureResponderEvent) => {
    const { locationX: x, locationY: y } = event.nativeEvent;
    if (!latest.current.enabled || !latest.current.active) return;
    clearPlayTimers();
    const now = clockNow();
    if (
      !pressPet(
        motion.current,
        x,
        y,
        dimensions.logical,
        now,
        latest.current.state,
        latest.current.reduced,
        sampleNow(event),
      )
    )
      return;
    gesture.current = { x, y, distance: 0, started: now };
    syncFallback();
    control.current?.wake(true);
  };
  const move = (event: GestureResponderEvent) => {
    const current = gesture.current;
    if (!current) return;
    const { locationX: x, locationY: y, touches } = event.nativeEvent;
    if (
      !latest.current.enabled ||
      (touches && touches.length !== 1) ||
      !movePet(
        motion.current,
        x,
        y,
        dimensions.logical,
        clockNow(),
        latest.current.state,
        sampleNow(event),
      )
    ) {
      cancel();
      return;
    }
    current.distance += Math.hypot(x - current.x, y - current.y);
    current.x = x;
    current.y = y;
    syncFallback();
    control.current?.wake();
  };
  const end = () => {
    if (!gesture.current) return;
    gesture.current = null;
    clearPlayTimers();
    const tap = releasePet(
      motion.current,
      clockNow(),
      false,
      latest.current.reduced,
    );
    updatePetPlay(
      motion.current.interaction!.play,
      0,
      clockNow(),
      latest.current.state,
      latest.current.reduced,
      latest.current.occupied,
    );
    syncFallback();
    control.current?.wake();
    if (latest.current.reduced) scheduleStill(1420);
    if (tap) onPress?.();
  };
  const fallback = (
    <Animated.View
      pointerEvents="none"
      style={{
        transform: [
          { scaleX: fallbackScale.x },
          { scaleY: fallbackScale.y },
          {
            rotate: fallbackTilt.interpolate({
              inputRange: [-1, 1],
              outputRange: ["-1rad", "1rad"],
            }),
          },
        ],
      }}
    >
      <PetFallback
        appearance={appearance}
        geometry={expression.geometry}
        size={dimensions.logical}
        resting={state === "resting" && !expression.stir}
        pleased={expression.face.low > 0.5}
        face={expression.face}
        sign={expression.sign}
      />
    </Animated.View>
  );
  const handlers: PetControls["handlers"] = {
    accessible: true,
    accessibilityRole: actionable ? "button" : "image",
    accessibilityLabel: label,
    accessibilityState: actionable ? { disabled: !enabled } : undefined,
    accessibilityActions: actionable ? [{ name: "activate" }] : undefined,
    onAccessibilityAction: (event) => {
      if (event.nativeEvent.actionName === "activate") acknowledge();
    },
    onAccessibilityTap: acknowledge,
    focusable: enabled,
    tabIndex: enabled ? 0 : undefined,
    ...(Platform.OS === "web"
      ? {
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.repeat) return;
            if (event.key === "Enter") {
              event.preventDefault();
              if (!latest.current.enabled || gesture.current) return;
              clearPlayTimers();
              keyPetPlay(
                motion.current.interaction!.play,
                "Enter",
                clockNow(),
                latest.current.reduced,
              );
              syncFallback();
              control.current?.wake();
              if (latest.current.reduced) scheduleStill(1420);
            } else if (event.key === " ") {
              event.preventDefault();
              if (!gesture.current)
                start({
                  nativeEvent: {
                    locationX: dimensions.logical / 2,
                    locationY: dimensions.logical / 2,
                  },
                } as GestureResponderEvent);
            } else if (
              event.key.startsWith("Arrow") &&
              latest.current.enabled
            ) {
              event.preventDefault();
              keyPetPlay(
                motion.current.interaction!.play,
                event.key,
                clockNow(),
                latest.current.reduced,
              );
              control.current?.wake();
            }
          },
          onFocus: (event: NativeSyntheticEvent<TargetedEvent>) => {
            if (
              !latest.current.enabled ||
              !(event.currentTarget as unknown as HTMLElement).matches(
                ":focus-visible",
              )
            )
              return;
            focusPetPlay(
              motion.current.interaction!.play,
              clockNow(),
              latest.current.reduced,
            );
            control.current?.wake();
          },
          onMouseMove: (event: React.MouseEvent<HTMLElement>) => {
            if (
              !latest.current.enabled ||
              gesture.current ||
              latest.current.reduced
            )
              return;
            const box = event.currentTarget.getBoundingClientRect(),
              span = Math.max(box.width, 320) * 1.2;
            hoverPetPlay(
              motion.current.interaction!.play,
              (event.clientX - box.left - box.width / 2) / span,
              -(event.clientY - box.top - box.height / 2) / span,
              clockNow(),
            );
            control.current?.wake();
          },
          onMouseLeave: () => {
            hoverPetPlay(
              motion.current.interaction!.play,
              0,
              0,
              clockNow(),
              false,
            );
            control.current?.wake();
          },
          onKeyUp: (event: React.KeyboardEvent) => {
            if (event.key === " ") {
              event.preventDefault();
              end();
            }
          },
          onBlur: cancel,
        }
      : {}),
    onStartShouldSetResponder: (event) =>
      latest.current.enabled &&
      latest.current.active &&
      (!event.nativeEvent.touches || event.nativeEvent.touches.length === 1) &&
      !!petContactPoint(
        event.nativeEvent.locationX,
        event.nativeEvent.locationY,
        dimensions.logical,
        motion.current,
        latest.current.state,
      ),
    onResponderGrant: start,
    onResponderStart: (event) => {
      // A stationary second finger produces start, not necessarily move.
      // Once cancelled, this contact sequence cannot become a tap again.
      if (event.nativeEvent.touches?.length !== 1) cancel();
    },
    onResponderMove: move,
    onResponderRelease: end,
    onResponderTerminate: cancel,
    onResponderTerminationRequest: () => true,
  };
  // Every render: the placeholder calls the newest handlers when the person touches it.
  useLayoutEffect(() => {
    if (controls)
      controls.current = {
        size: dimensions.logical,
        handlers,
        // Until it draws live, its stand-in follows the card at once.
        upToDate: () =>
          !ready || drawnCard.current === latest.current.background,
      };
  });
  return (
    <View
      ref={host}
      testID={testID}
      {...(controls ? HANDED_OFF : handlers)}
      style={{
        ...(Platform.OS === "web"
          ? {
              outlineColor: t.color.action.link,
              outlineWidth: 2,
              outlineOffset: 2,
            }
          : {}),
        width: dimensions.logical,
        height: dimensions.logical,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {!Surface || failed ? (
        fallback
      ) : (
        <GLBoundary fallback={fallback} onError={failRenderer}>
          <View
            pointerEvents="none"
            aria-hidden
            style={{
              width: surface,
              height: surface,
              opacity: ready ? 1 : 0,
              transform: [{ scale: dimensions.logical / surface }],
            }}
          >
            {/* expo-gl keeps the first drawing buffer; a new size needs a new surface. */}
            <Surface
              key={pixels}
              style={{ width: surface, height: surface }}
              onContextCreate={create}
            />
          </View>
          {standIn ? (
            <Animated.View
              pointerEvents="none"
              aria-hidden
              testID={`${testID}-still`}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: dimensions.logical,
                height: dimensions.logical,
                alignItems: "center",
                justifyContent: "center",
                opacity: ready ? standInFade : 1,
              }}
            >
              {snapshot === null || decoded !== snapshot ? (
                <View
                  testID={`${testID}-drawing`}
                  style={{ position: "absolute" }}
                >
                  {fallback}
                </View>
              ) : null}
              {snapshot !== null ? (
                <Animated.View
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    opacity: stillFade,
                  }}
                >
                  <Image
                    source={
                      typeof snapshot === "number"
                        ? snapshot
                        : { uri: snapshot }
                    }
                    fadeDuration={0}
                    onLoad={() => stillDecoded(snapshot)}
                    style={{
                      width: dimensions.logical,
                      height: dimensions.logical,
                    }}
                  />
                </Animated.View>
              ) : null}
            </Animated.View>
          ) : null}
        </GLBoundary>
      )}
    </View>
  );
});

/** A still not decoded by then is hidden until it is, and fades in over the drawing. */
const LATE_STILL_MS = 120;

// A pet that only draws: its placeholder is what the person touches and reads.
const HANDED_OFF = {
  pointerEvents: "none",
  accessible: false,
  importantForAccessibility: "no-hide-descendants",
  accessibilityElementsHidden: true,
  "aria-hidden": true,
} as const;

export default PetView;
