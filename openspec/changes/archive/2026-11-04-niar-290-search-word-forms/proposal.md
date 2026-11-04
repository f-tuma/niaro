## Why

A live MCP test (NIAR-289) showed that searching meetings for "zakázka" found nothing while "zakázky" found the meeting: meeting search matched only the exact string. Chats, tasks and memory already match word forms; meetings did not.

## What Changes

- Meeting search first matches the exact phrase, then meetings holding every query word by its stem (accents and case folded, stop words dropped, words of five or more letters cut to their first five, the rule saved memory uses).
- Exact phrase matches stay first. The web list, the chat agent's `meeting_search` and MCP `niaro_search` all use it.

## Impact

- `apps/server-identity/meeting-store.ts`; tests in `tests/meeting-workspace.node.ts` and `tests/mcp-router-http.node.ts`.
