import {
  COLUMNS,
  createLiquid,
  screenGravity,
} from "../packages/ui/liquid-sim";

const g = 9.81;
const run = (
  liquid: ReturnType<typeof createLiquid>,
  seconds: number,
  sideways: number,
  down: number,
  sample?: (time: number) => void,
) => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    liquid.step(1 / 60, sideways, down);
    sample?.(t);
  }
};
const edge = (liquid: ReturnType<typeof createLiquid>) =>
  liquid.height[COLUMNS - 1]! - liquid.height[0]!;
const volume = (liquid: ReturnType<typeof createLiquid>) =>
  liquid.height.reduce((sum, h) => sum + h, 0);

test("a steady tilt settles at the level slope and keeps the volume", () => {
  const liquid = createLiquid();
  const angle = 0.3;
  run(liquid, 30, g * Math.sin(angle), g * Math.cos(angle));
  // Water stands higher on the low side by tan(angle) across the lens.
  const span = 2 - 2 / COLUMNS;
  expect(edge(liquid) / span).toBeCloseTo(Math.tan(angle), 1);
  expect(Math.abs(volume(liquid))).toBeLessThan(1e-3);
});
test("a sudden tilt overshoots, sloshes back and dies away", () => {
  const liquid = createLiquid();
  const signs: number[] = [];
  let peak = 0;
  run(liquid, 1.2, g * Math.sin(0.4), g * Math.cos(0.4));
  // Upright again: the piled-up water swings across and back.
  run(liquid, 8, 0, g, () => {
    const now = edge(liquid);
    const sign = Math.sign(now);
    if (Math.abs(now) > 0.02 && sign !== signs.at(-1)) signs.push(sign);
    peak = Math.max(peak, Math.abs(now));
  });
  expect(signs.length).toBeGreaterThanOrEqual(3);
  expect(Math.abs(edge(liquid))).toBeLessThan(peak * 0.2);
  expect(Math.abs(volume(liquid))).toBeLessThan(1e-3);
});
test("lying flat or still, the surface stays at rest", () => {
  const liquid = createLiquid();
  run(liquid, 5, 0, 0.2);
  expect(Math.max(...liquid.height.map(Math.abs))).toBeLessThan(1e-6);
  // The back surface trails the front rather than leading it.
  run(liquid, 0.3, g * Math.sin(0.5), g * Math.cos(0.5));
  expect(
    Math.abs(liquid.trailing[COLUMNS - 1]!) <
      Math.abs(liquid.height[COLUMNS - 1]!),
  ).toBe(true);
});
test("gravity reads the same whichever way a platform signs it", () => {
  // Rolled clockwise by 0.3 rad: gravity pulls toward the screen's right edge.
  const down = { x: g * Math.sin(0.3), y: -g * Math.cos(0.3) };
  const reaction = { x: -down.x, y: -down.y };
  expect(screenGravity(down.x, down.y)).toEqual(
    screenGravity(reaction.x, reaction.y),
  );
  expect(screenGravity(down.x, down.y).sideways).toBeGreaterThan(0);
});
