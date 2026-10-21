import {
  analyseFrame,
  encodeWav,
  fft,
  resample,
  SampleWindow,
  SPECTRUM_BANDS,
} from "../packages/audio/analysis";

const rate = 16000;
const tone = (hz: number, amplitude = 0.5, length = 1024) =>
  Float32Array.from(
    { length },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate),
  );
/** A deterministic pseudo-random hiss. */
const noise = (amplitude: number, length = 1024) => {
  let seed = 7;
  return Float32Array.from({ length }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return amplitude * ((seed / 0x7fffffff) * 2 - 1);
  });
};
/** A crude vowel: harmonics of 140 Hz shaped by two formants. */
const vowel = (amplitude = 0.3, length = 1024) =>
  Float32Array.from({ length }, (_, i) => {
    let value = 0;
    for (let h = 1; h < 25; h++) {
      const hz = 140 * h;
      const formant =
        Math.exp(-(((hz - 700) / 200) ** 2)) +
        0.6 * Math.exp(-(((hz - 1200) / 250) ** 2));
      value += formant * Math.sin((2 * Math.PI * hz * i) / rate);
    }
    return amplitude * value * 0.5;
  });

test("fft finds a tone in its bin", () => {
  const re = tone(1000, 1, 256),
    im = new Float32Array(256);
  fft(re, im);
  const magnitude = Array.from(re, (r, i) => Math.hypot(r, im[i]!)).slice(
    0,
    128,
  );
  expect(magnitude.indexOf(Math.max(...magnitude))).toBe(
    Math.round((1000 * 256) / rate),
  );
});

test("the spectrum places low and high sounds in the matching bands", () => {
  const low = analyseFrame(tone(200), rate).spectrum;
  const high = analyseFrame(tone(5000), rate).spectrum;
  expect(low.length).toBe(SPECTRUM_BANDS);
  const peak = (s: Float32Array) => Array.from(s).indexOf(Math.max(...s));
  expect(peak(low)).toBeLessThan(6);
  expect(peak(high)).toBeGreaterThan(SPECTRUM_BANDS - 7);
  expect(analyseFrame(tone(1000, 0.5), rate).level).toBeCloseTo(-9, 0);
});

test("voicing tells a vowel from hiss of the same loudness and from silence", () => {
  const speech = analyseFrame(vowel(), rate);
  const hiss = analyseFrame(noise(0.3), rate);
  expect(Math.abs(speech.level - hiss.level)).toBeLessThan(1);
  expect(speech.voiced).toBeGreaterThan(0.6);
  expect(hiss.voiced).toBeLessThan(0.25);
  expect(analyseFrame(new Float32Array(1024), rate).voiced).toBe(0);
});

test("the window keeps the newest samples; resampling and WAV preserve the signal", () => {
  const window = new SampleWindow(4);
  expect(window.frame()).toBeNull();
  window.push(Float32Array.from([1, 2, 3]));
  expect(Array.from(window.frame()!)).toEqual([1, 2, 3]);
  window.push(Float32Array.from([4, 5]));
  expect(Array.from(window.frame()!)).toEqual([2, 3, 4, 5]);
  const down = resample(tone(300, 0.5, 4800), 48000, 16000);
  expect(down.length).toBe(1600);
  const wav = encodeWav(Float32Array.from([0, 1, -1]), 16000);
  const view = new DataView(wav.buffer);
  expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getInt16(46, true)).toBe(32767);
  expect(view.getInt16(48, true)).toBe(-32768);
  expect(wav.length).toBe(44 + 6);
});
