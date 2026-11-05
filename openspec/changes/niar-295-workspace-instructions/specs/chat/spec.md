# Spec Delta

## ADDED Requirements

### Requirement: Starters in an empty chat

The empty chat on the web and the phone's home SHALL show the workspace's starters (`GET /v1/:workspace/instructions`) in place of the app's own suggestions (web) and "Plan a meeting" (phone). Pressing a starter SHALL send it at once as the person's own message, without the composer's tags, reply or task. Without starters each app SHALL keep its own suggestions and their behaviour.

#### Scenario: Starter pressed

- **WHEN** the person presses the starter "Co čeká na schválení?" in a new chat
- **THEN** the chat is created and the message is sent at once, and the composer stays empty

#### Scenario: No starters configured

- **WHEN** neither the workspace nor the organization has starters
- **THEN** the web shows its own suggestions, which fill the composer, and the phone shows "Plan a meeting"

### Requirement: Members read workspace instructions

Every workspace member SHALL be able to read the instructions that apply in their workspace, read-only, on the web app's Skills page; the page SHALL show nothing when there are none.

#### Scenario: Member reads the instructions

- **WHEN** a member opens Skills in a workspace with instructions
- **THEN** they see the instructions rendered as Markdown with no way to edit them
