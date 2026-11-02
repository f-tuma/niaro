# Proposal

Tracker: **NIAR-272** (from the NIAR-265 inspiration research: `memory-ranking-czech`, ideas KNOW-04 and KNOW-08).

## Why

Each turn gets at most 8 saved memories, so the ranking decides what the assistant knows. `MemoryStore.search()` counts how many query tokens a record contains as substrings. Czech inflection breaks it: "schůzku" does not find "schůzka", and accents in the query decide whether anything matches. Every matching token also counts the same, so a record that shares only a common word ranks with one that shares a rare name.

The learner already refuses observations in sensitive categories (NIAR-246), but the person cannot see the list. Meetings record colleagues, so the profile needs a stated boundary.

## What Changes

- `MemoryStore.search()` ranks records by BM25 (k1 = 1.2, b = 0.75) over accent- and case-folded tokens, with a short Czech and English stop list and a minimum-length prefix rule. Preferences stay first; ties fall back to recency and then id.
- The ranking is computed per request over the plaintext the store already decrypts. Nothing new is stored: no index, no token list.
- `docs/guides/memory.md` documents the fixed list of categories the learner never keeps, and the ranking.
- Pet's **About you** (web `/pet`, phone Library) shows the list in a closed disclosure "What Niaro never learns", EN and CS.
- A fixed synthetic Czech and English test set with expected top results, and deterministic ordering tests.

## Non-goals

- Embeddings, semantic recall or a search index (`docs/architecture.md` keeps semantic recall off).
- A recency factor from use stamps (KNOW-02), a recall preview (KNOW-05) or any new memory UI beyond the About you disclosure.
- Changing the learner's filter patterns or what it extracts.
- Measuring against real memories.

## Risks

- Prefix matching over-matches short stems ("fakt" also recalls "faktura"). Mitigation: a 4-character minimum and a 5-character shared prefix; shorter tokens must be equal.
- Ranking changes which 8 memories reach a turn. Preferences are unaffected; the fixed test set pins the expected order.
- The sensitive-category filter is lexical and misses paraphrases, especially inflected Czech. The copy promises no guarantee and points to Delete.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `memory`: lexical ranking of saved memory; the documented never-kept categories shown to the person.

## Impact

- Server: new `apps/server-identity/memory-ranking.ts`; `MemoryStore.search()` in `apps/server-identity/memory.ts`.
- Web app: `apps/server-admin/web/app/pet-page.tsx`, `pet-copy.ts`.
- Phone: `apps/mobile/PetProfile.tsx`, `pet-profile-copy.ts` (ships with the next build).
- Docs: `docs/guides/memory.md`.
- Tests: new `tests/memory-ranking.node.ts`, `tests/fixtures/memory-ranking-set.ts`; `tests/web-pet-page.test.tsx`.
- Protocol: none. Storage: none.
