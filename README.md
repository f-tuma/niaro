# Niaro

A self-hosted company assistant: one server with a web app, administration and
a mobile app for iOS and Android. People chat with an agent that works in the
company's own services (CRM, Microsoft 365, MCP services); the server owns the
models, credentials, permissions, memory, usage limits and approvals.

The apps never talk to a model provider or a company service directly. The
server decides which model runs, which service actions a person may use and
when a write needs explicit approval.

> **Status: pilot.** Running in a first company pilot. It is not yet a general
> release or a security-audited service. See the
> [pilot guide](docs/guides/pilot.md) for known limitations.

## Features

Each area links to its specification, which describes current behavior.

- **Chat** with an agent that reads and writes in connected services, asks
  questions and waits for approval of writes:
  [chat](openspec/specs/chat/spec.md),
  [chat delivery](openspec/specs/chat-delivery/spec.md),
  [chat search](openspec/specs/chat-search/spec.md),
  [agent runtime](openspec/specs/agent-runtime/spec.md),
  [generated UI](openspec/specs/generative-ui/spec.md).
- **Overview**, a personal dashboard of widgets filled from the person's
  services: [hub](openspec/specs/hub/spec.md).
- **Tasks**, what is left to resolve: [tasks](openspec/specs/tasks/spec.md).
- **Meetings**: recording, transcription, summary and follow-up tasks:
  [meetings](openspec/specs/meetings/spec.md).
- **Processes**, repeatable company and personal work, designed, tested,
  activated and run:
  [definitions](openspec/specs/process-definitions/spec.md),
  [design](openspec/specs/process-design/spec.md),
  [qualification](openspec/specs/process-qualification/spec.md),
  [execution](openspec/specs/process-execution/spec.md).
- **Skills** and **memory**: [skills](openspec/specs/skills/spec.md),
  [memory](openspec/specs/memory/spec.md).
- **Voice** requests and spoken replies in the mobile app:
  [voice](openspec/specs/voice/spec.md).
- **Services and actions** over MCP and OpenAPI, with personal sign-in:
  [service catalog](openspec/specs/service-catalog/spec.md),
  [service sign-in](openspec/specs/service-sign-in/spec.md),
  [installed connectors](openspec/specs/hosted-mcp-servers/spec.md),
  [plugins](openspec/specs/plugins/spec.md),
  [web access](openspec/specs/web-access/spec.md).
- **External AI apps** use a workspace over MCP:
  [MCP server](openspec/specs/mcp-server/spec.md).
- **People and access**: organizations, workspaces, roles, invitations and
  app sign-in: [identity and access](openspec/specs/identity-access/spec.md),
  [app pairing](openspec/specs/app-pairing/spec.md).
- **Administration**, models and usage limits:
  [administration](openspec/specs/administration/spec.md),
  [models and providers](openspec/specs/models-and-providers/spec.md),
  [inference budget](openspec/specs/inference-budget/spec.md).
- **Deployment**: one container image, one data volume, backups:
  [deployment](openspec/specs/deployment/spec.md).

English and Czech; light and dark themes.

## Repository layout

| Area                                        | Location                                            |
| ------------------------------------------- | --------------------------------------------------- |
| Server entry and configuration              | `apps/reference-server`                             |
| Identity, authorization, catalog, processes | `apps/server-identity`                              |
| Service transport, discovery, model calls   | `apps/server-integrations`                          |
| Agent runtime (Mastra)                      | `apps/server-agent`                                 |
| Workflow storage and app API                | `apps/fixture-server`                               |
| MCP endpoint for external AI apps           | `apps/server-mcp`                                   |
| Installed connectors, plugins               | `apps/server-hosting`, `apps/server-plugins`        |
| Web app and administration                  | `apps/server-admin`                                 |
| Mobile app and its cards                    | `apps/mobile`, `packages/ui-catalog`, `packages/ui` |
| Shared contracts and client transport       | `packages/protocol`, `packages/client-core`         |

## Quick start

Requires Node 22.13+ and pnpm (`corepack enable` installs the pinned version).

```sh
pnpm install --frozen-lockfile
npm run admin:build
mkdir -p .servers/local
cp examples/self-hosted/server.local.json .servers/local/server.json
npm run server -- .servers/local/server.json
```

1. Open `http://localhost:8793/admin/` and create the organization and its
   owner. On a new server the first account becomes the owner.
2. Add an AI provider, a model and the services the assistant should use.
3. Open `http://localhost:8793/` for the web app. For the mobile app, run
   `npm run android` or `npm run ios` in another terminal and sign in with the
   server address.

The example profile makes no paid calls and has no real CRM or calendar.
Keep `.servers/` out of version control.
`npm run server:admin-rotate-key -- .servers/local/server.json` prints a
recovery key.

To run Niaro as a container with HTTPS, backups and upgrades, see
[deployment](docs/guides/deployment.md). For phones on Wi-Fi, console hot
reload and tests, see [development](docs/guides/development.md).

## Development

```sh
npm run check            # lint, boundaries, types, Jest and server tests
npm run admin:build      # web app and administration bundle
npm run build            # app export for web, iOS and Android
npm run storybook:web    # component catalog for the app's cards
pnpm eval:trust          # scripted agent trust scenarios
```

Behavior changes go through an OpenSpec change; see
[development](docs/guides/development.md#working-with-openspec) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [Specifications](openspec/specs): current behavior, one per capability
- [Changes](openspec/changes): proposed and archived changes
- Guides: [deployment](docs/guides/deployment.md) ·
  [administration](docs/guides/administration.md) ·
  [installed connectors](docs/guides/hosted-connectors.md) ·
  [plugins](docs/guides/plugins.md) ·
  [development](docs/guides/development.md) ·
  [pilot](docs/guides/pilot.md)
- [Architecture](docs/architecture.md): lasting design decisions
- [Product brief](docs/brief.md)
- [UI system](docs/ui-system.md) ·
  [administration design rules](apps/server-admin/DESIGN.md)

## Contributing and security

Contributions are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md) and
follow the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## License

[MIT](LICENSE) © 2026 Filip Tůma
