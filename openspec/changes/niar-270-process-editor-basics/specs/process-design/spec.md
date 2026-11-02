## ADDED Requirements

### Requirement: Saving the arrangement

The canvas SHALL save step positions and notes to the design session with `POST /admin/api/identity/catalog/processes/design/layout` (`{sessionId, layoutRevision, layout}`), outside the proposal: the proposal revision, acknowledgments and the review digest SHALL stay unchanged. A session SHALL start with the draft's layout and acceptance SHALL save the session's layout with the draft. The canvas MUST NOT keep the arrangement only in the browser.

#### Scenario: Move a step during review

- **WHEN** a person moves a step after reviewing the proposal and then accepts
- **THEN** the acceptance is not refused for a changed review and the draft carries the new arrangement

#### Scenario: Another browser

- **WHEN** a person arranged the steps and added a note, accepted, and an administrator opens the process on the canvas in another browser
- **THEN** the canvas shows the same positions and the note

### Requirement: Arrangement replay and conflicts

The same layout sent again after a lost response SHALL return the stored state; a different layout over a newer `layoutRevision` SHALL fail with `409 process_design_layout_conflict`, and an accepted session SHALL refuse it. Notes SHALL pass the credential guard. The designer model MUST NOT read or write the layout.

#### Scenario: Lost layout response

- **WHEN** the browser sends the same layout again with the revision it last saw
- **THEN** the server answers with the stored layout and its revision

#### Scenario: Arranged in another tab

- **WHEN** a second tab saves a different layout over an older revision
- **THEN** it is refused with `409 process_design_layout_conflict` and the canvas reads the session again

### Requirement: Problems on the steps they concern

Each validation issue SHALL be shown on the step it concerns with one sentence that names the step and the fix, in English and Czech; a mark on the step on the canvas SHALL select it. Issues of the whole process SHALL be listed on the canvas and in Review with the same sentences. When validation returns 20 issues, the list SHALL say that only the first 20 are shown. The server's issue codes SHALL stay the only source of what is wrong.

#### Scenario: Missing binding

- **WHEN** validation reports `binding_invalid` at `/steps/0/input/name` for the step _Find contacts_
- **THEN** the step carries a mark reading "Find contacts: give “name” a value from the process input or an earlier step."

#### Scenario: Limits

- **WHEN** validation reports `limit_exceeded` at `/limits/maxSteps`
- **THEN** no step is marked and the canvas lists a sentence about raising the step limit or removing steps

### Requirement: Agent instructions in four parts

The designer SHALL write each agent's instructions as **Goal**, numbered **Steps**, **Never** and **Done when**, with these English headings in the stored text, and SHALL keep stating that instructions never change actions or approval. The canvas SHALL edit instructions in this shape as four fields saved as one text, and Review SHALL show them as a list. Instructions in another shape SHALL stay valid and editable as one field.

#### Scenario: Editing the parts

- **WHEN** a person fills Goal, two steps, one Never rule and Done when for an agent step and saves
- **THEN** the proposal holds one instruction text with the four headings, numbered steps and a dashed rule

#### Scenario: Free text

- **WHEN** an agent's instructions are a single sentence without headings
- **THEN** the canvas shows one field with **Use sections**, and Review shows the text as written
