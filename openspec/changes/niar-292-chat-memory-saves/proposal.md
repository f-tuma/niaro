# Proposal

Tracker: **NIAR-292** (chat memory saves)

## Why

In production (2026-11-04) the owner sent profile answers from a generated form with "Zapamatuj si tyto údaje o mně pro pracovní profil …" on several lines. A save passed only when the latest message started with "Zapamatuj si"/"Remember" and the model copied the rest verbatim, so:

- the model split the answers into facts and `memory_remember` refused twice (`memory_explicit_instruction_required`), yet the reply said "Uloženo do paměti …";
- the next message, "Zapamatuj si je prosím", saved the literal memory "je prosím" while the reply claimed the whole profile was saved;
- then the assistant said it has no access to the person's personal memory.

The owner considers personal memory not working at all, and wants the facts saved one per item into his profile (the pet's "About you").

## What Changes

- **Facts, in any phrasing.** `memory_remember` takes 1 to 10 facts (`text`, `kind` preference|fact|note). The model decides that the person wants them kept: the latest message asks to remember or save in any words, or answers questions the assistant asked to build the person's profile. "Zapamatuj si je" refers back to what the person wrote.
- **Person-text guard on the server.** Each fact must be in the person's own words of this conversation (their messages only, never a tool, service or assistant text): at least ⌊2n/3⌋ (and at least one) of its n content tokens match theirs by the memory token rule, every number exactly, request words ("zapamatuj", "prosím", "remember") not counted. Never-kept categories, secrets and instructions are refused per fact; exact duplicates come back `already_saved`; the rest is saved, with a status per fact.
- **Saved as the person's assertion.** Private, active, trust `user_assertion`, source `user_message` with the chat message's command and conversation; shown in About you on web and phone like other memories.
- **In place in the chat.** Under the reply: "Uloženo do paměti: …" / "Saved to memory: …" with Delete, on the web chat and the phone. No card, toast or failure state; the reply explains refusals.
- **No false claims.** The tool result lists what was saved and refused and why; the instructions say to report only saved facts. The reply checker runs when a save was tried or the reply says something was saved to memory, and gets the save results.
- **The assistant knows its memory.** Tool descriptions, instructions and the memory context say the personal memory is the person's profile ("About you"), which it can read and save to.

## Non-goals

- Forgetting stays the exact "Forget …" command; the in-chat Delete is the plain way to undo a save.
- Corrections stay the exact `Revise memory: "OLD" -> "NEW"` command.
- The learner (observed memories) and MCP saves are unchanged.

## Risk

- A fact paraphrased far from the person's words is refused (`not_from_person`); the model is told to keep their wording.
- The lexical guard cannot tell who first wrote words the person later typed or pasted themselves; pasted text is the person's.
- A save line needs the chat's conversation id on the memory; chats without one show no line.
