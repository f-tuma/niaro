# Proposal

Tracker: **NIAR-279** follow-up (the phone chat stays offline and stuck after the server errors or restarts mid-answer)

## Why

On the phone, a message was sent and the dev server was stopped about 1.5 s later. After the server came back the phone stayed "Offline · last known state" for good, even after backgrounding and a JS reload; the composer held the sent text again, and an older bundle still showed Stop.

Reproduced on the emulator and traced to three causes:

1. **The server failed every read for this person (the real deadlock).** The first message after an app launch carries `session: "new"`, so the server moves the main chat into a session archive `archived-N`. The attachment generation of the earlier session moves with it, so a native task of that session (one that read a service, or that failed) is now projected with `conversationId: "archived-N"`. `syncNativeWork` adds such a task's chat as a content-free reference through `ConversationHistory.shell`, which skipped session archives ("a session archive was never referenced"), so it threw `Unknown native public conversation`. Snapshot, events and commands all sync native work first, so every one answered `500 fixture_error`. The phone's back-off kept retrying correctly, but the server answered 500 until the archive's task left the task window. A server restart did not help. The phone showed "Failed at: Loading workspace data, HTTP 500". The kill was not needed: with the same state, sending alone wedged the account within seconds.
2. **The composer offered the sent text again.** When a send ended without a confirmed outcome (dropped connection, 5xx, model error), the session keeps the exact command for Retry and Dismiss. The phone and the web still put the text back into the composer because the store did not show the message. Pressing Send then (after Check result had already settled it) would have sent the request a second time.
3. **Stop while offline.** A request still on its way when the reads fail keeps `sending`. Stop was shown disabled (phone and web) though nothing could be stopped. The owner's screenshots with Stop next to Send came from a phone still running the bundle from before NIAR-279; after a reload the same state shows Check result and Dismiss.

## What Changes

- The server treats a session archive like any other archived chat: a retained task may reference it as an empty, read-only reference. Snapshot, events and commands work again, and an account already in this state recovers on the next poll with no data repair.
- A message whose send ended with the command kept (outcome unknown) stays out of the composer on the phone and the web. Check result (Retry of the exact command) settles it. Dismiss asks the server, and only a confirmed `not_running` puts the text back, as NIAR-279 defined. A send the server refused, or one never sent, still goes back into the composer at once (NIAR-264).
- Stop (and Esc on the web) is offered only while the request runs and the client is online. Offline, the phone shows the sending spinner.

## Non-goals

- Changing the client's reconnect or back-off: it already retried every 1–30 s and at once on returning to the foreground. Tests now pin that behaviour.
- Making `syncNativeWork` skip unknown chats instead of failing. A single unknown reference still fails every read for that person; see Risk.
- The card copy ("Status unavailable. It won't be resent." next to "Check result", which re-posts the identical command) is unchanged.

## Risk

- `syncNativeWork` still fails closed on a task whose chat is unknown in every way. Any other path to such a reference would wedge the person's reads the same way. This is reported, not changed here.
- A session archive now appears in the snapshot as an empty read-only conversation while its task is retained, as archived and deleted chats already do.
