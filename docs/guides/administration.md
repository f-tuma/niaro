# Administration guide

For organization owners and admins working in the administration console at
`/admin`. Sections follow the order in which a new server is set up. Until
the basics are done, the console's **Overview** shows a checklist that links
to each step.

What each page does and the rules behind it are in the specs; this guide only
says where to click and what to enter. Console structure:
[administration](../../openspec/specs/administration/spec.md).

- [AI providers and models](#ai-providers-and-models)
- [Usage limits](#usage-limits)
- [Sign-in methods](#sign-in-methods)
- [Services](#services)
- [Installed connectors](#installed-connectors)
- [External AI apps](#external-ai-apps)
- [Web access and browser automation](#web-access-and-browser-automation)
- [Meetings](#meetings)
- [Overview widgets](#overview-widgets)

## AI providers and models

1. **AI providers → Add provider**: name, API base URL, API key, optionally a
   daily request limit. OpenRouter or any OpenAI-compatible API.
2. Open the provider → **Choose from catalog** and add the models you want, or
   **Add model** to enter a model ID by hand. A model whose tool support is
   unknown needs **Verify support** before it can run chat.
3. **Model choice** (`/admin/routing`), per workspace: **Chat model**
   (Workspace default), **Voice input** (speech-to-text and the Meetings
   transcription model), **Voice reply**, **Service picker**, and optional
   models per service.

Behavior: [models-and-providers](../../openspec/specs/models-and-providers/spec.md).

## Usage limits

**Usage limits** (`/admin/usage`), per workspace:

1. **Fill from providers** copies the list prices the provider publishes
   (OpenRouter publishes most). Type the rest under **Model prices**, in USD
   per million tokens for **Input** and **Output**. A free model is an
   explicit `0`.
2. **Max request** is the largest request the model may receive (it may be
   its whole context window); **Max reply** the largest answer. Niaro sets
   no smaller allowance of its own, so a reasoning model can think through a
   large task: with **Stop at limit** every call may write up to Max reply,
   otherwise up to the model's own maximum.
3. Set **Max per answer (tokens)** and **Max cost per answer**. A call
   reserves only its own request size, so the cap must hold the smallest
   call: 2,048 input tokens plus the model's **Max reply**. The page warns
   when even a short call would not fit.
4. **Mode → Stop at limit**, **Save changes**. The process designer and
   agent steps run only with **Stop at limit** and a priced model.

Each model you use needs its own price, including a separate Service picker
model. Editing a model or its provider makes its price out of date; save the
page again.

Behavior: [inference-budget](../../openspec/specs/inference-budget/spec.md).

## Sign-in methods

**Sign-in methods** (`/admin/auth-providers`) lets people sign in with
Google, Microsoft or GitHub, and lets services use a person's Microsoft or
Google account.

1. **Add method**, choose the provider. Copy the **Callback URL** shown in the
   form (`https://<server>/admin/auth/callback/<method id>`). It uses the
   server's public address and stays the same when saved.
2. Register an OAuth application at the provider with that callback URL:
   - **Microsoft**: Microsoft Entra → App registrations → New registration,
     platform _Web_, redirect URI = the callback URL. Create a client secret.
     Note the Application (client) ID and Directory (tenant) ID.
   - **Google**: Google Cloud console, an OAuth client of type _Web
     application_, authorized redirect URI = the callback URL.
   - **GitHub**: an OAuth App with the callback URL as authorization callback
     URL. GitHub cannot be used for personal service sign-in.
3. Enter **Client ID** and **Client secret**. Microsoft needs the
   **Microsoft tenant ID**; Google can be limited to one **Google hosted
   domain**. Save.
4. People who already have an account link it in the console's **Settings →
   Sign-in methods → Connect account**, then can sign in with it.

A secret left blank in an edit keeps the stored one. To change the provider
kind, client or tenant, add a new method.

Behavior: [identity-access](../../openspec/specs/identity-access/spec.md) and
[service-sign-in](../../openspec/specs/service-sign-in/spec.md).

## Services

Behavior of services, actions, permissions and own services:
[service-catalog](../../openspec/specs/service-catalog/spec.md). Personal
sign-in: [service-sign-in](../../openspec/specs/service-sign-in/spec.md).

### Add an MCP service

1. **Services → Add service → Configure manually**. Connection type _MCP_,
   **MCP endpoint** `https://…/mcp`. A private or plain-HTTP address must
   first be listed in **Settings → Allowed addresses → Service addresses**
   (applies after a restart). An installed connector needs none of this: use
   **Create service** on its row ([Installed connectors](#installed-connectors)).
2. **Authentication**: the server's shared key (**Bearer token** or **API key
   header**), or **None** when each person signs in with their own account
   (step 4). After saving, the server looks for the service's own OAuth and
   sets up personal sign-in when it finds it; the result line says what it
   found.
3. On the service's **Overview**, follow **Setup**: the address answers, then
   **Discover actions**. Leave **Name new actions with AI** off for a quick
   import. Discovery keeps running if you close the sheet.
4. Personal sign-in, on the **Access** tab: **When to require** _For every
   action_ (or _For changes_), **Sign-in with** an organization sign-in
   method or the service's own OAuth (HTTPS only), and the **Permissions** to
   request. See [Personal service sign-in](#personal-service-sign-in).
5. **Actions** tab: turn on what the assistant may use and who may use it.
6. **Test** in the checklist runs one read. Under personal sign-in, connect
   your own account first (the checklist links to the app's Connections).

### Mark reads

MCP tools arrive as changes that ask before running, even when the server
labels them read-only. Overview widgets read only enabled reads that run
without approval. After discovery, use **Mark as reads** in the result, or
**Turn on reads (n)** in the checklist, for the tools the server labels
read-only. Any other action can be switched to **Read only** in its editor
(**Effect**).

### Connect Microsoft 365

Each person reads their own mail and calendar with their own Microsoft
account, through the built-in connector.

1. **Installed connectors → Add connector → Microsoft 365**. Wait for
   _Running_ (the first start installs the pinned package).
2. **Microsoft Entra app registration** (entra.microsoft.com → App
   registrations → New registration), single tenant:
   - Platform _Web_, both redirect URIs on your public address:
     `https://<server>/admin/auth/callback/<sign-in method id>` (shown when
     you add the sign-in method in step 3) and
     `https://<server>/admin/service-connect`.
   - Certificates & secrets → New client secret; copy its value.
   - API permissions → Microsoft Graph → Delegated: `openid`, `profile`,
     `email`, `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`,
     `Calendars.ReadWrite`; grant admin consent for the tenant.
   - Note the Application (client) ID and the Directory (tenant) ID.
3. **Sign-in methods → Add method → Microsoft**: client ID, client secret,
   tenant ID, enabled. Copy its callback URL into the app registration.
4. Back in **Installed connectors**, the server's row → **Create service**.
   With the Microsoft method in place, the service gets personal sign-in for
   every action with `Calendars.ReadWrite Mail.ReadWrite Mail.Send`.
   Otherwise its checklist says "Needs a Microsoft sign-in method"; once the
   method exists, **Use _method_** finishes it.
5. Setup → **Discover actions**, then **Mark as reads**, and turn on the
   actions people may use (**Actions** tab).
6. Each person opens **Connections** in the app (or the checklist's
   **Connect**) and signs in with Microsoft. **Test** in the checklist then
   reads their mail.
7. In the app: **Overview → Edit → Add widget**, _Inbox_ or _Calendar_.
   Microsoft 365 is offered as a source once it has reads.

### Personal service sign-in

On the service's **Access** tab, **When to require**: _Never, use the shared
credential_, _For changes_ or _For every action_. Then **Sign-in with**:

- **Organization sign-in method** (Microsoft or Google). Its app
  registration is reused: add the **Redirect URL** shown on the tab
  (`https://<server>/admin/service-connect`) and the delegated permissions to
  that registration, and enter the same permissions under **Permissions**,
  separated by spaces (for Microsoft 365:
  `Calendars.ReadWrite Mail.ReadWrite Mail.Send`). `openid`, `profile` and,
  for Microsoft, `offline_access` are added automatically.
- **The service's own OAuth** (Twenty, or an MCP server with OAuth metadata),
  HTTPS only. **Detect OAuth**, then **Register Agent Server**, or enter an
  existing client's **Client ID** and **Client secret**. Empty
  **Permissions** request `api profile`.

**Who can connect** on the Access tab decides which roles may connect at all.
If the checklist says the sign-in doesn't ask for some permissions, **Add
permissions** adds them; everyone then signs in again.

### Members' own services

On **Services**, two workspace settings:

- **Members' own services**: _Not allowed_, _After an administrator's
  approval_ (default) or _At once_.
- **Their actions**: _Managed by the owner_ or _Managed by administrators_.

Under approval, a new own service appears in **Overview → Needs attention**
and on its service page with **Approve** and **Reject** (an optional reason
goes to the member). Check the address and tools before approving.

### Working with long lists

- **Actions** tab: search by name, description or binding, filter by status,
  25 rows per page. Select a page or **Select all matching actions**;
  selections survive filtering and paging. **Edit selected** changes only what
  you pick (enabled state, **Confirmation**, **Change allowed roles**; the rest
  stays _Keep unchanged_). The batch applies all or nothing; if the service
  changed meanwhile, **Discard changes and reload** and select again.
- **AI providers → a provider**: search and select models, then **Enable
  selected** or **Disable selected**. Changes run one model at a time; a
  failure stops the queue and leaves the remaining models selected.
- An action or model opens in a side sheet; errors show inside it.

## Installed connectors

Running MCP servers for services that have none (Microsoft 365, npm packages,
Docker images), and running your own next to Niaro:
[Installed connectors guide](hosted-connectors.md).

## External AI apps

**External AI apps** (`/admin/mcp`) connects an AI app such as Claude to
Niaro's MCP endpoint `https://<server>/mcp`. Behavior, tools and the task
contract: [mcp-server](../../openspec/specs/mcp-server/spec.md).

### Access token

1. Sign in with your own account and select the workspace.
2. **Connect an app**: **Client name**, mode **Runs actions** (the app calls
   the workspace's service actions as tools) or **Hands over tasks** (Niaro's
   agent does the work), permissions, **Valid for** 1, 7 or 30 days.
3. Copy the token now; it is shown only once.
4. Configure the app with the **Address for AI apps** and the token. The page
   shows an **Example client configuration**; the exact format depends on the
   client:

   ```json
   {
     "mcpServers": {
       "niaro": {
         "url": "https://<server>/mcp",
         "headers": { "Authorization": "Bearer YOUR_TOKEN" }
       }
     }
   }
   ```

A token can be revoked on the same page (`…` → **Revoke access**). A person
also sees and revokes their tokens on **Account** (`/me`) in the app.

### OAuth client

For apps that link through OAuth:

1. In the app's connector settings, copy its exact HTTPS callback address.
2. **External AI apps → Register OAuth client**, paste it as **Callback URL**,
   copy the returned **Client ID**.
3. Enter the client ID in the app's own-client settings, with the same `/mcp`
   endpoint. When linking, the person chooses the workspace and permissions.

OAuth access lasts at most an hour; link again after it expires.

### Client notes

- **ChatGPT** needs OAuth; it does not take a pasted bearer token.
- **Claude** accepts OAuth or a fixed bearer header. On a Team or Enterprise
  plan a header configured once for the organization gives everyone that one
  person's access; use OAuth or personal connectors instead. Remote
  connectors run from Anthropic's cloud, so the server must be publicly
  reachable.
- Reuse the same `requestId` when retrying a request whose answer was lost.
- After `task_submit`, poll `task_get` until the task finishes.
- Never resubmit a write whose outcome is unknown; check the service first.
- A connector call that needs approval returns an approval link; the person
  who owns the access approves it in Niaro, then the app reads the result with
  `niaro_call_status`.

## Web access and browser automation

### Web search and reading

**Built-in tools → Web**: _Enabled_, **Save changes**, per workspace. Settings
on that page: search model (empty uses the chat model; it must be on an
OpenRouter provider), search engine (`exa`, `native`, `auto`), results per
search, page text length, zero data retention providers only. Server-wide
defaults go in the profile under `plugins.settings.web`.

- **Costs.** A search is a model call of the run on the workspace's provider
  key and counts against usage limits. With Exa, OpenRouter charges $0.007
  per search with up to 10 results; native search passes the model
  provider's price through. Check OpenRouter's pricing page before enabling.
  A page read costs no model call; its text becomes input of the next call.
- **Privacy.** Queries go to OpenRouter and its search engine. Page reads go
  from the server straight to the website, without cookies or sign-in; the
  site sees the server's address. The operator log records counts, hosts and
  status, never queries or page content.

Behavior and limits: [web-access](../../openspec/specs/web-access/spec.md).

### Browser automation

For sites that need a real browser (JavaScript, forms, several steps), run
Microsoft's [Playwright MCP server](https://github.com/microsoft/playwright-mcp)
as its own service and connect it as an MCP service. Do not run it inside the
Niaro container.

```yaml
services:
  browser-mcp:
    # The tag you tested, pinned by digest.
    image: mcr.microsoft.com/playwright/mcp@sha256:<64 hex>
    init: true
    entrypoint: ["node", "/app/cli.js"]
    command:
      - --headless
      - --browser
      - chromium
      - --no-sandbox
      - --isolated
      - --port
      - "8931"
      - --host
      - 0.0.0.0
      - --allowed-hosts
      - browser-mcp
      - --output-dir
      - /tmp/output
    tmpfs: ["/tmp:size=512m"]
    shm_size: 1gb
    mem_limit: 2g
    cpus: 1.5
    pids_limit: 512
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    restart: unless-stopped
    # Only the browser network: no published port, no dokploy-network.
    networks: [browser]

networks:
  # Add `browser` to Niaro's networks too, so it reaches
  # http://browser-mcp:8931 and the browser reaches nothing else.
  browser:
    driver: bridge
```

- `--no-sandbox` is the image's documented way to run; the container is the
  sandbox. `--isolated` keeps the browser profile in memory, so no sign-ins
  or cookies survive. `--allowed-hosts` is the host name Niaro connects with.
- `--blocked-origins` is not a security boundary; network isolation is. The
  browser still reaches the internet and, through the host, private
  addresses. Where you control the host, drop private ranges for the browser
  network's subnet in Docker's `DOCKER-USER` chain:

  ```sh
  iptables -I DOCKER-USER -s <browser subnet> -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16 -j DROP
  ```

- On Dokploy without compose, run it as an application as in
  [Docker images on Dokploy](hosted-connectors.md#docker-images-on-dokploy),
  with the arguments above under **Advanced → Run command**. That puts it on
  `dokploy-network`; prefer the compose service for a network of its own.

Connect it:

1. **Settings → Allowed addresses → Service addresses**: add
   `http://browser-mcp:8931`, save, restart Niaro.
2. **Services → Add service → Configure manually**, connection type MCP,
   endpoint `http://browser-mcp:8931/mcp`, authentication **None**.
   **Discover actions**.
3. **Actions** tab:
   - Mark as reads: `browser_snapshot`, `browser_take_screenshot`,
     `browser_console_messages`, `browser_network_requests`,
     `browser_network_request`, `browser_find`, `browser_navigate`,
     `browser_navigate_back`, `browser_wait_for`, `browser_tabs`. With
     `--isolated` a navigation is a read: the browser has no sign-ins.
   - Keep as changes that ask first: `browser_click`, `browser_type`,
     `browser_fill_form`, `browser_select_option`, `browser_press_key`,
     `browser_hover`, `browser_drag`, `browser_drop`,
     `browser_handle_dialog`.
   - Leave off unless needed (they run code or send files):
     `browser_evaluate`, `browser_run_code_unsafe`, `browser_file_upload`.
4. Allow it only for the roles that need it.

## Meetings

**Settings → Meetings** (server-wide; the profile's values are the
defaults):

| Setting           | Profile key           | Notes                                         |
| ----------------- | --------------------- | --------------------------------------------- |
| Keep audio        | `audioRetentionDays`  | Days, `0` keeps it forever. Default 30.       |
| Transcript chunk  | `chunkSeconds`        | Seconds per transcription request, 120–600.   |
| Glossary          | `glossary`            | Names and terms to spell right, one per line. |
| Tell voices apart | `diarization.enabled` | Needs the diarizer service.                   |
| Diarizer address  | `diarization.url`     | Default `http://diarizer:8000`.               |

```json
"administration": {
  "identity": {
    "meetings": {
      "audioRetentionDays": 30,
      "chunkSeconds": 300,
      "glossary": ["Niaro", "Acme s.r.o."],
      "diarization": { "enabled": false, "url": "http://diarizer:8000" }
    }
  }
}
```

The transcription model is chosen in **Model choice → Voice input →
Meetings**.

### Telling voices apart

1. The operator installs the diarizer (compose profile `diarization`); see
   [Optional speaker diarization](deployment.md#optional-speaker-diarization).
2. **Settings → Meetings → Tell voices apart** _On_, check the **Diarizer
   address**, save. The row shows the service state: _Diarizer ready_,
   _Diarizer is loading its model…_, _Diarizer model not loaded_ (Hugging
   Face terms not accepted, or no network), _Diarizer not reachable_ or
   _Diarizer token does not match_.
3. It applies to meetings processed from then on; process a meeting again to
   add voices to it.

Behavior: [meetings](../../openspec/specs/meetings/spec.md).

### Costs

Timestamped transcription with `openai/gpt-4o-transcribe` costs about $0.36
per hour of speech at list price, `gpt-4o-mini-transcribe` about half. With
silence trimming and one record extraction a typical meeting comes to roughly
$0.25 per hour. A two-track recording pays for each channel's speech
separately. Check current OpenRouter prices before enabling. Diarization runs
locally and costs no provider calls.

## Overview widgets

People build their Overview in the app. A widget can also be any active
process without required input. Behavior:
[hub](../../openspec/specs/hub/spec.md).

### Example processes

Create these in the app under **Processes → New process** as personal
processes, test and turn them on; they then appear in **Add widget**. Asking
for one in chat does the same from one card.

- **My day**: "Every morning, list today's meetings from my calendar
  (Microsoft 365) with time and title, and the deadlines that end today. No
  inputs. Output: summary (short text) and meetings (list: time, title)."
- **Task summary**: "Load my open tasks from To Do / CRM and summarize what is
  overdue and what is due today. No inputs. Output: summary and overdue (list
  of titles)."
- **Companies in the CRM**: "Count the companies in the CRM. No inputs.
  Output: count (number)." Shows as a number.
- **Opportunities by stage**: "Group the open opportunities in the CRM by
  stage. No inputs. Output: stages (list: label, value)." Shows as a bar
  chart; switch it to a pie in **Set up view**.

### When a widget can't fill

Widgets read only enabled reads that run without approval, so a new MCP
service needs [Mark reads](#mark-reads) first. The widget shows one line and,
where there is one, the step that fixes it. Members see "Ask an
administrator." instead of an admin link.

| The person sees                               | Fix                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Your account isn't connected to the service.  | **Connect account** (the app's Connections)                                         |
| The overview has no AI model.                 | **Model choice** (`/admin/routing`): set the workspace default                      |
| No service the overview can read yet.         | **Services**: enable reads and grant them                                           |
| The overview can't read the chosen service.   | **Open service**: check its actions and access                                      |
| The service refused access: …                 | **Open service**: the checklist names missing sign-in permissions, or check the key |
| The assistant found nothing to read for this. | Refresh, or change the widget's request                                             |
| The assistant couldn't read the data.         | Refresh, or change the widget's request                                             |
