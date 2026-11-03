# Design

## Context

- The meeting proposal is `ProposalReview` in `apps/server-admin/web/app/chat-work.tsx` on the web and `ActionApprovalCard` in `packages/ui-catalog` on the phone (inside `WorkItemCard`). Both read `approveCalendarShort`, `approveDemoShort`, `approveCalendarMeeting`, `approveMeeting`, `rejectProposal` and `rejectProposalShort`.
- The approval card (`ServiceActionView` on the web, `ServiceActionCard` on the phone) ends with `serviceReject` then `serviceApprove`, right-aligned (NIAR-267 D1).
- `pet-page.tsx` keeps a `status` string that a fixed, bottom-centred box shows for 2.5 s after each save.
- The phone composer computes `attachmentSendReason` in `apps/mobile/chat/composer.tsx`; the web composer only blocks Send (`sendBlocked`) without a word.
- Web tests use `react-test-renderer` with design-system modules replaced by plain hosts (`tests/helpers/web-hosts.ts`); nothing computes roles or accessible names as a browser does. `jest-environment-jsdom` 29.7 (through `jest-expo`) and `@testing-library/dom` 10.4 (through Storybook) are already installed; `axe-core` is not.

## Decisions

### D1. One pair of words: Decline and Approve

"One name per thing" names the write decision **Approve** / **Potvrdit** (not Allow, OK) and **Decline** / **Odmítnout** (not Cancel, Reject). The meeting proposal is a write waiting for the person's decision, so it takes the approval card's keys, `serviceReject` and `serviceApprove`, on both clients, for the demo and the calendar. A specific verb ("Create event") would make the meeting card the one approval that reads differently and would need a second, demo verb; the effect line next to the buttons already says what happens and whether it is a demo. The six old keys are removed. `proposalRejected` says "declined"; `calendarEffect`, `approvalEffect` and `proposalChanged` say "approving" (the Czech already used "potvrzení").

### D2. Footer layout

Web: one wrapping row: the effect line on the left (only while waiting), then `ml-auto` a group (`data-testid="meeting-decisions"`) with outline **Decline** and default **Approve** (with the spinner while sending). An approved proposal whose operation has not started keeps **Decline** alone. Phone: a `Row` (`meeting-decisions`) with `justifyContent: "flex-end"` and wrap: quiet **Edit** pushed left by `marginRight: "auto"`, tonal **Decline**, primary **Approve** (only while waiting). The red `danger` decline and the full-width confirm button are gone. The editing form, notices and the operation's progress are unchanged.

### D3. Saves confirm in place

The pet page drops the floating box. Every save already returns the page to a clean state: the sheet or confirm dialog closes, the edit form closes, the switch shows its new value, the list reloads. The `status` text stays in an always-present `sr-only` `role="status"` region, so a screen reader still hears "Saved" (there is no visual change to announce otherwise); it clears after 2.5 s so the next save is announced again. No toast is added.

### D4. Send reason on the web

`attachmentSendReason(entries, ready)` moves to `packages/client-core/attachment-send-reason.ts` unchanged; the phone composer and the web composer import it. On the web, when it returns a key, the Send button's `aria-label` is that text instead of "Send" and a `text-xs` muted line (`composer-send-reason`) under the input group repeats it. Same keys, same copy as the phone (`attachmentWait`, `attachmentFailedSend`); no new strings.

### D5. Accessibility without a screen reader

A Jest project `dom` (`tests/**/*.dom.test.tsx`, excluded from `ui`) runs the `jest-expo` transform in jsdom through `tests/helpers/jsdom-environment.js`, which adds the platform globals jsdom lacks (fetch types, streams, text coding) from Node. `tests/web-a11y.dom.test.tsx` renders `ChatNextConversation` with the real components inside the providers the shell mounts (`TooltipProvider`, `ToastProvider`, `SidebarProvider`) and checks with Testing Library's role queries:

- every `button`, `link`, `textbox`, `combobox` and `checkbox` has a non-empty accessible name (a removed `aria-label` on the header menu fails it);
- the chat's name is the only `h1`; ids are unique; every `svg` is hidden or named;
- the header's `…` is "Chat options" with `aria-haspopup="menu"` and `aria-expanded`;
- "Copy code", the composer ("Message the assistant") and "Send" are named;
- the approval and meeting footers read Decline then Approve, and Decline on the meeting sends `proposal.decide` with `reject`;
- the one `answer-announcement` region is `role="status"`, `aria-live="polite"`, `aria-atomic`, empty on open and says "Answer ready. …" after a new stored answer.

`tests/a11y-mobile.test.tsx` checks `accessibilityRole`, `accessibilityLabel` and `accessibilityState.disabled` for Copy (and "Copied"), Edit, Again, the top bar's `…` and its menu items, and the meeting decisions in EN and CS (disabled when the card is stale).

*Alternative.* `jest-axe` / `axe-core`: catches more rules (contrast is not computed in jsdom anyway, landmarks, ARIA attribute validity). Not installed; adding a new dependency is for the owner to decide.

**Not covered by these tests (only a person with a screen reader would notice):** how VoiceOver, TalkBack or NVDA actually speak and in what order; whether a polite announcement is cut off by another one; focus movement after opening and closing menus, sheets and dialogs on a real browser; gestures on a phone; visual focus rings and contrast.

## Risks / Trade-offs

- [Two jsdom-only globals sets] → the environment copies only names Node has and jsdom does not.
- [Meeting label change] → covered by the effect line; release notes.
- [Hidden "Saved" region] → a screen reader still hears the save; sighted people see the closed sheet or changed value.

## Verification

- `npx jest tests/web-a11y.dom.test.tsx tests/a11y-mobile.test.tsx tests/chat-work-card.test.tsx tests/approval-card.test.tsx tests/ui-shell.test.tsx tests/web-chat-next.test.tsx tests/web-chat-composer.test.tsx tests/web-pet-page.test.tsx tests/chat-parity-mobile.test.tsx`.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run admin:build`.
- Not automated: light and dark screenshots of the meeting footer on the web and the phone; a screen-reader pass on a device.
