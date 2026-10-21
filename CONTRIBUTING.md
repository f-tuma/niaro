# Contributing

Thanks for your interest in Agent Client. This guide explains how to set up the project, what a good change looks like and how it gets reviewed.

## Ground rules

- Keep credentials, service calls, authorization and model routing on the server. The app renders what the server decides.
- Models choose only validated, registered actions. They cannot approve mutations or create privileges.
- Preserve idempotency and unknown-outcome semantics: a retried command must never repeat a completed action.
- Use synthetic data and local transports in tests. Never create real appointments or emails, and never commit private profiles, keys, databases, audio recordings or customer data.
- Be respectful; the [code of conduct](CODE_OF_CONDUCT.md) applies everywhere in the project.

## Setup

Use Node 22.13+, pnpm (`corepack enable`) and the committed lockfile:

```sh
pnpm install --frozen-lockfile
npm run check
```

The [README](README.md#quick-start) shows how to run the server, the console and the app locally. The [product goal](docs/goal.md), the [protocol](docs/protocol.md) and the [decision records](docs/adr) explain how the pieces fit.

## Making a change

1. Open an issue first for anything larger than a small fix, so the approach can be agreed before you invest time.
2. Keep pull requests focused: one behavior change with its tests and documentation.
3. Run before pushing:

   ```sh
   npm run check        # lint, boundaries, TypeScript, unit and identity tests
   npm run admin:build  # when the server console changed
   ```

4. Describe the user-visible behavior, how you verified it and what remains unverified (for example native devices or real audio). The pull request template lists the details reviewers need.

### Protocol and data

Changes to public protocol contracts (`packages/protocol`) need fixtures, migration or compatibility tests and an update to [docs/protocol.md](docs/protocol.md). Persistent storage changes must keep existing data readable. Record lasting decisions as an ADR in `docs/adr`.

### Server console

The console follows [apps/server-admin/DESIGN.md](apps/server-admin/DESIGN.md): shared page, section, status and form primitives, shadcn/ui components and semantic tokens. `@shadcn/lint` enforces it; call sites may only place components, while color, typography, spacing and shape come from component variants. Add official components with `npx shadcn add <component> --cwd apps/server-admin`. Include light/dark and desktop/phone-width screenshots for visual changes.

### App

UI changes need EN and CS strings, accessible labels, meaningful loading, empty and error states, and a Storybook story or browser preview. Do not add mocked health or status indicators to real configuration screens.

## Commits

Write commit messages in the imperative mood ("Add workspace invitations"), with a short summary line and a body that explains why when it isn't obvious.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
