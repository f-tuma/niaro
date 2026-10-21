# Niaro: candidate for production testing

The candidate combines the mobile app, administration, native Mastra processes,
meeting records and human decisions. Passing isolated tests is preparation for a
controlled production test, not proof of a live provider effect or public release.

## Start the existing development profile

Set `SERVER_PROFILE` in the ignored root `.env`, or pass a profile explicitly:

```sh
pnpm server:check
pnpm server
# Alternatively:
pnpm exec tsx apps/reference-server/cli.ts start .servers/current.json
```

Run only one owner of that profile's data directory. The default profile supports
`pnpm server` without a path. `server:check` validates local configuration; it does
not test remote providers or their credentials. The development backend remains
on loopback behind the existing HTTPS proxy.

The mobile development client is independent:

```sh
pnpm start --tunnel
```

Use the development-client link printed by Expo. A JavaScript reload loads UI and
client fixes. Changes to native modules, permissions or dependencies require a new
Android/iOS binary. This work does not restart another person's Expo or server.

## Process authoring and execution

Open **Processes → Design a process**, or the process designer from a service.
A fresh designer opens on **Canvas**. Choose **Create a blank process** to select
the first step yourself, or **Design with an agent** and send a message. The first
Send creates its session automatically. It uses an available routing model by
default; no configured model shows a setup explanation. Manual authoring does not
require a model. **Conversation**, **Canvas** and **Review** are separate
views of the same versioned proposal. The canvas follows the n8n working pattern:
nodes drag freely and snap to the grid, and **Tidy up** lays them out again.
Hovering a connection shows **+** (insert a step there) and a delete control. Drag
from a node's right handle onto another node to reconnect it, or onto empty
canvas to choose a new step placed there; dragging the manual start's handle
changes the entry. An output that leads nowhere shows a **+** and blocks saving
until it is connected. Removing a node joins its predecessors to its single
successor. **Ctrl+Z** undoes graph changes. Scroll pans, Ctrl+scroll zooms.
Node positions are remembered in this browser, not in the process.

The step picker lists flow steps (agent, condition, result) and then services;
a service opens its actions grouped into reads and writes, with approval marked.
Typing searches every action across services; arrow keys and Enter choose.

The editor can create a workflow without a model call, rename/remove action,
agent, branch and return nodes, change connections, select models and allowed
service actions, and configure instructions and memory. Data bindings use declared
input/output fields and typed fixed values. Nested schemas and execution limits
remain behind advanced JSON controls; this is not yet a complete no-code schema
builder.
Use **Apply field** for each changed JSON field, then **Save changes for review**.
Local invalid edits survive inspector closes and view changes. A clean editor
adopts incoming revisions; a stale edited proposal retains its changes and blocks
save until an explicit discard/reload. An unresolved acknowledgement retains the original command for explicit retry,
including the initial session and first message. Reload and status checks do not
send it again. Authoring does not run service tools.

Review unresolved questions, assumptions, action policies, sources and validation.
Accepting the proposal saves an inactive draft. Configure qualification scenarios,
run the native test, inspect its report, and activate only the exact qualified
version. Updating a proposal never activates it. Check rollback separately.

From the mobile app, select the active process, supply its typed inputs and review
them. Human questions and guarded service writes each retain their own approval
boundary. Check both the recorded tool receipt and the actual service relation:
creating a CRM note alone does not prove attaching it to the requested person.

## Meetings and human work

On Android, record a short test meeting or import a disposable audio file. Stop and
process it, then inspect the complete original/cleaned transcript, compact summary
and consolidated human obligations/questions. Human Tasks represent work requiring
a person's decision, not every step performed by an agent.

Open a meeting task and choose a qualified process. Select which source information
to pass, review the prepared input, and continue through the process's existing
question/approval flow. Closed, changed or inaccessible meeting/task sources are
rejected before native admission. Automatic post-meeting triggers remain disabled
pending their separate physical acceptance.

The web mobile client currently reviews records and tasks; it does not record or
import audio. Native recording requires separate checks for screen lock,
backgrounding, interruption, pause/resume, force-stop recovery, storage limits and
long recordings. See [meeting operation and acceptance](meetings.md).

## Candidate verification

Use the committed tree with its lockfile and generated Storybook inventory:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm admin:build
```

The process browser regression uses an already installed Playwright runtime:

```sh
NIARO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs pnpm test:process-mobile-web
```

Browser fixtures exercise actual client/HTTP/UI behavior with synthetic providers,
not the production CRM. Real provider quality, deployed Mastra Memory, live CRM
read-back, signed distribution builds and matched backup/restore remain separate
acceptance evidence. History/receipt limits and retention still constrain sustained
public use; see [service catalog operating limits](service-catalog.md).
