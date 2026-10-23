# Generative UI

An assistant answer is Markdown text. When a visual helps the person (a comparison, numbers, several records, a schedule, a status, a short form), the answer also carries one [OpenUI Lang](https://www.openui.com/docs/openui-lang) program that the web app and the phone render with their own design system. The program is presentation: it grants no permission, runs no service action and fetches no data. Approvals, questions with options, process offers, sign-in cards and hub widgets are system UI and stay as they were.

OpenUI (MIT, `github.com/thesysdev/openui`) is used locally: no OpenUI Gateway or Thesys cloud, no telemetry. Models are called through the existing provider catalog.

## Output contract

The model writes its reply as text with at most one fenced program after it:

````text
Sales grew in Q3, mainly in Prague.

```openui-lang
root = Stack([kpis, chart, top])
kpis = Row([Metric("Revenue Q3", "1.2 M", "CZK", "+12 % vs Q2", "success"), Metric("Orders", 340)])
chart = BarChart(["Jul", "Aug", "Sep"], [Series("Revenue", [380, 410, 440])])
top = Table(["Branch", "Revenue"], [["Prague", 520], ["Brno", 310]])
```
````

The program travels inside the reply stream, as OpenUI recommends for chat: its _inline mode_ is exactly "text, optionally with fenced OpenUI Lang", and the parser reads code from fences itself. Compared with the retired `compose_card` tool call this

- needs no extra model step after a tool result, and costs fewer tokens (OpenUI Lang is compact positional code, not a JSON graph);
- streams with the text: a renderer can draw each statement as its line arrives;
- keeps the program in the model's history as the assistant's own text, which OpenUI recommends so the next turn can change the UI ("make it a pie chart"); tool calls lost their arguments in history. The existing privacy projection still applies: a later turn sees an earlier answer that used service or memory data only as "[Prior private response withheld]", program included, which also keeps old programs out of the prompt.

The prompt asks for UI only when it helps, a one- or two-sentence text beside it, no UI for a simple answer, only facts from this turn's tool results, the person's language, and a complete program every time (no OpenUI edit patches).

The instructions come from lang-core's `generateSystemPrompt` in local mode (`{ library, promptOptions }`, never `cloud: true`), built once from the shared library spec (`packages/openui-library/prompt.ts`). Bindings and built-in functions stay supported by the renderers but are not advertised, which keeps the prompt near 2.5k tokens. The built-in `@ToAssistant` description offers hidden context; ours replaces it, since nothing hidden ever travels.

## Server: admission and storage

`apps/server-identity/mastra-domain.ts` finalizes an answer in this order:

1. `splitReply` separates the Markdown text from the first ` ```openui-lang ` fence (further programs are dropped; a reply that is only a bare program is accepted too).
2. `checkProgram` (`packages/openui-library/program.ts`) parses with lang-core's parser and the shared library and returns a normalized program, or refuses it. A refused program is sent back to the model once as a repair ("fix the program or leave it out"); a second refusal leaves the text alone.
3. The consistency checker receives the program's readable strings as `generatedUi` beside the reply. A rejection discards the UI with the reply.
4. System answers (an approval, a question, a sign-in, a drafted skill or process, a process offer) never carry UI. A failed, unknown or partly refused write is explained in text alone.
5. The admitted program is stored with the message as `ui: { type: "openui.program", version: 1, library: "niaro-ui@1", program }` (`packages/protocol/generative-ui.ts`), beside any service result. The text stays a complete answer, used for voice, search, memory and older clients; if the model wrote no text, the first heading becomes the text.

Admission rules:

| Program part                                                                                                | Result                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Unknown component, invalid statement, wrong arguments                                                       | dropped (lang-core parser)                                                                          |
| A component where its parent does not accept it (from the library schema)                                   | dropped                                                                                             |
| `Query`, `Mutation`, `@Run`                                                                                 | whole program refused (not supported in v1)                                                         |
| `@ToAssistant(message)`                                                                                     | kept; message at most 500 characters                                                                |
| `@OpenUrl(url)`, `Link(label, url)`                                                                         | kept only for a literal http(s) address that passes `displayLink`; otherwise the control is dropped |
| `@Set`, `@Reset`, `$variables`, ternaries                                                                   | kept (local UI state)                                                                               |
| Custom steps, other `@functions`                                                                            | the control or value is dropped                                                                     |
| More than 16,000 characters, 64 components, 12 actions or 8 levels; no `root = Stack(...)`; nothing to show | whole program refused                                                                               |
| Longer strings and arrays than the schema allows (e.g. 50 table rows)                                       | cut to the limit                                                                                    |

Images are not part of the library, as they were not part of cards. Model and service text stays text: both renderers escape it (React), and `Markdown` uses the same safe renderer as chat replies.

Delivery is negotiated: clients that render UI add `ui=agent-openui%2F1` to `snapshot`, `events`, `commands` and `conversations/messages`; other clients receive the message without `ui`. The web app and the phone ask for it.

## Component library

`packages/openui-library/spec.ts` is the one spec: component names, positional arguments (zod key order), descriptions and limits. The server builds the prompt and validates from it; both clients bind their renderers to the same objects, so names and schemas cannot drift.

| Group             | Components                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Layout            | `Stack` (root), `Row`, `Grid`, `Section`, `Tabs`/`Tab`, `Accordion`/`AccordionItem`, `Separator`                         |
| Content           | `Heading`, `Text`, `Markdown`, `Callout`, `Badge`, `Link`                                                                |
| Data              | `Metric`, `Details`/`Detail`, `List`/`ListItem`, `Table` (sorting off by default), `Progress`, `Timeline`/`TimelineItem` |
| Charts            | `BarChart`, `LineChart`, `PieChart` (donut), `Series`                                                                    |
| Actions and forms | `Button`, `Buttons`, `Form`, `TextField`, `Select`, `Checkbox`, `DateField`                                              |

Containers nest one way (Stack › Tabs/Accordion › Section › Row/Grid › blocks), which keeps generated layouts shallow. A `Detail` whose value is a complete email, phone number or https URL becomes a link, as card fields did.

- **Web** (`apps/server-admin/web/app/generative-ui/`): `createLibrary` and `Renderer` from `@openuidev/react-lang`, with shadcn components, the console patterns and the existing chart setup; light and dark from the tokens.
- **Phone** (`packages/ui-catalog/GenerativeUiView.tsx`, `generative-ui-runtime.ts`, `generative-ui-components.tsx`, `generative-ui-charts.tsx`): react-lang 1.0.1 renders DOM elements, so the app has its own renderer on lang-core's streaming parser, store and evaluator, mapping the same names to the React Native UI kit; charts are drawn with `react-native-svg`.

## Actions

- `@ToAssistant(message)` and a button without an action put a message in the person's message box; the person reviews and sends it. Nothing is sent automatically, so a write still goes through the ordinary turn and its approval. In a `Form`, the answered fields follow the message as `Label: value` lines (`followUpMessage` in `packages/openui-library/follow-up.ts`).
- `@OpenUrl(url)` and `Link` open an http(s) address checked again on the client.
- `@Set` and `@Reset` change local UI state only.

Read-only (archived) chats show the UI without actions.

## Streaming and history

Both renderers accept partial input: lang-core re-parses the accumulated text and shows complete statements as they arrive. The chat transport currently delivers an answer when it is complete (the reply is checked before publication), so the web app renders on arrival today and progressively once answers stream; the phone renders on completion.

The program is stored with its message and re-renders from history. The model's own thread keeps the program as its text (subject to the private-response projection above), so a follow-up can change it.

Messages stored with an old model-composed card (`result.type: "card.document"`) render as text: the message, then the card's title and text content (`cardDocumentText`). No data migration is needed. The server still resolves `card.respond` for such a stored card from older app builds; new clients no longer show card forms.

## Server cards

The server's own passive cards remain: service results and work summaries are built deterministically by `apps/server-cards/adapters.ts` and `CardBuilder` (`apps/server-cards/builders.ts`, passive documents only) and travel behind `cards=agent-card%2F1` as before. They are system UI, not model output.

## Privacy and dependencies

`@openuidev/lang-core` and `@openuidev/react-lang` are pinned to 1.0.1. Checked in their published code:

- lang-core's postinstall sends installation telemetry: `pnpm-workspace.yaml` denies its build script (`allowBuilds`), so it never runs.
- lang-core's runtime telemetry (sampled prompt-generation and parse events) runs only on a server that sets `OPENUI_RUNTIME_TELEMETRY_ENABLED`; `program.ts` also forces `OPENUI_TELEMETRY_DISABLED=1`. It never runs in a browser or React Native.
- react-lang's development build would mount `@openuidev/devtools`, which loads its UI from a CDN: the package is removed with a pnpm override and the web build aliases it to an empty module.
- `@openuidev/observability` is an in-memory event bus without network access.
- react-lang's renderer inserts one `<style>` element (a spinner keyframe for queries, which we do not use) without a nonce; the console CSP blocks it with one console message and nothing else changes.

## Verification

- `tests/generative-ui.test.ts`: admission (valid, unknown, nesting, Query/Mutation, unsafe links and steps, caps), reply splitting, follow-up text, negotiation, local prompt without network or telemetry.
- `tests/mastra-domain.node.ts`, `tests/native-tool-validation.node.ts`, `tests/mastra-http.node.ts`, `tests/action-failure-agent.node.ts` and the `ui-*` trust scenarios: repair, normalized storage, checker wiring, no UI for unknown writes, HTTP delivery.
- `tests/web-generative-ui.test.tsx` and `tests/mobile-generative-ui.test.tsx`: rendering, streaming input, follow-ups, links, local state and the text fallback for old cards.

Live-model quality of the UI (when to show it, layout choice, factual agreement) is measured separately, like the rest of the agent's answers.
