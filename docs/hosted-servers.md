# Hosted MCP servers

Some services have no MCP server of their own. Niaro can run one for them, or
connect to one you run yourself. There are three ways, and every one ends as an
ordinary MCP service under **Services → Add service**:

| Way                     | Where it runs                                   | Use it for                                                                |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| **Built-in**            | Administration → Hosted → Add server → _name_   | Servers shipped with Niaro (Microsoft 365)                                |
| **Custom**              | Administration → Hosted → Add server → Custom   | Any npm package at an exact version, or an image pinned by digest         |
| **Own compose service** | A container next to Niaro, connected by its URL | Anything else, e.g. a Python or Go server on a host without Docker access |

Built-in and custom servers are both **definitions** in one format, below. A
built-in is a definition committed in
[`apps/server-hosting/templates/<id>/definition.json`](../apps/server-hosting/templates/microsoft-365/definition.json)
together with its lockfile; the code path is the same.

## Definition format

A small, versioned JSON file, compose-like. It names what to run, never a
command or a shell, and it holds no secret values.

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

An image instead of a package:

```json
"source": { "image": "ghcr.io/example/tracker-mcp@sha256:<64 hex>", "port": 8080 }
```

| Field            | Required   | Meaning                                                                                                                                                                                                                     |
| ---------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`        | yes        | Format version, `1`.                                                                                                                                                                                                        |
| `name`           | yes        | Shown in administration, at most 100 characters.                                                                                                                                                                            |
| `source.npm`     | one of     | npm package name, optionally scoped. No paths, URLs or git sources.                                                                                                                                                         |
| `source.version` | with npm   | Exact version (`1.2.3`, `1.2.3-beta.1`). Ranges, tags and `latest` are refused.                                                                                                                                             |
| `source.bin`     | no         | The package executable to run; needed only when the package has more than one.                                                                                                                                              |
| `source.image`   | one of     | Container image pinned by digest: `repository[:tag]@sha256:<64 hex>`. Docker only.                                                                                                                                          |
| `source.port`    | with image | Port the server listens on inside the container.                                                                                                                                                                            |
| `args`           | no         | Arguments as a list, at most 40, no line breaks. `{port}` is replaced by the listening port; an npm definition must use it. Listen on `0.0.0.0`: in a container that is the container, as a process it becomes `127.0.0.1`. |
| `env`            | no         | Fixed, non-secret variables: `{ "NAME": "value" }`, names in `UPPER_CASE`, at most 30.                                                                                                                                      |
| `secrets`        | no         | Names of secret variables. Their values are entered in administration, stored encrypted (AES-256-GCM, key derived from the identity `secret`) and passed as environment variables. A name left empty is not passed.         |
| `memoryMb`       | no         | 128–4096, default 512. The container's hard limit, or the process's heap limit.                                                                                                                                             |
| `path`           | no         | The MCP endpoint path, default `/mcp`. The service URL is `http://127.0.0.1:<port><path>`.                                                                                                                                  |
| `onboarding`     | no         | How its service is set up, below. Only prefills; administrators change everything afterwards.                                                                                                                               |

`onboarding` describes the catalog service **Create service** makes for the
server:

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

| Field                | Meaning                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `icon`               | The service icon: `plug`, `database`, `users`, `calendar`, `mail`, `code`, `folder` or `search`. Without it the favicon is used. |
| `description`        | The service's purpose, at most 500 characters; the assistant routes by it.                                                       |
| `signIn.provider`    | `microsoft` or `google`: each person signs in with their own account through an organization sign-in method of this kind.        |
| `signIn.requiredFor` | `all` (default) or `writes`: which actions use the person's account.                                                             |
| `signIn.scopes`      | Delegated permissions to request, at most 30; the sign-in scopes are added on their own.                                         |

Reserved names cannot be used in `env` or `secrets`: `PATH`, `HOME`, `TMPDIR`
and everything starting with `NODE_`, `LD_` or `DYLD_` (they could load code
past the process confinement). Unknown fields are refused. The schema is
`HostedDefinition` in [`packages/protocol/hosted.ts`](../packages/protocol/hosted.ts).

## Adding a server

Organization owners and admins open **Administration → Hosted** (members see
nothing there):

- **Add server → Microsoft 365** shows the package and arguments, asks for any
  declared secrets and starts it. Each organization runs a built-in once.
- **Add server → Custom** opens a form (package or image, arguments, variables
  with a _Secret_ checkbox, and under _Advanced_ memory and path), or **Definition
  JSON**: paste a definition or **Upload** a file. The declared secrets get
  their own fields. **Look up** shows an npm package's publisher, licence, date
  and integrity, and fills in its latest exact version, before anything is
  installed.
- **⋯ → Export** downloads a server's definition (`<name>.mcp.json`) with secret
  names only, never values. Importing it on another server (Custom → Upload)
  asks for the values again.
- **⋯ → Secrets** sets new values; an empty field keeps the stored one. Saving
  restarts the server.

Once a server runs, its row offers **Create service**: it adds the MCP service
for the current workspace with the server's name and URL, authentication _None_
(the hosted server holds no key) and the definition's `onboarding`, then opens
the service. When the definition asks for personal sign-in and the organization
has an enabled sign-in method of that kind, the service's sign-in is set up too
(for Microsoft 365: Microsoft, every action, `Calendars.ReadWrite
Mail.ReadWrite Mail.Send`); otherwise the service's setup checklist says what is
missing. A server that already has a service shows **Open service** instead.
Nobody types the loopback URL: the hosted server's origin is trusted
automatically while it exists and is reachable only from Niaro itself.

**Who may add custom servers.** Custom definitions run code you chose on this
machine, so the operator decides in the server profile. They are on by default
for organization owners and admins; set this to keep only the built-ins (the
console cannot change it):

```json
"administration": { "identity": { "hosting": { "allowCustom": false } } }
```

## Runtimes

`administration.identity.hosting.runtime` chooses where servers run, and
`NIARO_HOSTED_RUNTIME` overrides it: `auto` (default) uses Docker when
`docker info` answers and Node processes otherwise; `docker` never falls back;
`process` never uses Docker. **Hosted** says "Without Docker" in its header when
processes are in use.

| Definition | Docker              | Without Docker (process)                              |
| ---------- | ------------------- | ----------------------------------------------------- |
| npm        | runs in a container | runs as a confined Node process                       |
| image      | runs in a container | unavailable: "Images need Docker"; refused when added |

**Installation.** An npm server is pinned when it is first installed: a
built-in copies its committed `package-lock.json`; a custom package gets one
from `npm install --package-lock-only --ignore-scripts` for its exact version,
kept in the server's directory from then on, so the same integrity hashes are
installed on every start. Installation is always `npm ci --ignore-scripts
--omit=dev`: every package is verified by its hash and no install script runs (a
package that needs one may not work; Look up warns). In Docker this runs inside
the sandbox; as a process it runs with the server's npm in the server's own
directory, with its cache, `HOME` and `TMPDIR` there too. It needs the npm
registry on first start; without it the server shows "Installation failed".

**Docker.** Every server is one container:

- the official Node image pinned by digest (npm), or the definition's image by
  digest;
- a read-only root file system, no Linux capabilities, `no-new-privileges`, the
  server's own unprivileged user, 256 processes and the definition's memory;
- its own `agent-hosted` network: internet access, but no access to Niaro, other
  services on the host's loopback or other hosted servers; its port is published
  on `127.0.0.1` only;
- one writable directory under `<identity directory>/hosted/`. Variables and
  secrets go through a private (`0600`) environment file, never the command line.

Access to Docker is equivalent to root on the host, so run Niaro with Docker
only on a machine you trust it with.

**Process (without Docker).** The program starts with Node's permission model:

- `node --permission`, reading only its own directory under
  `<identity directory>/hosted/` and writing only its `home/`. The identity
  database, `secret`, the admin key and workflow data are unreadable; so are
  `/proc` and other hosted servers. No child processes, worker threads, native
  addons or WASI. A symbolic link leading out of the directory fails the start,
  because Node follows it;
- an explicit environment: `PATH`, `HOME`, `TMPDIR`, `NODE_ENV=production`, the
  definition's `env` and its secrets. Nothing of Niaro's own environment is
  passed;
- `127.0.0.1` on its assigned port, a heap limit from `memoryMb`, and it exits
  when Niaro is gone, so no process keeps the port.

The process limits are weaker than the container's: it runs as Niaro's own
user, only Node's permission model limits its file access (Node does not call it
a defence against malicious code), its network is not restricted (it can reach
the internet, Niaro and other loopback services) and there is no process or hard
memory limit. Add only packages you would run on the host yourself, or set
`allowCustom` to `false` to keep the built-ins only.

**Supervision.** A crashed server restarts with backoff and stops after five
crashes in ten minutes. The log shows the last 200 lines with tokens and secret
values redacted. Up to eight hosted servers run, on loopback ports
39100–39199. Removing one deletes its container or process, directory and
address.

## Own compose service

Any MCP server that speaks Streamable HTTP can run as its own service next to
Niaro and be connected by URL. This is the way for servers that are not npm
packages on a host where Niaro has no Docker (the container image never has it),
and for servers that need more than a definition allows (volumes, other
networks, sidecars).

1. Add the service to a compose file next to Niaro's, on the same network.
   A generic server published as an image:

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

   Microsoft 365 the same way, from npm on the Node image:

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

   `npx` resolves the package's dependencies at every start; pin the image by
   digest and prefer a prebuilt image with a lockfile for production.

2. Allow its origin: **Administration → Settings → Allowed addresses → Service
   addresses**, add `http://tracker-mcp:8080` (the compose service name and port,
   no path), save and restart Niaro. Private and plain-HTTP addresses are
   reachable only when listed there (`administration.identity.integrationOrigins`
   in the profile).
3. **Services → Add service**, protocol MCP, URL `http://tracker-mcp:8080/mcp`,
   with the server's own authentication (or _None_ and personal sign-in, as for
   Microsoft 365 above).

The container's isolation, updates and backups are yours: Niaro does not
supervise it, show its log or keep its secrets.

## Docker images on Dokploy

The Niaro container has no Docker socket on purpose (access to Docker is
root on the host), so on Dokploy hosted servers run as processes and image
definitions are unavailable. Dokploy is itself a container platform: run an
image MCP server as its own Dokploy application next to Niaro and connect it
by URL.

1. **Create Service → Application** in the same Dokploy project. Under
   **General → Provider** choose _Docker_ and the image pinned by digest
   (`ghcr.io/example/tracker-mcp@sha256:<64 hex>`). Its arguments, if any,
   go in **Advanced → Run command**.
2. **Environment**: the server's variables and secrets. Dokploy keeps them;
   Niaro never sees them.
3. Add **no domain** and publish **no port**: Dokploy attaches applications to
   `dokploy-network`, the network Niaro's `compose.dokploy.yml` joins, so Niaro
   reaches it by the application's **App Name** (shown under General, e.g.
   `tracker-mcp-x1y2z3`) and nobody else can. To keep it in Niaro's compose
   project instead, add it as a second service there on `dokploy-network`, as
   in [Own compose service](#own-compose-service).
4. Allow its origin: **Administration → Settings → Allowed addresses → Service
   addresses**, add `http://<app-name>:<port>` (no path), save and restart
   Niaro.
5. **Services → Add service**, protocol MCP, URL
   `http://<app-name>:<port>/mcp`, then follow the service's setup checklist.

Dokploy restarts, updates and logs the application; Niaro does not supervise
it.

## Verification status

Definitions, the process runtime and the compose output are covered by
synthetic tests (`tests/hosted-servers.node.ts`). The Microsoft 365 npm definition
has run as a hosted server on the development server. Running an image MCP
server as its own Dokploy application next to Niaro follows the steps above
and has not been exercised end to end on a production host yet.
