# Server console design rules

The console is a professional admin dashboard for a self-hosted AI assistant server. Layout, hierarchy and state guide the operator; copy stays minimal. These rules are enforced by `@shadcn/lint` (`npm run lint`) wherever possible.

## Principles

1. **Design explains, words don't.** No helper paragraphs, no `?` tooltips, no labels that restate what a heading says. One short description under a page title at most. If something needs a paragraph, the flow is wrong.
2. **One way to do each thing.** Every page uses the same header, section, list, form, status and confirmation patterns listed below. No page invents its own.
3. **State is visual.** Enabled/draft/expired/failed use `StatusBadge`/`StatusDot` tones. Never a coloured sentence.
4. **One primary action per view.** It sits in the `PageHeader` actions (or `SaveBar` for forms). Everything else is `outline`, `ghost` or in a `DropdownMenu`.
5. **Progressive disclosure.** Advanced/technical options live behind a `Collapsible`, a `Sheet`, or a detail page, never inline by default. Loops expands a step in place; its technical metadata stays collapsed initially.

## Structure

- Shell (`console-shell.tsx`): sidebar with workspace switcher, grouped navigation, user menu (theme, language, sign out). Header shows breadcrumb + refresh. Pages never render their own top bar, scope selector, sign-out or language switch.
- The content fills the available width beside the sidebar, with 16 px padding on phones and 32 px from the desktop breakpoint. The shell has no fixed maximum content width; individual compact forms may constrain their own width.
- Every page starts with `PageHeader` (`@admin/components/console/page`). Nested pages pass `back`. Title is sentence case, no trailing punctuation.
- Page content is a vertical stack of `Section`s (`gap-8` comes from the shell). A `Section` has a title, optional `count` and right-aligned `actions`. Independent sections may share a responsive grid when this keeps short controls and their labels together.
- Service, plugin, AI provider and sign-in provider overviews use responsive card grids: one column on phones, then two, three and four columns as the available width grows.
- Routing pairs related model choices in two columns when their container is wide enough. Nested service routes respond to their own card width; smaller containers keep one column even on a large screen.
- Settings uses one to three columns of compact sections. Label/control rows respond to the card's width. Memory keeps its settings form at a compact theme width beside the records on wide screens, and stacks them on phones.
- Loops fills the remaining desktop content height. The run list scrolls independently on the left; the selected run's header and footer stay in place while its steps scroll. On phones, the run list and run follow each other vertically and the page scrolls normally.
- A run reads as a vertical timeline in recorded order, one step per row. The role (conversation, model, validation, internal tool, service read/write) is carried by the step's icon and a short label, never by columns. Each step shows a readable title, the service or model, at most two key facts and, only when it did not succeed, its state and reason. Missing evidence is omitted on the step, not announced. Exact identifiers, operation IDs and timestamps live in the expanded step's technical details. The step that only repeats the run's request is not listed.
- Lists and search: pass `SearchField` and filters (`Select`, `ToggleGroup`) as `toolbar` to `PageHeader` or `Section`. They share the row with the title and actions (search, filters, then the primary action) and wrap below the title on phones. The standalone `Toolbar` is only for lists inside a card or sheet that have no header of their own.

## Components (use these, in this priority)

| Need                                  | Use                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Page title + search/filters + actions | `PageHeader` (`toolbar`, `actions`)                                                                                                  |
| Region                                | `Section`                                                                                                                            |
| Rows of entities                      | `Card variant="list"` containing `Item variant="row" size="row"` (or a link via `asChild`)                                           |
| Clickable entity card                 | `Card variant="interactive"` with the title `Link` carrying `after:absolute after:inset-0`                                           |
| Tabular data                          | `Table` inside `Card variant="flush"`                                                                                                |
| Grid of entities                      | responsive grid of `Card`                                                                                                            |
| Label/value                           | `DetailList` (read-only), or `SettingRows` + `SettingRow` (label left, control right) from `components/console/setting-row`          |
| Status                                | `StatusBadge` (pill) or `StatusDot` (dense) with tone `success`/`warning`/`danger`/`info`/`neutral`                                  |
| Service/provider/plugin mark          | `EntityIcon` (`size` sm/md/lg) or `ServiceAvatar`                                                                                    |
| On/off setting                        | `Switch` in a row (not `Checkbox`). `Checkbox` is only for multi-select lists and table selection                                    |
| Choose one of few                     | `ToggleGroup variant="outline"` (≤ 4 options) or `RadioGroup`                                                                        |
| Choose one of many                    | `Select` (shadcn). `NativeSelect` only for plain filters on touch-heavy screens                                                      |
| Forms                                 | `FieldGroup` → `Field` + `FieldLabel` + control + `FieldError`. `FieldDescription` only if a value format is non-obvious (≤ 8 words) |
| Save/discard                          | `SaveBar` (sticky) with `SubmitButton`                                                                                               |
| Destructive action                    | `ConfirmAction` (AlertDialog). Trigger is `variant="ghost"` or `variant="destructive"`                                               |
| Secondary actions on a row            | `MoreActions` (`size="sm"` in rows and tables): a `ghost` icon button (`MoreHorizontal`) opening a `DropdownMenu`                    |
| Technical detail (IDs, JSON)          | `Disclosure` (closed by default) with `CodeBlock` or `DetailList` inside                                                             |
| When something happened               | `RelativeTime` (relative text, exact time in the tooltip). Never print both                                                          |
| Side editor                           | `Sheet` (right side). Full forms that need space get their own route                                                                 |
| Loop step details                     | `Collapsible` timeline step that expands in place                                                                                    |
| Empty                                 | `Empty variant="outline"` with icon, title, optional one-line description and one CTA                                                |
| Loading                               | `Skeleton` shaped like the content                                                                                                   |
| Error                                 | `Alert variant="destructive"` with a retry `Button`                                                                                  |

## Interaction rules

- **Saving.** `SaveBar` renders only while the form is dirty, saving, or showing a save error. Buttons: ghost "Discard changes", primary "Save changes" (same words everywhere). No permanent "Saved" label; once saved the bar disappears. Save is disabled while pending.
- **Destructive actions** never sit next to a primary action or in a `SaveBar`. Put them in a row/header `DropdownMenu` (`MoreHorizontal` → Delete) or on the left of a sheet footer, always through `ConfirmAction`. Hide them when the action is impossible (yourself, the last owner).
- **Sheets.** `SheetFooter` is right-aligned with the primary last; destructive goes first with `mr-auto`. Errors from a sheet's submit render inside the sheet (`Alert` above the footer), never only on the page behind it. While a multi-step save runs, the sheet cannot be closed.
- **Verbs.** "Add …" for creating anything (service, provider, account, workspace, action). The verb stays the same through the flow: button, sheet title and submit.
- **Counts** use `plural()` from `@admin/lib/plural` (Czech has one / few / other forms).
- **Permissions.** Management CTAs (add, edit, delete, setup steps) render only when the user can manage; members see read-only state, not disabled buttons.
- **Protocol and type labels** (MCP, OpenAPI, capabilities) are `Badge variant="outline"`; status uses `StatusBadge`. Never reuse a status tone for a label.
- **One refresh.** The shell header owns refresh; pages do not add their own.
- **Loop details.** Each step is a button that toggles its details in place; one step is open at a time. Switching between the overview and all steps keeps the recorded order.

## Styling

- Never restyle a component's color, typography, spacing inside, shape or effects via `className`. Only layout (margin, width, flex/grid placement) is allowed. If a treatment is missing, add a variant to `components/ui/*` deliberately — do not work around the linter.
- Tokens only (`bg-muted`, `text-muted-foreground`, `text-success`…). No raw colors, arbitrary values or inline styles.
- Density (Linear-like): body `text-sm` is 13 px, controls are 32 px (`sm` 28 px), list rows 44 px, table rows 40 px, radius 6–8 px, hairline borders, no shadows on cards.
- Type scale: page title `text-xl font-semibold` (PageHeader), section and card titles `text-md font-semibold` (14 px), body `text-sm`, meta `text-xs text-muted-foreground`. IDs (model IDs, tool names, URLs in tables) use `font-mono text-xs`.
- `CardFooter` is a neutral trailing row (no grey band, no border) pinned to the card bottom. Prefer header actions, a whole-card link or `MoreActions` over a row of footer buttons.
- Avoid: all-caps labels, `A · B · C` middle-dot strings, `→` appended to text, decorative icons in headings, nested cards (card inside card).
- Icons: lucide, `aria-hidden`, `data-icon="inline-start"` inside buttons.
- Responsive down to 360 px: grids collapse, tables hide secondary columns (`hidden md:table-cell`), toolbars wrap.
- Dark mode works automatically through tokens; check both.

## Copy

- Sentence case, verbs on buttons ("Add service", "Save changes"), the same verb through the flow.
- Errors say what happened and what to do, in one line.
- Copy lives in the feature's copy file (`catalog-copy.ts`, `plugins-copy.ts`, `i18n.ts`, `shell-copy.ts`) with complete EN and CS. Remove keys you stop using.
