export type VoiceEvaluationCase = {
  text: string;
  critical: string[][];
};

export const voiceWords = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** Literal critical phrases, not a claim of semantic equivalence or ASR confidence. */
export function scoreVoiceText(sample: VoiceEvaluationCase, text: string) {
  const expected = voiceWords(sample.text);
  const actual = voiceWords(text);
  const normalized = ` ${actual.join(" ")} `;
  const missing = sample.critical.filter(
    (group) =>
      !group.some((term) =>
        normalized.includes(` ${voiceWords(term).join(" ")} `),
      ),
  );
  let row = Array.from({ length: actual.length + 1 }, (_, i) => i);
  for (let i = 0; i < expected.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < actual.length; j++)
      next.push(
        Math.min(
          next[j]! + 1,
          row[j + 1]! + 1,
          row[j]! + Number(expected[i] !== actual[j]),
        ),
      );
    row = next;
  }
  return {
    missing,
    wordErrorRate: row[actual.length]! / Math.max(1, expected.length),
  };
}
