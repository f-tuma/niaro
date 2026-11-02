# process-design Specification

## Purpose

People create and change processes by talking to a designer agent or editing a canvas, review the proposal and save it as a draft; a person can also ask the chat agent to draft a personal process and save, test and turn it on from one card. This capability covers design sessions, the designer conversation, the visual editor and drafting processes from chat.

## Requirements

### Requirement: Design sessions

A person with authority to manage the target (see `process-definitions`) SHALL design in a design session bound at start to its scope, owner and, for an edit, the existing process and an optional frozen baseline version. Profile `agent-process-design/1` SHALL serve service processes and `agent-process-design/2` workspace and personal ones. Sessions SHALL be private to the person who started them, including between administrators.

#### Scenario: Another administrator opens a session

- **WHEN** an administrator reads a design session another administrator started
- **THEN** it is refused

#### Scenario: Member designs

- **WHEN** a member starts a session with `owner: {type: "user"}`
- **THEN** the session designs their personal process

### Requirement: Designer API

The designer SHALL be served under `/admin/api/identity/catalog/processes/design` with `/capabilities`, base GET (the fresh review), `/start`, `/update`, `/acknowledge`, `/accept`, `/turns` (POST and GET), `/turns/list`, `/sessions/list` and `/drafts/list`, and to the mobile app under `/v1/{workspace}/process-design` with the same bodies. Every request SHALL name organization and workspace; strict schemas SHALL reject actor or authority fields.

#### Scenario: Actor in the body

- **WHEN** a start body includes an actor field
- **THEN** it is rejected

### Requirement: Edit baseline and review

An edit SHALL start from the current draft; a selected frozen version SHALL serve as the comparison baseline. The review SHALL show the definition diff by stable step id and dependency revision changes, and SHALL mark missing history as unavailable instead of inventing removed dependencies.

#### Scenario: Editing from a version

- **WHEN** a person edits an existing process with `baselineVersion: 2`
- **THEN** the review compares the candidate with version 2 while the current draft is the starting candidate

### Requirement: Designer conversation

Each designer turn SHALL run the human-selected, tool-capable designer model, pinned for the session, with only the tools `design_list_capabilities`, `design_get_capability`, `design_read_proposal`, `design_update_proposal` and `design_validate_proposal`. These tools MUST NOT call business or discovery services, read saved memory, or set scope, actor, acknowledgments, acceptance, testing or activation.

#### Scenario: Turn proposes a workflow

- **WHEN** a person describes a process and the designer calls `design_update_proposal`
- **THEN** the proposal revision advances and nothing is saved to the registry

### Requirement: Designer context and caps

The designer SHALL see the latest 12 prior turns within 16 KiB and fresh proposal and capability data at each step. A session SHALL be limited to 64 turns, 24 tool receipts per turn and, by default, 32 model calls, 1,000,000 tokens and 10,000,000 USD millionths, narrowed by workspace policy. A turn SHALL have a two-minute deadline.

#### Scenario: Session budget exhausted

- **WHEN** the session's model-call cap is reached
- **THEN** further turns are refused and retrying or a new turn does not reset the cap

### Requirement: Designer budget readiness

Designer turns SHALL require the workspace budget in enforce mode with a price for the designer model (see `inference-budget`). Designer capabilities SHALL carry `budgetReady`; while it is false the designer and test pages SHALL show that the AI budget is not set up, tell members to ask an administrator, and keep sending and testing disabled.

#### Scenario: Observe-only budget

- **WHEN** the workspace budget is observe-only and a person opens the designer
- **THEN** the composer is disabled with the budget notice and no turn is sent

### Requirement: Turn commands

Turn start SHALL require a unique `requestId`, the current proposal revision, a `modelId`, nonblank text and an optional language (`en` default or `cs`). Repeating the same command SHALL return its recorded state without new inference; changed contents under the same id SHALL conflict. A new turn SHALL NOT start while the previous one is still running.

#### Scenario: Lost turn reply

- **WHEN** the client resends the exact turn command after losing the response
- **THEN** it gets the recorded turn and no new inference runs

#### Scenario: Second turn too early

- **WHEN** a person sends a new message while the previous turn still runs
- **THEN** the new turn is refused

### Requirement: Turn failure and restart

Reads SHALL be passive and MUST NOT resend work. After a server restart, running turns SHALL become interrupted and MUST NOT be resumed. A failed or interrupted turn SHALL keep the submitted text and committed proposal edits and show a safe code instead of provider error text. Each recorded turn SHALL report the designer model and provider it actually used.

#### Scenario: Restart during a turn

- **WHEN** the server restarts while a turn runs
- **THEN** the turn reads as interrupted, the text is kept and nothing is resent

### Requirement: Assumptions and questions

The designer's open questions and unacknowledged assumptions SHALL block acceptance. Acknowledgment SHALL bind each assumption's exact id and text digest, and editing an assumption SHALL void its acknowledgment.

#### Scenario: Edited assumption

- **WHEN** an acknowledged assumption's text changes
- **THEN** it must be acknowledged again before acceptance

### Requirement: Confirmation expectations

A confirmation expectation of `catalog` SHALL keep the catalog approval policy; `every_write` SHALL require every referenced write to already require approval; `grouped` SHALL block acceptance. Instructions MUST NOT lower catalog approval policy.

#### Scenario: Every write confirmed

- **WHEN** the expectation is `every_write` and a referenced write runs without approval
- **THEN** the proposal cannot be accepted

### Requirement: Acceptance

Acceptance SHALL require explicit human action, the current proposal revision and the exact server review digest including current capability revisions. It SHALL only save the draft (never freeze, test, activate or run), end the session, and return its original receipt on replay. A later change needs a new session.

#### Scenario: Stale review

- **WHEN** a person accepts with a review digest that no longer matches
- **THEN** acceptance is refused and nothing is saved

#### Scenario: Accept leaves the active version

- **WHEN** a person accepts a proposal for a process with an active version
- **THEN** the draft is updated and the active version is unchanged

### Requirement: Credential guard

Proposal content, designer messages and test suites SHALL be bounded (6,000 values, 24 levels, 64 KiB of keys and strings) and SHALL reject recognized bearer, basic, API-key, private-key and URL-userinfo patterns and credential-named literals before they are stored.

#### Scenario: Pasted API key

- **WHEN** a designer message contains a recognizable API key
- **THEN** it is refused before being stored or sent to the model

### Requirement: Capability projection

Designer capabilities SHALL list, through an allowlist, ids, revisions, descriptions, effect, approval policy and schemas of the actions the caller may use, and usable tool models. They MUST NOT include URLs, bindings, headers, credentials, schema examples or defaults, and SHALL NOT claim that a connection works.

#### Scenario: Credential-named schema field

- **WHEN** an action's input schema has a field named like a credential
- **THEN** its schema is reported unavailable and a proposal using it cannot be accepted

#### Scenario: Member's catalogue

- **WHEN** a member reads designer capabilities
- **THEN** only enabled actions they may use and configured tool models are listed

### Requirement: Visual editor

The designer SHALL offer a canvas where a person adds, connects, configures and removes action, agent, branch and return steps and edits schemas, bindings and settings. Saving canvas edits SHALL update only the proposal and MUST NOT save the draft, test, activate or run the process.

#### Scenario: Adding a step on the canvas

- **WHEN** a person adds an action step on the canvas and saves
- **THEN** the proposal revision advances and the registry draft is unchanged

### Requirement: Recovering designer commands in the browser

The browser SHALL store each designer command before sending it, scoped to the login, account, organization, workspace and session. Reload, refresh and polling MUST only read; a command whose response was lost SHALL be resent only by explicit human retry with the same body. Sign-out or lost authority SHALL hide private designer data.

#### Scenario: Lost acceptance response

- **WHEN** the browser loses the response to an accept and reloads
- **THEN** it reads the session state and does not send the accept again by itself

### Requirement: Limit advice

When a candidate's limits are below what an ordinary run needs (see "Limit sizing"), the designer's update, validate and read tool results SHALL include `limitsAdvice` (`raise` with sized limits, or `reservationTooLarge`). Registry validation SHALL stay unchanged.

#### Scenario: Too few steps

- **WHEN** the designer writes `maxSteps: 2` for an agent that may call a service
- **THEN** its tool result advises raising the limits

### Requirement: Drafting a process from chat

When a person asks in chat to create a process, or to add something to their overview that no addable process does, the chat agent SHALL be able to call `process_propose {request, name?, addToHub, hubView?, sessionId?}`. It SHALL run the designer for a new personal session under the person's authority and budget and end the turn with a `process.proposal` card. Proposing SHALL save nothing.

#### Scenario: Replayed tool call

- **WHEN** the same `process_propose` call is replayed
- **THEN** the same session and turn are returned without new inference

#### Scenario: Answering the designer's questions

- **WHEN** the card has status `questions` and the person answers in chat
- **THEN** the agent calls `process_propose` with that `sessionId` and the session continues

### Requirement: Proposal card

The `process.proposal` card SHALL show name, kind, readable steps, inputs, outputs, services read or written, assumptions with digests, questions, `hubEligible` (no required input and no write without approval), `addToHub` and `status` `ready`, `questions` or `budget`. The web app SHALL offer **Save and turn on** and **Edit** (the session in `/processes/design`); the mobile app SHALL offer to open it in the web app.

#### Scenario: Budget not set up

- **WHEN** the person asks for a process but the budget is not ready
- **THEN** the card has status `budget`, no session, and says to ask an administrator

#### Scenario: Ineligible for the overview

- **WHEN** the proposal has a required input
- **THEN** Add to overview is disabled with the reason

### Requirement: Save and turn on

**Save and turn on** SHALL send `POST /v1/{workspace}/process-proposals?language=cs|en` with `{profile: "agent-process-proposal/1", type: "accept", sessionId, requestId, revision, reviewDigest, assumptions, addToHub}` (at most 8 KiB, pairing rate limit), return the status at once and run the pipeline in the background under the person's credential. `GET …/process-proposals?sessionId=` SHALL read the status. Only the person who drafted it SHALL read or press it; others get 404.

#### Scenario: Another person's proposal

- **WHEN** a person reads a proposal session someone else drafted
- **THEN** the server answers 404

### Requirement: Save pipeline

The pipeline SHALL check the card's revision and digest (`process_proposal_changed`), acknowledge exactly the assumptions the card showed, accept, size limits, freeze, generate and run a native test (see `process-qualification`), activate a qualified test, and, when asked and eligible, add the process to the overview (see `hub`). State SHALL be `open`, `running` (phase `saving`, `testing`, `activating`, `hub`), `done`, `stopped` with a `gap`, or `failed` with a `failure`.

#### Scenario: Card is out of date

- **WHEN** the proposal changed after the card was shown and the person presses Save and turn on
- **THEN** the pipeline fails with `process_proposal_changed` and nothing is saved

#### Scenario: Overview step fails

- **WHEN** the process is not eligible for the overview
- **THEN** it is still turned on and only the overview step reports `hub: failed`

### Requirement: Save pipeline admission

A press while the pipeline runs SHALL be refused with `409 process_proposal_busy`, and a press while the budget is not ready with `409 process_proposal_budget_not_ready`. Every step SHALL be idempotent, so a repeated press returns the current status and a new press after a failure continues from the furthest step reached. A server restart SHALL mark a running save `process_proposal_interrupted`.

#### Scenario: Press while running

- **WHEN** the person presses again while the pipeline runs
- **THEN** the press is refused with `409 process_proposal_busy`

#### Scenario: Retry after a failed test

- **WHEN** the generated test failed and the person presses again
- **THEN** the pipeline resumes without saving or freezing a second time

### Requirement: Limit sizing

Before freezing, the pipeline SHALL size limits for an ordinary run: every entered node, model call and tool call counts as a step; an agent that may use services plans three tool calls and one more model call than tool calls; duration is 15 s plus 10 s per model call plus 5 s per service call; tokens and cost cover each model call at 32,768 input tokens (capped by the price) plus the full output. Sizing SHALL never lower the designer's values nor exceed the registry ceiling or workspace budget.

#### Scenario: Designer limits too small

- **WHEN** the designer wrote 1,200 tokens and 2 steps for an agent that reads the CRM
- **THEN** the saved draft is raised to 8 steps and 4 model calls before freezing

### Requirement: Reservation gap

When even the smallest useful run's model reservations (each call at least 2,048 input tokens plus the full output, and their tariff) exceed the ceiling or the workspace run limit, the pipeline SHALL stop with `gap: model_reservation_too_large` and a `reservation` of the required and allowed tokens and cost. The card SHALL link administrators to Usage limits and keep Save and turn on for a new press.

#### Scenario: Workspace run limit too small

- **WHEN** the workspace allows 15,000 tokens per run and the model's maximum reply is 8,000 tokens for a two-call process
- **THEN** the pipeline stops with `model_reservation_too_large` reporting 20,096 required tokens

### Requirement: Generated test gap and resize

When the generated test cannot be built safely, the pipeline SHALL stop after freezing with a `gap` and the card SHALL link to the process page for a hand-written test. A `done` proposal whose active version has limits an ordinary run outgrows SHALL read `resize: true`; its next press SHALL save, freeze, test and activate a resized version and keep the overview item.

#### Scenario: Agent that writes by itself

- **WHEN** a proposal's agent step can write through its own tool call
- **THEN** the pipeline stops after freezing and the card asks the person to write its test in Processes
