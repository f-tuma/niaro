# Niaro: product brief

## What it is

A self-hosted assistant for companies: one place where a person talks to an
agent that works with the company's services (CRM, Microsoft 365, MCP services,
plugins) and sees what matters for their day. It helps executives and teams
unify facts and act on them. It is informative first and interactive through
chat.

It is **not** an everything-app: no own calendar, notes, kanban or documents.
Those stay in the company's services, and the agent reads and changes them
there.

## Who uses it

- **Members** chat with the agent, keep a personal Overview, resolve Tasks,
  record Meetings, run company processes and design their own, and sign in to
  the services that need their own account.
- **Administrators and owners** run the server: providers and models, usage
  limits, services and actions, people and workspaces, sign-in methods,
  external AI apps, plugins, activity log and runs.
- **Operators** install one container image with one data volume behind HTTPS
  and keep backups.

## Shape

- One server image: app API, web app at `/`, administration at `/admin`
  (owners and administrators only), the Mastra runtime and storage. The
  mobile app is a harness over the same API.
- The server holds authority, scopes, the inference budget, durable receipts
  and explicit approval for every external effect. Clients render what the
  server decides.
- Every model and agent operation runs on Mastra and through the budget
  ledger; speech is billed per audio and stays outside the ledger.

## Where things are

- Current behavior: [`openspec/specs/`](../openspec/specs/), one capability per
  folder.
- Proposed changes: [`openspec/changes/`](../openspec/changes/).
- Lasting decisions: [architecture.md](architecture.md).
- How-to: [guides](guides/).
- Visual design: [ui-system.md](ui-system.md) and
  [apps/server-admin/DESIGN.md](../apps/server-admin/DESIGN.md).
- Work tracking: Itsaplan project NIAR; issue keys (`NIAR-123`) prefix commit
  messages.

## Stage

Pilot in a real company. Breaking changes are allowed: old mobile builds and
old data formats need no compatibility unless a change says otherwise.

## Not in scope now

Voice in the web app, a process output inspector on the web, promotion of
personal processes to company processes, retiring company processes,
billing speech in the ledger, a native mobile Overview, a published image or
high availability.
