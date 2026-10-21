import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  Pressable,
  type PressableProps,
  type ViewProps,
} from "react-native";
import { tokens as t } from "../design-tokens";

const MotionContext = createContext(true);
export const nativeMotion = Platform.OS !== "web";
export const motionEase = Easing.out(Easing.cubic);

/** One subscription for the app; stay still until the OS preference is known. */
export function MotionProvider({ children }: PropsWithChildren) {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (value) => {
        changed = true;
        if (active) setReduced(value);
      },
    );
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (active && !changed) setReduced(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);
  return (
    <MotionContext.Provider value={reduced}>{children}</MotionContext.Provider>
  );
}
export const useReducedMotion = () => useContext(MotionContext);

/** Transforms/opacity only: motion never changes layout or triggers an action. */
export function useMotionTarget(
  target: number,
  duration: number = t.motion.stateTransition,
) {
  const reduced = useReducedMotion();
  const [value] = useState(() => new Animated.Value(target));
  useEffect(() => {
    value.stopAnimation();
    if (reduced) {
      value.setValue(target);
      return;
    }
    const animation = Animated.timing(value, {
      toValue: target,
      duration,
      easing: motionEase,
      useNativeDriver: nativeMotion,
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [target, duration, reduced, value]);
  return value;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export function MotionPressable({
  style,
  onPressIn,
  onPressOut,
  disabled,
  ...props
}: PressableProps) {
  const [pressed, setPressed] = useState(false);
  const scale = useMotionTarget(
    pressed && !disabled ? t.motion.pressScale : 1,
    t.motion.feedback,
  );
  return (
    <AnimatedPressable
      {...props}
      disabled={disabled}
      onPressIn={(event) => {
        setPressed(true);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        onPressOut?.(event);
      }}
      style={[
        typeof style === "function"
          ? style({ pressed: pressed && !disabled })
          : style,
        { transform: [{ scale }] },
      ]}
    />
  );
}

export function Entrance({
  children,
  style,
  duration = t.motion.stateTransition,
  distance = 7,
  ...props
}: ViewProps & { duration?: number; distance?: number }) {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(reduced ? 1 : 0));
  const entered = useRef(false);
  useEffect(() => {
    if (reduced) {
      progress.stopAnimation();
      progress.setValue(1);
      entered.current = true;
      return;
    }
    if (entered.current) return;
    entered.current = true;
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration,
      easing: motionEase,
      useNativeDriver: nativeMotion,
      isInteraction: false,
    });
    animation.start();
    return () => {
      animation.stop();
      progress.setValue(1);
    };
  }, [reduced, duration, progress]);
  return (
    <Animated.View
      {...props}
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [distance, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
