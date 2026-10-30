# Private memory and observations

The memory plugin keeps explicit notes and private observations in Niaro's existing encrypted Mastra saved-memory store. A workspace must already allow and enable the plugin. Each person's opt-out applies to retrieval and learning. This change does not enable the plugin, configure providers or extract existing account data during deployment.

Explicit notes are user assertions. Observations are model inferences about one person in one workspace; their section, personal flag and up to five source references are encrypted with the statement. They become active private records after the learner's guarded commit. They never grant permission, approve a native action or replace current service authorization. Correcting an observation creates an explicit user note in the same lineage. Later extraction cannot revise that explicit note.

## Eligible evidence

Learning reads new accepted messages written by the person, the names of that person's bound successful service actions, and their own `me` turns in two-track meetings they recorded. A meeting task requires explicit `owner=me` and quotes backed by those turns. A null assignee is insufficient. Quoted, forwarded and code text, service results, other or unknown speakers, single-track speaker guesses, attachments, mailboxes and documents are excluded. There is no historical backfill or voice identification.

The closed extraction agent has no tools, shared conversation or memory. Its output is untrusted and passes strict count, length, section and evidence checks plus conservative EN/CS sensitive-data and credential filters. Those lexical filters and synthetic tests are defense in depth; they do not establish measured live-model quality. Sensitive health, ethnicity, political or religious beliefs, union membership, sexuality, biometrics/genetics and credentials/account numbers must not be retained.

## Context and retention

A saved observation can appear on the next turn, in a separate untrusted block of at most 12 observations and 1,500 serialized characters. Work observations precede personal ones; newer last-seen records precede older ones. Explicit lexical context has its own existing limit. Direct `memory_search` can search both origins. Expiry and the common memory version invalidate pending context. Owner-confirmed job/department values have an optional empty port here; the later pet server task supplies them.

There are at most 300 active private observations, independently of the explicit-memory limit. Reinforcement refreshes last seen and retention without creating another record. Updates supersede the prior observation and preserve first seen. Oldest observations are erased when capacity is exceeded. Source links follow archived chats through stable source IDs; deleted sources appear as removed.

## Owner controls and server contract

The existing authenticated memory endpoint supports `GET /admin/api/identity/memory?organizationId=…&workspaceId=…&scope=private`, returning a private readable `total` and at most 200 items. POST owner commands use the same target and stable `requestId`:

- `classify` with `id`, `revision`, `personal` changes an observation's classification.
- `personalThings` with `value: "keep" | "drop"` changes personal retention. Drop erases personal observed history and pending observation stages while preserving an explicit corrected head and its receipt.
- `forget` erases the whole chosen lineage; `forgetAll` with `scope: "private"` erases the owner's private records, including staged and expired history. Replaying an old erase-all command cannot erase newly created records.
- `preference` with `optOut` controls memory use and learning.

These controls remain available with learning disabled or opt-out enabled. Other people, workspaces and tenants cannot read or mutate these private records. The NIAR-243 member page and NIAR-246 pet/profile page remain later work; the existing administration panel only adds an observed-source label.

## Background work and uncertain charges

A 60-second scheduler considers at most four people, with at least ten minutes between attempts. Bounded rotating source discovery repairs missed notifications. Durable offsets retain unread own text and whole used-action names; a source is acknowledged only after both have been supplied. Partial offsets carry a digest of the eligible projection, so changed evidence restarts that source safely while a locator move preserves continuation. Available chat and meeting streams alternate with bounded per-stream allocation, including JSON escaping in the provider request, so either stream can advance while the other has a backlog or long action names. Failures back off for one hour, then six hours. Current membership, a live sign-in, plugin settings, opt-out, source access, model/provider settings and memory version are checked before publication. Captured memory version and durable privacy generation are also fenced before reservation and the held provider start, so completed erasure or correction cannot send an unpaid stale request.

Only an enforce-mode inference policy with a matching model/provider price can admit learning. Requests use the normal model SDK and inference ledger, bounded to two calls, 40,000 tokens and 100,000 cost micros, further narrowed by workspace policy. User material is at most 12 KiB; full first and repair requests are at most 24 KiB; output is limited to 2,000 tokens. No budget bypass or fallback provider is used. Only terminal ledger-cancelled pre-dispatch attempts are excluded from the private learner’s model-call slot count; their ledger rows, usage and cost accounting remain intact. Ordinary callers without the trusted profile hook retain the existing call-count rules. An incompatible wholly unpaid plan may obtain a new logical root only after owner-checked proof over every bound attempt and the complete old root shows no dispatch; old cancelled ledger and content-free root history remain. Dispatched, settled, unknown and received paid work never qualifies for that transition.

A source batch keeps one paid root across restarts, lease expiry and backoffs. Dispatch and ledger markers commit before the network starts. A received response is encrypted with an owner/batch-bound key domain and expires within 24 hours or current retention. A valid received answer can be replayed without another paid call, even when usage is unknown and the ledger retains its hold. Missing or uncertain responses, erased checkpoints and exhausted repair calls cannot automatically obtain a replacement paid root. Such a person's batch can remain blocked pending future proof-based reconciliation; no reset/reconciliation API is supplied here. Owner privacy changes scrub pending response ciphertext, and late callbacks cannot restore it. Bounded startup and 60-second-tick maintenance scrub expired ciphertext independently of sign-in, plugin settings or model/budget admission while preserving outcome/root/hold metadata.

## Upgrade and evaluation limits

The upgrade adds origin, last-seen and personal-preference columns while preserving old explicit records and writes. In-place downgrade to the old binary is unsupported: old positional inserts and strict source decoders reject the new format. Prefer a forward fix; stopped-writer restoration requires a consistent pre-upgrade identity/native/workflow backup and loses later writes. The copied-tuple reverse tool refuses observed records instead of converting them into assertions.

`node --import tsx scripts/profile-extraction-eval.ts` runs synthetic EN/CS controlled-output logic through the actual learner, SDK and ledger. Its fixture oracle does not measure model quality. A live quality evaluation requires an already authorized designated development model and synthetic snippets through the normal budget; none is configured or claimed by this checkpoint.
