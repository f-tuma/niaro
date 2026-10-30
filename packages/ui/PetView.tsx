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
} from "react-native";
import type { ExpoWebGLRenderingContext } from "expo-gl";
import { tokens as t } from "../design-tokens";
import { GLBoundary, supportedGLView } from "./gl-surface";
import { useReducedMotion } from "./motion";
import { createPetShader } from "./pet-shader";
import {
  advancePetMotion,
  createPetInteraction,
  petFrame,
  petHitTest,
  resetPetInteraction,
  strokePet,
  petRenderSize,
  type PetMotion,
  type PetState,
} from "./pet-motion";
import { PetFallback } from "./PetFallback";

export type PetViewProps = {
  size?: number;
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
};
export type { PetState } from "./pet-motion";

/** A single companion, with no recording, backend, or profile side effects. */
export const PetView = memo(function PetView({
  size = 156,
  background = t.color.background,
  state = "idle",
  level,
  label = "Niaro",
  testID = "niaro-pet",
  onPress,
  interactive = false,
  disabled = false,
}: PetViewProps) {
  const reduced = useReducedMotion();
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
  const [pleased, setPleased] = useState(false);
  const pleasedRef = useRef(false);
  const alive = useRef(true);
  const actionable = interactive || !!onPress;
  const enabled = actionable && !disabled && state === "idle";

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
    enabled,
  });
  const motion = useRef<PetMotion>({
    time: 2,
    level: 0,
    touch: 0,
    sleep: state === "resting" ? 1 : 0,
    interaction: createPetInteraction(),
  });
  const control = useRef<{ wake: () => void; stop: () => void } | null>(null);
  useLayoutEffect(() => {
    latest.current.enabled = enabled;
    gesture.current = null;
    resetPetInteraction(motion.current);
    pleasedRef.current = false;
    setPleased(false);
    latest.current.state = state;
    latest.current.reduced = reduced;
    latest.current.background = background;
    control.current?.wake();
  }, [state, reduced, size, background, enabled]);
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
        pleasedRef.current = false;
        setPleased(false);
      }
      control.current?.wake();
    });
    let observer: IntersectionObserver | undefined;
    const visibility = () => {
      latest.current.active = document.visibilityState !== "hidden";
      if (!latest.current.active) {
        gesture.current = null;
        resetPetInteraction(motion.current);
        pleasedRef.current = false;
        setPleased(false);
      }
      control.current?.wake();
    };
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", visibility);
      visibility();
      if (typeof IntersectionObserver !== "undefined" && host.current) {
        observer = new IntersectionObserver(([entry]) => {
          latest.current.visible = entry?.isIntersecting ?? true;
          if (!latest.current.visible) {
            gesture.current = null;
            resetPetInteraction(motion.current);
            pleasedRef.current = false;
            setPleased(false);
          }
          control.current?.wake();
        });
        observer.observe(host.current as unknown as Element);
      }
    }
    return () => {
      alive.current = false;
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
  const create = useCallback(
    (gl?: ExpoWebGLRenderingContext) => {
      if (!alive.current) return;
      control.current?.stop();
      let renderer: ReturnType<typeof createPetShader> | undefined;
      let frame = 0,
        last = 0,
        stopped = false,
        rendered = false;
      const canvas = Platform.OS === "web" ? gl?.canvas : undefined;
      const lost = (event: Event) => {
        event.preventDefault();
        stop();
        setFailed(true);
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
        if (stopped || !latest.current.active || !latest.current.visible) {
          last = 0;
          return;
        }
        if (!latest.current.reduced && last && now - last < 1000 / 30) {
          frame = requestAnimationFrame(draw);
          return;
        }
        const dt = last ? (now - last) / 1000 : 0;
        last = now;
        try {
          if (!latest.current.reduced)
            advancePetMotion(
              motion.current,
              dt,
              latest.current.state,
              latest.current.level,
            );
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
              !motion.current.interaction?.pressed;
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
            // Two expression transitions per contact, not per-frame React state.
            if (
              pleasedRef.current &&
              motion.current.touch < 0.015 &&
              !motion.current.interaction?.pressed
            ) {
              pleasedRef.current = false;
              setPleased(false);
            }
          }
          if (!rendered && renderer) {
            rendered = true;
            setReady(true);
          }
          if (
            !latest.current.reduced &&
            (renderer ||
              motion.current.touch > 0.001 ||
              motion.current.interaction?.pressed ||
              (motion.current.interaction?.acknowledgement ?? 0) > 0.001)
          )
            frame = requestAnimationFrame(draw);
        } catch {
          stop();
          setFailed(true);
        }
      };
      const wake = () => {
        cancelAnimationFrame(frame);
        last = 0;
        if (!stopped && latest.current.active && latest.current.visible)
          frame = requestAnimationFrame(draw);
      };
      control.current = { wake, stop };
      try {
        if (gl) renderer = createPetShader(gl, latest.current.background);
        if (canvas && "addEventListener" in canvas)
          canvas.addEventListener("webglcontextlost", lost);
        if (gl) wake();
      } catch {
        stop();
        setFailed(true);
      }
    },
    [fallbackScale, fallbackTilt],
  );
  useEffect(() => {
    if (!Surface || failed) create();
  }, [Surface, failed, create]);
  const acknowledge = () => {
    if (!latest.current.enabled || !latest.current.active) return;
    if (!latest.current.reduced) {
      motion.current.interaction!.acknowledgement = 1;
      pleasedRef.current = true;
      setPleased(true);
      control.current?.wake();
    }
    onPress?.();
  };
  const release = () => {
    gesture.current = null;
    motion.current.interaction!.pressed = false;
    control.current?.wake();
  };
  const start = (event: GestureResponderEvent) => {
    const { locationX: x, locationY: y } = event.nativeEvent;
    gesture.current = { x, y, distance: 0, started: Date.now() };
    if (!latest.current.reduced) {
      const interaction = motion.current.interaction!;
      interaction.pressed = true;
      interaction.targetX = (0.5 - x / dimensions.logical) * 2;
      interaction.targetY = (0.5 - y / dimensions.logical) * 2;
      pleasedRef.current = true;
      setPleased(true);
      control.current?.wake();
    }
  };
  const move = (event: GestureResponderEvent) => {
    const current = gesture.current;
    if (!current) return;
    const { locationX: x, locationY: y, touches } = event.nativeEvent;
    if (
      !latest.current.enabled ||
      (touches && touches.length !== 1) ||
      !petHitTest(x, y, dimensions.logical)
    ) {
      release();
      return;
    }
    const dx = x - current.x,
      dy = y - current.y;
    current.distance += Math.hypot(dx, dy);
    current.x = x;
    current.y = y;
    if (!latest.current.reduced)
      strokePet(motion.current, dx, dy, dimensions.logical);
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
        size={dimensions.logical}
        resting={state === "resting"}
        pleased={pleased && !reduced && state === "idle"}
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
              if (
                !event.repeat &&
                (event.key === "Enter" || event.key === " ")
              ) {
                event.preventDefault();
                acknowledge();
              }
            },
          }
        : {})}
      onStartShouldSetResponder={(event) =>
        latest.current.enabled &&
        latest.current.active &&
        (!event.nativeEvent.touches ||
          event.nativeEvent.touches.length === 1) &&
        petHitTest(
          event.nativeEvent.locationX,
          event.nativeEvent.locationY,
          dimensions.logical,
        )
      }
      onResponderGrant={start}
      onResponderStart={(event) => {
        // A stationary second finger produces start, not necessarily move.
        // Once cancelled, this contact sequence cannot become a tap again.
        if (event.nativeEvent.touches?.length !== 1) release();
      }}
      onResponderMove={move}
      onResponderRelease={() => {
        const current = gesture.current;
        release();
        if (
          current &&
          current.distance < 8 &&
          Date.now() - current.started < 600
        )
          acknowledge();
      }}
      onResponderTerminate={release}
      onResponderTerminationRequest={() => true}
      style={{
        width: dimensions.logical,
        height: dimensions.logical,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {!Surface || failed ? (
        fallback
      ) : (
        <GLBoundary fallback={fallback} onError={() => setFailed(true)}>
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
