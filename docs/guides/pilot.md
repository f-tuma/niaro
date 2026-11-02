# Pilot

Guide for administrators and testers of the first deployment in a company.
Installation details are in [deployment](deployment.md), setup in
[administration](administration.md), and current behavior in
[`openspec/specs`](../../openspec/specs).

## What we are testing

A company assistant in one place: an **Overview** with what matters for your
day, a **chat** with an agent that works in the company's services (CRM,
Microsoft 365, …), **Tasks**, **Meetings**, **Processes** (company and
personal) and **Connections** for your own accounts. Administration is
separate and visible only to owners and administrators.

It is not a calendar, notes app or kanban board: those stay in the company's
services, and the agent reads and changes them there.

## 1. Installation (administrator, once)

1. A server with Docker, a domain and open ports 80 and 443.
2. Start it ([deployment](deployment.md#production-behind-https-caddy)):

   ```sh
   NIARO_PUBLIC_URL=https://assistant.example.com docker compose --profile https up -d --build
   ```

3. Right away open `https://assistant.example.com/admin/` and create the
   organization and the owner. The first person who signs up becomes the
   owner, so do it before anyone else can.
4. For emergencies, get a recovery key and keep it safe:

   ```sh
   docker compose exec niaro niaro admin-rotate-key
   ```

   It works with **Use a recovery key** on the sign-in page.

5. Set up daily backups off the server and try one restore
   ([backup and restore](deployment.md#backup-and-restore)):

   ```sh
   umask 077
   docker compose exec -T niaro niaro backup - > backup-$(date +%F).tar.gz
   ```

## 2. First setup (administrator)

The administration Overview shows a checklist. Work through it from the top
([administration guide](administration.md)):

1. An **AI provider** with a key (for example OpenRouter or OpenAI).
2. A **model**, set as the workspace default in **Model choice**.
3. **Usage limits** in enforce mode, with a price for that model. Without them
   the process designer and process tests stay disabled.
4. **Services**: add the CRM or Microsoft 365, add the actions you want, and
   set who may use them and what needs approval.
5. **People**: invite testers with **Invite by email** (on People or in a
   workspace). Without SMTP you get a link to pass on; it works once and
   expires after 48 hours.

## 3. People

- Sign in at `https://assistant.example.com/` with email and password, or a
  company sign-in method if one is set up.
- Forgotten password: an administrator opens **People**, the person's row,
  **Password reset link**.
- Account (`/me`): change the password, see and revoke devices and browser
  sessions, sign out everywhere. One person can have at most 8 mobile
  devices; browsers do not count.
- Mobile app: signs in through the browser at the server address.
- Services that need your own account (for example Microsoft 365) are
  connected in **Connections**.

## 4. What to try

Every tester goes through at least the following and notes what did not work
or was unclear:

1. **Overview**: add a widget (**Edit overview**, **Add widget**, or tell the
   agent "add … to my overview"), refresh it, remove it.
2. **Chat, reading**: "Find company X in the CRM and show its contacts",
   "What meetings do I have today?".
3. **Chat, a write with approval**: "Create a task for Alex: call the client
   tomorrow". Check the approval card, approve, and verify the result in the
   service.
4. **Process offer**: when a matching process exists, the chat offers it. Try
   both **Open process** and **Without it**.
5. **Tasks**: open a task, **Resolve in chat**, **Mark done**.
6. **Meetings**: record a short meeting in the browser or the phone app, then
   read the transcript, summary and tasks.
7. **Personal process**: **Processes**, **New process**, describe it to the
   designer, adjust it on the canvas, save a version, test, activate and run
   it. Then delete it.
8. **Mobile**: sign-in, chat, tasks, starting a process.
9. **Administrator**: change the permission of an action and see it take
   effect for a member at once; remove a person from a workspace.

## 5. Reporting problems

For each problem, write:

- what you did and what you expected;
- the time (roughly is fine) and the page address (for example `/chat/…`);
- a screenshot, if it is about appearance;
- web or mobile app, and which browser or phone.

The administrator finds the run in **Runs** and the change in **Activity
log**. The server log (`docker compose logs niaro`) contains no message
contents or keys.

## 6. Known pilot limitations

- **One Microsoft (Google, GitHub) account belongs to one user.** A service
  with personal sign-in connects only with an account that belongs to you;
  another person's or a shared test account is refused as already belonging
  to another user ([service-sign-in](../../openspec/specs/service-sign-in/spec.md)).
- **Concurrency.** Each person has one agent run at a time (chat or process),
  plus one Overview refresh beside it. The server runs at most
  `NIARO_MAX_CONCURRENT_RUNS` runs at once (default 8); further requests get
  "try again in a moment".
- **Overview.** AI widgets set to hourly or daily refresh in the background
  (every 5 minutes the server checks what is due); others refresh when the
  Overview opens or with the button. Process widgets refresh only on open or
  with the button, and need a process that runs without input and writes
  nothing without approval ([hub](../../openspec/specs/hub/spec.md)).
- **Web and mobile differ.** The web app has no voice input and no full
  process output reader; the mobile app has no Overview.
- **Personal processes.** Deleting one cannot be undone in the apps, and a
  personal process cannot be turned into a company one.
- **Installed connectors in the container** run without Docker as confined
  Node processes: npm definitions only (Microsoft 365 or a custom package), no
  images. Other MCP servers run as their own compose service
  ([installed connectors](hosted-connectors.md)).
- **Voice is not in the usage limits.** Voice transcription, read-aloud and
  meeting transcription are billed by audio length and do not count toward
  usage limits.
- **Always set a chat model** (step 2.2): without one the assistant cannot
  answer.
