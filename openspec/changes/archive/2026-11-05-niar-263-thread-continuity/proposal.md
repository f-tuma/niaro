# Proposal

Tracker: **NIAR-263**

## Why

In a chat the model often did not know its own previous replies or what it looked up a turn ago ("Zkus to ještě jednou" after a save answered "I don't see the data"). A turn continues the chat's native thread only when the thread's memory pin is still valid, and that pin was the workspace-wide memory version: any memory change by anyone in the workspace advanced it. The pet's profile learner observes every chat within a minute and advances it, so nearly every next turn started a fresh thread that saw only the person's last eight messages, none of the assistant's replies and no earlier service results. Saves, other members' memory and organisation policy changes did the same, and a retry of a failed turn always started afresh.

## What Changes

- **Used items pinned.** A thread's memory pin records the ids of the saved items and observations that reached the model. A later turn may continue it when nothing changed since, or when every recorded item is still active, unchanged, unexpired and readable by the person. Additions, learner observations, items the thread never used and other people's memory no longer matter.
- **Own words exempt.** A fact saved from the person's words in this chat is not recorded, so deleting the save under the reply keeps the thread; the words stay in the chat anyway.
- **Own changes.** A memory change the chat itself makes keeps the recorded items, minus the item it retired, as before.
- **Policy.** An organisation policy change rotates the thread only when it used a service result; a thread without one continues under the new policy.
- **Retry.** A retry of a failed turn continues the chat's thread; the failed attempt is an earlier turn whose calls collapse into a note.
- **Diagnosable.** When a turn of the same chat starts a fresh thread, the operator log records one `native_thread_fresh` line with the reason (no personal data).

## Non-goals

- Pending approvals and runs keep the exact memory version check (`Memory change invalidates pending work`); a memory change during a turn still stops it as before.
- The provider history projection is unchanged. An earlier answer built on private service or memory data is still withheld; see design D5 for why this is now the main remaining cause of lost replies.
- A fresh thread still gets only the person's own earlier messages, not the assistant's.

## Risk

- An item id that stays active keeps the words the model saw: the store changes content only under a new id (a correction or a rewritten observation supersedes its row; a learner refresh or a personal/not personal mark keeps id and content). A future in-place content edit would break this and must supersede instead.
- Pins written before this change carry no item list and keep the exact version check until the chat's next fresh thread.
