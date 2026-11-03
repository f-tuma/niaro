import React, { useCallback, useLayoutEffect } from "react";
import { StyleSheet, type View } from "react-native";
import Animated, {
  measure,
  useAnimatedRef,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type AnimatedRef,
} from "react-native-reanimated";
import { petPlacement } from "./pet-stage-place";

/** A view the stage can find on the UI thread: a slot, or the area that clips it. */
export type FollowRef = AnimatedRef<View>;
export const useFollowRef = () => useAnimatedRef<View>();
export const FollowView = Animated.View;
/** Points a follow ref at a view another ref also holds. */
export function attachFollow(ref: FollowRef, node: unknown) {
  (ref as unknown as (node: unknown) => void)(node);
}

const UNPLACED = {
  outerX: 0,
  outerY: 0,
  innerX: 0,
  innerY: 0,
  petX: 0,
  petY: 0,
  scale: 1,
};

/**
 * Keeps the stage's pet over its slot on the UI thread, every frame: the slot is measured where
 * the screen has it now (scrolled, resized by the keyboard, moved by layout), so the pet moves with
 * it without waiting for JS, which may be busy while a screen opens. Only translations, scale and
 * opacity change, so each frame's placement is drawn in that frame. Until the slot is measured the
 * pet is not shown; before any slot it still lays out at full size (hidden), so its GL surface is
 * created and its shader compiles while the app starts.
 */
export function Follower({
  target,
  clip,
  size,
  shown,
  children,
}: {
  target: FollowRef | null;
  clip: FollowRef | null;
  /** The pet's own size in points; a slot of another size scales it. */
  size: number;
  shown: boolean;
  children: React.ReactNode;
}) {
  const host = useAnimatedRef<View>();
  const active = useSharedValue(shown);
  const placed = useSharedValue(0);
  const place = useSharedValue(UNPLACED);
  // Before paint, so the pet is placed in the frame its slot first shows.
  useLayoutEffect(() => {
    active.set(shown && !!target);
  }, [active, shown, target]);
  const follow = useCallback(() => {
    "worklet";
    if (!active.get() || !target) {
      if (placed.get() !== 0) placed.set(0);
      return;
    }
    const origin = measure(host);
    const box = measure(target);
    const bounds = clip ? measure(clip) : origin;
    if (!origin || !box || !bounds || box.width <= 0) {
      if (placed.get() !== 0) placed.set(0);
      return;
    }
    const next = petPlacement(origin, bounds, box, size);
    const p = place.get();
    if (
      p.outerX !== next.outerX ||
      p.outerY !== next.outerY ||
      p.innerX !== next.innerX ||
      p.innerY !== next.innerY ||
      p.petX !== next.petX ||
      p.petY !== next.petY ||
      p.scale !== next.scale
    )
      place.set(next);
    if (placed.get() !== 1) placed.set(1);
  }, [active, clip, host, place, placed, size, target]);
  useFrameCallback(follow);
  const outer = useAnimatedStyle(() => ({
    opacity: placed.get(),
    transform: [
      { translateX: place.get().outerX },
      { translateY: place.get().outerY },
    ],
  }));
  const inner = useAnimatedStyle(() => ({
    transform: [
      { translateX: place.get().innerX },
      { translateY: place.get().innerY },
    ],
  }));
  const pet = useAnimatedStyle(() => ({
    transform: [
      { translateX: place.get().petX },
      { translateY: place.get().petY },
      { scale: place.get().scale },
    ],
  }));
  return (
    <Animated.View
      ref={host}
      collapsable={false}
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      <Animated.View pointerEvents="none" style={[styles.layer, outer]}>
        <Animated.View pointerEvents="none" style={[styles.layer, inner]}>
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: "absolute",
                left: 0,
                top: 0,
                width: size,
                height: size,
              },
              pet,
            ]}
          >
            {children}
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: "absolute",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
  },
});
