# Tasks

Requirement references are to this change's `process-design` delta.

## 1. Readiness

- [x] 1.1 Optional `services` in `ProcessProposalStatusSchema`; `proposalReadiness` and `status()` in `apps/server-identity/process-proposal.ts`; verify with `node --import tsx --test tests/process-proposal.node.ts tests/process-proposal-http.node.ts`. (Proposal sign-in readiness)

## 2. Phone card

- [x] 2.1 `apps/mobile/ProcessProposal.tsx` with Save and turn on, status following, services with Sign in; used by the proposal part; copy in the NIAR-271 block; verify with `npx jest tests/process-proposal-mobile.test.tsx`. (Proposal card, Sign-in readiness on the phone card)

## 3. Integration

- [x] 3.1 `npm run lint`, `npm run typecheck`, `npm test` and `openspec validate niar-271-phone-proposal-save --strict` pass.
- [ ] 3.2 A device check (internal build): save a drafted process from the phone, sign in to a service from the card. Not done in this implementation run.

## Workflow follow-up

- Archive the change after review; archive is not proof of deployment.
