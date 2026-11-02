# Proposal

Tracker: **NIAR-269** (idea CHAT-11 and the phone part of CHAT-08 in the 2 November 2026 inspiration research, `implementation-spec.md` 4.4 `chat-parity-pack`).

## Why

The web and the phone chat feel like two products. The `chat` spec already says "Each message SHALL offer copy", and the phone breaks it. The phone has no message times and no day dividers, no **Edit** on the last request and no **Again** on the last answer (only for messages with files). Its chat list groups days by 24-hour spans, so a chat from the long autumn night falls into "Previous 7 days", and Czech month headings start in lower case. Phone search opens the chat at its newest page instead of at the found message, and never finds meetings. The bottom tab says "Work" while the web and the `tasks` spec say **Tasks**. Attachments can look ready while they are still uploading, and Send stays silent about why it does not send.

## What Changes

- **Message actions on the phone.** Under each message a quiet row: the time (when the server sent one), **Copy**, **Edit** on the latest request and **Again** on the latest answer. Always visible (touch). Copy takes the message as written (an answer as its Markdown). Edit puts the request back in the composer; Again sends the request before the answer once more as a new message without touching the composer's draft. History never changes. Archived chats offer Copy only.
- **Days in a chat.** A divider ("Today", "Yesterday", "Tuesday 27 October") where a new calendar day starts, on the phone as on the web. The phone asks the server for message times (`agent-message-time/1`).
- **One day grouping for both clients.** `groupChatsByDay` and `messageDays` move from the web into `packages/client-core/chat-days.ts`; the phone drawer and the web sidebar, search and transcript use them. Calendar days, never 24-hour spans; month headings start with a capital in Czech.
- **Phone search.** A result opens the chat at the found message: older pages load until it is there, it scrolls into view and is outlined for 2.5 s. Under **All**, matching meetings follow as their own **Meetings** group and open the meeting.
- **Tasks.** The phone's "Work" tab and screen title become **Tasks** / **Úkoly**.
- **Attachment readiness (phone).** Each attachment chip already shows preparing, uploading, checking, ready or failed from `packages/client-core/attachments.ts`; the phone composer now also says why Send waits ("Wait for the attachment" / "Počkej na přílohu", or "An attachment failed" when one failed) and the Send button carries the reason as its label while it waits.

## Non-goals

- The web chat (it already has these, except the shared day module it now imports).
- Folding long requests, headings in answers and "Copy code" (`chat-reading`), the chat header `…` (`ui-consistency-pack`).
- Pin sync between devices (pins stay per device).
- Attachment states the server does not report yet (`chat-attachments-camera-s3` 3.x–7.x: durable acceptance, conversion progress per file). The composer shows what `AttachmentRuntime` knows today.
- The Send reason on the web composer (the web chips already show each file's state); left to `chat-attachments-camera-s3`.
- A toast for "Copied": the Copy button itself says "Copied" for a moment (no new toast channel on the phone).

## Risks

- Day grouping changes the label of a few chats on the web (none in practice: the web already counted calendar days) and on the phone (the DST fix). Shared unit tests pin both.
- **Again** can be pressed twice; each press is a new message, as on the web. It is disabled while an answer runs, offline and while files wait in the composer, so it never takes the composer's attachments or attached task.
- `expo-clipboard` is a new native module: it needs a new phone build (planned; old builds need no compatibility).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat`: message actions on every client with the time; day dividers and calendar-day grouping; Send waits for attachments and says why.
- `chat-search`: the phone search lists meetings and opens a chat at the found message.

## Impact

- Shared: new `packages/client-core/chat-days.ts`; `packages/i18n/index.ts` (one NIAR-269 block); `packages/ui` gets a `copy` icon.
- Phone: `apps/mobile/chat/*` (thread projection, parts, composer from NIAR-268), `App.tsx` (message times, Edit, Again, search jump), `ChatHistory.tsx`, `ChatSearch.tsx`, `ScreenChrome.tsx` (Send reason, tab label), `companion-copy.ts`, new `apps/mobile/clipboard.ts`; dependency `expo-clipboard`.
- Web: `chat-history.tsx` and `chat-message-actions.tsx` import the shared day module instead of their own copies; no visible change.
- Tests: new `tests/chat-days.test.ts`, `tests/chat-parity-mobile.test.tsx`; the tab name in existing mobile suites.
