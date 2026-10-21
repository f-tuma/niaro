import { useCallback, useEffect } from "react";
import Animated, {
  SensorType,
  useAnimatedSensor,
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
} from "react-native-reanimated";
import { levelAngle } from "./liquid-physics";

/** A layer the gravity sensor may turn; the same view on every platform. */
export const TiltView = Animated.View;
function useGravitySensor() {
  const gravity = useAnimatedSensor(SensorType.GRAVITY, { interval: "auto" });
  const { unregister } = gravity;
  useEffect(() => () => unregister(), [unregister]);
  return gravity;
}
/** For the drawn (SVG) liquid: a heavy spring turns the layers to stay level. */
export function useTilt(active: boolean) {
  const gravity = useGravitySensor();
  const angle = useDerivedValue(() => {
    const { x, y } = gravity.sensor.value;
    // Heavy and under-damped (about a two-second swing, one soft overshoot):
    // liquid follows the glass late and settles slowly.
    return withSpring(active ? levelAngle(x, y) : 0, {
      damping: 4.5,
      stiffness: 14,
      mass: 1.4,
    });
  });
  return useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle.value}rad` }],
  }));
}
/** For the GL liquid, which simulates on its own frame clock: the latest reading. */
export function useGravity() {
  const gravity = useGravitySensor();
  return useCallback(() => {
    const { x, y } = gravity.sensor.value;
    return { x, y };
  }, [gravity]);
}
