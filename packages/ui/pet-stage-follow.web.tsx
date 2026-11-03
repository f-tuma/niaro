import React, { useEffect, useRef } from "react";
import { View } from "react-native";

// The browser keeps a pet per screen (no stage there, see PetStage), and Jest has no worklet
// runtime: the stage's pet simply stays in one hidden layer, which is all the tests look at.
export type FollowRef = React.RefObject<View | null>;
export const useFollowRef = () => useRef<View>(null);
export const FollowView = View;
export function attachFollow(ref: FollowRef, node: unknown) {
  (ref as { current: unknown }).current = node;
}

export function Follower({
  target,
  shown,
  size,
  slot,
  onPlaced,
  revealed,
  children,
}: {
  target: FollowRef | null;
  clip: FollowRef | null;
  size: number;
  shown: boolean;
  slot: number | null;
  onPlaced: (slot: number) => void;
  revealed: boolean;
  children: React.ReactNode;
}) {
  // After the commit, as the UI thread would: the slot is placed once its screen is there.
  useEffect(() => {
    if (shown && target && slot !== null) onPlaced(slot);
  }, [shown, target, slot, onPlaced]);
  return (
    <View
      pointerEvents="none"
      testID="pet-stage"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: size,
        height: size,
        opacity: shown && revealed ? 1 : 0,
      }}
    >
      {children}
    </View>
  );
}
