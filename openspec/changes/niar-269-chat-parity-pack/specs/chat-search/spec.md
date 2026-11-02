## MODIFIED Requirements

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
