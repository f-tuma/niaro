# chat-search Specification

## Purpose

Chat search lets a person find their own earlier chats and messages by words, in the web app and the mobile app, without exposing anything outside their own scope.

## Requirements

### Requirement: What chat search finds

The system SHALL search the person's own chats with `GET search?profile=agent-chat-search/1&q=…`: chat names, the person's messages and the assistant's final answer of each turn, never tool outputs, card data, process journals or private transcripts. Deleted chats SHALL never appear and the scope SHALL be the authenticated person.

#### Scenario: Deleted chat

- **WHEN** the person searches a word that appeared only in a deleted chat
- **THEN** no result is returned

### Requirement: Search matching

All query words SHALL be required, ignoring case and accents; the last word SHALL match as a prefix and `"quoted words"` SHALL match as a phrase. Query syntax SHALL never be passed to the database.

#### Scenario: Accent-insensitive search

- **WHEN** the person searches `schuzka`
- **THEN** a chat containing "Schůzka" is found

### Requirement: Search parameters

Search SHALL accept, each at most once, `q` (trimmed, 1–200 characters), `after`, `limit` (1–20, default 10), `include=archived`, `state=archived` and `role=user|assistant`; anything else SHALL be `400` and a wrong profile `406`. An older server without search SHALL answer `404`, and the apps SHALL then search the loaded chats' names.

#### Scenario: Invalid parameter

- **WHEN** a client sends `GET search` with an unknown parameter or an empty `q`
- **THEN** the server answers `400`

### Requirement: Search results

Each result SHALL be one chat (`id`, `title`, `updatedAt`, `archived`) with title ranges, up to three best matches (plain-text snippets with ordered `[start, end)` ranges) and `matchCount`, ranked by relevance with more matching messages, a matching name and recent changes ranked higher. Clients SHALL render ranges themselves and never treat results as markup.

#### Scenario: Highlight

- **WHEN** a snippet contains `<b>` text from a message
- **THEN** the client shows it as text and highlights only the server's ranges

### Requirement: Search rate limit

The system SHALL allow at most 40 searches per 10 seconds per person and SHALL rank at most 4,000 matching messages per search.

#### Scenario: Too many searches

- **WHEN** a person sends a 41st search within 10 seconds
- **THEN** the server answers `429 chat_search_rate_limited`

### Requirement: Search screen

The web app SHALL offer search at `/search` (sidebar **Search**, Ctrl/Cmd+K) and the mobile app in its drawer. Without words it SHALL list recent chats by day; typing SHALL search 200 ms after the last key on the web and 250 ms on the phone with chips **All**, **My questions**, **Answers** and **Archived**, and under **All** matching meetings SHALL follow as their own group on both clients.

#### Scenario: Meetings group

- **WHEN** the person's words also match a meeting under **All**
- **THEN** the meeting appears in a separate **Meetings** group after the chats

#### Scenario: Meeting from the phone

- **WHEN** the person opens a meeting from the **Meetings** group in the mobile app
- **THEN** the meeting's record opens in Meetings

### Requirement: Opening a search result

A search result SHALL open the chat at the found message: the web at `/chat/:id?m=<messageId>`, the mobile app in the chat screen. The chat SHALL load older pages until that message shows, scroll it into view and outline it briefly.

#### Scenario: Open an old message

- **WHEN** the person opens a search result from an old message
- **THEN** the chat loads until that message is visible and highlights it

#### Scenario: Open an old message on the phone

- **WHEN** the person opens, in the mobile app, a search result whose message is two pages back
- **THEN** the chat reads the older pages, shows that message and outlines it
