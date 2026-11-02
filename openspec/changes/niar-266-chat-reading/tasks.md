# Tasks

Requirement references are to this change's `chat` delta.

## 1. Web renderer

- [x] 1.1 Headings as `h2`–`h6` on two steps, the first table row as `thead`/`th`, code blocks with a copy action, a `size="chat"` variant in `components/ui/markdown.tsx`; new `tests/web-markdown.test.tsx`; verify with `npx jest tests/web-markdown.test.tsx`. (Readable answers)

## 2. Chat page

- [x] 2.1 `leading-chat` token in `web/style.css`, the exception in `apps/server-admin/DESIGN.md`, the bubble, the answer and the composer (`InputGroupTextarea size="chat"`) at `text-md leading-chat`; verify with `npm run lint`. (Chat reading size)
- [x] 2.2 Fold requests longer than 12 lines with Show more / Show less, never the search-jump target; tests in `tests/web-chat-next.test.tsx`. (Long requests fold)
- [x] 2.3 One always-mounted polite status region announcing "Answer ready" and the first paragraph once per newly stored answer (`app/chat-next/announce.ts`); tests for silence on open and while streaming and for two identical answers. (Finished answers are announced)

## 3. Phone renderer

- [x] 3.1 `MarkdownText`: heading steps, header row, Copy code through `MarkdownCopyContext`; NIAR-266 strings in `packages/i18n/index.ts`; stories and `tests/chat-markdown.test.tsx`. (Readable answers)
- [ ] 3.2 Phone app: announce stored answers through `AccessibilityInfo` (skipped while a reply is spoken) and provide a native clipboard to `MarkdownCopyContext` (separate change, `apps/mobile/*`). (Readable answers, Finished answers are announced)

## 4. Integration

- [x] 4.1 `npm run lint`, `npm run typecheck`, `npm test`, `npm run admin:build`.
- [ ] 4.2 Screen-reader pass (VoiceOver or NVDA) on one answer; light, dark and 360 px screenshots of an answer with a heading, a table and code, and of a folded request.
