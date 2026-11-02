# Proposal

Tracker: **NIAR-266** (inspiration research NIAR-265, `chat-reading`: CHAT-01, CHAT-02, CHAT-03, CHAT-06)

## Why

Answers with tables of deals or invoices are the core output of the chat. Today the web renderer draws Markdown headings as bold paragraphs, every table row as equal cells and code blocks without a way to copy them, all at the console's 13 px. A pasted e-mail in a request pushes the answer below the fold. A screen-reader user hears "Thinking" and then nothing when the answer is stored.

## What Changes

- **Markdown that reads (web and phone).** The safe syntax-tree renderers (`apps/server-admin/web/components/ui/markdown.tsx`, `packages/ui-catalog/MarkdownText.tsx`) render headings as real headings on a two-step scale, the first table row as a header row, and code blocks with a copy action ("Copy code"). No raw HTML, no HTML strings with a sanitiser, no syntax highlighting.
- **Chat reading size (web).** The transcript and the composer use 14 px (`text-md`) with a chat-only 22 px line height; the rest of the app, cards and generated UI keep console density. No size preference (owner decision D2). The exception is written into `apps/server-admin/DESIGN.md`.
- **Long requests fold (web).** A request taller than 12 lines folds with a fade and a **Show more** / **Show less** text button, except when it is the target of a search jump.
- **Finished answers are announced (web).** One always-mounted, invisible polite `role="status"` region says "Answer ready" and the first paragraph of each newly stored answer, once; streamed text is never announced, and two identical consecutive answers are both announced.

## Non-goals

- A Small / Normal / Large text-size preference (D2 says not now).
- The phone announcement through `AccessibilityInfo`, its skip while a reply is spoken, and a native clipboard in the phone app: done in the phone app by a separate change (`apps/mobile/*` is not touched here).
- Folding answers, attachments or cards.
- Syntax highlighting and a language label on code blocks.

## Risks

- Keep the syntax-tree route: AnythingLLM's HTML-string renderer produced its XSS advisories. Every node stays a React element with escaped text.
- 14 px applies only to the transcript's prose and the composer; generated UI and cards keep their fixed slots.
- The phone app has no clipboard module today. `MarkdownText` takes the copy function from a provider; without one (native builds until the app wires it) the action is hidden. The web build uses the browser clipboard.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat`: readable answers (headings, table header, code copy), reading size, folded long requests and the finished-answer announcement.

## Impact

- Web: `components/ui/markdown.tsx`, `app/chat-next/chat-next-page.tsx`, `app/chat-next/parts.tsx`, `app/chat-copy.ts`, `web/style.css` (one `leading-chat` token), `apps/server-admin/DESIGN.md`.
- Shared phone UI: `packages/ui-catalog/MarkdownText.tsx` and its stories, `packages/i18n/index.ts` (one NIAR-266 block).
- Tests: new `tests/web-markdown.test.tsx`; `tests/web-chat-next.test.tsx`, `tests/chat-markdown.test.tsx`.
- Server and protocol: none.
