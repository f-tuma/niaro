import { assessTranscript } from "../apps/fixture-server/voice";
const output = (text: string, p = 0.96) => ({
  transcription: [
    { text, tokens: text.split(" ").map((text) => ({ text, p })) },
  ],
});
test("clear token evidence permits a message, not an assertion of semantic correctness", () => {
  expect(
    assessTranscript(output("Prepare a meeting with Peter tomorrow")),
  ).toEqual({
    text: "Prepare a meeting with Peter tomorrow",
    reviewReasons: [],
  });
});
test("weak and missing quality evidence require review", () => {
  expect(assessTranscript(output("Find Petra", 0.4)).reviewReasons).toContain(
    "uncertain",
  );
  expect(
    assessTranscript({ transcription: [{ text: "Find Petra" }] }).reviewReasons,
  ).toEqual(["uncertain"]);
  const singleWeak = output("Find Petra today");
  singleWeak.transcription[0]!.tokens[1]!.p = 0.05;
  expect(assessTranscript(singleWeak).reviewReasons).toContain("uncertain");
});
test("suspicious repetition and recording cutoff require review even with high token scores", () => {
  expect(
    assessTranscript(
      output("thank you thank you thank you thank you thank you"),
    ).reviewReasons,
  ).toContain("repetition");
  expect(
    assessTranscript(output("Prepare a meeting"), true).reviewReasons,
  ).toEqual(["limit"]);
});
test.each([
  {},
  output(""),
  output("[Music]"),
  output("(silence)"),
  output("a", 5),
])(
  "unusable/malformed output never becomes a submitted command: %j",
  (value) => {
    expect(() => assessTranscript(value)).toThrow();
  },
);
