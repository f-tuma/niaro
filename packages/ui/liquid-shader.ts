import { COLUMNS } from "./liquid-sim";

const vertex = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = position; gl_Position = vec4(position, 0.0, 1.0); }
`;
// A glass sphere seen face on, half full: glass, the back surface, the glyph,
// then the lit front surface over it, so the glyph rests in the liquid. The
// surfaces follow a simulated height field (liquid-sim.ts) plus small waves.
const fragment = `
precision mediump float;
varying vec2 uv;
uniform float time;
uniform float heights[${COLUMNS}];
uniform float trailing[${COLUMNS}];
uniform float amp;
uniform float pixel;
uniform float glyph;
uniform vec3 glassA;
uniform vec3 glassB;
uniform vec3 backColor;
uniform vec3 frontColor;
uniform float backAlpha;
uniform float frontAlpha;
float box(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// Lucide "mic" on its 24-unit grid (y down), stroked at 1.75 units.
float mic(vec2 P) {
  float head = abs(box(P - vec2(12.0, 8.0), vec2(3.0, 6.0), 3.0));
  vec2 c = P - vec2(12.0, 12.0);
  float arc = c.y < 0.0 ? 1e3 : abs(length(c) - 7.0);
  float sides = min(segment(P, vec2(5.0, 10.0), vec2(5.0, 12.0)),
                    segment(P, vec2(19.0, 10.0), vec2(19.0, 12.0)));
  float stem = segment(P, vec2(12.0, 19.0), vec2(12.0, 22.0));
  return min(min(head, arc), min(sides, stem)) - 0.875;
}
float glyphDistance(vec2 p) {
  if (glyph < 0.5) {
    float unit = 0.03;
    return mic(vec2(p.x, -p.y) / unit + 12.0) * unit;
  }
  if (glyph < 1.5) return length(p) - 0.28;
  return box(p, vec2(0.24), 0.12);
}
// The simulated height at x: columns sit at their centres, tent-weighted.
float field(float x, bool back) {
  float at = (x + 1.0) * 0.5 * ${COLUMNS}.0 - 0.5;
  float sum = 0.0;
  for (int i = 0; i < ${COLUMNS}; i++) {
    float w = max(0.0, 1.0 - abs(at - float(i)));
    sum += w * (back ? trailing[i] : heights[i]);
  }
  return sum;
}
float surface(float x, float level, float k, float speed, float phase, bool back) {
  return level + field(clamp(x, -0.98, 0.98), back) + amp * sin(x * k + time * speed + phase);
}
void main() {
  vec2 p = uv;
  float r = length(p);
  float edge = 1.0 - smoothstep(1.0 - pixel * 1.5, 1.0, r);
  if (edge <= 0.0) { gl_FragColor = vec4(0.0); return; }
  // Glass: deep toward the lower right, softly lit from the upper left.
  vec3 color = mix(glassA, glassB, clamp(0.5 - 0.4 * p.y + 0.2 * p.x, 0.0, 1.0));
  color += vec3(0.22) * (1.0 - smoothstep(0.0, 1.25, length(p - vec2(-0.45, 0.62))));
  float soft = pixel * 1.2;
  float back = 1.0 - smoothstep(-soft, soft, p.y - surface(p.x, -0.06, 2.6, -1.4, 1.6, true));
  color = mix(color, backColor, back * backAlpha);
  float ink = 1.0 - smoothstep(-pixel, pixel, glyphDistance(p));
  color = mix(color, vec3(1.0), ink);
  float front = 1.0 - smoothstep(-soft, soft, p.y - surface(p.x, -0.16, 2.2, 2.1, 0.0, false));
  color = mix(color, frontColor, front * frontAlpha);
  gl_FragColor = vec4(color * edge, edge);
}
`;
const rgb = (hex: string) =>
  [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
export type LiquidColors = {
  from: string;
  via: string;
  to: string;
  surface: string;
};
export type LiquidFrame = {
  time: number;
  amp: number;
  heights: Float32Array;
  trailing: Float32Array;
};
/** Draws the lens only; owns nothing but these GL resources. */
export type LiquidLook = {
  colors: LiquidColors;
  glyph: "mic" | "record" | "stop";
  grey: boolean;
};
export function createLiquidShader(gl: WebGLRenderingContext) {
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const dispose = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    buffer = null;
    program = null;
    shaders.length = 0;
  };
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Shader unavailable");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Shader compile failed");
      return shader;
    };
    program = gl.createProgram();
    if (!program) throw new Error("Shader program unavailable");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error("Shader link failed");
    gl.useProgram(program);
    buffer = gl.createBuffer();
    if (!buffer) throw new Error("Shader buffer unavailable");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const set3 = (name: string, hex: string) => {
      const location = gl.getUniformLocation(program!, name);
      // Expo GL does not consistently treat a null uniform as a no-op.
      if (location !== null) gl.uniform3fv(location, rgb(hex));
    };
    const set1 = (name: string, value: number) => {
      const location = gl.getUniformLocation(program!, name);
      if (location !== null) gl.uniform1f(location, value);
    };
    // The look can change while the context lives (record → stop, disabled).
    const apply = ({ colors, glyph, grey }: LiquidLook) => {
      set3("glassA", colors.via);
      set3("glassB", colors.to);
      set3("backColor", colors.from);
      set3("frontColor", colors.surface);
      set1("backAlpha", grey ? 0.35 : 0.6);
      set1("frontAlpha", grey ? 0.4 : 0.82);
      set1("glyph", glyph === "mic" ? 0 : glyph === "record" ? 1 : 2);
    };
    const uniforms = Object.fromEntries(
      ["time", "amp", "pixel"].map((name) => [
        name,
        gl.getUniformLocation(program!, name),
      ]),
    );
    // Array uniforms are addressed by their first element.
    const heights = gl.getUniformLocation(program, "heights[0]");
    const trailing = gl.getUniformLocation(program, "trailing[0]");
    gl.clearColor(0, 0, 0, 0);
    return {
      draw(frame: LiquidFrame, look: LiquidLook) {
        if (!program) return;
        apply(look);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        if (heights !== null) gl.uniform1fv(heights, frame.heights);
        if (trailing !== null) gl.uniform1fv(trailing, frame.trailing);
        for (const [name, value] of Object.entries({
          time: frame.time,
          amp: frame.amp,
          pixel: 2 / Math.max(1, gl.drawingBufferWidth),
        })) {
          const location = uniforms[name];
          if (location)
            gl.uniform1f(location, Number.isFinite(value) ? value : 0);
        }
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
