import { speechBands, voiceVisualMeter } from "../packages/audio/spectrum";

test.each([
  [80, 300, 0],
  [300, 2000, 1],
  [2000, 8000, 2],
])("%i–%i Hz drives only its own voice layer", (from, to, index) => {
  const data = new Float32Array(1024).fill(-Infinity);
  for (
    let bin = Math.ceil((from * 2048) / 48000);
    bin < Math.ceil((to * 2048) / 48000);
    bin++
  )
    data[bin] = -24;
  const result = speechBands(data, 48000, 2048);
  result.forEach((db, band) =>
    expect(db).toBeCloseTo(band === index ? -24 : -160),
  );
});
test("silence, unavailable bins and a low sample rate stay finite", () => {
  expect(speechBands(new Float32Array(128).fill(NaN), 8000, 256)).toEqual([
    -160, -160, -160,
  ]);
  expect(speechBands(new Float32Array(0), 48000, 2048)).toEqual([
    -160, -160, -160,
  ]);
});

test("quiet speech is visible without shouting while silence and invalid samples stay still", () => {
  const quiet = voiceVisualMeter(-52, [-74, -70, -80]);
  expect(quiet.level).toBeGreaterThan(0.5);
  expect(quiet.bands![0]).toBeGreaterThan(0.45);
  expect(quiet.bands![1]).toBeGreaterThan(quiet.bands![0]);
  expect(voiceVisualMeter(-80, [-70, -70, -70])).toEqual({
    level: 0,
    bands: [0, 0, 0],
  });
  expect(voiceVisualMeter(NaN, [NaN, Infinity, -Infinity])).toEqual({
    level: 0,
    bands: [0, 0, 0],
  });
  expect(voiceVisualMeter(0, [0, 0, 0])).toEqual({
    level: 1,
    bands: [1, 1, 1],
  });
});
