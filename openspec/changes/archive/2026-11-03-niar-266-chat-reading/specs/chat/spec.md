## ADDED Requirements

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
