# chat Specification

## Purpose

Chat is where a person talks to the assistant in the web app and the mobile app: creating and continuing chats, the chat directory (rename, archive, restore, delete), cancelling open work, the Thinking row, questions and approvals inside the chat, the composer and attachments.

## Requirements

### Requirement: Creating a chat

The system SHALL create a chat with the idempotent `conversation.create` command; an id starting with `archived-` SHALL be refused. In the web app, `/chat` SHALL be an empty new chat that exists only on the page until its first message, then becomes `/chat/:id` without reloading.

#### Scenario: First message in a new chat

- **WHEN** the person sends the first message at `/chat`
- **THEN** the chat is created on the server and the address becomes `/chat/:id`

### Requirement: Main chat sessions

The mobile app SHALL start the main chat empty after an app launch and after four hours in the background, marking the first new request with `session: "new"` (never on an answer to a question). The server SHALL then move the main chat's messages into a read-only session archive (`archived-N`) and clear short-term context before the model reads anything; open work stays available in Tasks. A replayed command SHALL NOT archive twice and an empty chat SHALL write no archive.

#### Scenario: Return after a long break

- **WHEN** the mobile app resumes after more than four hours in the background and the person sends a request
- **THEN** the previous main chat appears in the archive as a read-only chat
- **AND** the assistant answers without the earlier session's short-term context

### Requirement: Renaming a chat

The system SHALL rename a chat for all of the person's clients with `conversation.rename {conversationId, title}`; `title` SHALL be trimmed and at most 160 characters, and an empty title SHALL restore the server's title (the first request). Renaming SHALL NOT change any message or a reply in flight, and an archived chat SHALL be renameable.

#### Scenario: Clearing a name

- **WHEN** the person renames a chat to an empty name
- **THEN** the chat shows its first request as its title again on every device

### Requirement: Listing chats

The system SHALL list a person's chats in pages of at most 40 through `GET conversations`; `state=active` SHALL list only chats that can continue and `state=archived` only the archive, both newest first by last change. A snapshot that would hold more than 50 chats SHALL require `agent-conversation-projection/1`, otherwise `406`. The web sidebar SHALL list active chats only and load older ones on demand.

#### Scenario: Archive filter

- **WHEN** a client reads `GET conversations?state=archived`
- **THEN** it receives only archived chats, newest first

### Requirement: Directory changes reach every client

Archiving, restoring and deleting a chat SHALL restart the event log at a new floor so that every client of the person re-reads its snapshot and chat list. The web app SHALL also re-read the list on window focus and reload.

#### Scenario: Sidebar after archiving on another device

- **WHEN** the person archives a chat on the phone
- **THEN** the web app's next events read answers `409` and the re-read sidebar no longer lists the chat

### Requirement: Archiving a chat

The system SHALL archive a chat with `conversation.archive {conversationId, cancelOpenWork?}`, accepted also for a chat already archived. The chat SHALL keep its id, messages, name and conversation memory and leave the chat list. Archiving the main chat SHALL move its messages into a new session archive and continue the main chat empty. A hub item's chat (`chat-hub-…`) SHALL NOT be archived.

#### Scenario: Archiving a hub item's chat

- **WHEN** a client sends `conversation.archive` for a `chat-hub-…` chat
- **THEN** the command is `rejected/unknown_context`

#### Scenario: Unknown chat

- **WHEN** a client archives an unknown, foreign or deleted chat
- **THEN** the command is `rejected/unknown_context`

### Requirement: Archived chats are read-only

An archived chat SHALL be marked `readOnly: true`. It SHALL be readable, renameable, restorable and deletable, and any other command naming it SHALL be `rejected/unknown_context` without a model call; process answers SHALL NOT be published into it.

#### Scenario: Message to an archived chat

- **WHEN** a client sends `message.send` to an archived chat
- **THEN** the command is `rejected/unknown_context`
- **AND** no model is called

### Requirement: Restoring a chat

The system SHALL restore an archived chat with `conversation.restore {conversationId}`, accepted also for a chat already active; an unknown, foreign or deleted chat SHALL be `rejected/unknown_context`. The chat SHALL return in place with its id, messages and name under a new revision and can be continued (see `memory`).

#### Scenario: Restoring

- **WHEN** the person restores an archived chat
- **THEN** it returns to the chat list with its id, messages and name and can be continued

### Requirement: Deleting a chat

The system SHALL delete a chat with `conversation.delete {conversationId, cancelOpenWork?}`, removing its messages, name, short-term context and the assistant's conversation memory of it (see `memory`). A deleted chat SHALL never be listed or searched, its message page SHALL be `404`, and every later command naming it SHALL be `rejected/unknown_context` without a model call. Deleting an already deleted chat SHALL be accepted.

#### Scenario: Foreign chat

- **WHEN** a person tries to delete another person's chat id
- **THEN** the command is `rejected/unknown_context` and nothing changes

#### Scenario: Message to a deleted chat

- **WHEN** a client sends `message.send` naming a deleted chat
- **THEN** the command is `rejected/unknown_context` without a model call

### Requirement: Deleted chat receipts

Receipts of a deleted chat SHALL stay for idempotency without what the person wrote: the request text SHALL become `[deleted]` and tags and attached tasks SHALL be dropped, so a replay is `idempotency_conflict`, never a new turn. A tombstone SHALL keep the id so it is never reused.

#### Scenario: Delete then replay

- **WHEN** a deleted chat's earlier `message.send` is replayed with its original ids
- **THEN** the server answers `idempotency_conflict` and starts no turn

### Requirement: Fixed chats are emptied

Deleting the main chat (`conversation-1`) or a hub item's chat (`chat-hub-…`) SHALL empty it instead: it leaves the list and returns as a new chat with its next message. A finished task that still points at a deleted or archived chat SHALL keep an empty chat entity in the snapshot.

#### Scenario: Delete the main chat

- **WHEN** the person deletes the main chat and later writes to the assistant
- **THEN** the main chat starts empty without the deleted messages

### Requirement: Open work

Open work SHALL be a work item of the chat that still waits for the person or the server (`waiting_input`, `waiting_approval`, `waiting_system`, `running`, `queued`, `scheduled`, or a process run still running or waiting). Settled work, a question or approval past its expiry, and a run that ended with an unconfirmed write SHALL NOT be open.

#### Scenario: Run with an unconfirmed write

- **WHEN** a chat's only work ended with an `unknown` write
- **THEN** the chat can be deleted and the work item stays visible in Tasks

### Requirement: Open work blocks archive and delete

Archive or delete of a chat with open work SHALL be `rejected/operation_in_progress`; clients that ask with `work=agent-open-work/1` SHALL receive `openWork: [{workItemId, title, kind}]` (at most 50, `kind` `question`, `approval`, `process` or `task`). A chat answering right now SHALL be `conflict/operation_in_progress` without a receipt.

#### Scenario: Delete with a waiting approval

- **WHEN** the person deletes a chat whose write still awaits approval
- **THEN** the command is refused with the approval listed as open work

#### Scenario: Chat still answering

- **WHEN** the person deletes a chat while its answer is still being produced
- **THEN** the command is `conflict/operation_in_progress` and the same press can be retried later

### Requirement: Cancel and then archive or delete

With `cancelOpenWork: true` the server SHALL first cancel the chat's open work exactly as `work.cancel` does and then archive or delete. If a cancellation is refused midway, the command SHALL answer `conflict` without a receipt, keep what was already cancelled, and a repeated press SHALL continue. The web app SHALL name the waiting items and offer **Keep** or **Cancel and delete** / **Cancel and archive**.

#### Scenario: Cancel and delete

- **WHEN** the person chooses **Cancel and delete** for a chat with a waiting approval
- **THEN** the approval is declined, nothing is written, and the chat is deleted

### Requirement: Cancelling open work

The system SHALL let a person cancel their own waiting work in a chat with `work.cancel {conversationId, workItemId, expectedWorkRevision, language}`. A question SHALL end `cancelled`, an approval SHALL be declined (its receipt `rejected`, nothing dispatched), a run stopped mid-way SHALL be closed once its retirement is proved, and a waiting process run SHALL be cancelled (see `process-execution`). Each cancellation SHALL write the audit entry `work.cancelled`.

#### Scenario: Cancel a question

- **WHEN** the person presses **Cancel** on the assistant's open question
- **THEN** the question ends `cancelled` with a short reply

### Requirement: Cancel never undoes an effect

`work.cancel` SHALL never cancel an effect already dispatched; an `unknown` write SHALL stay `unknown`. A different revision SHALL be `conflict/revision_conflict`; work executing right now SHALL be `conflict/operation_in_progress`; a foreign, unknown, archived-chat or deleted-chat item SHALL be `rejected/unknown_context`. Work already settled at that revision SHALL be accepted without change.

#### Scenario: Stale card

- **WHEN** the person presses **Cancel** on a work card whose revision changed since it was shown
- **THEN** the command is `conflict/revision_conflict`

#### Scenario: Cancel while the run executes

- **WHEN** the person cancels a run that is executing right now
- **THEN** the command is `conflict/operation_in_progress` without a receipt

### Requirement: Questions with offered answers

When the assistant asks a question with known likely answers, the question SHALL offer 2–6 options of at most 80 characters, optionally `multiple`, delivered only to clients that ask with `questions=agent-question-options/1`. A picked answer SHALL be an ordinary `message.send` with the question's `context` and the option text, several joined by ", ". The web app SHALL send one option on click or its digit key; **Other…** SHALL open the composer as the answer.

#### Scenario: Several answers

- **WHEN** the person ticks two options of a `multiple` question and sends
- **THEN** one message is sent with both labels joined by ", " and the question's context

#### Scenario: Older client

- **WHEN** a client did not ask for question options
- **THEN** it receives the question text only and the person answers by typing

### Requirement: Thinking row

Clients SHALL poll progress from 250 ms after sending, then every 500 ms (250 ms while a draft is present), and SHALL show one "Thinking" row with elapsed seconds that reads "Reading <service>" while a service is read, with the draft drawn below it; the stored message SHALL replace both on completion. Unavailable progress SHALL degrade to an unconfirmed state and SHALL NOT fail or retry the command. Reasoning SHALL never be shown.

#### Scenario: Service read during an answer

- **WHEN** the assistant reads the CRM while answering
- **THEN** the row reads "Reading" with the service's name instead of "Thinking"

#### Scenario: Progress unavailable

- **WHEN** the activity route fails
- **THEN** the chat shows the request as unconfirmed without resending it

### Requirement: Approval in chat

A write that needs the person's decision SHALL appear in the chat as an approval card with the action, the service and the reviewed values, decided only by `service.resolve {operationId, approved}` (see `agent-runtime`). A `service.action` result SHALL be shown as a card only while it awaits the decision; afterwards the chat SHALL show only the answer's text and generated UI.

#### Scenario: Decline

- **WHEN** the person declines an approval card
- **THEN** nothing is written and the assistant continues with the declined outcome

#### Scenario: Stale approval

- **WHEN** the person approves a card whose work item revision changed
- **THEN** the server answers `revision_conflict` and runs nothing

#### Scenario: Phone and web agree

- **WHEN** the same pending write is shown on the web and on the phone
- **THEN** both show Decline before Approve, right-aligned, with the same labels

### Requirement: Approval card footer

On every client the approval card, and the meeting proposal card, SHALL end with **Decline** and then **Approve**, right-aligned, with Approve as the only primary action. The decline action SHALL be labelled "Decline" / "Odmítnout", never with the word that closes a sheet, and the approve action "Approve" / "Potvrdit", for a demo and a real write alike. A declined card SHALL read "Declined" / "Odmítnuto".

#### Scenario: Declined card

- **WHEN** the person declines a pending write
- **THEN** the card reads "Declined" / "Odmítnuto"

#### Scenario: Meeting proposal

- **WHEN** a meeting proposal waits for the person's decision on the web or on the phone
- **THEN** it ends with **Decline** then **Approve**, right-aligned, labelled as on the approval card, and its effect line says whether a calendar event is created or it is a demo

#### Scenario: Approved meeting not started yet

- **WHEN** an approved meeting proposal's operation has not started
- **THEN** the card offers **Decline** and no second **Approve**

### Requirement: Approval card side actions

The effect line next to the approval decisions SHALL say what approving does. Other actions of an approval or meeting proposal card, such as **Edit** on the phone's meeting proposal, SHALL NOT be primary and SHALL stay to the left of the decisions.

#### Scenario: Edit on a meeting proposal

- **WHEN** the phone shows a meeting proposal that can be edited
- **THEN** Edit sits left of Decline and Approve and is not a primary button

### Requirement: Composer

The composer SHALL refuse to send more than 4,000 characters. Enter SHALL send, Shift+Enter SHALL break a line and Esc SHALL stop a running answer; Ctrl/Cmd+Shift+O SHALL start a new chat and Ctrl/Cmd+K SHALL open search. `@` SHALL open a picker of what the person can tag (see `skills`). A button SHALL jump back to the end of a long chat.

#### Scenario: Too long

- **WHEN** the person types more than 4,000 characters
- **THEN** sending is disabled

### Requirement: Attachments to a message

A message SHALL carry an open item from Tasks the person brought to the chat as `humanTask {id, title}`, which cannot be combined with a question answer `context`; the server SHALL read the item itself by id in the person's scope, the title being only a display copy. A meeting attached from the meeting page (**Ask**) SHALL travel as a `meeting` mention.

#### Scenario: Task brought to chat

- **WHEN** the person opens an item from Tasks in chat and sends a message
- **THEN** the message carries `humanTask` and the assistant works on that item

#### Scenario: Task and answer together

- **WHEN** a `message.send` carries both `humanTask` and a question `context`
- **THEN** the command is refused as invalid

### Requirement: Message actions

Each message SHALL offer copy on every client (an answer as its Markdown), next to the time it was stored when the server sent one; the latest answer SHALL offer **Again**, which resends the request before it as a new message, and the latest request SHALL offer **Edit**, which puts it back in the composer. History SHALL never change.

#### Scenario: Again

- **WHEN** the person presses **Again** on the latest answer
- **THEN** the request before it is sent again as a new message and the earlier answer stays

#### Scenario: Copy on the phone

- **WHEN** the person presses **Copy** under an answer in the mobile app
- **THEN** the answer's text is on the clipboard and the button reads "Copied" for a moment

#### Scenario: Again keeps the draft

- **WHEN** the person has typed a new message and presses **Again** on the latest answer
- **THEN** the earlier request is sent again and the typed text stays in the composer

#### Scenario: Edit sends nothing

- **WHEN** the person presses **Edit** on the latest request
- **THEN** its text is in the composer and nothing is sent until the person sends it

### Requirement: Message action limits

Again SHALL leave the composer's draft, attached files and attached task as they are. Read-only chats SHALL offer no edit and no again. On touch screens the message actions SHALL always be visible.

#### Scenario: Read-only chat

- **WHEN** the person opens a read-only chat
- **THEN** its messages offer copy but no Edit and no Again

### Requirement: Archive screens

The web account page (`/me`, **Archived chats**) and the mobile Settings SHALL list archived chats newest first with date and message count, offering **Restore** and **Delete** after one confirmation; the web list SHALL offer a search once it holds more than eight chats. Opening an archived chat SHALL show it read-only with **New chat** and **Restore**.

#### Scenario: Open an archived chat

- **WHEN** the person opens an archived chat from the archive
- **THEN** it opens read-only at `/chat/:id` with no composer and offers **Restore**

### Requirement: Web chat credential

The web app SHALL obtain its chat credential from the signed-in browser session with `POST /admin/api/identity/app/session {organizationId, workspaceId}`; it SHALL expire with that browser session, have no refresh token and use none of the person's device slots. The page SHALL quietly obtain the next one when it expires. The server SHALL keep at most 12 per browser session and workspace and 32 per person, dropping the oldest.

#### Scenario: Several tabs

- **WHEN** a person keeps several tabs of the same workspace open
- **THEN** each tab keeps chatting without asking to sign in again

### Requirement: Browser storage

The web app SHALL keep chat caches, unsent drafts and credentials only in page memory. `localStorage` SHALL hold presentation choices only (language, chosen workspace, sidebar state, pinned chat ids); chat names SHALL live on the server.

#### Scenario: Reload

- **WHEN** the person reloads the chat page
- **THEN** no chat content or credential is read from browser storage

### Requirement: Readable answers

The answer renderers of the web app and the mobile app SHALL render Markdown from the parsed syntax tree without raw HTML: headings as headings on a two-step scale, the first row of a table as its header row, and code blocks with a visible **Copy code** action that copies the block's text. HTML in an answer SHALL stay text and remote images SHALL NOT be fetched.

#### Scenario: Table answer

- **WHEN** an answer contains a Markdown table
- **THEN** its first row is rendered as column headers

#### Scenario: Copy code

- **WHEN** the person presses **Copy code** on a code block
- **THEN** exactly the block's text is copied and the action reads "Copied" for a moment

#### Scenario: HTML in an answer

- **WHEN** an answer contains `<script>`
- **THEN** it is shown as text and nothing runs

### Requirement: Chat reading size

The web chat transcript and composer SHALL use 14 px text with a 22 px line height; cards, generated UI and the rest of the app SHALL keep the console's 13 px density.

#### Scenario: Long answer

- **WHEN** an answer of several paragraphs is shown in the web chat
- **THEN** its prose is 14 px with a 22 px line height and a card beside it keeps 13 px

### Requirement: Long requests fold

In the web chat a request taller than 12 lines SHALL be folded with a **Show more** control that expands it and **Show less** that folds it again, except when it is the target of a search jump. Answers, attachments and cards SHALL NOT fold.

#### Scenario: Pasted e-mail

- **WHEN** the person sends a request of 40 lines
- **THEN** it shows 12 lines and **Show more**

#### Scenario: Search jump

- **WHEN** the person opens that request from a search result
- **THEN** it is shown whole

### Requirement: Finished answers are announced

When an answer is stored, the web chat SHALL announce "Answer ready" and the answer's first paragraph once, through one polite status region that is always present; it SHALL NOT announce streamed text or answers that were already stored when the chat was opened.

#### Scenario: Same answer twice

- **WHEN** two consecutive answers have the same text
- **THEN** both are announced

#### Scenario: Opening a chat

- **WHEN** the person opens a chat with stored answers
- **THEN** nothing is announced

### Requirement: Chat header

The web chat page SHALL start with one line holding the chat's name and a `…` menu with **Rename**, **Pin**, **Archive** and **Delete**, the same actions and confirmations as the chat's sidebar row, whether or not the sidebar is visible. A chat that cannot be archived SHALL offer no Archive; a new chat that is not saved yet and an archived chat SHALL show no menu.

#### Scenario: Collapsed sidebar

- **WHEN** the person collapses the sidebar and opens the chat's `…` menu
- **THEN** they can rename, pin, archive or delete the chat from there

#### Scenario: Delete from the header

- **WHEN** the person chooses **Delete** in the header
- **THEN** the chat is deleted only after they confirm, and the app leaves the chat

### Requirement: Copied and Undo confirmations

The web app SHALL confirm a copy with a short "Copied" toast and offer **Undo** after archiving a chat ("Chat archived"), which restores the chat and reopens it when it was open. The toast SHALL be used for nothing else: never for errors, approvals, questions or saves. One toast SHALL be shown at a time and SHALL be announced politely to screen readers.

#### Scenario: Undo an archive

- **WHEN** the person archives the open chat and presses **Undo**
- **THEN** the chat is restored, listed again and opened

#### Scenario: Error

- **WHEN** archiving a chat fails
- **THEN** the error is shown where the action was pressed and no toast appears

#### Scenario: Pet appearance saved

- **WHEN** the person saves the pet's appearance on the web
- **THEN** the sheet closes, the pet shows the new appearance and no toast or floating "Saved" appears

### Requirement: Saves confirm in place

A save SHALL confirm in place on every client: the form, sheet or dialog returns to its clean or closed state and the saved value is shown, with no toast. Screen readers MAY be told "Saved" through a visually hidden polite status or an accessibility announcement.

#### Scenario: Appearance saved

- **WHEN** the person saves the pet's appearance
- **THEN** the sheet closes, the new look is shown and no toast appears

### Requirement: Days in chats

Clients SHALL group the chat list and divide a chat's messages by local calendar days, never by 24-hour spans, with the same rules on every client: the list groups **Today**, **Yesterday**, **Previous 7 days**, then months (with the year when it is not the current one, the month starting with a capital), and inside a chat a divider names the day ("Today", "Yesterday", or the weekday and date) where a new day starts. Messages without a stored time SHALL start no divider.

#### Scenario: Daylight-saving night

- **WHEN** a chat was last active at 00:30 on the day the clocks went back, and the list is opened the next morning
- **THEN** the chat is under **Yesterday** on the web and on the phone

#### Scenario: Czech month heading

- **WHEN** the app is in Czech and a chat is older than seven days, from September of this year
- **THEN** it is under the heading "Září"

#### Scenario: Divider in a chat

- **WHEN** a chat has messages from yesterday and from today
- **THEN** a divider "Yesterday" precedes the first of yesterday's messages and "Today" the first of today's

### Requirement: Attachments wait before sending

The composer SHALL NOT send while an attachment is still being prepared, uploaded or checked, or when one failed. Each attachment chip SHALL show its own state (preparing, uploading, checking, ready or failed, with a retry when the upload can be retried).

#### Scenario: Slow upload

- **WHEN** a photo is still uploading
- **THEN** Send is disabled and its label says the attachment is not ready

#### Scenario: Failed upload

- **WHEN** an attachment failed to upload
- **THEN** Send stays disabled, the composer says an attachment failed and the chip shows the failure

#### Scenario: Web composer

- **WHEN** a file added in the web composer is still uploading
- **THEN** the Send button is named "Wait for the attachment" and the line under the composer says the same, until the file is ready

### Requirement: Send says why it waits

Every client SHALL say why Send waits for an attachment, next to the composer and in the Send button's accessible name, with the same words: "Wait for the attachment" / "Počkej na přílohu" while a file is not ready, "An attachment failed" / "Příloha se nenahrála" when one failed.

#### Scenario: Upload still running on the web

- **WHEN** a file is still uploading in the web composer
- **THEN** Send is disabled and both its name and the line under the composer say "Wait for the attachment"
