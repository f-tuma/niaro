## MODIFIED Requirements

### Requirement: Message actions

Each message SHALL offer copy on every client (an answer as its Markdown), next to the time it was stored when the server sent one; the latest answer SHALL offer **Again**, which resends the request before it as a new message, and the latest request SHALL offer **Edit**, which puts it back in the composer. Again SHALL leave the composer's draft, attached files and attached task as they are. History SHALL never change. Read-only chats SHALL offer no edit and no again. On touch screens the actions SHALL always be visible.

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

## ADDED Requirements

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

The composer SHALL NOT send while an attachment is still being prepared, uploaded or checked, or when one failed. Each attachment chip SHALL show its own state (preparing, uploading, checking, ready or failed, with a retry when the upload can be retried). The mobile app SHALL also say why Send waits, above the composer and in the Send button's label.

#### Scenario: Slow upload

- **WHEN** a photo is still uploading
- **THEN** Send is disabled and its label says the attachment is not ready

#### Scenario: Failed upload

- **WHEN** an attachment failed to upload
- **THEN** Send stays disabled, the phone composer says an attachment failed and the chip shows the failure
