## MODIFIED Requirements

### Requirement: Approval card footer

On every client the approval card, and the meeting proposal card, SHALL end with **Decline** and then **Approve**, right-aligned, with Approve as the only primary action. The decline action SHALL be labelled "Decline" / "Odmítnout", never with the word that closes a sheet, and the approve action "Approve" / "Potvrdit", for a demo and a real write alike; the effect line next to them SHALL say what approving does. A declined card SHALL read "Declined" / "Odmítnuto". Other actions of the card, such as **Edit** on the phone's meeting proposal, SHALL NOT be primary and SHALL stay to the left of the decisions.

#### Scenario: Declined card

- **WHEN** the person declines a pending write
- **THEN** the card reads "Declined" / "Odmítnuto"

#### Scenario: Meeting proposal

- **WHEN** a meeting proposal waits for the person's decision on the web or on the phone
- **THEN** it ends with **Decline** then **Approve**, right-aligned, labelled as on the approval card, and its effect line says whether a calendar event is created or it is a demo

#### Scenario: Approved meeting not started yet

- **WHEN** an approved meeting proposal's operation has not started
- **THEN** the card offers **Decline** and no second **Approve**

### Requirement: Copied and Undo confirmations

The web app SHALL confirm a copy with a short "Copied" toast and offer **Undo** after archiving a chat ("Chat archived"), which restores the chat and reopens it when it was open. The toast SHALL be used for nothing else: never for errors, approvals, questions or saves. One toast SHALL be shown at a time and SHALL be announced politely to screen readers. A save SHALL confirm in place: the form, sheet or dialog returns to its clean or closed state and the saved value is shown; screen readers MAY be told "Saved" through a visually hidden polite status.

#### Scenario: Undo an archive

- **WHEN** the person archives the open chat and presses **Undo**
- **THEN** the chat is restored, listed again and opened

#### Scenario: Error

- **WHEN** archiving a chat fails
- **THEN** the error is shown where the action was pressed and no toast appears

#### Scenario: Pet appearance saved

- **WHEN** the person saves the pet's appearance on the web
- **THEN** the sheet closes, the pet shows the new appearance and no toast or floating "Saved" appears

### Requirement: Attachments wait before sending

The composer SHALL NOT send while an attachment is still being prepared, uploaded or checked, or when one failed. Each attachment chip SHALL show its own state (preparing, uploading, checking, ready or failed, with a retry when the upload can be retried). Every client SHALL also say why Send waits, next to the composer and in the Send button's accessible name, with the same words: "Wait for the attachment" / "Počkej na přílohu" while a file is not ready, "An attachment failed" / "Příloha se nenahrála" when one failed.

#### Scenario: Slow upload

- **WHEN** a photo is still uploading
- **THEN** Send is disabled and its label says the attachment is not ready

#### Scenario: Failed upload

- **WHEN** an attachment failed to upload
- **THEN** Send stays disabled, the composer says an attachment failed and the chip shows the failure

#### Scenario: Web composer

- **WHEN** a file added in the web composer is still uploading
- **THEN** the Send button is named "Wait for the attachment" and the line under the composer says the same, until the file is ready
