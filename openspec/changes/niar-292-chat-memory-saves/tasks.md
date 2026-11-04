# Tasks

## 1. Saving facts

- [x] 1.1 `memory_remember` takes 1–10 facts; descriptions say when to save, one fact per item, the person's words, report only saved facts, and that the memory is the profile ("About you").
- [x] 1.2 Memory capability saves per fact: retry, never-kept/secret/instruction refusal, person-text guard, duplicates, opt-out and capacity; `user_message` source with the visible command id.
- [x] 1.3 `supportedByPerson` and `profileTextRefusal`; the native and legacy runtimes pass the person's own messages.

## 2. Honest replies

- [x] 2.1 Memory instructions and context name the profile; never claim no access.
- [x] 2.2 The reply checker runs on a save or a save claim and gets the save results.

## 3. In the chat

- [x] 3.1 Pet memory query filter `conversationId`; a chat save notifies the pet stream.
- [x] 3.2 Web chat and phone: "Saved to memory: …" with Delete under the reply.

## 4. Verification

- [x] 4.1 Node: form answers, "zapamatuj si je", tool-result injection, never-kept and secret, duplicates and retry, opt-out, guard threshold.
- [x] 4.2 Jest: the save line and Delete on web and phone.
