## MODIFIED Requirements

### Requirement: Conversation context

The assistant SHALL keep the recent conversation of a chat (up to its last 40 messages) as context for that chat only. Semantic recall, embeddings of the conversation and model-managed working memory SHALL be off, so nothing said in one chat is recalled in another chat. Files the person sent MAY be found in another chat only through workspace knowledge, by that person (see `knowledge`).

#### Scenario: Another chat

- **WHEN** the person asks in a new chat about something said only in another chat
- **THEN** the assistant has no context from that other chat
