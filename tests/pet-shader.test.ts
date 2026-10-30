import {
  createPetInteraction,
  advancePetMotion,
  pressPet,
  type PetMotion,
} from "../packages/ui/pet-motion";
import { createPetShader } from "../packages/ui/pet-shader";
function context() {
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    COLOR_BUFFER_BIT: 8,
    TRIANGLES: 9,
    drawingBufferWidth: 600,
    drawingBufferHeight: 100,
    createShader: jest.fn(() => ({})),
    shaderSource: jest.fn(),
    compileShader: jest.fn(),
    getShaderParameter: jest.fn(() => true),
    createProgram: jest.fn(() => ({})),
    attachShader: jest.fn(),
    linkProgram: jest.fn(),
    getProgramParameter: jest.fn(() => true),
    useProgram: jest.fn(),
    createBuffer: jest.fn(() => ({})),
    bindBuffer: jest.fn(),
    bufferData: jest.fn(),
    getAttribLocation: jest.fn(() => 0),
    enableVertexAttribArray: jest.fn(),
    vertexAttribPointer: jest.fn(),
    getUniformLocation: jest.fn(
      (_: unknown, name: string): string | null => name,
    ),
    uniform3fv: jest.fn(),
    uniform1fv: jest.fn(),
    uniform1f: jest.fn(),
    uniform2f: jest.fn(),
    uniform4f: jest.fn(),
    uniform4fv: jest.fn(),
    clearColor: jest.fn(),
    viewport: jest.fn(),
    clear: jest.fn(),
    drawArrays: jest.fn(),
    flush: jest.fn(),
    deleteShader: jest.fn(),
    deleteProgram: jest.fn(),
    deleteBuffer: jest.fn(),
  };
}

const pose = { time: 2, level: 0.5, touch: 0, sleep: 0 };
test("pet shader releases partial allocations after compile or link failure", () => {
  const compile = context();
  compile.getShaderParameter
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(false);
  expect(() =>
    createPetShader(compile as unknown as WebGLRenderingContext, "#141518"),
  ).toThrow();
  expect(compile.deleteShader).toHaveBeenCalledTimes(2);
  expect(compile.deleteProgram).toHaveBeenCalledTimes(1);
  const link = context();
  link.getProgramParameter.mockReturnValue(false);
  expect(() =>
    createPetShader(link as unknown as WebGLRenderingContext, "#141518"),
  ).toThrow();
  expect(link.deleteShader).toHaveBeenCalledTimes(2);
  expect(link.deleteProgram).toHaveBeenCalledTimes(1);
});
test("no external halo is compiled and disposed renderer never draws again", () => {
  const gl = context();
  const shader = createPetShader(
    gl as unknown as WebGLRenderingContext,
    "#141518",
  );
  const fragment = gl.shaderSource.mock.calls[1]?.[1] as string;
  expect(fragment).toContain("vec3 bgc = backdrop(uv);");
  expect(fragment).not.toContain("uTintL * uGlow");
  shader.draw(pose, "listening", false);
  expect(gl.drawArrays).toHaveBeenCalledTimes(1);
  shader.dispose();
  shader.dispose();
  shader.draw(pose, "working", false);
  expect(gl.drawArrays).toHaveBeenCalledTimes(1);
  expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
  expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  expect(gl.deleteShader).toHaveBeenCalledTimes(2);
});
test("optimized-out uniforms do not corrupt native uniform location zero", () => {
  const gl = context();
  gl.getUniformLocation.mockImplementation((_, name) =>
    name === "uR" ? name : null,
  );
  const shader = createPetShader(
    gl as unknown as WebGLRenderingContext,
    "#141518",
  );
  shader.draw(pose, "resting", true);
  for (const setter of [
    gl.uniform1f,
    gl.uniform2f,
    gl.uniform3fv,
    gl.uniform4f,
    gl.uniform4fv,
  ])
    expect(setter.mock.calls.every(([location]) => location !== null)).toBe(
      true,
    );
  expect(gl.drawArrays).toHaveBeenCalledTimes(1);
});

test("a held-hug water sign reaches the real renderer above-right with original scale and live material", () => {
  const gl = context();
  const shader = createPetShader(
    gl as unknown as WebGLRenderingContext,
    "#141518",
  );
  const motion: PetMotion = {
    time: 2,
    level: 0,
    touch: 0,
    sleep: 0,
    interaction: createPetInteraction(),
  };
  pressPet(motion, 110, 110, 220, 2);
  for (let i = 0; i < 72; i++) advancePetMotion(motion, 1 / 60, "idle", 0);
  shader.draw(motion, "idle", false);
  const anchor = gl.uniform2f.mock.calls
    .filter(([key]) => key === "uEmotePos")
    .at(-1)!;
  expect(anchor[1]).toBeGreaterThan(0.3);
  expect(anchor[2]).toBeGreaterThan(0.6);
  expect(anchor[2]).toBeLessThan(0.85);
  const emote = gl.uniform4f.mock.calls
    .filter(([key]) => key === "uEmote")
    .at(-1)!;
  expect(emote[1]).toBe(4);
  expect(emote[2]).toBeGreaterThan(0.9);
  expect(emote[2]).toBeLessThan(1.2);
  expect(
    gl.uniform1f.mock.calls.filter(([key]) => key === "uEmoteM").at(-1)![1],
  ).toBeGreaterThan(0.9);
  const part = gl.uniform2f.mock.calls
    .filter(([key]) => key === "uEmotePart")
    .at(-1)!;
  expect(part[2]).toBeGreaterThan(0);
  shader.dispose();
});
