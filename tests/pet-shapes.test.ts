import {
  PET_CUSTOM_SHAPES,
  PET_RADIUS,
  PET_SHAPES,
  petBodyPath,
  petContactPoint,
  petCustomRadius,
  petCustomSlope,
  petLobe,
  petLobeSlope,
  petShape,
  type PetAppearance,
} from "../packages/ui/pet-motion";
import { PetShapeSchema } from "../packages/protocol/work-pet";
import { createPetShader } from "../packages/ui/pet-shader";

const STEPS = 2880;
const angles = Array.from(
  { length: STEPS },
  (_, i) => (i / STEPS) * 2 * Math.PI,
);
const custom = ["cat", "heart"] as const;

/** Curvature radius minimum of the polar outline r(θ) = R·(1 + k(θ)) over θ. */
function minCurvatureRadius(shape: PetAppearance["shape"]) {
  const terms = petShape({ shape });
  const h = 1e-4;
  let max = 0;
  for (const angle of angles) {
    const r = 1 + petLobe(terms, angle),
      r1 = petLobeSlope(terms, angle),
      r2 =
        (petLobeSlope(terms, angle + h) - petLobeSlope(terms, angle - h)) /
        (2 * h);
    const kappa = (r * r + 2 * r1 * r1 - r * r2) / (r * r + r1 * r1) ** 1.5;
    max = Math.max(max, Math.abs(kappa));
  }
  return 1 / max;
}

test("cat and heart are pinnable shapes appended after the family", () => {
  expect(PetShapeSchema.options.slice(-2)).toEqual(["cat", "heart"]);
  expect(Object.keys(PET_SHAPES)).toEqual(PetShapeSchema.options);
  expect(PET_SHAPES.cat[0]).toBe(PET_CUSTOM_SHAPES.cat.kind);
  expect(PET_SHAPES.heart[0]).toBe(PET_CUSTOM_SHAPES.heart.kind);
  expect(petShape({ shape: "cat" }).custom).toBe(
    PET_CUSTOM_SHAPES.cat.coefficients,
  );
});

test("the family's terms, lips and extents are untouched", () => {
  const cookie = petShape({ shape: "cookie" });
  expect(cookie).toMatchObject({
    n: 9,
    a: 0.075,
    extent: 0.075,
    custom: undefined,
  });
  expect(cookie.lip).toBeCloseTo(1.675);
  expect(petShape({ shape: "clover" }).lip).toBeCloseTo(1.64);
  expect(petShape({ shape: "pill" })).toMatchObject({
    sx: 1.22,
    sy: 0.84,
    lip: 1,
  });
});

test.each(custom)("%s radius is finite, positive and periodic", (shape) => {
  const terms = petShape({ shape });
  for (const angle of angles) {
    const r = 1 + petLobe(terms, angle);
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeGreaterThan(0.5);
    expect(petLobe(terms, angle + 2 * Math.PI)).toBeCloseTo(
      petLobe(terms, angle),
      12,
    );
    // left/right symmetric: a series in sin θ
    expect(petLobe(terms, Math.PI - angle)).toBeCloseTo(
      petLobe(terms, angle),
      12,
    );
  }
});

test.each(custom)(
  "%s Clenshaw evaluation matches the Chebyshev sum and its slope",
  (shape) => {
    const cs = PET_CUSTOM_SHAPES[shape].coefficients;
    for (let y = -1; y <= 1; y += 1 / 64) {
      const direct = cs.reduce(
        (sum, c, i) => sum + c * Math.cos(i * Math.acos(y)),
        0,
      );
      expect(petCustomRadius(y, cs)).toBeCloseTo(direct, 10);
      if (Math.abs(y) < 0.999) {
        const h = 1e-5;
        const numeric =
          (petCustomRadius(y + h, cs) - petCustomRadius(y - h, cs)) / (2 * h);
        expect(petCustomSlope(y, cs)).toBeCloseTo(numeric, 5);
      }
    }
    expect(
      1 +
        Math.max(
          ...angles.map((a) => Math.abs(petLobeSlope(petShape({ shape }), a))),
        ),
    ).toBeLessThanOrEqual(PET_CUSTOM_SHAPES[shape].lip);
    expect(
      Math.max(...angles.map((a) => petLobe(petShape({ shape }), a))),
    ).toBeLessThanOrEqual(PET_CUSTOM_SHAPES[shape].extent);
  },
);

test("the shader carries the same coefficient table, unrolled per shape", () => {
  const sources: string[] = [];
  const gl = {
    createShader: () => ({}),
    shaderSource: (_: unknown, source: string) => sources.push(source),
    compileShader: () => {},
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    useProgram: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    getUniformLocation: () => null,
    uniform1f: () => {},
    uniform2f: () => {},
    uniform3fv: () => {},
    uniform4f: () => {},
    uniform4fv: () => {},
    deleteShader: () => {},
    deleteProgram: () => {},
    deleteBuffer: () => {},
    ARRAY_BUFFER: 0,
    STATIC_DRAW: 0,
    VERTEX_SHADER: 0,
    FRAGMENT_SHADER: 1,
    COMPILE_STATUS: 0,
    LINK_STATUS: 0,
    FLOAT: 0,
  } as unknown as WebGLRenderingContext;
  createPetShader(gl, "#101014");
  const fragment = sources.find((source) => source.includes("float lobe("))!;
  expect(fragment).toContain("if (s.x < -0.5) return customLobe(u1, s.x);");
  expect(fragment).toContain(
    "mix(lobeSlope(qh, uShapeA), lobeSlope(qh, uShapeB), uMorph)",
  );
  for (const shape of custom) {
    const body = fragment.slice(
      fragment.indexOf(`float ${shape}K(float y)`),
      fragment.indexOf(`float ${shape}Kd(float y)`),
    );
    const numbers = [...body.matchAll(/-?\d+\.\d{10}/g)].map((m) =>
      Number(m[0]),
    );
    // Clenshaw runs from the highest term down; c₀ closes the recurrence
    const expected = [...PET_CUSTOM_SHAPES[shape].coefficients.slice(1)]
      .reverse()
      .concat(PET_CUSTOM_SHAPES[shape].coefficients[0]);
    expect(numbers).toHaveLength(expected.length);
    numbers.forEach((n, i) => expect(n).toBeCloseTo(expected[i]!, 10));
  }
});

test("tips and valleys are at least as round as the clover's, within the family's reach", () => {
  const floor = minCurvatureRadius("clover");
  expect(floor).toBeCloseTo(0.3617, 3);
  for (const shape of custom) {
    expect(minCurvatureRadius(shape)).toBeGreaterThanOrEqual(floor);
    const radii = angles.map((a) => 1 + petLobe(petShape({ shape }), a));
    expect(Math.max(...radii)).toBeGreaterThanOrEqual(0.9);
    expect(Math.max(...radii)).toBeLessThanOrEqual(1.15);
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(0.7);
  }
});

test.each(custom)(
  "%s body path closes and the centre, eyes and sides are inside",
  (shape) => {
    const path = petBodyPath({ shape });
    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    expect(path.match(/L/g)).toHaveLength(96);
    const motion = {
      time: 2,
      level: 0,
      touch: 0,
      sleep: 0,
      appearance: { shape },
    };
    expect(petContactPoint(240, 240, 480, motion)?.zone).toBe("body");
    expect(
      petContactPoint(
        240 - (0.21 * 240) / (3.2 * 0.37),
        240 - (0.112 * 240) / (3.2 * 0.37),
        480,
        motion,
      )?.zone,
    ).toBe("eye");
    expect(
      petContactPoint(
        240 - (0.85 * PET_RADIUS * 240) / (3.2 * 0.37),
        240,
        480,
        motion,
      ),
    ).not.toBeNull();
    // the transparent corner never takes the touch
    expect(petContactPoint(30, 30, 480, motion)).toBeNull();
    expect(petContactPoint(240, 15, 480, motion)).toBeNull();
  },
);
