# Design

## Context

- Web approval: `ServiceActionView` (`apps/server-admin/web/app/chat-cards.tsx`) renders Approve, then the outline "Cancel", then the effect line and "Don't ask next time", left-aligned in `CardFooter`. Phone: `packages/ui-catalog/ServiceActionCard.tsx` renders two equal-width buttons, decline first. Both read `serviceApprove` / `serviceReject` from `packages/i18n/index.ts`; `serviceRejected` ("Cancelled") labels a declined card.
- Chat actions: `ChatHistoryNav` and `ChatRow` (`app/chat-history.tsx`) own rename (in place), pin (browser-local), archive and delete (confirmed, with the open-work question from `open-work-dialog.tsx`). The sidebar (`collapsible="icon"`) hides the chat list when collapsed; on phones it is a sheet. The chat page has only an `sr-only` `h1` and the compact pet on its own row; the shell draws a phone-only row with the sidebar button.
- `components/ui/tooltip.tsx` sets `delayDuration = 0`. `DialogContent` is 384 px from `sm`; call sites add `sm:max-w-md|sm|5xl`; sheets add `data-[side=right]:sm:max-w-md|lg|xl` or `size="lg"`.
- No toast exists; the code block's copy (NIAR-266) calls an `onCopied` nobody passes.

## Goals / Non-Goals

**Goals:** one footer order and one decline word on both clients; chat actions reachable from the chat itself; calmer tooltips; widths named by job; one quiet confirmation channel for Copied and Undo.

**Non-Goals:** the phone top bar and snackbar, the rest of CHAT-16, new chat menu items.

## Decisions

### D1. Approval footer

Web: one wrapping row in `CardFooter`: the effect line and "Don't ask next time" on the left, then `ml-auto` a group (`data-testid="service-action-decisions"`) with `Button variant="outline"` **Decline** and the default (primary) **Approve**. The approval still goes first and the "Don't ask" rule is saved only after the server accepted it. Phone: a `Row` with `justifyContent: "flex-end"` and `flexWrap`, the tonal `secondary` **Decline** then the primary **Approve** at their natural width (large, 52 px). Labels: `serviceReject` "Decline" / "Odmítnout", `serviceRejected` "Declined" / "Odmítnuto"; `cancel` keeps "Cancel" / "Zrušit" for sheets.

### D2. Shared chat actions and the header

`useChatActions(session?)` in `chat-history.tsx` holds what `ChatHistoryNav` did: the pins query (same key, so pinning in the header updates the sidebar), rename / archive / delete mutations with the optimistic list edits, the delete `AlertDialog` and the `OpenWorkDialog` (returned as `dialogs`, rendered once by each user), and a `failure` line. `ChatMenuItems` renders the four items; `chatNameField` gives the rename field's props (Enter or blur saves a changed name, Escape keeps it). `ChatRow` and `ChatHeader` both use them, so the two menus cannot drift.

`ChatHeader` (`app/chat-next/chat-header.tsx`) is a 48 px `header`: the phone-only `SidebarTrigger`, the `h1` (`text-md font-semibold`, truncated), then `ml-auto` the compact pet and the `…` (`Button variant="ghost" size="icon-sm"`, "Chat options") opening `DropdownMenuContent align="end"`. Rename swaps the `h1` for an `Input` in place; focus is kept from the closing menu as in the sidebar. The shown name comes from the sidebar's cached list (`useListedChat`, which a rename edits at once), then the opened chat's history, then "New chat"; a rename in the header also shows at once for a chat the list has not loaded, until the name it replaced changes. `useChatTitle` names a hub item's chat as the sidebar does.

The page passes `chatId` only for a saved, writable chat. On the empty new chat the header has `data-home`: the `h1` is `sr-only` and the row has no height from `md`, so the home looks as before. The shell no longer draws its phone row on `/chat` and `/chat/…` while a session exists (the header has the sidebar button); without a session the shell's row stays.

*Alternatives.* Lifting the actions into a context provider in the shell (one instance, but the header would depend on the sidebar being mounted, which a phone's closed sheet is not); inline rename on a click of the title (left for later; the menu item is the visible way).

### D3. Tooltip delays

`TooltipProvider` defaults to `delayDuration` 300 and `skipDelayDuration` 300; `Tooltip` takes `delay?: "action" | "name"` (300 / 800 ms) and passes it to Radix as `delayDuration`, which a call site may still override. Radix opens on keyboard focus at once regardless of the delay. The message time uses `delay="name"`.

### D4. Named widths

`DialogContent size` (`data-size`): `default` `sm:max-w-sm`, `form` `sm:max-w-md`, `wide` `sm:max-w-xl`, `full` `sm:max-w-5xl`; below `sm` each keeps 16 px per side. `SheetContent size`: `default` (`sm:max-w-sm`), `form` and `wide` (full width on phones, `sm:max-w-md` / `sm:max-w-xl`); `lg` is gone. The values equal Tailwind's, so 448, 384, 576 and 1024 px uses render as before. The three 512 px sheets were looked at: the auth provider editor is a form (`form`); finding actions and the audit entry list long rows (`wide`). The widget large view is `full`; the attachment preview and speaker dialog are `form`; phone pairing is `default`.

### D5. One toast

`components/ui/toast.tsx`: `ToastProvider` (mounted once in `AppShell` with the "Copied" and "Undo" labels) and `useToast()` (null outside it, so the console and tests need nothing). Its API is only `copied()` and `undo(message, onUndo)`. One toast at a time, replaced by the next; Copied stays 2 s, Undo 6 s; hover or focus holds it. The region is an always-mounted `role="status"` `aria-live="polite"`, bottom-right from `sm`, above the composer on phones. Copy (message action and code block) calls `copied()`; a successful archive calls `undo("Chat archived", …)`, whose Undo restores the chat with `conversation.restore`, refreshes both lists and reopens it when it was open. The undo runs outside the component that archived (the header unmounts when the open chat leaves). An Undo that fails shows the error where the archive was pressed, if that is still on screen.

*Alternative.* shadcn Sonner (spec suggestion): not installed; one more dependency for two messages was not worth it, and a closed API keeps errors and approvals out of the toast.

## Risks / Trade-offs

- [Wrong taps after the order change] → release notes.
- [Undo after cancelling open work] → restores the chat only; the open-work dialog already said the work ends.
- [Two action instances] → the sidebar and the header each own their dialogs and failure line; pins share one query.
- [Phone header] → the header is the chat page's; other pages keep the shell's row.

## Verification

- `tests/web-chat-header.test.tsx` (new): header order (sidebar button, name, pet, `…`), the four items, rename by Enter and Escape, pin stored in the browser, archive leaves the open chat and Undo restores and reopens it, open work asked first without Undo, delete only after the confirmation, no Archive for a hub chat, no menu for a new chat.
- `tests/web-chat-next.test.tsx`: the opened chat's header and menu, the new chat's `sr-only` name, no menu on an archived chat, the web footer Decline (outline) then Approve and Decline sending `approved: false`.
- `tests/web-ui-system.test.tsx` (new): each dialog and sheet size, a scan that no page sets a dialog's or sheet's width, tooltip delays, the toast's region, timing, Undo, replacement and hover hold.
- `tests/service-action-card.test.tsx`: the phone footer right-aligned with Decline then Approve, the new labels in EN and CS; Storybook `ServiceActionCard` stories `DecisionsNarrowCzech` and `Declined`.
- `tests/web-markdown.test.tsx`: code copy raises the Copied toast.
- Commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run admin:build`.
- Not automated: a browser check of the header menu with the sidebar collapsed and on a phone width; light and dark screenshots of the card and the toast.
