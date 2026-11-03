# Design

## The stuck sequence (before)

1. App launch: `withChatSession` marks the first message `session: "new"`.
2. `FixtureStorage.archiveSession` copies the main chat into `archived-N` (`legacy_session = N`, `read_only = 1`) and `attachments.rollover` moves the earlier generation to `archived-N`.
3. A native task of the earlier session (operations, a pending approval or a failure) is still in the task window. `mastra-runtime` `projectTasks` names its chat through `attachmentGenerationConversation(generation)`, which is now `archived-N`.
4. The next snapshot, events or commands request runs `storage.syncNativeWork` first. `FixtureEngine.syncNativeWork` does not find `archived-N` among the live conversations. It asks `history.live` (refuses read-only) and `history.shell` (refused `legacy_session IS NOT NULL`) and throws `Unknown native public conversation`. The route answers `500 fixture_error`.
5. The client: `sync` → `refresh` → snapshot 500 → `status: "offline"`, retried with back-off up to 30 s, forever. The command in flight ends as a 500 or a dropped connection → `pending` kept, `network_error`. The phone's `restore()` puts the text back into the composer.

## Decisions

### D1. A session archive is a valid empty reference

`ConversationHistory.shell` returns `{id, revision, messages: []}` for any deleted or read-only chat, session archives included. `saveKey` already ignores an empty reference to a read-only chat, so the archive's messages and name stay as they are. `restore` still strips earlier-session work references when an archive is restored.

Alternative considered: project the task into the live main chat again. Rejected: the task belongs to the earlier session, whose messages are now the archive's. The attachment generation already says so.

Alternative considered: skip unknown chats in `syncNativeWork`. Rejected for this change because it hides data errors. It is reported as a risk.

### D2. A kept command is not unsent

`heldForRecovery(state, command)` (`packages/client-core/chat-view.ts`) is true while the session still holds that exact command as `pending` after its send ended. The phone's and the web's `restore` return early then. NIAR-279's Dismiss already puts the text back after the server confirms `not_running`. A refusal (`pending` cleared) or a send never delivered still restores at once.

### D3. Stop needs a connection

The phone passes `onStop` only when `online`. The web's `stoppable` (Stop button and Esc) requires `state.status === "online"`. While offline, a request on its way shows the sending spinner (phone) or Send disabled (web).

## Verification

- `tests/conversation-directory-storage.test.ts`: a task of the earlier session that names the session archive leaves snapshot and sync working across restarts (fails before D1 with `Unknown native public conversation`).
- `tests/reconnect-after-server-loss.test.ts` (real `ClientSession` over a fake server that dies, answers 500 and comes back): offline without Stop, back online by polling or on foreground with no resend, Check result posts the identical command once, and a recorded one is replayed without a second message.
- `tests/failed-request-mobile.test.tsx`, `tests/web-chat-next.test.tsx`: a lost answer keeps the composer empty until a confirmed Dismiss, a refusal restores at once, and Stop is hidden while offline (the phone tests fail before D2/D3).
- Emulator: stopping the server mid-answer and starting it again; screenshots in the session scratchpad `n279-fix/`.
