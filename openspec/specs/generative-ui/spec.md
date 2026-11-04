# generative-ui Specification

## Purpose

Generated UI lets an assistant answer carry one visual (tables, charts, metrics, schedules, short forms) beside its text, rendered by the web app and the phone with their own design system, while the server keeps it presentation-only; it also covers the server's own passive cards.

## Requirements

### Requirement: Output contract

An assistant answer SHALL be Markdown text with at most one OpenUI Lang program in a fenced ` ```openui-lang ` block. The server SHALL split the text from the first such fence, drop any further programs, and accept a reply that is only a bare program. The model SHALL be asked for UI only where a visual helps, beside one or two sentences of text, using only facts from the current turn's results, in the person's language, and as a complete program each time.

#### Scenario: Two programs

- **WHEN** the model writes two `openui-lang` fences in one answer
- **THEN** only the first program is considered and the second is dropped

#### Scenario: Program without text

- **WHEN** the model writes only an admitted program
- **THEN** the program's first heading (or a generic overview sentence) becomes the answer's text

### Requirement: Presentation only

A generated program SHALL grant no permission, run no service action and fetch no data. Approvals, questions with options, sign-in cards, process offers, skill and process drafts and hub widgets SHALL remain system UI and SHALL never carry a generated program.

#### Scenario: Approval answer

- **WHEN** a turn ends waiting for approval of a write
- **THEN** the answer carries the approval card and no generated program

### Requirement: Server admission

Before a program is checked, stored or delivered, the server SHALL parse it against the shared component library and return a normalized program or refuse it. Unknown components, invalid statements, wrong arguments and components placed where their parent does not accept them SHALL be dropped. Strings and arrays longer than the library allows SHALL be cut to the limit (for example 50 table rows, 8 columns, 6 series, 2,000 characters of text).

#### Scenario: Unknown component

- **WHEN** a program uses a component the library does not define
- **THEN** that component is dropped and the rest of the program is kept

#### Scenario: Long table

- **WHEN** a program's table has 80 rows
- **THEN** the admitted program keeps the first 50

### Requirement: Whole-program refusal

The server SHALL refuse a whole program that contains `Query` or `Mutation` statements, is longer than 16,000 characters, has more than 64 components, more than 12 actions or more than 8 levels of nesting, lacks `root = Stack(...)`, or shows nothing.

#### Scenario: Data fetching

- **WHEN** a program declares a `Query`
- **THEN** the whole program is refused

#### Scenario: Too many components

- **WHEN** a program renders more than 64 components
- **THEN** the whole program is refused

### Requirement: One repair round

A refused program SHALL be sent back to the model once with the reasons, asking it to fix the program or leave it out. If the next answer is refused again, the server SHALL publish the text without UI.

#### Scenario: Second refusal

- **WHEN** the repaired answer's program is refused again
- **THEN** the answer is stored with its text and without a program

### Requirement: Allowed actions

A program's actions SHALL be limited to `@ToAssistant(message)` with a message of at most 500 characters, `@OpenUrl(url)` and `Link(label, url)` with a literal http(s) address that passes the link check, and local UI state (`@Set`, `@Reset`, `$variables`, ternaries). Any other step SHALL drop the control or value that uses it, and a `Link` or `@OpenUrl` without a valid address SHALL be dropped.

#### Scenario: Unsafe link

- **WHEN** a program's button opens `javascript:alert(1)`
- **THEN** the button is dropped from the admitted program

### Requirement: Follow-up actions send at once

A `@ToAssistant` action, a button without an action and a `Form`'s button SHALL send the message at once as the person's own message, as a typed one is sent; the composer's draft SHALL stay. A `Form` SHALL add its answered fields as `Label: value` lines; hidden `context` is never sent. Only the chat's latest reply SHALL send follow-ups, each form or button once, and none while the chat cannot send. `@OpenUrl` and `Link` SHALL open only an http(s) address checked again on the client.

#### Scenario: Form follow-up

- **WHEN** the person fills a generated form and presses its button
- **THEN** a message with the button's words and one `Label: value` line per answered field is sent at once and shown as the person's own message
- **AND** whatever the person had typed in the composer stays there

#### Scenario: Second press

- **WHEN** the person presses the button of a form that has already sent its answers
- **THEN** nothing more is sent and the form's fields and buttons no longer act

#### Scenario: Reply already answered

- **WHEN** a message of the person follows a reply with buttons, for example the other choice of a Yes/No pair, also after the chat is reopened
- **THEN** that reply's follow-up buttons no longer act and nothing is sent

#### Scenario: Chat cannot send

- **WHEN** the chat is offline or an answer is still running
- **THEN** the follow-up buttons wait as Send does, and nothing is dropped or put into the composer

### Requirement: Checker sees the UI

When an answer is checked for consistency (see `agent-runtime`), the program's readable strings SHALL be checked together with the text; a rejection SHALL discard the UI with the reply. A failed, unknown or partly refused write SHALL be explained in text alone.

#### Scenario: Unsupported claim in UI

- **WHEN** the checker rejects an answer whose table claims a write succeeded that has no receipt
- **THEN** the UI is discarded with the reply and the model must answer again

### Requirement: Storage and negotiation

The admitted program SHALL be stored on the assistant message as `ui: {type: "openui.program", version: 1, library: "niaro-ui@1", program}` beside any service result, and the text SHALL remain a complete answer used for voice, search and memory. Clients SHALL receive `ui` only when they ask with `ui=agent-openui/1` on `snapshot`, `events`, `commands` or `conversations/messages`; other clients SHALL receive the message text alone.

#### Scenario: Client without UI support

- **WHEN** a client reads a snapshot without `ui=agent-openui/1`
- **THEN** its assistant messages carry no `ui` field and keep their full text

### Requirement: Component library

The system SHALL define the component library once and use it for the prompt, server admission and both renderers, so names and arguments cannot drift between server and clients. Images SHALL NOT be part of the library.

#### Scenario: Detail link

- **WHEN** a `Detail` value is a complete email address, phone number or https URL
- **THEN** it is rendered as a link

### Requirement: Library components

The library SHALL contain layout `Stack` (root), `Row`, `Grid`, `Section`, `Tabs`/`Tab`, `Accordion`/`AccordionItem`, `Separator`; content `Heading`, `Text`, `Markdown`, `Callout`, `Badge`, `Link`; data `Metric`, `Details`/`Detail`, `List`/`ListItem`, `Table`, `Progress`, `Timeline`/`TimelineItem`; charts `BarChart`, `LineChart`, `PieChart`, `Series`; and actions and forms `Button`, `Buttons`, `Form`, `TextField`, `Select`, `Checkbox`, `DateField`.

#### Scenario: Image requested

- **WHEN** the model writes an `Image(...)` component
- **THEN** it is dropped as an unknown component

### Requirement: Safe rendering

Both renderers SHALL treat model and service text as text (escaped), and `Markdown` SHALL use the same safe renderer as chat replies. A renderer SHALL drop anything outside the library.

#### Scenario: Markup in text

- **WHEN** a `Text` value contains HTML tags
- **THEN** the tags are shown as text and nothing is executed

### Requirement: Web and phone renderers

The web app SHALL render a program in the chat as the `niaro.openui` part with its design system, light and dark; the phone SHALL render the same component names with its native UI kit and charts. Read-only (archived) chats SHALL show the UI without actions.

#### Scenario: Archived chat

- **WHEN** the person views an answer with a form in an archived chat
- **THEN** the form is shown and its controls do nothing

### Requirement: Streaming draft rendering

While the model writes, both clients SHALL render the draft's program as it arrives (each complete statement), inert: buttons, fields and links in a draft SHALL do nothing. A draft program is not admitted and SHALL never be stored; the stored message SHALL replace it, and a draft that was sent back SHALL simply disappear.

#### Scenario: Button in a draft

- **WHEN** the person clicks a button of a program still being written
- **THEN** nothing happens

### Requirement: UI in later turns

The program SHALL stay in the model's history as the assistant's own text, so a follow-up can change it ("make it a pie chart"), except that an earlier answer that used private service or memory data SHALL be withheld from later turns, program included (see `agent-runtime`).

#### Scenario: Change the chart

- **WHEN** the person asks to show the previous answer's bar chart as a pie chart and that answer used no private data
- **THEN** the model sees its earlier program and writes a new complete program

### Requirement: Legacy composed cards

Messages stored with a model-composed card (`result.type: "card.document"`) SHALL render as text: the message, then the card's title and text. The `card.respond` command SHALL NOT exist: a server SHALL refuse it as an invalid command, and no client shows a stored card's controls.

#### Scenario: Old card form

- **WHEN** a client sends `card.respond`
- **THEN** the server refuses it as an invalid command

### Requirement: Server passive cards

The server SHALL build passive cards for service results and work summaries deterministically, never from model output, delivered as `ServiceResult.card` and `WorkItem.card` only to clients that ask with `cards=agent-card/1` on `snapshot`, `events`, `commands` and `server`. Unnegotiated responses SHALL omit them and keep the ordinary text and workflow entities.

#### Scenario: Client without cards

- **WHEN** a client reads a snapshot without `cards=agent-card/1`
- **THEN** work items and service results arrive without `card` fields

### Requirement: No external OpenUI services

The system SHALL use OpenUI locally only: no OpenUI cloud, gateway or telemetry, no code loaded from a CDN, and models called only through the configured providers (see `models-and-providers`).

#### Scenario: Rendering offline

- **WHEN** a generated answer is rendered on a server without internet access
- **THEN** it renders fully and no request leaves the server or the browser for OpenUI
