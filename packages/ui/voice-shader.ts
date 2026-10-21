import { tokens as t } from "../design-tokens";

/** Bands of the voice spectrum the ribbon can follow (matches the audio analysis). */
export const SPECTRUM_BANDS = 24;
const vertex = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = position; gl_Position = vec4(position, 0.0, 1.0); }
`;
// One luminous ribbon built from three translucent layers that share a
// centre. Loudness sets volume, the speech bands shape each layer; waves
// stand in place (no scrolling history) and taper to nothing at the edges.
const fragment = `
precision mediump float;
varying vec2 uv;
uniform vec3 bands;
uniform float spectrum[24];
uniform float shaped;
uniform float time;
uniform float pixel;
uniform float reveal;
uniform vec3 blue;
uniform vec3 violet;
uniform vec3 cyan;
void main() {
  float x = uv.x;
  float y = uv.y;
  // Following a spectrum, the edges carry sibilants, so they may taper later.
  float taper = pow(max(0.0, 1.0 - x*x), mix(1.8, 1.1, shaped));
  float loud = max(bands.x, max(bands.y, bands.z));
  // The voice's spectral envelope along the ribbon: low tones at the centre,
  // high ones toward both edges. Each band is a soft bump; 1.6 bands wide.
  float position = min(abs(x) / 0.85, 1.0) * 23.0;
  float envelope = 0.0;
  for (int i = 0; i < 24; i++) {
    float d = (position - float(i)) / 1.6;
    envelope += spectrum[i] * exp(-d*d);
  }
  envelope = min(1.0, envelope / 1.7);
  vec3 pigment = vec3(0.0);
  float alpha = 0.0;
  for (int layer = 0; layer < 3; layer++) {
    float l = float(layer);
    // Low speech drives the broad layer, mids the main one, sibilants the fine one.
    float energy = layer == 0 ? mix(bands.x, bands.y, 0.35)
                 : (layer == 1 ? bands.y : mix(bands.z, bands.y, 0.3));
    // With a spectrum every layer takes the envelope's shape, the fine one a
    // little less, so the ribbon keeps depth while drawing the voice.
    energy = mix(energy, envelope * (1.0 - 0.18*l), shaped);
    float frequency = layer == 0 ? 2.1 : (layer == 1 ? 3.3 : 5.2);
    float speed = layer == 0 ? 1.3 : (layer == 1 ? 1.9 : 2.7);
    float seed = l * 2.1;
    float wave = sin(x*frequency + seed) * cos(time*speed + seed)
               + 0.35*sin(x*frequency*1.9 - seed) * sin(time*speed*0.7 + seed*1.3);
    float amplitude = taper * (0.035 + 1.05*energy*(0.75 + 0.25*loud));
    // Soft limit: small swings stay linear, loud ones ease toward the edge
    // instead of clipping. The lens reaches ~1.07x the curve, so 0.8 keeps
    // the whole ribbon (and its line) inside the canvas.
    float raw = amplitude * wave;
    float limit = 0.8;
    float curve = raw / sqrt(1.0 + (raw / limit) * (raw / limit));
    // A soft lens between the curve and its mirror gives the ribbon body.
    float body = abs(curve) * (0.62 - 0.12*l);
    float edge = pixel * 1.5;
    float inside = 1.0 - smoothstep(body - edge, body + edge, abs(y - curve*0.45));
    // pow() with a negative base is undefined in GLSL ES; square explicitly.
    float d = (y - curve) / (pixel*0.9 + 0.012);
    float line = exp(-d*d);
    vec3 hue = layer == 0 ? mix(cyan, blue, 0.35 + 0.35*x)
             : (layer == 1 ? mix(blue, violet, 0.5 + 0.5*x) : mix(violet, cyan, 0.5 - 0.5*x));
    float ink = (inside*(0.16 + 0.34*energy) + line*(0.55 + 0.45*energy)) * (0.35 + 0.65*taper);
    pigment += hue * ink;
    alpha += ink;
  }
  float a = clamp(alpha, 0.0, 0.95) * reveal;
  vec3 color = pigment / max(alpha, 0.001);
  gl_FragColor = vec4(color * a, a);
}
`;
// Calm pill outline around the composer. It brightens with the voice level
// instead of spinning on its own, so attention stays on the ribbon.
const borderFragment = `
precision mediump float;
varying vec2 uv;
uniform vec2 resolution;
uniform vec3 bands;
uniform float time;
uniform float pixel;
uniform float reveal;
uniform vec3 blue;
uniform vec3 sky;
uniform vec3 white;
void main() {
  float aspect=resolution.x/max(resolution.y,1.0);
  vec2 p=uv*vec2(aspect,1.0);
  float halfHeight=0.955;
  vec2 extent=vec2(aspect-0.045,halfHeight);
  // Radius equals half the height: an exact pill, like the composer frame.
  vec2 q=abs(p)-(extent-vec2(halfHeight));
  float distance=length(max(q,0.0))+min(max(q.x,q.y),0.0)-halfHeight;
  float loud=max(bands.x,max(bands.y,bands.z));
  float ring=1.0-smoothstep(0.018,0.018+pixel,abs(distance));
  float g=distance/(0.05+0.05*loud);
  float glow=exp(-g*g)*(0.05+0.18*loud);
  float along=p.x/max(aspect,1.0);
  float drift=0.5+0.5*sin(along*2.4+time*0.35);
  vec3 color=mix(mix(sky,blue,drift),white,0.15*(1.0-loud));
  float alpha=min(0.9,ring*(0.55+0.4*loud)+glow)*reveal;
  gl_FragColor=vec4(color*alpha,alpha);
}
`;
const rgb = (hex: string) =>
  [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);

/** No capture or network access. Owns only the resources used by this visual. */
export function createVoiceShader(
  gl: WebGLRenderingContext,
  variant: "wave" | "border" = "wave",
) {
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
    const vert = compile(gl.VERTEX_SHADER, vertex);
    const frag = compile(
      gl.FRAGMENT_SHADER,
      variant === "border" ? borderFragment : fragment,
    );
    program = gl.createProgram();
    if (!program) throw new Error("Shader program unavailable");
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
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
    for (const [name, color] of Object.entries({
      blue: variant === "border" ? t.color.accent.blue : t.color.action.primary,
      violet: t.color.wave.violet,
      cyan: t.color.wave.cyan,
      sky: t.color.wave.cyan,
      white: t.color.surfaceRaised,
    })) {
      const location = gl.getUniformLocation(program, name);
      // Expo GL does not consistently treat a null uniform as a no-op.
      if (location !== null) gl.uniform3fv(location, rgb(color));
    }
    const amplitude = gl.getUniformLocation(program, "bands");
    const time = gl.getUniformLocation(program, "time");
    // Array uniforms are addressed by their first element.
    const spectrum = gl.getUniformLocation(program, "spectrum[0]");
    const strength = gl.getUniformLocation(program, "shaped");
    const resolution = gl.getUniformLocation(program, "resolution");
    const pixel = gl.getUniformLocation(program, "pixel");
    const reveal = gl.getUniformLocation(program, "reveal");
    gl.clearColor(0, 0, 0, 0);
    return {
      draw(
        bands: readonly [number, number, number],
        seconds: number,
        visibility = 1,
        shape?: readonly number[],
        shaped = 0,
      ) {
        if (!program) return;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        if (amplitude !== null)
          gl.uniform3fv(
            amplitude,
            bands.map((value) =>
              Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)),
            ),
          );
        if (spectrum !== null)
          gl.uniform1fv(
            spectrum,
            Array.from({ length: SPECTRUM_BANDS }, (_, i) => {
              const value = shape?.[i] ?? 0;
              return Number.isFinite(value)
                ? Math.max(0, Math.min(1, value))
                : 0;
            }),
          );
        if (strength !== null)
          gl.uniform1f(strength, Math.max(0, Math.min(1, shaped)));
        if (time !== null) gl.uniform1f(time, seconds);
        if (resolution !== null)
          gl.uniform2f(
            resolution,
            gl.drawingBufferWidth,
            gl.drawingBufferHeight,
          );
        if (reveal !== null) gl.uniform1f(reveal, visibility);
        if (pixel !== null)
          gl.uniform1f(pixel, 2 / Math.max(1, gl.drawingBufferHeight));
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.flush();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
