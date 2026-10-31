import React from "react";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  G,
  Path,
  RadialGradient,
  Stop,
} from "react-native-svg";
import { PetFallbackDrawing } from "./pet-fallback-drawing";
const primitives = {
  Svg,
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  G,
  Path,
  RadialGradient,
  Stop,
};
export function PetFallback(
  props: Omit<React.ComponentProps<typeof PetFallbackDrawing>, "components">,
) {
  return <PetFallbackDrawing {...props} components={primitives} />;
}
