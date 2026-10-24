# Product goal and pilot readiness

Agreed with the owner on 2026-10-16. This is the target state and the bar for
starting tests in a real company environment ("pilot"). Each item names how it
is verified; an item is done only when its check passes.

## 1. What the product is

A self-hosted assistant for companies: one place where a person talks to an
agent that works with the company's services (CRM, Microsoft 365, …) and sees
what matters for their day. It helps executives and teams unify facts and act on
them. It is informative first and interactive through chat. It is **not** an
everything-app: no own calendar, notes, kanban or documents; those stay in the
company's services and the agent reads and changes them there.

## 2. Target state

### 2.1 One application, one image

- One container image runs the whole server: app API, web app, administration,
  Mastra runtime and storage. Data lives in one mounted volume.
- The server's address opens the **web app**. Administration is a section of the
  same app at `/admin`, shown in the menu only to organization owners and
  administrators. The mobile app talks to the same server.
- Verify: `docker compose up` on a clean machine with the example config gives a
  working instance behind HTTPS (reverse proxy example); health check passes.

### 2.2 Roles

|                                                                            | Member                | Administrator / owner   |
| -------------------------------------------------------------------------- | --------------------- | ----------------------- |
| Chat, hub, tasks, connections                                              | yes                   | yes                     |
| Own personal processes (design, test, activate)                            | yes                   | yes                     |
| Start company processes                                                    | yes, under own grants | yes                     |
| Providers, models, limits, services, actions, access                       | no                    | yes                     |
| People, invitations, workspaces, roles                                     | no                    | yes (owner for members) |
| External AI apps, built-in tools, activity log, runs, installed connectors | no                    | yes                     |

Verify: authorization tests per row; members get 403/404 on admin APIs.

### 2.3 Web app (people)

- **Overview** (`/`, where the app opens): the person's own dashboard, informative
  first, laid out like a TwentyCRM dashboard but one per person.
  - Built-in "Tasks": the person's open tasks.
  - Widgets the person chose, each backed by a process (personal or company)
    that produces a result: e.g. "My day" (today's meetings and deadlines
    from Microsoft 365), "Companies in the CRM", "Opportunities by stage".
    Each widget shows its result as a number, chart, list, table, text or
    summary, chosen from the process's output schema. Results show when they
    were produced; refresh on demand and when stale.
  - The person shapes it directly (edit mode: move, resize, set up a view,
    add, remove) or by talking to the agent ("put a chart of opportunities by
    stage on my overview", "remove…"). The agent can only add processes
    the person can run and nothing it adds runs until the person refreshes it.
  - "Ask the assistant…" hands a question to a new chat.
- **New chat** (`/chat`): an empty chat; its first message gives it its
  address.
- **Chat** (`/chat/:id`): agent with Mastra, tools from the person's allowed
  services, approvals, cards, process offers, history.
- **Tasks**, **Processes** (start, personal design and lifecycle),
  **Connections** (personal sign-ins), **Account** (name, language, theme,
  password, devices and sessions with revoke, sign out).
- Verify: jest + live browser walkthrough at 1440 px and 390 px as a member and
  as an admin.

### 2.4 Administration

Everything server-wide: providers, models, routing, usage limits (enforce mode
with prices), services and actions, access, sign-in methods, people and
invitations, workspaces, MCP, plugins, audit, runs. A first-run checklist on the
overview leads an administrator through the minimum setup.

### 2.5 Engine

Mastra is the core of every model and agent operation (chat, designer, process
agent steps, meetings, catalog enrichment); every inference call goes through
the budget ledger. Known exceptions are documented: voice transcription and
speech (billed per audio, not tokens), and the legacy engine reachable only for
workspaces without a catalog model.

## 3. Pilot readiness checklist

The pilot can start when all of these pass.

**Install and operate**

1. Image builds reproducibly; `compose` example with a data volume and a Caddy
   HTTPS example; `/healthz` for orchestration.
2. First run: the owner account is created from the console (setup flow) with
   the admin key printed once in the logs; documented.
3. Backup and restore: a script stops writes or uses SQLite online backup for
   every database (identity, workflow, Mastra) and restores into a new volume;
   restore tested.
4. Upgrade: starting a newer image on an old volume migrates in place; tested
   from the current dev data copy.
5. Logs: structured enough to diagnose (requests, failures, model calls), no
   secrets or private content.

**People can get in** 6. Invitations work with SMTP and without it (the administrator copies an
invitation link). 7. Forgotten password: an administrator issues a one-time reset link (copy or
email); a person can change their own password. 8. A person sees their devices and web sessions and can revoke them; the
device limit tells them what to do.

**It is usable for real work** 9. Admin first-run checklist: provider → model → budget enforce with prices →
service and actions → invite people. 10. Members see when the AI budget is not set up before they try to design or
test, with one line telling them to ask an administrator. 11. Personal processes can be deleted (archived) by their owner. 12. Hub MVP as in 2.3, with at least the built-in tasks item and process-backed
items, managed by chat and directly.

**Quality bar** 13. All suites green: lint, typecheck, boundaries, jest, `test:identity`,
`test:agent`, `test:mcp`. 14. Automated smoke test against a fresh container: bootstrap owner, invite a
member, member signs in to the web app, chats (fixture model), opens tasks,
processes, connections and hub; admin opens administration. 15. Security review of everything added in this phase (web session credential,
personal processes, sign-in list, invitation and reset links, hub API):
findings fixed or recorded. 16. Pilot guide (`docs/pilot.md`): install, first setup, onboarding people,
what to test, how to report problems, known limitations.

## 4. Out of scope for the pilot

Voice in the web app, meeting proposal editing on the web, process output
inspector on the web, promotion of personal processes to company processes,
retiring the legacy engine, billing voice usage in the ledger, a
native mobile hub.

## 5. Status — 2026-10-17

All checklist items pass; the pilot can start.

| #   | Item                                    | Verified by                                                                                               |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Image, compose, Caddy HTTPS, `/healthz` | `Dockerfile`, `compose.yml`; built and run, HTTPS through Caddy ([deployment.md](deployment.md))          |
| 2   | First run                               | first sign-up becomes the owner, no key; `tests/deployment.node.ts`, `tests/identity.node.ts`, smoke      |
| 3   | Backup and restore                      | `niaro backup` / `restore`, online SQLite backup + integrity check; round trip tested                     |
| 4   | Upgrade                                 | new image on a copy of the dev data: migrated, counts unchanged, integrity ok                             |
| 5   | Logs                                    | structured access / model-call lines without secrets or content; smoke checks the log                     |
| 6   | Invitations without SMTP                | copyable link; `tests/account-security.node.ts`, smoke                                                    |
| 7   | Passwords                               | own change, admin reset link; `tests/account-security.node.ts`                                            |
| 8   | Devices and sessions                    | `/me` with revoke incl. MCP grants; web chat outside device slots                                         |
| 9   | Admin checklist                         | console overview; `tests/setup-checklist.test.ts`, smoke                                                  |
| 10  | Budget readiness for members            | `budgetReady` in designer capabilities                                                                    |
| 11  | Delete personal processes               | archive command; `tests/process-archive-client.node.ts`                                                   |
| 12  | Hub MVP                                 | [hub.md](hub.md); `tests/hub*.node.ts`, `tests/web-hub.test.tsx`, smoke                                   |
| 13  | All suites green                        | lint, typecheck, boundaries, jest 1933/1933, identity 1712/1712, agent 442/442, MCP 58/58, deployment 6/6 |
| 14  | Smoke test on a fresh container         | `npm run smoke`: 32/32 incl. browser, hardened container                                                  |
| 15  | Security review                         | 0 critical/high; 3 medium and 12 low fixed with tests                                                     |
| 16  | Pilot guide                             | [pilot.md](pilot.md)                                                                                      |
