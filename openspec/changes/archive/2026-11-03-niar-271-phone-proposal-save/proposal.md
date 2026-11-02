# Proposal

Tracker: **NIAR-271**, phone part (idea PROC-09 in the 2 November 2026 inspiration research, `implementation-spec.md` 4.6 `process-recovery-without-model`). The rest of NIAR-271 (failure sentences, Run again, Generate test, the web card's readiness rows) is in `niar-271-process-recovery`.

## Why

A process drafted in chat on the phone can only be opened in the web app today. The save pipeline is already on the server, idempotent and authenticated (`apps/server-identity/process-proposal.ts`), so the phone hands off a step it could take itself. And nothing on either card says that a service still needs the person's own sign-in, so a freshly saved process can end up blocked with `connection_required` on its first run.

## What Changes

- **Save and turn on on the phone.** The phone's `process.proposal` card shows the name, the steps, the services, the assumptions it acknowledges and the designer's questions, and offers **Save and turn on** through the existing `POST …/process-proposals`. It follows the status (`running` phases, `done`, `stopped`, `failed`) like the web card. **Open in the web app** stays for editing.
- **Sign-in readiness, read live.** `GET …/process-proposals?sessionId=` also returns, for each service the proposal uses, `signIn`: `connected` (signed in with the person's own account), `needed` (a run would stop at `connection_required`) or `none` (no personal sign-in). The phone card shows "Signed in", "Not signed in" with **Sign in**, or "No sign-in needed", and reads the status again after a sign-in completes. It says signed in, never that the service works.

## Non-goals

- Editing on the phone (it stays in the web app).
- The **Add to overview** switch on the phone: the card saves with the proposal's own `addToHub` (as drafted from the request) and says so.
- The web card's readiness rows (`niar-271-process-recovery`).
- Blocking Save while a service needs sign-in: the person may save first and sign in later; the card says which services wait.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `process-design`: the mobile proposal card saves and turns on; the proposal status carries per-service sign-in readiness.

## Impact

- Protocol: optional `services` in `ProcessProposalStatusSchema` (`packages/protocol/process-proposal.ts`).
- Server: `proposalReadiness` and `status()` in `apps/server-identity/process-proposal.ts` (read only, nothing stored).
- Phone: new `apps/mobile/ProcessProposal.tsx`, used by the proposal part in `apps/mobile/chat/parts.tsx`; `connectionPlatform` exported from `apps/mobile/ServiceConnection.tsx`.
- Copy: one NIAR-271 block in `packages/i18n/index.ts`.
- Tests: `tests/process-proposal.node.ts` (readiness), `tests/process-proposal-http.node.ts` (status over HTTP), new `tests/process-proposal-mobile.test.tsx`.
