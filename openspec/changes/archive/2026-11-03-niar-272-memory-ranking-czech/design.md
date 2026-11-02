# Design

## Context

- `MemoryStore.search()` (`apps/server-identity/memory.ts`) reads up to 2,000 scoped rows inside a gate, decrypts them outside it, then filters readable items and sorts: preferences first, then a score, then `updatedAt` desc, then `id`. The score was the number of NFKC-lowercased query tokens (at least 2 characters, at most 20) contained as substrings in the record. The result is cut to `maxItems` and `maxContextChars`.
- The NIAR-246 learner filters observations with `isSafeObservation()` (`apps/server-identity/profile-material.ts`): folded EN/CS patterns for health, ethnic origin, political, religious or philosophical beliefs, trade union membership, sexuality, biometric or genetic data, credentials, IBAN, card, account and birth numbers, and instruction-like text. The guide named the categories in one sentence; the pet showed nothing.

## Decisions

### D1. BM25 in a pure module

`apps/server-identity/memory-ranking.ts` exports `memoryScores(query, documents)`, a pure function without I/O. `search()` calls it over the contents of the readable items of this request and keeps its existing sort and limits. The corpus statistics (document count, average length, document frequency) come from the same readable candidates, so they change only with the person's own readable memories.

Score per query term: `idf × tf × (k1 + 1) / (tf + k1 × (1 − b + b × dl / avgdl))` with `idf = ln(1 + (N − df + 0.5) / (df + 0.5))` (never negative), k1 = 1.2, b = 0.75. Scores are rounded to 1e-9 so equal evidence ties exactly and the tie-break decides.

*Alternative.* SQLite FTS5 over the content: it would store plaintext on disk next to the encrypted payload, which the memory spec forbids.

### D2. Folding, stop words and the prefix rule

- Folding: NFKD, combining marks and format characters removed, lowercase.
- Tokens: runs of letters and digits of at least 2 characters, minus a short Czech (folded) and English stop list. At most 20 distinct query terms.
- Matching: two tokens match when they are equal, when both have at least 5 characters and share the first 5, or when the shorter has at least 4 characters and starts the longer. So "schůzku"/"schůzka", "faktura"/"faktury", "úkol"/"úkoly" and "invoice"/"invoices" match; "cr"/"crm", "kontrola"/"kontaktní" and "contact"/"contract" do not.
- `tf` counts the record's tokens that match the query term; `df` counts the records with at least one.

*Alternatives.* A Czech suffix stemmer (more rules to maintain, little gain for short notes); a fixed 5-character prefix only (misses 4-letter roots such as "úkol" and "plán").

### D3. Ordering

Preferences first regardless of score (unchanged). Other records need a score above zero. Then score desc, `updatedAt` desc, `id` asc. The same input gives the same order, independent of row order.

### D4. Never-kept categories

The list lives in `docs/guides/memory.md` ("Never kept") and matches the existing filter; the filter itself does not change. Pet's About you sheet on web and phone gets a closed disclosure "What Niaro never learns" / "Co si Niaro nikdy nezapíše" with the list and "If something slips through, delete it." There is no promise of completeness. A test checks that the guide names each category and that the filter refuses an EN and a CS example of each.

## Verification

- `tests/memory-ranking.node.ts`: folding, stop words and the prefix rule; the fixed set in `tests/fixtures/memory-ranking-set.ts` (22 synthetic CS/EN memories, 15 queries with expected leading results); order independence and exact ties; through `MemoryStore.search()`: preferences first, the expected top 8 with recency tie-breaks, repeated searches identical, another person's record never ranked; no table or row of the identity database holds the memory text; the never-kept list.
- Existing `tests/memory*.node.ts` and `tests/profile-*.node.ts`.
- `tests/web-pet-page.test.tsx`: About you shows the closed "What Niaro never learns" disclosure with the list; the other web and phone pet tests (`npm test`).

## Not verified

- Quality on real memories (none were used).
- The disclosure in a browser and on a device (no dev server in this change).
