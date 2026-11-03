# Proposal

Tracker: **NIAR-278** (leftovers of NIAR-267 `ui-consistency-pack` and NIAR-269 `chat-parity-pack`; "One name per thing" in the accepted design draft of 2 November 2026).

## Why

Wave 1 unified the approval card, but the meeting proposal kept its own footer: on the web **Create event** / **Confirm · Demo** first and an outline **Dismiss** after it, on the phone a full-width confirm button over **Edit** and a red **Reject proposal**. Three words for one decision, and the primary action on the wrong side. The pet page still confirms a save with its own floating "Saved" toast, although toasts are only for Copied and Undo. The phone says why Send waits for an attachment; the web stays silent. Wave 1's accessibility work (the "Answer ready" region, the chat header menu, the decision and copy buttons) was never checked with a screen reader, and the owner has none.

## What Changes

- **Meeting proposal footer (web and phone).** The card ends like the approval card: **Decline** (outline on the web, tonal on the phone) then **Approve** (the one primary), right-aligned. On the web the effect line ("Creates a test calendar event. No invitations sent." / "Demo only. …") sits on the left of the same row. On the phone **Edit** stays, as a quiet button on the left of the row. Labels are the approval card's: "Decline" / "Odmítnout" and "Approve" / "Potvrdit", for the demo and the calendar alike; the effect line says what Approve does. A declined proposal reads "Proposal declined. …" in English (Czech already said "odmítnut"). The sentences that said "confirming" say "approving".
- **Pet page saves in place (web).** No floating "Saved" box. The sheet or dialog closes, the switch or the edited memory shows its new value, and "Saved" is only in a visually hidden polite status for screen readers.
- **Web Send waits with a reason.** While a file in the composer is being prepared, uploaded or checked, the web Send button is named "Wait for the attachment" / "Počkej na přílohu" and the line under the composer says the same; when one failed, "An attachment failed" / "Příloha se nenahrála". The words and the rule are the phone's (`attachmentSendReason`, now in `packages/client-core`).
- **Automated accessibility checks.** A new Jest project `dom` renders the web chat page in jsdom with its real components: every button, link, text field and checkbox has an accessible name; the chat's name is the one `h1`; ids are unique; decorative icons are hidden; the header's `…` is a named menu button; the code block's copy button, the composer and Send are named; approval and meeting decisions read Decline then Approve; a stored answer is announced once in the one polite status region. On the phone, Copy, Edit, Again, the top bar's `…` and the meeting decisions are buttons with spoken names and their disabled state.

## Non-goals

- The phone pet profile's own "Saved" toast (`apps/mobile/PetProfile.tsx`): the phone pet is changed by another agent (NIAR-246 area). Reported, not changed.
- An axe-core run: neither `axe-core` nor `jest-axe` is installed; adding them is a new dependency left to the owner.
- A manual screen-reader pass on a device.
- Other approval-like cards (process approvals, skill proposals).

## Risks

- "Approve" replaces "Create event" on the calendar proposal; the effect line beside it carries what happens. People who learned the old order may tap the wrong side: name it in the release notes.
- The jsdom suite uses `jest-environment-jsdom` and `@testing-library/dom`, which were already installed through `jest-expo` and Storybook; they are now declared development dependencies at the same versions.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat`: the approval card footer covers the meeting proposal; saves confirm in place, not in a toast; Send says why it waits on every client.

## Impact

- Shared: `packages/ui-catalog/ActionApprovalCard.tsx` and its stories, `packages/i18n/index.ts` (labels removed, three sentences reworded), new `packages/client-core/attachment-send-reason.ts`.
- Web: `app/chat-work.tsx` (meeting footer), `app/chat-next/chat-next-page.tsx` (Send reason), `app/pet-page.tsx` (no toast).
- Phone: `apps/mobile/chat/composer.tsx` imports the shared reason.
- Tests: new `tests/web-a11y.dom.test.tsx` (`dom` project, `tests/helpers/jsdom-environment.js`), new `tests/a11y-mobile.test.tsx`; `tests/chat-work-card.test.tsx`, `tests/approval-card.test.tsx`, `tests/ui-shell.test.tsx`, `tests/web-chat-next.test.tsx`, `tests/web-chat-composer.test.tsx`, `tests/web-pet-page.test.tsx`, `tests/chat-parity-mobile.test.tsx`; `jest.config.js`, `package.json`, `pnpm-lock.yaml`.
- Server and protocol: none.
