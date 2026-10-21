import { View } from "react-native";

/** Browsers offer no dependable gravity here: the liquid stays level. */
export const TiltView = View;
export function useTilt(_active: boolean) {
  return undefined;
}
const none = () => null;
export function useGravity(): () => { x: number; y: number } | null {
  return none;
}
