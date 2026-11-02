# Proposal

Tracker: **NIAR-267** (inspiration research NIAR-265, `ui-consistency-pack`: CHAT-05, CHAT-09, CHAT-16 footer order and label only; owner decisions D1 and D16)

## Why

The web approval card puts **Approve** first on the left and the phone card puts the decline first, and both label the decline "Cancel", the word that closes every sheet. Rename, Pin, Archive and Delete exist only on the sidebar's chat rows, so they vanish when the sidebar is collapsed or closed on a phone. Tooltips open the instant a pointer passes over anything. Dialogs and sheets take ad-hoc `sm:max-w-*` widths at their call sites (six different widths). The web app has no shared way to confirm a copy or to take an archive back.

## What Changes

- **Approval footer (web and the shared phone card).** The card ends with **Decline** (outline; tonal on the phone) then **Approve** (primary), right-aligned; on the web the effect line and "Don't ask next time" stay on the left. `serviceReject` becomes "Decline" / "Odmítnout" and `serviceRejected` "Declined" / "Odmítnuto" (D1). "Cancel" stays the word for closing a sheet.
- **Chat header (web).** The chat page starts with one line: the chat's name as the page's `h1`, then the compact pet and a `…` menu with **Rename** (in place), **Pin**, **Archive** and **Delete**, the same items and rules as the sidebar row. It belongs to the page, so it is there with the sidebar collapsed; on phones it also holds the sidebar button. A new chat keeps its name for screen readers only and has no menu; an archived chat has no menu (Restore stays in the page).
- **Tooltips (web).** Immediate on keyboard focus; on hover after 300 ms on icon buttons and 800 ms for a truncated name or detail shown whole; moving to the next trigger skips the wait (D16).
- **Named dialog and sheet widths (web).** `DialogContent size`: `default` 384, `form` 448, `wide` 576, `full` 1024 px; `SheetContent size`: `default`, `form`, `wide`. Every call site uses a name after a look at its content; none sets `sm:max-w-*` itself (D16).
- **One toast (web), only for Copied and Undo (D16).** Copying a message or a code block says "Copied"; archiving a chat says "Chat archived" with **Undo**, which restores it (and reopens it when it was open). Never for errors, approvals or questions; one at a time.

## Non-goals

- The phone top bar `…` and New chat in the drawer header (D3): the phone app's own change; `apps/mobile/*` is not touched here.
- A phone snackbar for Copied and Undo.
- The approval card's consequence sentence, shaped previews and visible expiry (the rest of CHAT-16).
- Export, Memory or Fork in the chat menu (later ideas hang off it).
- Moving the pet page's own "Saved" toast or the console's inline "Copied" labels onto the toast.
- The meeting proposal card (`ActionApprovalCard`), which has its own labels.

## Risks

- People used to the old order may tap the wrong button: name the change in the release notes.
- Undo after an archive that first cancelled open work restores the chat, not the cancelled work.
- Sheets that were 512 px (`sm:max-w-lg`) become 448 (`form`) or 576 (`wide`).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat`: approval card footer and labels on every client, the chat header with the chat's actions, Undo after archiving and the Copied confirmation.

## Impact

- Web: `app/chat-cards.tsx`, `app/chat-history.tsx` (shared chat actions), new `app/chat-next/chat-header.tsx`, `app/chat-next/chat-next-page.tsx`, `app/shell.tsx`, `app/chat-message-actions.tsx`, `app/chat-copy.ts`, `components/ui/{dialog,sheet,tooltip,markdown}.tsx`, new `components/ui/toast.tsx`, the dialog and sheet call sites, `apps/server-admin/DESIGN.md`.
- Shared phone UI: `packages/ui-catalog/ServiceActionCard.tsx` and its stories; `packages/i18n/index.ts` (`serviceReject`, `serviceRejected`).
- Tests: `tests/web-chat-header.test.tsx`, `tests/web-ui-system.test.tsx` (new); `tests/web-chat-next.test.tsx`, `tests/service-action-card.test.tsx`, `tests/web-markdown.test.tsx`.
- Server and protocol: none.
