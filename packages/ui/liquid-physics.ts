/**
 * How far the liquid must turn (radians, clockwise on screen) to stay level
 * for a gravity reading in the screen's axes (x right, y up).
 *
 * Platforms sign gravity differently (towards the ground, or its reaction).
 * Held upright, most of it lies on y either way, and x measures the roll on
 * the same convention, so |y| as the reference works for both. Lying flat,
 * gravity has no direction on the screen and the liquid rests level.
 */
export function levelAngle(x: number, y: number) {
  "worklet";
  const onScreen = Math.hypot(x, y) / 9.81;
  const weight = Math.min(1, Math.max(0, (onScreen - 0.15) / 0.35));
  const roll = Math.atan2(y < 0 ? x : -x, Math.abs(y));
  return Math.max(-0.6, Math.min(0.6, -roll)) * weight;
}
