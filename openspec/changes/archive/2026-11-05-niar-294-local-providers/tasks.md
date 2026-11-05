# Tasks

## 1. Provider shape and requests

- [x] 1.1 `packages/protocol/providers.ts`: dialect, key handling, presets, free limits, search backend kinds (Provider presets, Provider key handling).
- [x] 1.2 Provider settings gain preset, auth, dialect, free and data-handling note; saves fill a missing dialect; stored providers migrate once without a revision bump (Organization-owned providers, Stored provider dialect).
- [x] 1.3 One request helper for headers and endpoints; OpenRouter flags only in its dialect; keyless providers store no key and count as connected (Write-only provider keys).

## 2. Discovery and capability test

- [x] 2.1 Discovery from a plain `/models` list; unknown models importable without tool calling; image input from modalities; zero list price for free providers (Model discovery, Declared tool support).
- [x] 2.2 `POST …/catalog/models/test`: probes by kind, budgeted chat probes, daily limit, answers only; image input as a declared capability (Capability test, Manual model entry).

## 3. Free providers and audio

- [x] 3.1 Implied zero prices in the applied usage policy, never stored, pinned in runs (Free providers' models).
- [x] 3.2 Multipart transport; voice input, meetings and spoken replies through the standard endpoints of any provider (Audio through standard endpoints).

## 4. Web search

- [x] 4.1 Search backends with write-only keys, removal guard, policy option and reference check (Search backends).
- [x] 4.2 SearXNG, Brave and Tavily searches; provider search by dialect; costs, logs and privacy (Search through a backend, Search through OpenRouter, Search costs, Privacy).

## 5. Bundle and console

- [x] 5.1 Bundle carries the provider fields and a `searchBackends` section without keys; the policy names its backend (Configuration bundle export).
- [x] 5.2 Provider form with presets, data-handling note on cards, capability test in the model editor, search backends section, web search setting on Models (Provider and model pages, Models page).

## 6. Checks

- [x] 6.1 `tests/local-providers.node.ts` and `tests/admin-local-providers.test.tsx`; affected suites, type check, lint, MCP suite.
