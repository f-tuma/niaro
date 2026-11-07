# Spike NIAR-301: Pi Durable as Niaro's durable agent core

Isolated spike. Its own `package.json` with exact pins (`@earendil-works/pi-durable` 1.5.0, `pi-ai`, `chord`,
`pi-schema` 1.5.0), installed here only. No production code is imported for writing; Q1 imports
`packages/protocol/providers.ts` and `model-policy.ts` read-only, and reads the dev identity database
read-only.

Findings and captured outputs: [RESULTS.md](RESULTS.md).

## Run

Node ≥ 22.19 (Pi's engine floor; tested on 22.23.4).

```sh
cd spikes/pi-durable
pnpm install          # build scripts of @google/genai and protobufjs are denied in pnpm-workspace.yaml
pnpm typecheck
pnpm q1               # providers + model roles (Q1-B makes ONE real OpenRouter call, ~$0.00003)
SKIP_REAL=1 pnpm q1   # stub-server part only, no network
pnpm q2               # policy hooks: approval, access, budget (faux model, deterministic)
pnpm q3               # crash scenarios with real SIGKILL; or e.g. `pnpm q3 a c`
```

Q1-B reads `.servers/current.json` → identity directory → `secret` and `identity.sqlite` (read-only), unseals
the OpenRouter provider key in-process, and never prints it. It does not touch the running dev server and
does not increment the provider's daily request counter.

Runtime data goes to `.data/` (git-ignored). Captured outputs used in RESULTS.md are in `output/`.

## Layout

| File | What it is |
|---|---|
| `src/niaro-provider.ts` | Niaro runtime provider config (URL, auth none/bearer/header, dialect, catalog models) → pi-ai `Provider` |
| `src/dev-catalog.ts` | Reads the OpenRouter provider and the chat role's model from the dev identity DB; unseals the key |
| `src/stub-server.ts` | Local OpenAI-compatible streaming server that records URL, model, auth and custom headers |
| `src/policy.ts` | Our side: ledger/side-effect/access tables (node:sqlite), fake notes service, access + approval hooks, budget gate |
| `src/setup.ts` | Opens one Niaro-on-Pi Harness with a deterministic scripted model (pi-ai faux provider) |
| `scripts/q1-providers.ts` | Q1 |
| `scripts/q2-hooks.ts` | Q2 |
| `scripts/q3-crash.ts`, `scripts/q3-child.ts` | Q3 orchestrator (spawns, SIGKILLs, resumes) and the child process |
