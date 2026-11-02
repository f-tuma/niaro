/**
 * Deterministic lexical ranking for saved memory (NIAR-272).
 *
 * Runs in memory over the plaintext a request has already decrypted; it never
 * builds or stores an index. Tokens are accent- and case-folded, stop words
 * dropped, and two tokens match when they share a long enough prefix, so
 * Czech inflections ("schůzku", "schůzka") meet without a stemmer.
 */

/** BM25 saturation and length normalization. */
export const MEMORY_BM25 = { k1: 1.2, b: 0.75 } as const;
/** Tokens match on a shared prefix of this many characters… */
export const MEMORY_PREFIX = 5;
/** …or when the shorter one, at least this long, starts the longer one. */
export const MEMORY_MIN_PREFIX = 4;
/** At most this many distinct query terms count. */
export const MEMORY_QUERY_TERMS = 20;

const STOP_WORDS = new Set(
  [
    // Czech, already folded (no accents).
    "a aby ale ani asi az bez by byl byla byli bylo byt bude budu ci co do ho i jak jako je jeho jeji jejich jen jeste ji jim jsem jsi jsme jsou jste k kam kde kdo kdy kdyz ke ktera ktere kteri kterou ktery ku ma mam mame mas me mi mne mu muj my na nad nam nas ne nebo neco nic o od on ona oni ono ony po pod pri pro proc s se si sve svuj ta tak take tam te tedy ten tento ti tim to tohle toho tom tomu tu ty u uz v vam vas ve vsak z za ze",
    // English.
    "about all also am an and any are as at be been but by can could did do does for from had has have he her here his how i if in into is it its just me my no not of on or our out please she so some than that the their them then there these they this those to up us was we were what when where which who whom why will with would you your",
  ]
    .join(" ")
    .split(" "),
);

/** NFKD, combining marks and format characters removed, lowercase. */
export function foldMemoryText(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .toLowerCase();
}

/** Folded word tokens of at least two characters, stop words removed, in order. */
export function memoryTokens(text: string) {
  return (foldMemoryText(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => token.length >= 2 && !STOP_WORDS.has(token),
  );
}

/** The minimum-length prefix rule; short tokens must be equal. */
export function memoryTermsMatch(a: string, b: string) {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < MEMORY_MIN_PREFIX) return false;
  const need = Math.min(shorter, MEMORY_PREFIX);
  for (let i = 0; i < need; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Distinct folded query terms in first-seen order, at most 20. */
export function memoryQueryTerms(query: string) {
  return [...new Set(memoryTokens(query))].slice(0, MEMORY_QUERY_TERMS);
}

/**
 * BM25 score of each document for the query, in input order. A document
 * matching no term scores 0. Scores are rounded to 1e-9 so equal evidence
 * always ties exactly and the caller's tie-break decides.
 */
export function memoryScores(query: string, documents: readonly string[]) {
  const terms = memoryQueryTerms(query);
  const docs = documents.map(memoryTokens);
  if (!terms.length || !docs.length) return docs.map(() => 0);
  const total = docs.reduce((sum, tokens) => sum + tokens.length, 0);
  const average = total / docs.length || 1;
  const { k1, b } = MEMORY_BM25;
  const frequencies = terms.map((term) =>
    docs.map(
      (tokens) =>
        tokens.filter((token) => memoryTermsMatch(term, token)).length,
    ),
  );
  const idf = frequencies.map((counts) => {
    const df = counts.filter((count) => count > 0).length;
    return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
  });
  return docs.map((tokens, index) => {
    let score = 0;
    terms.forEach((_, term) => {
      const tf = frequencies[term]![index]!;
      if (!tf) return;
      score +=
        (idf[term]! * (tf * (k1 + 1))) /
        (tf + k1 * (1 - b + (b * tokens.length) / average));
    });
    return Math.round(score * 1e9) / 1e9;
  });
}
