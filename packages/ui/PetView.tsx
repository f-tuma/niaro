import {
  type PetAppearance,
  createPetCadence,
  petCadenceDue,
  advancePetMotion,
  createPetInteraction,
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
  useRef,
  useState,
} from "react";
import {
  AppState,
  PixelRatio,
  Platform,
  Animated,
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
import {
  focusPetPlay,
  keyPetPlay,
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
};
export type { PetState } from "./pet-motion";

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
}: PetViewProps) {
  const systemReduced = useReducedMotion();
  const reduced = systemReduced || !animate;
  const [Surface] = useState(supportedGLView);
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

  const dimensions = petRenderSize(size, PixelRatio.get());
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
  });
  const motion = useRef<PetMotion>({
    time: 2,
    level: 0,
    touch: 0,
    sleep: state === "resting" ? 1 : 0,
    interaction: createPetInteraction(),
  });
  const control = useRef<{
    wake: (immediate?: boolean) => void;
    stop: () => void;
  } | null>(null);
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
        rendered = false;
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
      const draw = (now: number) => {
        frame = 0;
        if (
          stopped ||
          !latest.current.active ||
          !latest.current.visible ||
          !latest.current.ownerVisible
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
            setReady(true);
          }
          if (
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
        if (
          stopped ||
          !latest.current.active ||
          !latest.current.visible ||
          !latest.current.ownerVisible
        ) {
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
        if (gl) renderer = createPetShader(gl, latest.current.background);
        if (canvas && "addEventListener" in canvas)
          canvas.addEventListener("webglcontextlost", lost);
        if (gl) wake();
      } catch {
        stop();
        failRenderer();
      }
    },
    [fallbackScale, fallbackTilt, failRenderer],
  );
  useEffect(() => {
    if (!Surface || failed) create();
  }, [Surface, failed, create]);
  const clockNow = () =>
    latest.current.reduced ? performance.now() / 1000 : motion.current.time;
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
  return (
    <View
      ref={host}
      testID={testID}
      accessible
      accessibilityRole={actionable ? "button" : "image"}
      accessibilityLabel={label}
      accessibilityState={actionable ? { disabled: !enabled } : undefined}
      accessibilityActions={actionable ? [{ name: "activate" }] : undefined}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "activate") acknowledge();
      }}
      onAccessibilityTap={acknowledge}
      focusable={enabled}
      tabIndex={enabled ? 0 : undefined}
      {...(Platform.OS === "web"
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
        : {})}
      onStartShouldSetResponder={(event) =>
        latest.current.enabled &&
        latest.current.active &&
        (!event.nativeEvent.touches ||
          event.nativeEvent.touches.length === 1) &&
        !!petContactPoint(
          event.nativeEvent.locationX,
          event.nativeEvent.locationY,
          dimensions.logical,
          motion.current,
          latest.current.state,
        )
      }
      onResponderGrant={start}
      onResponderStart={(event) => {
        // A stationary second finger produces start, not necessarily move.
        // Once cancelled, this contact sequence cannot become a tap again.
        if (event.nativeEvent.touches?.length !== 1) cancel();
      }}
      onResponderMove={move}
      onResponderRelease={end}
      onResponderTerminate={cancel}
      onResponderTerminationRequest={() => true}
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
          {!ready ? (
            <View pointerEvents="none" style={{ position: "absolute" }}>
              {fallback}
            </View>
          ) : null}
          <View
            pointerEvents="none"
            aria-hidden
            style={{
              width: dimensions.surface,
              height: dimensions.surface,
              opacity: ready ? 1 : 0,
              transform: [{ scale: dimensions.logical / dimensions.surface }],
            }}
          >
            <Surface
              style={{ width: dimensions.surface, height: dimensions.surface }}
              onContextCreate={create}
            />
          </View>
        </GLBoundary>
      )}
    </View>
  );
});

export default PetView;
