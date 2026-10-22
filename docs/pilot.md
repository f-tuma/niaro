# Pilot

Guide for administrators and testers of the first deployment in a company. The
target state and readiness criteria are in [goal.md](goal.md), deployment details
in [deployment.md](deployment.md).

## What we are testing

A company assistant in one place: an **Overview** with what matters for your day,
a **chat** with an agent that works in the company's services (CRM, Microsoft
365, …), **Tasks**, **Processes** (company and personal) and **Connections** for
your accounts. Server administration is separate and visible only to
administrators.

It is not a calendar, notes app or kanban board: those stay in the company's
services, and the agent reads and changes them there.

## 1. Installation (administrator, once)

1. A server with Docker, a domain and open ports 80/443.
2. Following [deployment.md](deployment.md#install-with-compose):
   `NIARO_PUBLIC_URL=https://assistant.example.com docker compose --profile https up -d --build`.
3. Right after the deploy, open `https://assistant.example.com/admin/` and
   create the organization and the owner account: on a new server the first
   person who signs up becomes the owner, so do it before anyone else can.
   You land signed in, with a first workspace named like the organization.
   For emergencies, `docker compose exec niaro niaro admin-rotate-key` prints
   a recovery key (**Use a recovery key** on the sign-in page).
4. Set up backups: `docker compose exec -T niaro niaro backup - > backup-$(date +%F).tar.gz`
   (daily, off the server). Try a restore once.

## 2. First setup (administrator)

The administration Overview shows a checklist; work through it from the top:

1. An **AI provider** with a key (for example OpenRouter, OpenAI).
2. A **model**, assigned to chat in _Model routing_.
3. **Usage limits** in _Enforce_ mode, with model prices. Without them the
   process designer and process tests do not work.
4. **Services**: add the CRM / Microsoft 365, load actions, turn on only the ones
   you want to use, and set who may use them and what needs approval.
5. **People**: invite testers (_Workspaces → Invite to workspace_). Without SMTP
   you get a link to send them yourself; it is valid for 48 hours and only once.

## 3. People

- Sign-in: `https://assistant.example.com/` → email and password (or company
  sign-in, if configured).
- Forgotten password: the administrator opens _People_ → the person's row →
  _Password reset link_.
- Account (`/me`): change password, devices and browser sign-ins, sign out
  everywhere. One account can have at most 8 mobile devices; browsers do not
  count toward the limit.
- Mobile app: signs in through the browser at the server address.
- Connections: services that need your own account (for example Microsoft 365)
  are connected in _Connections_.

## 4. What to try

Every tester goes through at least the following and notes what did not work or
was unclear:

1. **Overview**: add a card (_Edit overview → Add_, or tell the agent "add …
   to my overview"), refresh it, remove it.
2. **Chat — reading**: "Find company X in the CRM and show its contacts", "What
   meetings do I have today?".
3. **Chat — write with approval**: "Create a task for Alex: call the client
   tomorrow". Check the approval card, approve, verify the result in the
   service.
4. **Process offer**: when a matching process exists, the chat offers it; try
   both _Open process_ and _Without it_.
5. **Tasks**: open a task, _Resolve in chat_, mark it done.
6. **Personal process**: _Processes → New process_, describe it to the designer,
   adjust it on the canvas, create a version, test, activate and run it. Then
   delete it.
7. **Mobile**: sign-in, chat, tasks, starting a process.
8. **Administrator**: change permission for an action and see it take effect for
   a member immediately; remove a person from a workspace.

## 5. Reporting problems

For each problem, write:

- what you did and what you expected,
- the time (roughly is fine) and the page address (for example `/chat/chat-…`),
- a screenshot, if it is about appearance,
- whether it was the web or mobile app (and which browser / phone).

The administrator finds the run in _Loops_ and _Audit log_; the server log
contains no message contents or keys (`docker compose logs niaro`).

## 6. Known pilot limitations

- **One Microsoft (Google, GitHub) account belongs to one user.** A service with
  Microsoft sign-in connects only with an account that belongs to you; trying a
  foreign or test account ends with a message that the account already belongs
  to another user.

- **Concurrency**: each person has one agent run at a time (chat or process),
  plus an Overview refresh beside it. The whole server handles
  `NIARO_MAX_CONCURRENT_RUNS` runs at once (default 8); further ones get "try
  again in a moment".
- The **Overview** refreshes on open when a card is stale, or with the button; it
  does not refresh in the background. Cards from processes must be runnable
  without inputs.
- The web app does not yet have voice, editing of a meeting draft or detailed
  process outputs; the mobile app does not yet have the Overview.
- Deleting a personal process cannot be undone; a personal process cannot be
  converted into a company one.
- Inside the container, hosted MCP servers run without Docker as confined Node
  processes: npm definitions only (Microsoft 365 or a custom package), no images
  ([without Docker](self-hosting.md#without-docker)); other servers run as their
  own compose service ([hosted MCP servers](hosted-servers.md#own-compose-service)).
- Voice transcription and read-aloud do not count toward usage limits (they are
  billed by audio length).
- A workspace without a model set in the catalog uses the older simplified
  engine; for the pilot, always set a model (step 2.2).
