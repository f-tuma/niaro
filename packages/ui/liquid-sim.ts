/**
 * Liquid in the lens as a 1D shallow-water height field: water flows toward
 * the side gravity pulls it, piles up against the glass, comes back and
 * sloshes until damping settles it at the level slope. Units are the lens's
 * own (x from -1 to 1); gravity arrives in m/s² along the screen axes.
 */
export const COLUMNS = 32;
const DX = 2 / COLUMNS;
const DEPTH = 0.9;
// Much slower than a real glass of this size reads as heavy, viscous liquid:
// about three and a half seconds per slosh, settled within one or two.
const GRAVITY_SCALE = 0.15;
const DAMPING = 1.4;
// Viscosity smooths short ripples, so quick hand movement does not jitter.
const VISCOSITY = 0.02;
// The sensor is followed this slowly (seconds): shake never reaches the liquid.
const SETTLE = 0.3;
const LIMIT = 0.7;

export type Liquid = ReturnType<typeof createLiquid>;
export function createLiquid() {
  /** Surface height above rest at each column centre. */
  const height = new Float32Array(COLUMNS);
  /** A slower copy for the back surface: it trails the front, which reads as depth. */
  const trailing = new Float32Array(COLUMNS);
  /** Flow between columns; the glass walls (first and last face) hold none. */
  const flow = new Float32Array(COLUMNS + 1);
  const next = new Float32Array(COLUMNS + 1);
  const pull = { sideways: 0, down: 9.81 };
  return {
    height,
    trailing,
    /**
     * `sideways`: gravity along the screen's x toward +x; `down`: gravity
     * toward the screen's bottom edge. Lying flat both are ~0 and the
     * surface relaxes to rest.
     */
    step(dt: number, sideways: number, down: number) {
      if (!(dt > 0)) return;
      const ease = 1 - Math.exp(-dt / SETTLE);
      pull.sideways += (sideways - pull.sideways) * ease;
      pull.down += (down - pull.down) * ease;
      const g = Math.max(3, pull.down) * GRAVITY_SCALE;
      const push = pull.sideways * GRAVITY_SCALE;
      const speed = Math.sqrt(g * DEPTH);
      // Substeps keep the explicit scheme stable (CFL below 0.5).
      const steps = Math.max(
        1,
        Math.ceil((dt * speed) / (0.5 * DX)),
        Math.ceil((dt * VISCOSITY) / (0.4 * DX * DX)),
      );
      const h = dt / steps;
      const keep = 1 - DAMPING * h;
      for (let s = 0; s < steps; s++) {
        for (let j = 1; j < COLUMNS; j++)
          next[j] =
            (flow[j]! +
              h *
                (push -
                  (g * (height[j]! - height[j - 1]!)) / DX +
                  (VISCOSITY * (flow[j + 1]! - 2 * flow[j]! + flow[j - 1]!)) /
                    (DX * DX))) *
            keep;
        flow.set(next.subarray(1, COLUMNS), 1);
        for (let i = 0; i < COLUMNS; i++)
          height[i] = Math.max(
            -LIMIT,
            Math.min(
              LIMIT,
              height[i]! - (h * DEPTH * (flow[i + 1]! - flow[i]!)) / DX,
            ),
          );
      }
      const follow = 1 - Math.exp(-dt / 0.35);
      for (let i = 0; i < COLUMNS; i++)
        trailing[i] = trailing[i]! + (height[i]! - trailing[i]!) * follow;
    },
  };
}
/**
 * A gravity reading split into the two pulls the liquid feels. Platforms sign
 * gravity differently (towards the ground, or its reaction); held upright
 * most of it lies on y either way and x follows the same convention.
 */
export function screenGravity(x: number, y: number) {
  const toward = y < 0 ? x : -x;
  return { sideways: toward, down: Math.abs(y) };
}
