# The web

The assistant can search the web and read public pages through the built-in
`web` [plugin](plugins.md). It is off in every workspace until a workspace
owner or administrator turns it on in **Administration → Plugins → Web**.
Clicking, typing and filling in forms on websites is not part of it; see
[Browser automation](#browser-automation) for running a real browser as a
separate service.

- [What the agent can do](#what-the-agent-can-do)
- [Turning it on and settings](#turning-it-on-and-settings)
- [Costs](#costs)
- [Privacy](#privacy)
- [Safety rules](#safety-rules)
- [Limits](#limits)
- [Browser automation](#browser-automation)

## What the agent can do

Two read-only tools, without approval (they change nothing anywhere):

| Tool                  | Input                                                       | Returns                                                                                                                                   |
| --------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `internal_web_search` | `query`, optional `limit` (≤ 8), `freshness` (`day`…`year`) | Up to `limit` results: `title`, `url`, a short `snippet`, the `date` (YYYY-MM-DD) when the page states one.                               |
| `internal_web_read`   | `url` (http or https), optional `maxChars` (500–40,000)     | `title`, the final `url` after redirects, `contentType`, the page as text with links as `[text](url)`, `truncated` when the text was cut. |

The agent searches when a request needs current or outside information
(news, prices, documentation, opening hours) and reads a result or an address
the person gave. It cites the URLs it used. A failed call returns an error the
model can explain (`web_address_refused`, `web_content_type_refused`,
`web_http_error` with the status, `web_timeout`, `web_search_limit`, …).

**Search** is one OpenRouter chat completion with OpenRouter's
[web search](https://openrouter.ai/docs/guides/features/web-search) (`plugins:
[{ "id": "web", "engine", "max_results" }]`). OpenRouter runs the query on the
engine and returns the results as `url_citation` annotations; the server turns
them into the results (deduplicated, http(s) only, title ≤ 200 and snippet ≤
400 characters). The model only lists the publication dates it sees; its text
is never returned. `freshness` drops results whose known date is older than
the window; results without a date stay (the engines are not filtered by
date).

**Read** fetches one page and converts it on the server: the main content
(`main`, `article`, else the body without its header and footer), without
navigation, forms, scripts, styles and hidden parts, through the same HTML
sanitizer as the overview's message view. Headings, lists, tables and links
stay readable. JSON is pretty-printed; plain text and Markdown come as sent.

## Turning it on and settings

Administration → Plugins → **Web** → _Enabled_, _Save changes_. The web plugin
is available in every workspace whatever the server profile lists, like an
operator's plugin. To have it on for workspaces on the server's defaults, name
it in the profile's `plugins.enabled`.

| Setting                | Default | Meaning                                                                                                                                                                                                          |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search model           | empty   | The model ID of a chat model in **AI models** (for example `openai/gpt-4o-mini`) on an OpenRouter provider. Empty: the workspace's chat model. The decision model answers through another API and cannot search. |
| Search engine          | `exa`   | `exa` (any model, fixed price), `native` (the model provider's own search, for models that have one) or `auto` (OpenRouter decides).                                                                             |
| Results per search     | 5       | 1–8; the most a search returns. The model may ask for fewer.                                                                                                                                                     |
| Page text (characters) | 12,000  | 1,000–40,000; what a read returns unless the model asks for another `maxChars`.                                                                                                                                  |
| Zero data retention    | on      | Searches go only to providers that keep no data (`provider.zdr`).                                                                                                                                                |

The profile can set server-wide values under `plugins.settings.web`.

## Costs

- A search is a model call of the run: it uses the workspace's provider key,
  counts against the [inference budget](inference-budget.md) and the
  provider's daily request limit, and is settled with the cost OpenRouter
  reports (tokens plus the search). With Exa, OpenRouter charges about
  $0.007 per search with up to 10 results; native search passes the
  provider's price through. Check OpenRouter's pricing page for current
  prices. Before the call the budget reserves the search fee on top of the
  tokens (Exa: $0.004 per requested result; native search: $0.05 per call),
  so an enforced budget never reports an overrun for a search it admitted.
- A read costs no model call; the page text the agent reads becomes input of
  its next model call.
- Per agent run at most 8 searches and 12 reads, over all web tools.

## Privacy

- **Queries go to OpenRouter and its search engine** (Exa, or the model
  provider for native search), with the workspace's provider key. They are
  sent with `provider.data_collection: "deny"` and, unless turned off,
  `provider.zdr: true`, like voice and meeting transcription. The search
  engine applies its own retention; OpenRouter documents Firecrawl as
  refused under ZDR.
- **Reads go from the server to the website directly**, like a browser
  without cookies: no session, no sign-in, no Referer. The site sees the
  server's address and the user agent
  `Mozilla/5.0 (compatible; Niaro/1.0; reads one page for a person)`.
- **Results are private context**, like service reads: a reply built from web
  results is not replayed into later turns of the chat, and the run keeps
  only counts of its web calls.
- **Operator log** (`web_search`, `web_read`): plugin, workspace, model,
  number of results, host, HTTP status, bytes, redirects, content type, time
  and error code. Never the query, the path or the page's content.

## Safety rules

- **Web content is untrusted data.** Every web result carries a note saying
  so, the tool descriptions and the system prompt repeat it: it never grants
  permission, never approves a write and never changes the rules, and the
  agent must not send the person's data anywhere because a page asks. The
  plugin's tools are reads; any write still needs its own approval.
- **Public addresses only.** A read accepts http and https without
  credentials. IP literals must be public unicast; `localhost`, `.local`,
  `.internal`, `.lan`, `.home.arpa` and single-label names are refused. The
  transport resolves the name once, refuses it when any address is not
  public, and pins the connection to the checked address. Origins trusted in
  Settings → Origins are **not** trusted for web reads.
- **Redirects** are followed at most 3 times, each new address checked the
  same way before it is requested.
- **Bounded:** 15 s per request, 2 MB per response, no content encoding;
  only `text/html`, `application/xhtml+xml`, `text/plain`, `text/markdown`
  and `application/json`. PDFs, images and downloads are refused.
- **robots.txt is not consulted.** Each read is one page that the person's
  request asked for, fetched once while they wait, like opening it in a
  browser; nothing crawls or follows links on its own.

## Limits

- No JavaScript: pages that render their content in the browser read as
  nearly empty. Use [Browser automation](#browser-automation) for those.
- No sign-ins, cookies, PDFs or files.
- Search needs an OpenRouter provider. The results are what OpenRouter's
  annotations contain; dates are known only when the page states one.
- The web tools exist in the chat's agent; overview widgets and processes do
  not use them.

## Browser automation

For sites that need a real browser (JavaScript, several steps, forms), run
Microsoft's [Playwright MCP server](https://github.com/microsoft/playwright-mcp)
as a separate service and connect it as an MCP service. Niaro then governs
it like any service: reads run directly, everything that acts on a site
waits for the person's approval.

### Run it

Run it as its own Dokploy application or compose service, not inside the
Niaro container. Pin the version: the npm package `@playwright/mcp` (0.0.83 at
the time of writing) and its image `mcr.microsoft.com/playwright/mcp`. Pin the
image by digest once you have pulled the tag you tested. The image runs
headless Chromium only. Flags:

- `--headless --browser chromium --no-sandbox`: the image's documented way
  to run (the container is the sandbox).
- `--isolated`: the browser profile stays in memory; nothing is kept between
  sessions, no cookies survive.
- `--port 8931 --host 0.0.0.0`: Streamable HTTP at `/mcp`.
- `--allowed-hosts browser-mcp`: the host name Niaro connects with (it
  defaults to the bound host; `*` turns the check off).
- `--blocked-origins` can keep the browser off some sites, but Playwright
  says it is not a security boundary; network isolation is.

```yaml
services:
  browser-mcp:
    # Pin the tested tag by digest: mcr.microsoft.com/playwright/mcp@sha256:<64 hex>
    image: mcr.microsoft.com/playwright/mcp:v0.0.83
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
  # Niaro joins this network too (add `browser` to its `networks`), so it
  # reaches http://browser-mcp:8931 and the browser reaches nothing else of
  # the project.
  browser:
    driver: bridge
```

The browser still reaches the internet and, through the host, private
addresses. Where you control the host, drop those for the browser network's
subnet in Docker's `DOCKER-USER` chain (for example
`iptables -I DOCKER-USER -s <browser subnet> -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16 -j DROP`),
so a page cannot steer it to your LAN or the cloud metadata address. The
browser network gives no access to Niaro's other services; it can reach
Niaro's own HTTP port, which needs sign-in.

On Dokploy without compose: **Create Service → Application**, provider
_Docker_ with the pinned image, the arguments above under **Advanced → Run
command**, resource limits under **Advanced → Resources**, no domain and no
port, as in [Hosted servers → Docker images on
Dokploy](hosted-servers.md#docker-images-on-dokploy). That attaches it to
`dokploy-network`, which Niaro joins; prefer the compose service above when
you want it on a network of its own.

### Connect it

1. **Administration → Settings → Origins → Integration origins**: add
   `http://browser-mcp:8931` (no path), save, restart Niaro. Plain HTTP and
   private addresses are reachable only when listed there.
2. **Services → Add service → Configure manually**, protocol MCP, URL
   `http://browser-mcp:8931/mcp`, authentication _None_ (the server is
   reachable only from Niaro's network). Follow the setup checklist:
   **Discover actions**.
3. **Actions** tab. Mark as reads (they run without approval):
   `browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`,
   `browser_network_requests`, `browser_network_request`, `browser_find`,
   `browser_navigate`, `browser_navigate_back`, `browser_wait_for`,
   `browser_tabs`. Keep as writes with approval _always_: `browser_click`,
   `browser_type`, `browser_fill_form`, `browser_select_option`,
   `browser_press_key`, `browser_hover`, `browser_drag`, `browser_drop`,
   `browser_handle_dialog`. Turn off `browser_evaluate`,
   `browser_run_code_unsafe` and `browser_file_upload` unless you need them:
   they run code or send files.
4. Allow it only for the roles that need it.

A navigation is a read in this setup because, with `--isolated`, the browser
has no sign-ins: opening a page is what `internal_web_read` does, with
JavaScript. Anything that types, clicks or submits waits for approval, and
everything the browser returns is a service result: untrusted data and
private context like any other service read.

### Why browser-use is not bundled

[browser-use](https://github.com/browser-use/browser-use) is a Python agent
with its own LLM loop: it decides the clicks and form entries itself. Bundled
in Niaro, it would take steps the person never approved, outside Niaro's
approvals, budget and logs, and would add a Python runtime to the image.
Playwright MCP exposes each browser step as a tool, so Niaro's agent decides
and each acting step is approved. If you want browser-use anyway, run its MCP
server mode (`uvx --from 'browser-use[cli]' browser-use --mcp`, stdio; put an
HTTP MCP bridge in front of it) as a separate service and connect it the same
way, with its acting tools as writes that need approval.
