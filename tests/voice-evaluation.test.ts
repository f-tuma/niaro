import { scoreVoiceText } from "../scripts/audio/voice-evaluation";
import cases from "../scripts/audio/voice-cases.cs.json";

const sample = (id: string) => cases.find((value) => value.id === id)!;

test("a time must not swallow the requested duration", () => {
  const request = sample("clarify");
  expect(scoreVoiceText(request, "Zítra ve 14:45.").missing).toHaveLength(1);
  expect(
    scoreVoiceText(request, "Zítra ve 14 hodin na 45 minut.").missing,
  ).toEqual([]);
});

test("written digits in half past do not change the intended time", () => {
  const request = sample("half");
  expect(
    scoreVoiceText(request, "Připrav schůzku zítra v půl 3 odpoledne.").missing,
  ).toEqual([]);
  expect(
    scoreVoiceText(request, "Připrav schůzku zítra v půl 4 odpoledne.").missing,
  ).toHaveLength(1);
});

test("word boundaries preserve negation and names instead of substring matches", () => {
  expect(
    scoreVoiceText(sample("negation"), "Ne, schůzku vytvářej.").missing,
  ).toHaveLength(1);
  expect(
    scoreVoiceText(sample("contact"), "Vyber Petera Novákem.").missing,
  ).toHaveLength(1);
});

test("WER handles empty and punctuation-only text without invalid numbers", () => {
  expect(scoreVoiceText({ text: "", critical: [] }, "...").wordErrorRate).toBe(
    0,
  );
  expect(
    scoreVoiceText({ text: "Ahoj světe", critical: [] }, "AHOJ, světe!")
      .wordErrorRate,
  ).toBe(0);
  expect(
    scoreVoiceText({ text: "Ahoj světe", critical: [] }, "").wordErrorRate,
  ).toBe(1);
});
