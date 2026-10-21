import React from "react";
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import type { GLView } from "expo-gl";

/** The GL view when this build has it; null where only a fallback can draw. */
export function supportedGLView(): typeof GLView | null {
  if (Platform.OS !== "web" && !requireOptionalNativeModule("ExpoGL"))
    return null;
  // Load only when the native module exists; importing it earlier would throw.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("expo-gl").GLView as typeof GLView;
}
/** A GL visual that throws while mounting shows its static fallback instead. */
export class GLBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
