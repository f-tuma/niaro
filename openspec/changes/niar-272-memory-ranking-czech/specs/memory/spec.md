## ADDED Requirements

### Requirement: Lexical memory ranking

Memory search SHALL rank the records it may return by a deterministic BM25 score (k1 = 1.2, b = 0.75) over accent- and case-folded tokens of at least two characters, leaving out a Czech and English stop list, where two tokens match when they are equal, share their first five characters, or the shorter has at least four characters and starts the longer. Preferences SHALL come first; other records SHALL need a score above zero; ties SHALL fall back to the newer update and then the record id. The score SHALL be computed per request over the plaintext already decrypted for it, and no plaintext index or token list SHALL be stored.

#### Scenario: Czech inflection

- **WHEN** the person asks about "schůzku" and a memory says "Schůzka s klientem je ve čtvrtek"
- **THEN** that memory is recalled

#### Scenario: Short words

- **WHEN** the query contains "CR" and a memory mentions "CRM"
- **THEN** the memory is not recalled by that word

#### Scenario: Same order every time

- **WHEN** the same query runs twice over the same memories
- **THEN** the same records come back in the same order

#### Scenario: Nothing new on disk

- **WHEN** a memory has been searched
- **THEN** the identity database still holds its text only in the encrypted payload

### Requirement: Never-kept categories are shown

The learner's never-kept categories SHALL be a fixed, documented list: health, ethnic origin, political opinions, religious or philosophical beliefs, trade union membership, sex life or sexual orientation, biometric or genetic data, passwords and keys, and account, card and birth numbers. Pet's About you on web and phone SHALL list them in a closed disclosure, EN and CS, without promising that every mention is caught, and SHALL point to Delete.

#### Scenario: Owner reads the boundary

- **WHEN** the owner opens About you and expands "What Niaro never learns"
- **THEN** the page lists the categories and says to delete anything that slipped through

#### Scenario: Health mention

- **WHEN** the learner proposes the observation "Has diabetes"
- **THEN** it is not kept
