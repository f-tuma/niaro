## ADDED Requirements

### Requirement: Exporting own memory

`GET …/memory/export` SHALL return the person's own private memories and observations in the workspace, decrypted for them, as Markdown or JSON attachment, with kind, section, status and dates but no source digests. Shared notes and other people's entries SHALL never be included.

#### Scenario: Member exports

- **WHEN** a member exports while the owner has private and shared notes
- **THEN** the file lists only the member's own memories

### Requirement: Memory export in the web app

The About you page and the memory page SHALL offer Export as Markdown and Export as JSON in their `…` menu as plain download links.

#### Scenario: Export from the memory page

- **WHEN** the person chooses Export as JSON on `/me/memory`
- **THEN** the browser saves `memory-<date>.json`
