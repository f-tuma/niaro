import { createVoiceShader } from "../packages/ui/voice-shader";
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
test("shader releases partial allocations when compilation or linking fails", () => {
  const compile = context();
  compile.getShaderParameter
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(false);
  expect(() =>
    createVoiceShader(compile as unknown as WebGLRenderingContext),
  ).toThrow();
  expect(compile.deleteShader).toHaveBeenCalledTimes(2);
  const link = context();
  link.getProgramParameter.mockReturnValue(false);
  expect(() =>
    createVoiceShader(link as unknown as WebGLRenderingContext),
  ).toThrow();
  expect(link.deleteShader).toHaveBeenCalledTimes(2);
  expect(link.deleteProgram).toHaveBeenCalledTimes(1);
});
test("invalid microphone samples render silence and disposal stops further drawing", () => {
  const gl = context();
  const shader = createVoiceShader(gl as unknown as WebGLRenderingContext);
  shader.draw([NaN, Infinity, -1], 0);
  expect(gl.uniform3fv).toHaveBeenCalledWith("bands", [0, 0, 0]);
  // Without a spectrum the ribbon keeps its classic shape: 24 silent bands, unshaped.
  expect(gl.uniform1fv).toHaveBeenCalledWith(
    "spectrum[0]",
    new Array(24).fill(0),
  );
  expect(gl.uniform1f).toHaveBeenCalledWith("shaped", 0);
  shader.draw([0, 0, 0], 0, 1, [NaN, Infinity, -1, 0.5, 2], 3);
  expect(gl.uniform1fv).toHaveBeenLastCalledWith("spectrum[0]", [
    0,
    0,
    0,
    0.5,
    1,
    ...new Array(19).fill(0),
  ]);
  expect(gl.uniform1f).toHaveBeenCalledWith("shaped", 1);
  expect(gl.drawArrays).toHaveBeenCalledTimes(2);
  shader.dispose();
  shader.dispose();
  shader.draw([1, 1, 1], 2);
  // Disposed: no further drawing.
  expect(gl.drawArrays).toHaveBeenCalledTimes(2);
  expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
  expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  expect(gl.deleteShader).toHaveBeenCalledTimes(2);
});
test.each(["wave", "border"] as const)(
  "%s skips inactive uniforms instead of overwriting native GL location zero",
  (variant) => {
    const gl = context();
    const active = new Set([
      "blue",
      "time",
      "pixel",
      "reveal",
      ...(variant === "wave"
        ? ["bands", "violet", "cyan"]
        : ["resolution", "sky", "white"]),
    ]);
    gl.getUniformLocation.mockImplementation((_, name) =>
      active.has(name) ? name : null,
    );
    const shader = createVoiceShader(
      gl as unknown as WebGLRenderingContext,
      variant,
    );
    shader.draw([0, 0, 0], 1, 0.5);
    for (const setter of [gl.uniform3fv, gl.uniform2f, gl.uniform1f])
      expect(setter.mock.calls.every(([location]) => location !== null)).toBe(
        true,
      );
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    shader.dispose();
  },
);
