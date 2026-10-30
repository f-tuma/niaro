# Architecture decisions

The lasting decisions behind Niaro and why they were made. Behavior is in
[`openspec/specs/`](../openspec/specs/); a new decision is recorded in its
change's `design.md` and added here when it outlives the change. Each line is
the decision, then the reason.

## Product boundary

- **Not an everything-app.** Calendar, mail, CRM and documents stay in the
  company's services; the agent reads and changes them there. Keeps scope small
  and avoids a second system of record.
- **One image, one volume, administration inside the same app.** Install,
  backup and upgrade stay simple for a single company. One container per
  volume; no replicas.
- **The server decides, clients render.** Identity, integrations, permissions,
  workflow, model routing and credentials live on the server. The web and
  mobile apps hold no model, tool implementation or business logic.

## Authority

- **Models propose, never command or approve.** A model chooses only
  validated, registered actions. Prompts, UI state, tool arguments, transcripts
  and model output never grant permission or approval.
- **Authority is checked, never cached as a grant.** Permissions are checked at
  discovery, again at dispatch and at commit, and for processes at freeze,
  test, activation, start and every step. Role, membership and policy changes
  advance a policy epoch that retires in-flight work.
- **A client-selected organization or workspace is only a selector.** The
  authenticated session derives user and workspace; request bodies cannot
  override them.
- **Signing in does not authorize administration.** Console access is a
  separate role decision.
- **Membership alone grants nothing.** Workspaces are server-owned resources,
  not Better Auth teams; tools and connections are explicit grants and new
  workspaces start empty.
- **Personal processes run only on their owner's grants.** Administrators can
  read them but not change them, so nobody acts under someone else's authority.

## Effects, approvals and receipts

- **An approval binds the reviewed revision.** An edit voids consent; a
  duplicate or late approval never creates a second operation; an ambiguous
  "yes" or a rendered card never approves.
- **Approval is Niaro's `service.resolve` on its own receipt, not Mastra's
  tool-call approval.** The receipt binds operation, action revision, sign-in
  pin and work revision, and is idempotent and audited.
- **Durable receipts are checked before inference.** A replay never pays for a
  second model call and never repeats a completed action.
- **Unknown outcomes are never resent.** An uncertain write or model call is
  `unknown`; only an explicit command enters proof-gated reconciliation. Its
  budget reservation is kept: a conservative bound beats a guessed refund.
- **Writes verify, not trust a 2xx.** An external write uses a deterministic
  identity with a conditional create and is confirmed by an independent read.
- **Nothing implicit resumes work.** No boot, read, poll or page open starts,
  resumes or approves a run. Recovery is explicit.
- **Derived output never rewrites an effect.** A succeeded write stays
  succeeded when a later output check or budget refusal fails.
- **Inference holds no database transaction.** Session and cursor are rechecked
  before commit.

## Agent runtime

- **Mastra owns the loop, history and checkpoints; Niaro owns authority,
  receipts and approvals.** Native checkpoints and business receipts share no
  transaction, which is why recovery is explicit.
- **One execution engine.** Processes compile frozen definitions to native
  Mastra workflows and agents and share the chat runtime, catalog controller
  and receipts. No second trust implementation.
- **The chat model plans; the decision model only makes narrow choices.** Its
  checks are hints, not gates.
- **The model sees a services listing and loads actions by name.** A full
  catalog in every prompt was too slow and costly.
- **Mastra semantic recall and working memory stay off** until a retrieval and
  deletion policy exists.

## Identity and credentials

- **Better Auth with the Organization plugin** is the identity foundation
  (owner, admin, member) rather than a home-grown stack.
- **Identity is the OIDC issuer and subject,** mapped to the server's own user;
  never an email match and never a bare OAuth token.
- **Provider tokens never reach clients.** The app gets a server-issued
  credential through a short one-use code with PKCE.
- **Bearer tokens travel only in the `Authorization` header** and are stored
  only as SHA-256 digests. URLs leak into logs; a database read must not yield
  usable credentials.
- **Only the user-selected server receives the token;** fetches forbid
  redirects and ambient cookies.
- **The native credential lives in SecureStore** (this device only, excluded
  from backup) with no plaintext fallback.
- **Signing out does not cancel approved server work.** Approval and effect are
  server-owned.
- **The recovery key is an independent, revocable backup** that never
  impersonates a member; only its digest is stored.
- **Service credentials are write-only and encrypted** with keys derived
  separately from the auth secret.
- **Personal service sign-in is one generic mechanism** (`never`, `writes`,
  `all`) and never falls back to the shared credential: mailboxes and calendars
  must see the person. The account is bound by the id_token subject, so a
  forwarded consent link cannot attach someone else's account (GitHub is
  refused for that reason). A refresh keeps the connection revision; only
  `invalid_grant` disconnects.
- **MCP grants for external AI apps are a separate credential store** bound to
  the original member record, so leaving and rejoining never restores access.
  No refresh tokens; manual tokens expire within 30 days; OAuth uses the
  Better Auth provider with pinned callbacks and PKCE S256; dynamic client
  registration and metadata fetching are off (SSRF risk). A durable job keeps
  only the grant id and revalidates it before each dispatch.
- **The activity log holds metadata only,** written in the same transaction as
  the change. It is not tamper-evident and has no retention.

## Models and budget

- **The budget is per root run, not a workspace quota.** Each call reserves its
  own request size, not the model maximum, so large-context models stay usable.
- **Speech is outside the ledger** because providers bill it by duration or
  characters.
- **Provider calls deny data collection and request zero data retention;**
  nothing silently weakens that. Provider errors expose only safe codes.

## Memory

- **Memory distinguishes explicit assertions and private observations.** Explicit
  candidates never enter context. Active observations are attributed model
  inferences, bounded separately and never permissions; any memory change or
  expiry invalidates pending context. Corrections become explicit user notes.
  Ordinary erasure covers the whole lineage; personal-only erasure removes
  observed history while preserving an explicit corrected head.
- **Private learning uses existing source and budget owners.** Transaction-bound
  minimal chat/meeting references, durable cursors and leases feed a quiet
  no-tool extraction agent through the normal model SDK and inference ledger.
  Only current own evidence is eligible. Unknown paid outcomes retain their
  original root/hold across restart; bounded encrypted response checkpoints
  permit replay without a repeated charge. See [memory](guides/memory.md).
- **Saved memory is encrypted in Mastra Memory** with its lifecycle in identity
  storage.
- **Memory and search grow inside Niaro's own storage, on Mastra** (decided
  29 Oct 2026, after surveying Mem0, Graphiti, Letta, Cognee, Qdrant, LanceDB
  and pgvector). No separate memory framework or database service: they would
  call models outside the ledger and duplicate encryption, erasure and
  access rules. The memory store stays the source of truth; any vector index
  (libSQL vectors first, LanceDB if it outgrows them) is derived, rebuildable
  and erased with its record. Every indexed item carries its access labels,
  queries filter by them and each hit is re-checked against current identity
  before use (fail closed), and what reaches whom is recorded.
- **A public chat is separate from native threads** (one chat can span several
  native segments), with a continuation lock per chat. Opening history never
  invokes a model.

## Interface

- **Generated UI is an inline OpenUI Lang program,** not a tool call: one
  shared spec drives the prompt, the server validator and both renderers. It
  runs locally with no cloud or telemetry; follow-ups never send by
  themselves.
- **Server cards are deterministic** and never model-authored.
- **The web chat uses assistant-ui with an external store:** the session stays
  the source of truth, system UI is `niaro.*` tool parts and the app owns the
  composer. The AI SDK chat adapter was not used because it would own state
  the server must own.
- **HTML from services never reaches a page;** the server sends a sanitized
  tree.

## Overview (hub)

- **Fills only read.** A widget fill sees unattended read actions only, so a
  dashboard can never write or leave an approval behind. Process widgets are
  checked for that on add and on every refresh, because policy changes.
- **Collect, then assemble** against the widget type's schema; the type, not
  the service, decides the shape.
- **Date-free recipes replay without the agent** to save cost.
- **Items the agent adds stay manual** until the person refreshes them, so the
  agent cannot spend or read on their behalf.

## Processes

- **Registry and validation are passive;** enforcement happens only in the
  trusted runner, so reads never cause effects.
- **Qualification is scripted evidence and activation is always a human
  decision** bound to exact digests.

## Meetings and voice

- **All audio goes through our own transcription;** vendor transcripts are not
  imported, for consistent quality and attribution.
- **One structured call over the whole meeting,** not per-minute summaries, so
  record and tasks agree. Quotes are verified; owner and deadline are cleared
  unless quoted.
- **Paid calls are checkpointed and never auto-replayed.** Silence is never
  sent to a paid provider.
- **Two-track recording** keeps "me" and "others" apart. Diarization is
  optional, local and on CPU, and never blocks a meeting.
- **A recording counts as saved only after native completion and a non-empty
  file;** the pending file is journaled before capture starts, scoped to the
  account, and a damaged journal blocks changes instead of being overwritten.
- **A transcript is untrusted data.** Transcription never executes, answers or
  approves. Clean transcripts send, flagged ones need review, and the spoken
  language comes from the audio, not the UI locale.
- **Spoken replies must read the text verbatim;** ASR, the text agent and
  speech are separate roles.

## Storage and operations

- **State, events and receipts commit in one SQLite transaction** before the
  reply; the event table is a durable outbox. WAL with full sync, local disk
  only.
- **One process owns a data directory** (exclusive lock).
- **The identity and Mastra stores are not atomic together,** so a backup
  captures them as one matched set, together with the identity secret.
- **Server extension points take trusted TypeScript,** never code from JSON or
  from a model. Plugins are reviewed like server code.
