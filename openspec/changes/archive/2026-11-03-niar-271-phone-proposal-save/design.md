# Design

## Context

- The chat tool `process_propose` returns a `process.proposal` card. The web card (`apps/server-admin/web/app/chat-cards.tsx`, `ProcessProposalView`) reads the status with `ClientSession.readProcessProposal`, presses with `acceptProcessProposal` and polls while `running`.
- The phone card (`apps/mobile/chat/parts.tsx`, `ProposalPart`, after the NIAR-268 split) shows only the name and **Open in the web app** (`processProposalWebUrl`).
- Whether a person can run a service is decided in `ServiceProcessStore` availability (`apps/server-identity/service-processes.ts`): `catalog.oauth.executionReady(...)` per action effect, plus "a service with auth but no shared credential needs a personal connection". That is the rule the readiness reuses.
- The phone already signs in to a service from chat through `ConnectionFlow` (`packages/client-core/service-connection-flow.ts`) and `ServiceConnection.tsx`.

## Decisions

### D1. Readiness is read with the status, not stored on the card

The card in the message is fixed when it is drafted; sign-in changes afterwards. `status(actor, sessionId)` adds `services: [{serviceId, name, signIn}]` computed from the review's current candidate (`capabilitiesOf`) for this person: `needed` when any of the service's used actions is not execution-ready for them (`executionReady` returns `false`, or the service has auth, no shared credential and no personal connection), `connected` when it runs on their personal connection, otherwise `none`. Unknown or unreadable services are left out. Nothing is stored; `accept` and the pipeline are unchanged. The field is optional, so the status of a session without a candidate has none.

`proposalReadiness` is a pure function of the candidate, a catalog lookup and the actor, unit-tested without a server.

### D2. The phone card

`apps/mobile/ProcessProposal.tsx` (`ProcessProposalCard`) mirrors the web card's states with phone copy:

- Reads the status on mount and while `running` every 1.5 s (3 s after a failed read); stops offline and on unmount.
- **Save and turn on** (primary, right) sends exactly the card's `revision`, `reviewDigest`, assumption ids and digests, and `addToHub && hubEligible`. A press whose answer is lost keeps its `requestId`, so pressing again replays it (the server recognises it); a press that got an answer clears it. Pressable again after `failed`, after a `stopped` with `model_reservation_too_large` or `limits_exceeded`, and on a `done` with `resize`, as on the web.
- **Open in the web app** (secondary, left of Save) stays for editing and for stops that need the web (`stopped`).
- Services: each row shows the name and "Signed in", "Not signed in" or "No sign-in needed"; a `needed` row runs a `ConnectionFlow` and offers **Sign in**; when that sign-in completes the status is read again.
- Disabled while the chat is busy, offline or archived.

### D3. Copy

One NIAR-271 block in `packages/i18n/index.ts`, wording aligned with the web card's (`chat-copy.ts` `proposal`): Save and turn on / Uložit a zapnout, phases, done, stopped, failed, services and sign-in states.

## Risks

- The readiness rule is copied from availability, not shared with it; if availability changes, readiness may drift. A shared helper in `service-processes.ts` is a follow-up (it would touch the other agent's area).
- A service whose sign-in setup is broken reads as `needed` with a **Sign in** that ends in "unavailable" from `ConnectionFlow`; the row then shows "Not signed in" without the button.

## Verification

- `node --import tsx --test tests/process-proposal.node.ts`: readiness for a personal sign-in that is missing, present, and a service without sign-in.
- `node --import tsx --test tests/process-proposal-http.node.ts`: the status over HTTP carries the fixture service as `none`.
- `npx jest tests/process-proposal-mobile.test.tsx`: Save and turn on sends the card's revision, digest and assumptions and follows `running` to `done`; a lost answer is replayed with the same `requestId`; a `needed` service shows Sign in; a `questions` card cannot be saved.
- Not verified here: a real OAuth sign-in from the phone, a real device.
