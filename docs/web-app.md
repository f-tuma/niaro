# Web app

The server's main address opens the web app: chat with the assistant and the
person's own menu. Administration is a section of the same app at `/admin`,
listed in the account menu (the sidebar footer) only for organization owners
and administrators. One build
(`npm run admin:build` → `dist-admin`) serves both; `index.tsx` picks the web app,
the console (`/admin/*`) or the public account pages (`/account/*`) by path.

| Path                | Page                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/`                 | Overview: the person's dashboard ([hub](hub.md)); the app opens here after sign-in                                             |
| `/chat`             | New chat: an empty chat that exists only on the page until its first message, then becomes `/chat/:id` without reloading       |
| `/chat/:id`         | A saved conversation                                                                                                           |
| `/tasks`            | Open and done tasks                                                                                                            |
| `/meetings`         | Meetings: list, recording in the browser, adding a recording; `/meetings/:id` is one meeting ([meetings](meetings.md#web-app)) |
| `/processes`        | Processes the person can start, their runs and personal processes                                                              |
| `/processes/design` | The process designer for a new or changed personal process                                                                     |
| `/processes/:id`    | A personal process: overview, versions, tests and activation                                                                   |
| `/skills`           | The person's skills ("Mine") and company skills ("Company"); `/skills/:id` edits one ([skills](skills.md))                     |
| `/connections`      | Personal sign-ins; `/connections/:id` is one service: its account and what the assistant may do there                          |
| `/search`           | Search: search in the person's chats (names, their questions, the assistant's answers) and meetings; Ctrl/Cmd+K                |
| `/me`               | Account: password, mobile devices and browser sessions with revoke, sign out everywhere, archived chats                        |
| `/admin/…`          | Administration (owners and administrators)                                                                                     |

Only these paths receive the shell (`APP_ROUTE` in `apps/server-admin/http.ts`);
everything else, including `/v1`, stays with the API. The public account pages
`/account/login`, `/account/invite` and `/account/reset` are `ACCOUNT_ROUTE`.
The account page is `/me` because `/account/*` belongs to those public pages;
it opens from the user menu and renders even when chat cannot connect (for
example at the device limit). See [app sign-in](app-sign-in.md#passwords).

## Sign-in and the chat session

People sign in with their account (email and password or a configured sign-in
method); the browser session cookie stays on `/admin`, where every API call
goes. The browser remembers the account for
`administration.identity.accountSessionDays` (default 30) since it was last
used: using the app at most once a day extends the session and its cookie.
Signing out, a password change or reset, removal from the organization and
"sign out everywhere" still end it at once. The administrator recovery key's
console session stays short (`administration.sessionSeconds`). The chat uses the same app API as the mobile clients (`/v1/:workspace`)
through `ClientSession` from `packages/client-core`. Its credential comes from
`POST /admin/api/identity/app/session {organizationId, workspaceId}`: it is bound
to the browser session, expires with it, has no refresh token and never uses
one of the person's device slots. When it expires the page quietly asks the
signed-in browser session for the next one, so chat never asks to sign in
again while the browser stays signed in. Each browser session keeps its newest four
for a workspace, so several open tabs keep chatting and a reload just adds a
new one in place of the oldest; a person holds at most 16 in all. The server's
public origin is added to the app API's allowed origins automatically.

What the browser keeps: chat caches and credentials live only in memory for
the page. `localStorage` holds presentation choices only (language, the chosen
workspace, the sidebar state, process canvas layout, the ids of pinned
chats). Names for chats live on the server; an older browser-only name is
dropped on the first visit. `sessionStorage` (this tab, until it closes) holds the process
designer's unsaved drafts and design conversation state and a process command
waiting to be confirmed, so a reload does not lose them; they are cleared on
every sign-in and sign-out.

## Chat

- **Questions with answers.** When the assistant asks (`ask_user`) and the
  likely answers are known, it offers 2–6 of them. One answer is sent by a
  click (or the digit key on a desktop); with `multiple` the person ticks
  several and sends them joined by commas. **Other…** opens the composer as the
  answer to the same question. The answer is an ordinary `message.send` with
  the question's `context`.
- **Message actions** (hover on a desktop, always on a phone): copy (an
  answer as its Markdown), **Again** on the latest answer resends the request
  before it as a new message, **Edit** on the latest request puts it back
  in the composer. History never changes.
- **Composer.** `@` (typed, or the `@` button under the text on the left;
  send is on the right) opens a picker of the services, processes and skills
  the person can tag (`GET /v1/:workspace/mentions`; without it, no picker). A pick
  becomes `@Name` in the text and a chip; the message carries
  `mentions: [{kind, id}]` for the tags still in the text, and the sent bubble
  shows them. Enter sends, Shift+Enter breaks a line, Esc stops a running
  answer, Ctrl/Cmd+Shift+O starts a new chat (`/chat`; the sidebar's **New
  chat** goes there too, **Overview** to `/`) and Ctrl/Cmd+K opens **Search**
  (`/search`). More than 4,000 characters cannot be
  sent. A button jumps back to the end of a long chat.
- **Message times.** Hovering a message shows when it was sent; the full date
  is in its tooltip. A quiet divider marks a new day (Yesterday, Today, then the
  date). Messages from before message times show none. The page asks for
  `createdAt` with `messages=agent-message-time/1` (see
  [protocol](protocol.md#message-times-and-result-types-optional)).
- **History.** The sidebar lists active chats only (`state=active`); older
  chats load on demand. **Search** under **New chat** opens the search. The row menu: **Rename** names the chat for all the
  person's devices (`conversation.rename`; an empty name returns the server's
  title), pin, **Archive** (`conversation.archive`; not for a hub item's
  chat) and **Delete**, which asks once and then deletes the chat, its
  messages and the assistant's memory of it (`conversation.delete`, see
  [protocol](protocol.md#chat-directory-rename-archive-and-delete)). Archiving
  or deleting the open chat goes to the overview (`/`). A chat still answering isn't
  archived or deleted; the sidebar says so. When a question, approval, task
  or process run still waits in it, a dialog names each one (**Waiting in this chat**:
  title and kind) and offers **Keep** or the destructive **Cancel and
  delete** / **Cancel and archive**, which repeats the command with
  `cancelOpenWork: true`: the work is cancelled first, then the chat goes.
  Changes from another device appear when the list re-reads: after a new
  snapshot, on window focus or reload.
- **Cancelling work.** A waiting card of the assistant's own work in a chat
  (a question, a run waiting for the server or one that stopped mid-way, a
  waiting process run) has **Cancel** (`work.cancel` at the revision shown,
  see [protocol](protocol.md#cancelling-open-work)). An approval keeps its
  own decline button. A run still answering refuses ("It's still running"), a
  changed one asks to check it first. A run that ended with an unconfirmed
  write offers nothing to cancel. Human tasks (Tasks) keep their own done and
  remove; the web Tasks page lists only those, so native work is cancelled
  from its chat card.
- **Archive.** Archived chats (also the main chat's earlier sessions) live on
  the account page (`/me`, section **Archived chats**, also in the user
  menu): newest first with date and message count, a search from nine chats
  on, **Restore** (`conversation.restore`: the chat returns to the sidebar and
  continues) and **Delete** after one confirmation (with the same open-work
  dialog as the sidebar). A title opens the chat
  read-only at `/chat/:id`; there the bar under it offers **New chat** and
  **Restore**. The mobile app has the same list under Settings, and
  **Archive** in the drawer's row menu.

## Chat (next)

The chat is being rebuilt on [assistant-ui](https://github.com/assistant-ui/assistant-ui)
(MIT, `@assistant-ui/react`), next to the classic one, so the web stops
carrying its own thread, composer and part rendering
([ADR 020](adr/020-web-chat-on-assistant-ui.md)). It takes the same addresses
(`/chat`, `/chat/:id`) once chosen:

- **Switch.** The account menu offers **Try the new chat** / **Back to the
  classic chat**; `?chat=next` or `?chat=classic` in the address picks one
  too. The choice is remembered in the browser (`localStorage["niaro.chat"]`).
  Nothing else changes: the sidebar, search, archive and the mobile app stay
  as they are.
- **Transport.** The session is the thread's external store
  (`useExternalStoreRuntime`): its stored messages, the message on its way
  and the streamed answer (NIAR-226/227: the draft, the tool steps and a
  write waiting for approval, which client-core already reads from the answer
  stream) are mapped to assistant-ui messages in
  `apps/server-admin/web/app/chat-next/transport.ts`. Sending goes through the
  same commands as before (`conversation.create`, `message.send` with
  mentions and the attached task, `service.resolve`), so idempotency, retry,
  offline and the server's authority are unchanged.
- **Parts.** Every system view is a tool-call part with a `niaro.*` name the
  thread renders through its tool UI: the generated answer (`niaro.openui` →
  the same `GeneratedUi`), an approval (`niaro.approval` → `ServiceActionView`),
  the assistant's own work with its question and offered answers
  (`niaro.work`), a sign-in (`niaro.signin`), a process offer (`niaro.offer`),
  a skill or process draft, contacts and an old composed card. A streamed tool
  step is one line, "Twenty CRM · Search loans · returned items 71", named as
  the Runs page names it. **Thinking** shows only until the first word of the
  answer; reasoning is never shown.
- **Kept from the classic chat:** the `@` picker and chips, the attached task,
  stop (Esc), retry, the chat's own errors, the 4,000-character limit and its
  counter, IME-safe keys, the read-only archived chat with **Restore**,
  message links (`?m=`), day dividers, message times, **Copy**, **Again** and
  **Edit**.
- **Not in the next chat (use the classic one):** typed replies to a process
  question (its card has no **Reply**; offered answers still work), the
  recovery of an unconfirmed process answer and the process answer notice.
  These belong to the process runtime and will move once the next chat is the
  only one.

`tests/web-chat-next.test.tsx` runs the classic chat's cases against it.

## Search

`/search` (sidebar **Search**, Ctrl/Cmd+K) is its own screen, as in
ChatGPT: a large field at the top, focused. Without words it lists recent
chats by day (Today, Yesterday, Previous 7 days, then months) from the chat
directory. Typing searches 200 ms after the last key
(`GET /v1/:workspace/search`, see
[protocol](protocol.md#chat-search-optional-agent-chat-search1)): one row per
chat, best first, with its name and up to two snippets, matched words in
bold (`<mark>`, from the server's ranges; nothing is rendered as markup),
the date and **Archived** for an archived chat. Under **All**, matching
meetings follow as their own group **Meetings** (name, the matched words with
their time; a row opens the meeting). Chips: **All** (archived
chats included), **My questions**, **Answers**, **Archived** (without
words: the archive). ↑/↓ move, Enter opens, Esc clears the field and then
goes back. A result opens `/chat/:id?m=<messageId>`: the chat reads older
pages until that message is shown, scrolls it to the middle and outlines it
for a moment. An older server without search: names of the loaded chats are
searched instead, with one line saying so. The mobile app has the same
search behind **Search** in the drawer (recent chats, the four filters, a
row opens the chat).

## Personal processes

"My processes" lists every process the person owns (`owner {type: "user"}`),
drafts included, from the `/2` registry, with its state: draft, tested
(latest version passed its test), active (vN) or blocked (the start
inventory's reason). An active process that can start now has a start button;
company processes stay start-only. The designer and the process page are the
console's own components (`ProcessDesignRuntime`, `ProcessConsoleRuntime`),
mounted with a personal scope and a `ProcessHostContext` that keeps links into
administration for administrators only and refuses processes that aren't the
person's own. Designer turns and native tests need the workspace's
enforce-mode budget with model prices; everyone sees that before writing
(members through the capabilities' `budgetReady`), with sending and testing
disabled and, for members, one line to ask an administrator. The owner deletes
a personal process with **Delete** in the process page's More menu (archived;
see [service processes](service-processes.md#deleting-a-personal-process)).
Asking in chat ("create a process for me…", or an overview item nothing offers yet)
drafts one with the same designer and ends the turn with a card; **Save and
turn on** saves, tests and turns it on in one go (see
[processes from chat](service-processes.md#processes-from-chat)).

## Meetings

"Meetings" lists the person's meetings like the app's Meetings tab (newest
first, with date, length, open tasks and state; the search covers names,
summaries and transcripts, filter by state) and `/meetings/:id` is one
meeting as a workspace: rename in place, notes (summary, decisions, tasks with
owner and time, open questions) beside the player and the transcript, every
time jumps the player, **Ask** opens a chat with the meeting attached,
and the `…` menu copies Markdown, downloads the transcript or deletes the
sound or the meeting. Recording asks to confirm the others know first. The page
records in the browser (microphone, or microphone and a call shared from
another tab as two separate tracks) and adds recordings made elsewhere,
including the MP4 video recordings of Teams, Zoom, Meet or Slack calls. A
recording stays only in the page's memory until the server has it; leaving the
page asks first. Details in [meetings](meetings.md#web-app).

## Connections

**Connections** lists the services that act under the person's own account, with
their sign-in state; a missing sign-in is connected right from the list.
`/connections/:id` shows the account with connect/disconnect and **What your
assistant can do**: the service's actions grouped as _Reading_ and _Changes_, a switch
each, _Always ask_ / _Don't ask_ for changes, search for long lists and
_Turn all on_ / _Turn all off_ per group. Each change saves at once. A waiting
change in chat offers **Don't ask next time**. Rules and API in
[who manages the assistant's permissions](service-authentication.md#who-manages-the-assistants-permissions).

## Roles

Everyone with workspace access gets chat, tasks, meetings, processes (including their own
personal processes) and connections. Providers, services, models, limits,
people and the other server settings stay in administration.
