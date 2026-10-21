/** Speech analysis shared by every recorder: one windowed frame in, bounded features out.
 * Pure arithmetic on samples already captured; nothing is stored or sent. */

export const SPECTRUM_BANDS = 24;
const LOW_HZ = 80;
const HIGH_HZ = 8000;

/** In-place iterative radix-2 FFT; `re.length` must be a power of two. */
export function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size)
      for (let k = 0; k < size / 2; k++) {
        const cos = Math.cos(step * k),
          sin = Math.sin(step * k);
        const a = start + k,
          b = a + size / 2;
        const tr = re[b]! * cos - im[b]! * sin;
        const ti = re[b]! * sin + im[b]! * cos;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
  }
}

export type VoiceFrame = {
  /** RMS level in dBFS. */
  level: number;
  /** Mean power per log-spaced band, 80 Hz–8 kHz, in dBFS. */
  spectrum: Float32Array;
  /** 0–1: how much the frame looks like speech rather than noise or silence. */
  voiced: number;
};

/** Band edges on a log scale, where speech formants spread evenly. */
function edges(count: number) {
  return Array.from(
    { length: count + 1 },
    (_, i) => LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / count),
  );
}
const BAND_EDGES = edges(SPECTRUM_BANDS);

/** Mean power of power-spectrum bins between two frequencies, in dB. */
function bandPower(
  power: Float32Array,
  binHz: number,
  from: number,
  to: number,
) {
  const start = Math.max(1, Math.floor(from / binHz));
  const end = Math.max(
    start + 1,
    Math.min(power.length, Math.ceil(to / binHz)),
  );
  let sum = 0;
  for (let i = start; i < end; i++) sum += power[i]!;
  const mean = sum / (end - start);
  return mean > 0 ? 10 * Math.log10(mean) : -160;
}

/** Features of one frame of mono samples (-1..1). Any length is accepted; the
 * largest power-of-two tail is analysed with a Hann window. */
export function analyseFrame(
  samples: Float32Array,
  sampleRate: number,
): VoiceFrame {
  let n = 1;
  while (n * 2 <= samples.length && n < 4096) n *= 2;
  const offset = samples.length - n;
  const re = new Float32Array(n),
    im = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const value = samples[offset + i]!;
    energy += value * value;
    re[i] = value * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  const rms = Math.sqrt(energy / Math.max(1, n));
  const level = rms > 0 ? 20 * Math.log10(rms) : -160;
  fft(re, im);
  // Hann window coherent gain is 0.5; normalise so a full-scale tone reads ~0 dB.
  const scale = 2 / (n * 0.5);
  const power = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    const m = Math.hypot(re[i]!, im[i]!) * scale;
    power[i] = m * m;
  }
  const binHz = sampleRate / n;
  const spectrum = new Float32Array(SPECTRUM_BANDS);
  for (let i = 0; i < SPECTRUM_BANDS; i++)
    spectrum[i] = bandPower(power, binHz, BAND_EDGES[i]!, BAND_EDGES[i + 1]!);
  return { level, spectrum, voiced: voicing(power, binHz, level) };
}

/** Speech concentrates energy in 250–3500 Hz and is far from spectrally flat;
 * fans, traffic and hiss spread evenly. Both cues, not loudness alone. */
function voicing(power: Float32Array, binHz: number, level: number) {
  if (level < -70) return 0;
  const start = Math.max(1, Math.floor(250 / binHz));
  const end = Math.min(power.length, Math.ceil(3500 / binHz));
  let inside = 0,
    total = 0,
    logSum = 0,
    count = 0;
  for (let i = 1; i < power.length; i++) {
    const p = power[i]! + 1e-12;
    total += p;
    if (i >= start && i < end) {
      inside += p;
      logSum += Math.log(p);
      count++;
    }
  }
  if (!count || total <= 0) return 0;
  const ratio = inside / total;
  const flatness = Math.exp(logSum / count) / (inside / count);
  const tonal = Math.max(0, Math.min(1, (0.45 - flatness) / 0.35));
  const band = Math.max(0, Math.min(1, (ratio - 0.35) / 0.4));
  return Math.sqrt(tonal * band);
}

/** Keeps the latest samples so any caller can read a current frame. */
export class SampleWindow {
  private buffer: Float32Array;
  private filled = 0;
  constructor(readonly size: number) {
    this.buffer = new Float32Array(size);
  }
  push(samples: Float32Array) {
    if (samples.length >= this.size) {
      this.buffer.set(samples.subarray(samples.length - this.size));
      this.filled = this.size;
      return;
    }
    this.buffer.copyWithin(0, samples.length);
    this.buffer.set(samples, this.size - samples.length);
    this.filled = Math.min(this.size, this.filled + samples.length);
  }
  frame() {
    return this.filled ? this.buffer.subarray(this.size - this.filled) : null;
  }
}

/** Linear resampling to the speech rate the server transcribes; enough for voice. */
export function resample(samples: Float32Array, from: number, to: number) {
  if (from === to) return samples;
  const length = Math.floor((samples.length * to) / from);
  const out = new Float32Array(length);
  const ratio = from / to;
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(samples.length - 1, index + 1);
    const t = position - index;
    out[i] = samples[index]! * (1 - t) + samples[next]! * t;
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}
