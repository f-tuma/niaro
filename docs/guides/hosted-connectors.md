# Installed connectors

Some services have no MCP server of their own. Niaro can run one for them
(**Installed connectors**, `/admin/hosted`), or you run one next to Niaro and
connect it by URL. Every way ends as an ordinary MCP service under
**Services**.

Behavior, field rules, limits and isolation are in
[hosted-mcp-servers](../../openspec/specs/hosted-mcp-servers/spec.md).

| Way                     | Where                                                 | Use it for                                                       |
| ----------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| Built-in                | Installed connectors → Add connector → _name_         | Servers shipped with Niaro (Microsoft 365)                       |
| Custom                  | Installed connectors → Add connector → Custom         | An npm package at an exact version, or an image pinned by digest |
| Own compose service     | A container next to Niaro, connected by URL           | Anything else, or a host where Niaro has no Docker               |
| Own Dokploy application | A Dokploy application next to Niaro, connected by URL | Image servers on Dokploy                                         |

## Definition

Built-in and custom servers use the same JSON definition. It names what to
run, never a command or a shell, and holds no secret values.

```json
{
  "version": 1,
  "name": "Issue tracker",
  "source": { "npm": "@example/tracker-mcp", "version": "2.0.1" },
  "args": ["--http", "0.0.0.0:{port}"],
  "env": { "TRACKER_REGION": "eu" },
  "secrets": ["TRACKER_TOKEN"],
  "memoryMb": 512,
  "path": "/mcp"
}
```

An image instead of a package (Docker only):

```json
"source": { "image": "ghcr.io/example/tracker-mcp@sha256:<64 hex>", "port": 8080 }
```

`{port}` in `args` is replaced by the listening port. Listen on `0.0.0.0`.

`onboarding` prefills the service that **Create service** makes. The
built-in Microsoft 365 definition carries:

```json
"onboarding": {
  "icon": "mail",
  "description": "Mail and calendar of each person's own Microsoft 365 account.",
  "signIn": {
    "provider": "microsoft",
    "requiredFor": "all",
    "scopes": ["Calendars.ReadWrite", "Mail.ReadWrite", "Mail.Send"]
  }
}
```

## Add a server

Organization owners and admins, in **Installed connectors**:

1. **Add connector → Microsoft 365** (or another built-in): review the package
   and arguments, enter any declared secrets, add. Wait for _Running_.
2. **Add connector → Custom**: fill in the **Form** (npm package or Docker
   image, arguments, environment variables with a _Secret_ checkbox; memory and
   MCP path under _Advanced_), or switch to **Definition JSON** and paste or
   **Upload** a definition. **Look up** shows an npm package's publisher,
   license, publish date and integrity and fills in its latest exact version
   before anything is installed.
3. When it runs, use **Create service** on its row. It adds the MCP service to
   the current workspace with the server's address, authentication _None_ and
   the definition's `onboarding`, then opens the service. Follow its **Setup**
   checklist. A server that already has a service shows **Open service**.

The row's log button shows recent output with tokens redacted. Its `…` menu
has **Restart**, **Stop** or **Start**, **Secrets** (new values; saving
restarts the server), **Export** (`<name>.mcp.json` with secret names only)
and **Remove**.

To move a server to another Niaro, **Export** it there and **Upload** it under
Custom; enter the secrets again.

## Operator settings

Custom definitions run code you chose on this machine. To keep only the
built-ins, set this in the server profile (the console cannot change it):

```json
"administration": { "identity": { "hosting": { "allowCustom": false } } }
```

Where servers run: `administration.identity.hosting.runtime` is `auto`
(default: Docker when it answers, otherwise confined Node processes),
`docker` or `process`. `NIARO_HOSTED_RUNTIME` overrides it. When processes are
in use, the page header says "Without Docker: connectors run directly on this
server", and image definitions are unavailable.

## Security

- Access to Docker is root on the host. Run Niaro with Docker access only on a
  machine you trust it with.
- Process mode is weaker than Docker: the server runs as Niaro's own user, its
  network is not restricted and Node's permission model is not a defence
  against malicious code. Add only packages you would run on the host
  yourself, or set `allowCustom` to `false`.
- An own compose service or Dokploy application is outside Niaro: you own its
  isolation, updates, logs and secrets.

## Own compose service

Any MCP server that speaks Streamable HTTP can run as its own container next to
Niaro.

1. Add it to a compose file next to Niaro's, on the same network. A server
   published as an image:

   ```yaml
   # compose.mcp.yml: docker compose -f compose.yml -f compose.mcp.yml up -d
   services:
     tracker-mcp:
       image: ghcr.io/example/tracker-mcp@sha256:<64 hex>
       restart: unless-stopped
       command: ["--http", "0.0.0.0:8080"]
       environment:
         TRACKER_TOKEN: ${TRACKER_TOKEN:?}
       # No ports: only containers on the compose network reach it.
       read_only: true
       cap_drop: [ALL]
       security_opt: ["no-new-privileges:true"]
       mem_limit: 512m
   ```

   Microsoft 365 from npm on the Node image:

   ```yaml
   services:
     ms365-mcp:
       image: node:22-alpine
       restart: unless-stopped
       command:
         - npx
         - --yes
         - "@softeria/ms-365-mcp-server@0.156.2"
         - --http
         - 0.0.0.0:3000
         - --preset
         - calendar,mail
         - --allow-unauthenticated-discovery
       environment:
         MS365_MCP_BODY_FORMAT: html
         npm_config_cache: /tmp/npm
       tmpfs: [/tmp]
       cap_drop: [ALL]
       security_opt: ["no-new-privileges:true"]
   ```

   `npx` resolves dependencies at every start. For production, pin the image
   by digest and prefer a prebuilt image with a lockfile.

2. **Settings → Allowed addresses → Service addresses**: add
   `http://tracker-mcp:8080` (service name and port, no path), save, restart
   Niaro. In the profile this is `administration.identity.integrationOrigins`.
3. **Services → Add service → Configure manually**, connection type MCP,
   endpoint `http://tracker-mcp:8080/mcp`, with the server's own authentication
   (or _None_ and personal sign-in, see
   [Connect Microsoft 365](administration.md#connect-microsoft-365)).

## Docker images on Dokploy

The Niaro container has no Docker socket, so on Dokploy connectors run as
processes and image definitions are unavailable. Run an image MCP server as
its own Dokploy application instead:

1. **Create Service → Application** in the same Dokploy project. **General →
   Provider**: _Docker_, the image pinned by digest. Arguments go in
   **Advanced → Run command**.
2. **Environment**: the server's variables and secrets. Niaro never sees them.
3. No domain and no published port. The application joins `dokploy-network`,
   which Niaro's `compose.dokploy.yml` also joins, so Niaro reaches it by its
   **App Name** (General, e.g. `tracker-mcp-x1y2z3`). To keep it in Niaro's
   compose project instead, add it there as a second service on
   `dokploy-network`, as above.
4. **Settings → Allowed addresses → Service addresses**: add
   `http://<app-name>:<port>`, save, restart Niaro.
5. **Services → Add service**, connection type MCP, endpoint
   `http://<app-name>:<port>/mcp`, then follow the setup checklist.
