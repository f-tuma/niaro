# Design

## Context

- Web answers render through `AssistantText` (`apps/server-admin/web/app/chat-next/parts.tsx`) → `Markdown` (`components/ui/markdown.tsx`): `mdast-util-from-markdown` with GFM, one React element per node, links only for http(s)/mailto/tel, HTML and images as text. `heading` renders `<p className="font-semibold">`, every table cell is a `<td>` in a `<tbody>`, `code` is a bare `<pre><code>`. The same component renders text in generated UI (`app/generative-ui/content.tsx`).
- The chat page (`app/chat-next/chat-next-page.tsx`) shows the person's bubble at `text-sm`, the answer at the Markdown's `text-sm` and the composer textarea at the input's size (16 px on phones, 13 px from `md`). A search result opens `/chat/:id?m=<messageId>` and `useMessageLink` scrolls to and highlights that message.
- The only live regions are the "Thinking" progress (`role="status"`) inside the streamed answer and errors (`role="alert"`). Once the stored message replaces the stream, nothing is announced.
- Phone: `packages/ui-catalog/MarkdownText.tsx` (the same syntax-tree approach) renders every heading at `cardTitle`, the first table row only bold, code blocks in a horizontal `ScrollView` with no action. The app has no clipboard module.

## Goals / Non-Goals

**Goals:** answers that read like documents on both clients without leaving the safe renderer; prose at a reading size in the web chat only; long requests that do not push the answer away; an answer a screen-reader user hears.

**Non-Goals:** a text-size preference, syntax highlighting, the phone announcement and a phone clipboard (phone app, separate change), folding anything but requests.

## Decisions

### D1. Headings, table header and code in the web renderer

- `heading` of depth *d* renders as `h{min(d+1, 6)}`, so the chat title stays the page's only `h1`. `#`–`###` (`h2`–`h4`) use the section-title size (`text-md`, semibold), `####` and deeper (`h5`, `h6`) the label size (`text-sm`, semibold). A heading that is not the first block gets 12 px more space above. At the chat size the body is 14 px too, so the two steps differ by weight there.
- `table`: the first row goes into `<thead>` with `<th scope="col">` cells on `muted`, the rest into `<tbody>`; GFM column alignment becomes `text-left|center|right`. The table keeps its horizontal scroller.
- `code`: a `CodeBlock`. With `codeCopy` labels from the caller it adds a ghost icon button with a tooltip in the block's top right corner ("Copy code" / "Kopírovat kód") that writes exactly the block's text to the clipboard, then shows a check and "Copied" for 1.5 s and calls `onCopied`. Without labels (generated UI and other callers) code blocks look as before.
- `size`: `default` keeps `text-sm`; `chat` is `text-md` with `leading-chat`. It is a variant of the component (`data-size`), so call sites do not restyle it and `@shadcn/lint` stays strict.

*Alternatives.* An HTML string with a sanitiser (rejected: the XSS route of the reference project); a syntax highlighter (bundle size and two themes for little gain).

### D2. Chat reading size

`web/style.css` gets `--leading-chat: 1.375rem` in `@theme`, so `leading-chat` is a token class the linter knows. The person's bubble, the answer (`Markdown size="chat"`) and the composer (`InputGroupTextarea size="chat"`: 14 px from `md`, 16 px stays on touch screens so phones do not zoom) read at `text-md leading-chat`. Cards, step lines, meta lines and generated UI keep console density. `apps/server-admin/DESIGN.md` records the exception under Styling.

### D3. Folding long requests

`UserMessage` wraps the bubble's text in `FoldedText`. It is long when its `scrollHeight` exceeds 12 lines of 22 px; before layout (and in tests without layout) a text estimate decides (more than 12 lines when wrapped at 70 characters), and a `ResizeObserver` re-measures when the width changes. Folded, the text has `max-h-66` (264 px = 12 lines), `overflow-hidden` and a bottom `mask-image` fade (`mask-b-from-50%`, no colour, so both themes work), followed by a `Button variant="link" size="xs"` **Show more** / **Zobrazit víc** with `aria-expanded` and `aria-controls`; open, it reads **Show less** / **Zobrazit méně**. A message whose id is the `?m=` target of a search jump is never folded, so the highlighted hit is visible. Answers, attachments and cards never fold.

### D4. Announcing a stored answer

One always-mounted `<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">` sits in the chat page next to the hidden `h1`, outside the thread, so it exists before the first answer. `useAnswerAnnouncement` (`app/chat-next/announce.ts`) receives the chat's stored messages only (never the streamed draft) and whether the history is shown:

- The first time the history is shown (or, for a new chat, immediately), every stored answer id becomes known without a word: opening a chat is silent.
- Later, ids not known before are added; when the newest stored answer is among them, the region is emptied and 100 ms later set to "Answer ready. <first paragraph>" ("Odpověď je hotová. …"). Emptying first makes a second answer with identical text (a new id) be announced again. Older pages read while scrolling up are new ids but never the newest answer, so they stay silent.
- The first paragraph comes from the same Markdown parser: the first paragraph (also inside a list or quote; a heading only when there is none) as plain text, at most 300 characters. An answer without text announces "Answer ready" alone.
- Failures stay in their `role="alert"`.

### D5. Phone `MarkdownText`

- Headings keep `accessibilityRole="header"`; `#`–`###` use `cardTitle` (17 px), deeper ones `rowTitle` (16 px semibold), with `spacing.sm` above when not first.
- The first table row is a header row: semibold on `fill`, each cell with `accessibilityRole="header"`.
- Code: a quiet small **Copy code** button under the block, always visible (no long-press-only path: every gesture needs a visible equivalent). It copies through `MarkdownCopyContext` (`{copy?, language}`): the web build defaults to `navigator.clipboard`; on native nothing is provided today, so the button is hidden until the app provides a copier at its root. After copying the label reads "Copied" with a check for 1.5 s.
- Strings `copyCode` / `codeCopied` live in a NIAR-266 block in `packages/i18n/index.ts`. Call sites stay `MarkdownText text=…`.

## Risks / Trade-offs

- [Folding needs layout] → the text estimate decides until the bubble is laid out.
- [A reconnect snapshot bringing several answers] → only the newest new answer is announced, once.
- [Phone copy hidden on native until the app wires a clipboard] → handed to the phone change; the Storybook stories provide a copier.
- [Same-size headings in chat] → weight and spacing separate them; a larger chat heading would need a new type token.

## Verification

- `tests/web-markdown.test.tsx` (new): headings as `h2`/`h3`/`h5` and no `h1`, table head with `th scope="col"` and alignment, code copy writes exactly the block, shows Copied and calls `onCopied`, no copy action without labels, `size="chat"` as a variant, HTML and unsafe links stay text, the announcement summary.
- `tests/web-chat-next.test.tsx`: bubble and composer at the chat size; a 20-line request folds behind Show more and opens and folds again; a search-jump target does not fold; opening the chat and the streamed draft are silent; a stored answer is announced once with its first paragraph; a second identical answer empties the region and is announced again.
- `tests/chat-markdown.test.tsx`: phone heading steps and header row, Copy code with a provided copier, no action without one.
- Storybook: `MarkdownText` stories `HeadingsTableAndCopyCode` (EN, CS) and `CodeWithoutClipboard`.
- Commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run admin:build`.
- Not automated: a VoiceOver or NVDA pass on one answer; light, dark and 360 px screenshots.
