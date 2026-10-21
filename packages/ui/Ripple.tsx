import React, { useEffect, useState } from "react";
import { Animated, Easing, View } from "react-native";
import { nativeMotion, useReducedMotion } from "./motion";

/**
 * A ring that spreads from a shape and fades: the app's one sign of
 * "something is happening here". Callers decide when that is true.
 */
export function Ripple({
  size,
  color,
  running,
  period = 1600,
  pause = 0,
  reach = 1.9,
  strength = 0.35,
}: {
  /** Diameter of the shape the ring starts from. */
  size: number;
  color: string;
  running: boolean;
  /** One spread, in milliseconds. */
  period?: number;
  /** Stillness between spreads; an invitation waits, work does not. */
  pause?: number;
  /** How far the ring travels, as a multiple of `size`. */
  reach?: number;
  strength?: number;
}) {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(0));
  const animate = running && !reduced;
  useEffect(() => {
    progress.stopAnimation();
    progress.setValue(0);
    if (!animate) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: period,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: nativeMotion,
          isInteraction: false,
        }),
        Animated.delay(pause),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animate, period, pause, progress]);
  if (!animate) return null;
  return (
    <View
      aria-hidden
      style={{
        position: "absolute",
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <Animated.View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          opacity: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [strength, 0],
          }),
          transform: [
            {
              scale: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [1, reach],
              }),
            },
          ],
        }}
      />
    </View>
  );
}
