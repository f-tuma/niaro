/**
 * Tolerant location of a model's verbatim quote in the original transcript.
 *
 * Models copy quotes with small deviations: other quote marks or dashes,
 * collapsed whitespace, different case, a "Me:" speaker label in front, or a
 * misheard letter. A quote that still means the same words is repaired to
 * the exact original text; one that cannot be found is reported as missing
 * so the caller can drop that single source.
 */
const SPEAKER_LABEL =
  /(?:^|(?<=\s))(?:Já|Ostatní|Me|Others|(?:Mluvčí|Speaker) \d{1,2})\s*:\s*/giu;
const LEADING_LABEL =
  /^\s*(?:Já|Ostatní|Me|Others|(?:Mluvčí|Speaker) \d{1,2})\s*:\s*/iu;
const PUNCTUATION = /[.,!?;:…]/u;
const QUOTES = /["'`´„“”‚‘’«»‹›]/u;
const DASHES = /[‐‑‒–—―−]/u;

/** One character of normalized text; empty for characters that vanish. */
function normalizeChar(char: string) {
  if (/\s/u.test(char)) return " ";
  if (QUOTES.test(char)) return "'";
  if (DASHES.test(char)) return "-";
  // Compatibility forms and accents never decide whether words match; the
  // repaired quote is always the original text, accents included.
  return char.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}
/** Normalized text and, per normalized character, its index in the original. */
export function normalizeWithMap(original: string, stripLabels = true) {
  const text = original;
  const labels = new Set<number>();
  if (stripLabels)
    for (const match of text.matchAll(SPEAKER_LABEL))
      for (let i = 0; i < match[0].length; i++) labels.add(match.index + i);
  let normalized = "";
  const map: number[] = [];
  let index = 0;
  for (const char of text) {
    const value = labels.has(index) ? " " : normalizeChar(char);
    for (const part of value) {
      // Collapse whitespace runs and drop leading whitespace.
      if (part === " " && (!normalized || normalized.endsWith(" "))) continue;
      normalized += part;
      map.push(index);
    }
    index += char.length;
  }
  return { text, normalized, map };
}
export function normalizeQuote(quote: string) {
  let value = normalizeWithMap(quote).normalized.trim();
  // Elision marks and wrapping quotes are the model's, not the speaker's.
  value = value
    .replace(/^(?:\.\.\.|[' ])+/u, "")
    .replace(/(?:\.\.\.|[' ])+$/u, "")
    .trim();
  return value;
}
/**
 * Levenshtein distance of `a` and `b`, or `Infinity` once it must exceed
 * `max`. Only a band of `max` cells either side of the diagonal is filled,
 * and the rows stop as soon as every cell in the band is over `max`.
 */
function boundedDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  const over = max + 1;
  let previous = new Int32Array(b.length + 1).fill(over);
  let current = new Int32Array(b.length + 1).fill(over);
  for (let j = 0; j <= Math.min(b.length, max); j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const from = Math.max(1, i - max);
    const to = Math.min(b.length, i + max);
    current[from - 1] = from === 1 ? Math.min(i, over) : over;
    let lowest = current[from - 1]!;
    const char = a.charCodeAt(i - 1);
    for (let j = from; j <= to; j++) {
      const value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (char === b.charCodeAt(j - 1) ? 0 : 1),
        over,
      );
      current[j] = value;
      if (value < lowest) lowest = value;
    }
    if (to < b.length) current[to + 1] = over;
    if (lowest > max) return Infinity;
    [previous, current] = [current, previous];
  }
  return previous[b.length]! > max ? Infinity : previous[b.length]!;
}
/**
 * Bounded Levenshtein similarity in [0, 1]. A pair less similar than `min`
 * scores 0 without its exact distance being worked out.
 */
export function similarity(a: string, b: string, min = 0) {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  if (Math.abs(a.length - b.length) / longest > 0.15) return 0;
  const distance = boundedDistance(
    a,
    b,
    Math.floor((1 - min) * longest + 1e-9),
  );
  return distance === Infinity ? 0 : 1 - distance / longest;
}
function originalSpan(
  source: ReturnType<typeof normalizeWithMap>,
  start: number,
  end: number,
) {
  const from = source.map[start]!;
  const lastIndex = source.map[end - 1]!;
  const last = source.text.codePointAt(lastIndex)!;
  let to = lastIndex + String.fromCodePoint(last).length;
  while (to < source.text.length && /\p{M}/u.test(source.text[to]!)) to++;
  return source.text.slice(from, to).trim();
}
export const MEETING_QUOTE_SIMILARITY = 0.85;
/**
 * Normalized characters of the longest quote worth a fuzzy search. A
 * repaired quote is kept only up to 600 characters, which a longer quote
 * cannot match at 0.85; past it, a quote must be found as it is.
 */
export const MEETING_QUOTE_FUZZY_CHARS = 720;
/** The last few minutes normalized: one record cites the same minute often. */
const normalizedSources = new Map<
  string,
  ReturnType<typeof normalizeWithMap>
>();
function normalizedSource(text: string) {
  let source = normalizedSources.get(text);
  if (!source) {
    source = normalizeWithMap(text);
    if (normalizedSources.size >= 8)
      normalizedSources.delete(normalizedSources.keys().next().value!);
    normalizedSources.set(text, source);
  }
  return source;
}
/**
 * The exact original text a quote refers to, or undefined. Exact first, then
 * normalized (case, Unicode, quote marks, dashes, whitespace, speaker
 * labels), then the most similar window of words (similarity ≥ 0.85).
 */
export function locateQuote(segmentText: string, quote: string, fuzzy = true) {
  // The speaker label is the transcript's, not the speaker's words.
  const bare = quote.replace(LEADING_LABEL, "").trim();
  if (bare && segmentText.includes(bare)) return bare;
  const needle = normalizeQuote(quote);
  if (needle.length < 2) return undefined;
  const source = normalizedSource(segmentText);
  const at = source.normalized.indexOf(needle);
  if (at >= 0) return originalSpan(source, at, at + needle.length);
  if (!fuzzy || needle.length > MEETING_QUOTE_FUZZY_CHARS) return undefined;
  // Fuzzy: compare against windows of about the same number of words. A
  // cheap word-overlap score picks the candidates worth an edit distance.
  const starts = [0];
  for (let i = 0; i < source.normalized.length; i++)
    if (source.normalized[i] === " ") starts.push(i + 1);
  const bareWord = (word: string) => word.replace(/^\P{L}+|\P{L}+$/gu, "");
  const wordCount = needle.split(" ").length;
  const needleWords = new Set(needle.split(" ").map(bareWord));
  // A quote without its closing (or opening) punctuation matches without it.
  const trimEnd = !PUNCTUATION.test(needle.at(-1) ?? "");
  const trimStart = !PUNCTUATION.test(needle[0] ?? "");
  // Words of the minute that the quote has too, summed up to each word.
  const hits = [0];
  for (const word of source.normalized.split(" "))
    hits.push(hits.at(-1)! + (needleWords.has(bareWord(word)) ? 1 : 0));
  const candidates: { w: number; span: number; overlap: number }[] = [];
  for (let w = 0; w < starts.length; w++)
    for (const span of [wordCount - 1, wordCount, wordCount + 1]) {
      if (span < 1 || w + span > starts.length) continue;
      const overlap =
        (hits[w + span]! - hits[w]!) / Math.max(span, needleWords.size);
      candidates.push({ w, span, overlap });
    }
  candidates.sort((a, b) => b.overlap - a.overlap);
  let best: { start: number; end: number; score: number } | undefined;
  for (const { w, span } of candidates.slice(0, 12)) {
    let start = starts[w]!;
    let end =
      w + span < starts.length
        ? starts[w + span]! - 1
        : source.normalized.length;
    while (end > start + 1 && source.normalized[end - 1] === " ") end--;
    while (
      trimEnd &&
      end > start + 1 &&
      PUNCTUATION.test(source.normalized[end - 1]!)
    )
      end--;
    while (
      trimStart &&
      start < end - 1 &&
      PUNCTUATION.test(source.normalized[start]!)
    )
      start++;
    const score = similarity(
      needle,
      source.normalized.slice(start, end),
      MEETING_QUOTE_SIMILARITY,
    );
    if (!best || score > best.score) best = { start, end, score };
  }
  if (!best || best.score < MEETING_QUOTE_SIMILARITY) return undefined;
  return originalSpan(source, best.start, best.end);
}
/** Whether a short value (an owner or a deadline) appears in a quote, tolerantly. */
export function quoteMentions(quote: string, value: string) {
  if (quote.includes(value)) return true;
  const needle = normalizeQuote(value);
  return !!needle && normalizeWithMap(quote).normalized.includes(needle);
}
