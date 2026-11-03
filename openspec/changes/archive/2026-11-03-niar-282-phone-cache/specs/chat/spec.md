# Spec Delta

## ADDED Requirements

### Requirement: Phone list cache

The mobile app SHALL keep on the device only the last server answer of its lists: the menu's chats (newest 200), the first page of each Tasks tab (50 each), meetings (50) and the services in **Where Niaro reads** (100), at most 256 KB per list. It SHALL NOT keep credentials, unsent drafts or commands there. A server answer SHALL always replace the stored list.

#### Scenario: More chats than kept

- **WHEN** the person has 300 active chats
- **THEN** the phone keeps the newest 200 and the menu still lists all 300 once the server has answered

### Requirement: Phone lists belong to one identity

Stored lists SHALL belong to the signed-in person on one server and workspace. Signing out, an expired sign-in and signing in as another person or to another server SHALL remove every stored list of the previous identity. A stored list SHALL carry a version and SHALL be removed instead of shown when it no longer matches what the app reads.

#### Scenario: Signing out

- **WHEN** the person signs out in the app
- **THEN** no list of theirs remains on the device and the next person to sign in sees none of it

#### Scenario: Another server

- **WHEN** the person signs in to another server
- **THEN** the lists kept for the previous server are removed and the new server's lists are read

#### Scenario: App updated with a new list shape

- **WHEN** a stored list no longer matches what the app reads
- **THEN** it is removed and the screen waits for the server as on a first start

### Requirement: Chat list shows at once on the phone

The phone's menu SHALL show the last known chats as soon as it opens, from this session or from the device after a start, without a loading message over them, and SHALL replace them with the server's answer when it arrives. A failed read SHALL keep the last known chats with the failure notice.

#### Scenario: After the app starts

- **WHEN** the app starts and the person opens the menu before the server answers
- **THEN** the chats from the last run are shown and no loading message appears

#### Scenario: Offline

- **WHEN** the person opens the menu without a connection
- **THEN** the last known chats are shown with the failure notice and nothing else changes

### Requirement: Chat list read only after a change

The phone's menu SHALL read the chat list from the server again only when the events cursor has moved, the directory version has changed, two minutes have passed since the last answer in this session, the person pulls to refresh, or the person presses **Refresh** after a failure. While the menu is open a directory change SHALL re-read it.

#### Scenario: Re-opening the menu

- **WHEN** the person closes the menu and opens it again a minute later with no new message or change in between
- **THEN** the chats are there at once and the app does not read the chat list from the server

#### Scenario: After a message

- **WHEN** the person sent a message and opens the menu
- **THEN** the last known chats show at once and are replaced quietly when the server's list arrives
