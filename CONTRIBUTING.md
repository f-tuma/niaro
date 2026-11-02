# Contributing

Thanks for your interest in Niaro. This guide explains how to set up the
project, what a good change looks like and how it gets reviewed.

## Ground rules

- Keep credentials, service calls, authorization and model routing on the
  server. The apps render what the server decides.
- Models choose only validated, registered actions. They cannot approve
  writes or create privileges.
- Preserve idempotency and unknown-outcome semantics: a retried command must
  never repeat a completed action.
- Use synthetic data and local transports in tests. Never create real
  appointments or emails, and never commit private profiles, keys, databases,
  audio recordings or customer data.
- Be respectful; the [code of conduct](CODE_OF_CONDUCT.md) applies everywhere
  in the project.

## Setup

Use Node 22.13+, pnpm (`corepack enable`) and the committed lockfile:

```sh
pnpm install --frozen-lockfile
npm run check
```

The [README](README.md#quick-start) shows how to run the server and the apps
locally; the [development guide](docs/guides/development.md) covers the rest.
Current behavior is described in [`openspec/specs`](openspec/specs), and
lasting design decisions in [architecture](docs/architecture.md).

## Making a change

1. Open an issue first for anything larger than a small fix, so the approach
   can be agreed before you invest time.
2. A behavior change starts as an OpenSpec change in `openspec/changes/<id>`:
   proposal, design, tasks and spec deltas. Get the design reviewed before you
   implement. When the change is merged, archive it so its deltas land in
   `openspec/specs`. See
   [working with OpenSpec](docs/guides/development.md#working-with-openspec).
3. Keep pull requests focused: one behavior change with its tests, spec
   deltas and guide updates.
4. Run before pushing:

   ```sh
   npm run check        # lint, boundaries, types, Jest and server tests
   npm run admin:build  # when the web app or administration changed
   spec openspec --project . -- validate --specs --strict
   ```

5. Describe the user-visible behavior, how you verified it and what remains
   unverified (for example native devices or real audio). The pull request
   template lists the details reviewers need.

### Protocol and data

Changes to public protocol contracts (`packages/protocol`) need fixtures and
tests, and update the contract requirements of the affected spec in the
change's spec deltas. Persistent storage changes must keep existing data
readable. Record decisions in the change's `design.md`; decisions that outlive
the change go to [docs/architecture.md](docs/architecture.md).

### Web app and administration

They follow [apps/server-admin/DESIGN.md](apps/server-admin/DESIGN.md) and
the [UI system](docs/ui-system.md): shared page, section, status and form
primitives, shadcn/ui components and semantic tokens. `@shadcn/lint`
enforces it; call sites may only place components, while color, typography,
spacing and shape come from component variants. Add official components with
`npx shadcn add <component> --cwd apps/server-admin`. Include light/dark and
desktop/phone-width screenshots for visual changes.

### Mobile app

UI changes need EN and CS strings, accessible labels, meaningful loading,
empty and error states, and a Storybook story or browser preview. Do not add
mocked health or status indicators to real configuration screens.

## Commits

Start the summary line with the tracker key when there is one
(`NIAR-123 Add workspace invitations`). Use the imperative mood and a short
summary line, with a body that explains why when it isn't obvious.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
