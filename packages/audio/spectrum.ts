/** Mean power per speech band in dBFS. Unequal bin counts cannot bias the result. */
export function speechBands(
  spectrum: Float32Array,
  sampleRate: number,
  fftSize: number,
): readonly [number, number, number] {
  const band = (from: number, to: number) => {
    const start = Math.max(0, Math.ceil((from * fftSize) / sampleRate));
    const end = Math.min(
      spectrum.length,
      Math.ceil((to * fftSize) / sampleRate),
    );
    let power = 0;
    for (let i = start; i < end; i++) {
      const db = spectrum[i]!;
      if (Number.isFinite(db)) power += 10 ** (db / 10);
    }
    return power > 0 && end > start
      ? 10 * Math.log10(power / (end - start))
      : -160;
  };
  return [band(80, 300), band(300, 2000), band(2000, 8000)];
}

/** Visual compression makes quiet speech readable; a separate RMS gate keeps silence still. */
export function voiceVisualMeter(
  db: number | null,
  bands?: readonly [number, number, number] | null,
  spectrum?: ArrayLike<number> | null,
): {
  level: number;
  bands?: readonly [number, number, number];
  spectrum?: readonly number[];
} {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const response = (value: number | null, floor: number, ceiling: number) =>
    value !== null && Number.isFinite(value)
      ? clamp((value - floor) / (ceiling - floor)) ** 0.65
      : 0;
  const level = response(db, -66, -30);
  const gate = db !== null && Number.isFinite(db) ? clamp((db + 68) / 10) : 0;
  const band = (value: number) => response(value, -88, -44) * gate;
  // The voice's shape, independent of microphone gain: each band relative to the
  // strongest one (40 dB range), then scaled by how loud the frame is.
  const peak = spectrum ? Math.max(...Array.from(spectrum)) : -160;
  const shape = spectrum
    ? Array.from(
        spectrum,
        (value) =>
          (Number.isFinite(value) ? clamp((value - (peak - 40)) / 40) : 0) **
            1.6 *
          level *
          gate,
      )
    : undefined;
  const mean = (from: number, to: number) =>
    shape!.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);
  return {
    level,
    bands: bands
      ? [band(bands[0]), band(bands[1]), band(bands[2])]
      : shape
        ? [mean(0, 8), mean(8, 17), mean(17, shape.length)]
        : undefined,
    ...(shape ? { spectrum: shape } : {}),
  };
}
