# Design

## Context

See proposal.md for the motivation. Today:

- **The phone chat after NIAR-268.** NIAR-268 (no spec change, no visible change) split the chat out of `apps/mobile/App.tsx` the way the web is split (`apps/server-admin/web/app/chat-next/{chat-next-page,parts,transport}`): `apps/mobile/chat/thread.ts` projects the stored messages into entries with one *part* each (`projectThread`, `trailingWork`, `visibleMessages`, all pure); `apps/mobile/chat/parts.tsx` holds the parts registry (`threadParts`, one view per part, reading a `MobileChat` context that carries the session and the commands the workspace owns); `apps/mobile/chat/ChatThread.tsx` draws the transcript, the message on its way, work no message presents and the answer being written; `apps/mobile/chat/composer.tsx` (`ChatFooter`) is the footer with notices, reply context, voice and the composer. `Workspace` still owns the draft, the commands (`submitMessage`, `reuseAttachmentMessage`, `openVoice`) and the session. The native regression suites passed unchanged (223 suites, 2,548 tests). This change builds on that split, so each parity item lands in one module.
- **Web.** `MessageActions` and `DaySeparator` in `apps/server-admin/web/app/chat-message-actions.tsx` (time with full date on hover, Copy, Edit on the latest request, Again on the latest answer), `messageDays` there, and `groupChatsByDay` in `chat-history.tsx` (calendar days, capitalised month).
- **Phone.** No time, no Copy; Edit/Again only for messages with files (`MobileMessageAttachments`); `ChatHistory.tsx` `groupByDay` subtracts 24-hour spans; `ChatSearch.tsx` opens a `ConversationSummary` only and lists no meetings; `companion-copy.ts` `work: "Work" / "Práce"`; `Composer` has `sendBlocked` without a reason.
- **Message times.** `createdAt` is delivered only to clients that ask for `agent-message-time/1` (`messageTimes` option of `ClientSession`); the phone does not ask.

## Decisions

### D1. One day module in client-core

`packages/client-core/chat-days.ts`: `groupChatsByDay(rows, language, labels, now)` (generic over `{updatedAt}`), `messageDays(messages, now)`, `dayLabel(day, language, labels, now)`, `messageTime`, `messageMoment`, `startOfDay`. All work in local calendar days (`setDate(getDate() - n)`), never `n * 86_400_000`. Month headings are capitalised (`listopad` → `Listopad`); dividers keep the grammatical form (`úterý 27. října`). The web's `chat-history.tsx` re-exports `groupChatsByDay` and `chat-message-actions.tsx` uses `messageDays`/`dayLabel` from it, so both clients compute the same thing; existing web tests stay the contract.

*Alternative.* Fix the phone's `groupByDay` in place: two copies drift again, which is how the bug came about.

### D2. Message actions in the parts registry

`projectThread` gains, per entry, `day` (from `messageDays` over the entries that show), `editable` (the latest user message, not read-only) and `again` (for the newest message when it is an answer: the request before it). A `MessageMeta` row in `parts.tsx` shows the time (`messageTime`, read out as `messageMoment`), **Copy**, **Edit** and **Again**; every part that shows text ends with it, so a new part gets it by using `AnswerBody`. Buttons are 36 px icons with a 44 px touch target, always visible (touch), labelled for screen readers.

- **Copy** goes through `apps/mobile/clipboard.ts` (`expo-clipboard` `setStringAsync`); the button says "Copied" for 1.5 s. Text only; attachments are not copied.
- **Edit** (the latest request): with files, the existing `reuseAttachmentMessage(m, false)`; otherwise the reply context is cleared, the text goes into the composer and it takes focus. Nothing is sent.
- **Again** (the latest answer): with files, `reuseAttachmentMessage(request, true)`; otherwise `submitMessage(text, null, -1, {detached: true, mentions})`. `-1` owns no draft, so whatever the person is typing stays (the same rule the offered answers use). `detached` leaves the attached task in the composer. Mentions are recomputed from the text against the mention directory (`messageMentions(text, mentionsInText(text, directory))`), as the web does. Disabled while busy, offline, read-only, or while files wait in the composer (they would otherwise ride along).
- A **day divider** precedes the first message of each new calendar day; messages without a time start none (older servers, older messages).

### D3. Phone search opens at the message and lists meetings

`ChatSearchScreen` keeps the found match's `messageId` and, under **All** with words, reads `session.readMeetings({query})` (as the web search page) and shows up to five meetings as a **Meetings** group after the chats; an older server without meeting search simply shows none. `onOpen(conversation, messageId?)` and `onOpenMeeting(id)` replace `onOpen(conversation)`.

`Workspace.openHistoryConversation(selected, messageId)` remembers the target; while it is not among the loaded messages and an older page exists, it reads older pages (at most 25, then it gives up quietly). The message's part reports its layout; the chat scrolls there (instead of to the end) and outlines it for 2.5 s (2 px ring, static under reduced motion). The target is cleared when another chat opens.

### D4. Tasks

`companion-copy.ts` `work` becomes `tasks: "Tasks" / "Úkoly"`, used by the bottom tab and the screen title. The pet's memory scope "Work" (`pet-profile-copy.ts`) is another thing and stays.

### D5. Attachment readiness

`AttachmentRuntime` (`packages/client-core/attachments.ts`) already tracks each entry (`preparing`, `uploading`, `verifying`, `uploaded`, `uncertain`, `failed`, `removing`) and `ready`; the chips already show it through `transferLabel`. `attachmentSendReason(entries, ready)` in `apps/mobile/chat/composer.tsx` picks the reason and the phone `Composer` gets `sendBlockedReason`: "An attachment failed" when an entry failed or expired, otherwise "Wait for the attachment" while the runtime is not ready (preparing, uploading, checking, or an uncertain upload that the chip's **Check** resolves). It is shown as a caption above the input row and is the Send button's accessible label while Send waits. `submitMessage` already refuses to send while not ready; nothing changes on the server.

The web composer keeps its silent `sendBlocked` for now (its chips already show each state); the reason line on the web is left to the attachments change.

What the attachments change (`chat-attachments-camera-s3`, tasks 3.x–7.x) will add (durable acceptance, conversion progress) is not invented here; the reason line reads the runtime's states, so new states only need a label.

### D6. Copy

New strings in one NIAR-269 block of `packages/i18n/index.ts` (EN/CS, tykání): `messageCopy` Copy/Kopírovat, `messageCopied` Copied/Zkopírováno, `messageEdit` Edit/Upravit, `messageAgain` Again/Znovu, `searchMeetings` Meetings/Schůzky, `attachmentWait` Wait for the attachment/Počkej na přílohu, `attachmentFailedSend` An attachment failed/Příloha se nenahrála.

## Verification

- `tests/chat-days.test.ts`: autumn and spring daylight-saving nights in Europe/Prague, Czech month capitals and year, dividers across the change, Czech weekday.
- `tests/chat-parity-mobile.test.tsx`: times, day dividers and Copy (Markdown kept); Edit fills the composer and sends nothing; Again sends the request again and leaves a typed draft; read-only chats offer no Edit/Again and Again only under the newest answer; a search hit opens at an older message after reading the older page and outlines it; a meeting hit opens the meeting; Send says why it waits. The Tasks tab is pinned by `tests/ui-shell.test.tsx`.
- Existing suites (`conversation-history-mobile`, `chat-search-mobile`, `web-chat`, `attachment-client-ui`, …) pass; tab names updated where they named "Work".
- Not verified here: a native build with `expo-clipboard`, TalkBack/VoiceOver reading the meta row, real uploads over a slow network.
