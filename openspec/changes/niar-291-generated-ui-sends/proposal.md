# Proposal

Tracker: **NIAR-291**

## Why

Seen in production on 2026-11-04: when the assistant asks with a generated form or buttons and the person presses the submit button ("Odeslat odpovědi"), the answer only lands in the composer for review and the person has to send it a second time. The owner decided that a pressed follow-up is sent at once. Until now this was deliberate ("Follow-up actions send nothing").

## What Changes

- On the web and the phone, a `@ToAssistant` step, a button without an action and a form's button send their message at once, through the same path as a typed message: the same busy, offline and read-only rules, idempotent delivery, and a message that does not go through stays in the chat as failed with Try again.
- The message shows as the person's own message: the button's words, then each answered field as `Label: value`. Hidden `context` is still never sent.
- The composer is left alone: its draft, reply and attached task stay; nothing is put into it. Files waiting in the composer go only with a typed message, so follow-ups wait while there are any.
- Each form, or button outside a form, sends once: afterwards its controls are disabled. A double press, or two `@ToAssistant` steps in one press, send one message. A follow-up the chat did not take leaves the form usable.
- While the chat cannot send (offline, an answer running, archived), follow-up buttons are disabled as Send is; fields still take answers, and links and local steps still work.
- The model's instructions say a pressed follow-up is sent as the person's message.

## Non-goals

- Remembering an answered form across reloads: the used state is local to the shown answer.
- Changing what a follow-up says (`followUpMessage` is unchanged).
