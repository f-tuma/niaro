# Proposal

Tracker: **NIAR-302** (wave 1, foundation), **NIAR-303** (wave 2, processes), **NIAR-304** (wave 3, chat), **NIAR-305** (wave 4, remove Mastra and libSQL). Evidence: NIAR-301 spike (`spikes/pi-durable/RESULTS.md`).

## Why

The agent runtime today is Mastra (`@mastra/core`, `@mastra/memory`, `@mastra/libsql`) plus about 9,000 lines of Niaro code that adapts it, proves recovery over its snapshots and keeps a second SQLite driver (libSQL) beside the identity database's `node:sqlite`. The NIAR-301 spike showed that Pi Durable (`@earendil-works/pi-durable`, MIT, experimental) covers the durability Niaro needs (tasks, memos, submissions by request id, resume after a crash) with much less code, that Niaro's policy fits its hooks, and that providers and model roles stay configuration-driven. On 2026-11-07 the owner decided to adopt it, with recovery policy A, aiming at the simplest reliable stack.

## What Changes

- **Wave 1 (NIAR-302), no member-visible change.** Pi Durable, pinned to exact versions, becomes a dependency of `@niaro/server-agent`. A new module `apps/server-agent/pi/` owns one Pi Harness over `node:sqlite` beside the identity database (`identity.sqlite.pi.sqlite`), opened when the identity server starts (resuming interrupted work under policy A) and closed when it stops. A Niaro Pi provider sends every model request through the integration transport (SSRF guard, trusted origins), the admin model policy and catalog, and the inference budget ledger. pi-ai's vendor SDKs are not installed. A reusable crash harness (child process, SIGKILL, reopen) tests recovery at Pi level.
- **Wave 2 (NIAR-303).** Service process graphs run as Pi tasks instead of Mastra workflows: one task per drive, a node per phase, a durable run checkpoint with pending approvals and questions, restart only by the original command after proof. Agent steps move with chat in wave 3.
- **Wave 3 (NIAR-304).** Chat and process agent steps run as Pi conversations: services listing, call-by-name actions, approvals as durable memos, questions, external writes with idempotency keys, checker and visible-reply rules as hooks, streaming to the apps, and a member projection that hides Pi's internal states.
- **Wave 4 (NIAR-305).** Mastra, libSQL and the code that adapts them are removed; the dev database's Mastra store is dropped (pilot: breaking changes allowed).

## Non-goals

- Semantic memory, knowledge search, speech, transcription, embeddings, decisions (Jev) and the web plugin stay on Niaro's own code and transports.
- Horizontal scaling: one server owns one agent core file, as today.
- Compatibility shims for old mobile builds or old Mastra threads.

## Risk

- Pi's API breaks between releases (34 breaking changes in 1.5.0): exact pins and a changelog review before every upgrade.
- Pi's transcript holds internal states (failed attempts, interrupted tool results, aborted partials): the member projection must hide them (wave 3).
- Pi's storage and the identity database share no transaction: business state that must commit with the transcript moves into Pi documents, and every external write carries an idempotency key or is reported to the model as interrupted.
