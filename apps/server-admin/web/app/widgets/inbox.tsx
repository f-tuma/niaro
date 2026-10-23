import { useEffect, useState, type ComponentProps } from "react";
import type { z } from "zod";
import { BookOpen, Mail, MessagesSquare } from "lucide-react";
import { StatusBadge } from "@admin/components/console/status";
import { Button } from "@admin/components/ui/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import type { ClientSession } from "../../../../../packages/client-core/session";
import type { HubItemDetail } from "../../../../../packages/protocol/hub";
import { inboxWidget } from "../../../../../packages/protocol/widgets/inbox";
import {
  AskAction,
  CountField,
  DetailLines,
  DetailPane,
  DetailPopover,
  Nothing,
  SourceLink,
  SplitPane,
  SwitchField,
  WidgetRow,
  WidgetRows,
  WidgetToolbar,
  formatWhen,
  rowLimit,
} from "./shared";
import { EmailDoc, LinkedText } from "./email-doc";
import { defineRenderer, type WidgetAsk, type WidgetLanguage } from "./types";

type Data = z.infer<typeof inboxWidget.data>;
type Config = z.infer<typeof inboxWidget.config>;
type Email = Data["emails"][number];
type Filter = "all" | "important" | "unread";
/** A message body as the reader has it; absent while it loads. */
type Loaded = { status: "ok"; detail: HubItemDetail } | { status: "failed" };
/** Loading shows a word only after this long: an indexed body comes at once. */
const LOADING_WORD_MS = 300;

const text = {
  cs: {
    high: "Důležité",
    nothing: "Nic, co by čekalo na tebe.",
    nothingFiltered: "Nic takového.",
    unread: (count: number) => `${count} nepřečtených`,
    unreadOne: "Nepřečtený",
    thread: (count: number) => `${count} ve vlákně`,
    filters: { all: "Vše", important: "Důležité", unread: "Nepřečtené" },
    filter: "Filtr",
    read: "Přečíst",
    loading: "Načítám…",
    failed: "Nejde načíst.",
    to: "Komu",
    reply: "Navrhni odpověď",
    replyText: (from: string, subject: string, received: string) =>
      `Navrhni odpověď na e-mail od ${from} „${subject}“ (${received}).`,
    wants: "Co po mně chce?",
    wantsText: (from: string, subject: string, received: string) =>
      `Co po mně chce ${from} v e-mailu „${subject}“ (${received})? Shrň vlákno a navrhni další krok.`,
    received: "Přišlo",
    action: "Doporučení",
    open: "Otevřít",
    count: "Nejvýš e-mailů",
    importantOnly: "Jen důležité",
    describe: (count: number, important: boolean) =>
      `${count} ${important ? "důležitých " : ""}e-mailů`,
  },
  en: {
    high: "Important",
    nothing: "Nothing waits for you.",
    nothingFiltered: "Nothing like that.",
    unread: (count: number) => `${count} unread`,
    unreadOne: "Unread",
    thread: (count: number) => `${count} in thread`,
    filters: { all: "All", important: "Important", unread: "Unread" },
    filter: "Filter",
    read: "Read",
    loading: "Loading…",
    failed: "Can't load.",
    to: "To",
    reply: "Draft a reply",
    replyText: (from: string, subject: string, received: string) =>
      `Draft a reply to the email from ${from} "${subject}" (${received}).`,
    wants: "What do they want?",
    wantsText: (from: string, subject: string, received: string) =>
      `What does ${from} want from me in the email "${subject}" (${received})? Summarize the thread and suggest the next step.`,
    received: "Received",
    action: "Suggested",
    open: "Open",
    count: "Emails at most",
    importantOnly: "Important only",
    describe: (count: number, important: boolean) =>
      `${count} ${important ? "important " : ""}emails`,
  },
};

const passes = (email: Email, filter: Filter) =>
  filter === "all"
    ? true
    : filter === "important"
      ? email.importance === "high"
      : email.unreadFlag === true;
/** An email's key within its widget: the source's id, else its position. */
const keyOf = (email: Email, index: number) => email.id ?? `#${index}`;
/**
 * The row last chosen in each widget, by item id. The body is mounted again
 * in the expand dialog, so "Read" on the card hands its row over through
 * this map; the dialog's body reads it once, when it mounts.
 */
const lastSelection = new Map<string, string>();

/** The prepared requests of one email; the link lives in the detail header. */
function Actions({
  email,
  language,
  ask,
}: {
  email: Email;
  language: WidgetLanguage;
  ask: WidgetAsk;
}) {
  const t = text[language];
  const received = formatWhen(email.receivedAt, language);
  return (
    <>
      <AskAction
        label={t.reply}
        onAsk={() =>
          ask(
            t.replyText(email.from, email.subject, received) +
              (email.suggestedAction ? ` ${email.suggestedAction}.` : ""),
          )
        }
      />
      <AskAction
        label={t.wants}
        onAsk={() => ask(t.wantsText(email.from, email.subject, received))}
      />
    </>
  );
}

/** "Received 10/18 3:24 AM · Microsoft 365 · 3 in thread" */
function metaOf(email: Email, language: WidgetLanguage) {
  const t = text[language];
  return [
    `${t.received} ${formatWhen(email.receivedAt, language)}`,
    email.source,
    email.threadCount !== undefined && email.threadCount > 1
      ? t.thread(email.threadCount)
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The card's popover: the gist, the suggestion, then the actions. */
function Detail({
  email,
  language,
  ask,
  onRead,
}: {
  email: Email;
  language: WidgetLanguage;
  ask: WidgetAsk;
  /** Opens the message in the reader; absent when it cannot be read. */
  onRead?: () => void;
}) {
  const t = text[language];
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-testid="inbox-detail"
      data-importance={email.importance}
    >
      <DetailLines
        lines={[
          email.summary,
          email.suggestedAction && (
            <span key="action">
              <span className="text-muted-foreground">{t.action}: </span>
              {email.suggestedAction}
            </span>
          ),
        ]}
      />
      <div className="flex flex-wrap items-center gap-1">
        {onRead && (
          <Button size="xs" data-testid="inbox-read" onClick={onRead}>
            <BookOpen data-icon="inline-start" aria-hidden="true" />
            {t.read}
          </Button>
        )}
        <Actions email={email} language={language} ask={ask} />
        {email.link && <SourceLink href={email.link} label={t.open} />}
      </div>
    </div>
  );
}

/** The reading pane of the large view: the message as plain text. */
function Reader({
  email,
  state,
  language,
  ask,
}: {
  email: Email;
  /** Null when the body cannot be read here (no session or no id). */
  state: Loaded | { status: "loading"; slow: boolean } | null;
  language: WidgetLanguage;
  ask: WidgetAsk;
}) {
  const t = text[language];
  const detail = state?.status === "ok" ? state.detail : null;
  const meta = [
    detail?.from || email.from,
    detail?.to?.length ? `${t.to}: ${detail.to.join(", ")}` : "",
    formatWhen(detail?.at ?? email.receivedAt, language),
  ]
    .filter(Boolean)
    .join(" · ");
  const status =
    state?.status === "loading"
      ? state.slow
        ? t.loading
        : undefined
      : state?.status === "failed"
        ? t.failed
        : undefined;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="inbox-reader"
      data-status={state?.status ?? "summary"}
    >
      <DetailPane
        title={email.subject}
        meta={meta}
        link={detail?.link ?? email.link}
        linkLabel={t.open}
        status={status && <span data-testid="inbox-status">{status}</span>}
        actions={<Actions email={email} language={language} ask={ask} />}
      >
        {detail ? (
          detail.doc ? (
            <div data-testid="inbox-body">
              <EmailDoc key={email.id} doc={detail.doc} language={language} />
              {detail.truncated && "…"}
            </div>
          ) : (
            <p
              className="text-sm leading-relaxed whitespace-pre-wrap"
              data-testid="inbox-body"
            >
              <LinkedText text={detail.text} />
              {detail.truncated && "…"}
            </p>
          )
        ) : (
          state?.status !== "loading" && (
            <DetailLines
              lines={[
                <span key="summary" className="text-muted-foreground">
                  {email.summary}
                </span>,
                email.suggestedAction && (
                  <span key="action">
                    <span className="text-muted-foreground">{t.action}: </span>
                    {email.suggestedAction}
                  </span>
                ),
              ]}
            />
          )
        )}
      </DetailPane>
    </div>
  );
}

/** A row; the popover trigger's props (and ref) pass through to the button. */
function Row({
  email,
  language,
  selected,
  summary,
  preview,
  ...props
}: {
  email: Email;
  language: WidgetLanguage;
  selected: boolean;
  /** The card shows the gist under the subject; the reader's list doesn't. */
  summary?: boolean;
  /** The gallery's narrow preview: the sender and subject, no badge. */
  preview?: boolean;
} & Omit<ComponentProps<"button">, "title">) {
  const t = text[language];
  const unread = email.unreadFlag === true;
  return (
    <WidgetRow
      {...props}
      selected={selected}
      emphasis={unread}
      leading={
        <span
          aria-label={unread ? t.unreadOne : undefined}
          data-testid="inbox-unread"
          data-unread={unread}
          className="size-1.5 rounded-full data-[unread=true]:bg-primary"
        />
      }
      title={email.from}
      badge={
        email.importance === "high" && !preview ? (
          <StatusBadge tone="warning">{t.high}</StatusBadge>
        ) : undefined
      }
      trailing={formatWhen(email.receivedAt, language)}
      detail={
        <>
          <span className="min-w-0 flex-1 truncate">{email.subject}</span>
          {email.threadCount !== undefined && email.threadCount > 1 && (
            <span
              aria-label={t.thread(email.threadCount)}
              className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground tabular-nums"
            >
              <MessagesSquare aria-hidden="true" className="size-3" />
              {email.threadCount}
            </span>
          )}
        </>
      }
      gist={summary && !preview ? email.summary || undefined : undefined}
    />
  );
}

/** Loads the shown message's body once; aborts when the row or dialog changes. */
function useBody(input: {
  session: ClientSession | undefined;
  itemId: string | undefined;
  ref: string | undefined;
  language: WidgetLanguage;
  active: boolean;
}) {
  const { session, itemId, ref, language, active } = input;
  const [bodies, setBodies] = useState<Record<string, Loaded>>({});
  const [slow, setSlow] = useState(false);
  const cached = ref ? bodies[ref] : undefined;
  useEffect(() => {
    if (!active || !session || !itemId || !ref || cached) return;
    const controller = new AbortController();
    const timer = setTimeout(() => setSlow(true), LOADING_WORD_MS);
    session.openHubItem(language, itemId, ref, controller.signal).then(
      (detail) => {
        if (!controller.signal.aborted)
          setBodies((prev) => ({ ...prev, [ref]: { status: "ok", detail } }));
      },
      () => {
        if (!controller.signal.aborted)
          setBodies((prev) => ({ ...prev, [ref]: { status: "failed" } }));
      },
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
      setSlow(false);
    };
  }, [active, session, itemId, ref, language, cached]);
  if (!session || !itemId || !ref) return null;
  return cached ?? { status: "loading" as const, slow };
}

export default defineRenderer<Data, Config>({
  type: "inbox",
  icon: Mail,
  tall: true,
  describe: (config, language) =>
    text[language].describe(config.count, config.importantOnly),
  Body: ({
    data,
    config,
    item,
    language,
    ask,
    session,
    preview,
    expanded,
    onExpand,
  }) => {
    const t = text[language];
    const [filter, setFilter] = useState<Filter>("all");
    // The card's popover, or the reader's row (handed over from the card).
    const [selected, setSelected] = useState<string | null>(() =>
      expanded && item ? (lastSelection.get(item.id) ?? null) : null,
    );
    const all = data.emails
      .slice(0, rowLimit(config.count, preview))
      .map((email, index) => ({ email, key: keyOf(email, index) }));
    const flagged = all.some(({ email }) => email.unreadFlag !== undefined);
    const emails = all.filter(({ email }) => passes(email, filter));
    const shown =
      expanded && emails.length
        ? (emails.find(({ key }) => key === selected) ?? emails[0]!)
        : null;
    const select = (key: string | null) => {
      setSelected(key);
      if (item && key) lastSelection.set(item.id, key);
    };
    const state = useBody({
      session,
      itemId: item?.id,
      ref: shown?.email.id,
      language,
      active: !!expanded,
    });
    const chips: Filter[] = flagged
      ? ["all", "important", "unread"]
      : ["all", "important"];
    const filters = !preview && all.length > 0;
    const toolbar = (
      <WidgetToolbar
        start={
          data.unread !== undefined ? (
            <span data-testid="inbox-header">{t.unread(data.unread)}</span>
          ) : undefined
        }
        end={
          filters ? (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={filter}
              aria-label={t.filter}
              data-testid="inbox-filter"
              onValueChange={(next) => {
                if (next) setFilter(next as Filter);
              }}
            >
              {chips.map((chip) => (
                <ToggleGroupItem key={chip} value={chip}>
                  {t.filters[chip]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : undefined
        }
      />
    );
    const list = (
      <WidgetRows>
        {emails.map(({ email, key }) => {
          const open = selected === key;
          const row = (
            <Row
              email={email}
              language={language}
              summary={!expanded}
              preview={preview}
              selected={expanded ? shown?.key === key : open}
              onClick={() => select(open && !expanded ? null : key)}
            />
          );
          return (
            <li
              key={key}
              data-testid="inbox-email"
              data-importance={email.importance}
              className="min-w-0"
            >
              {preview || expanded ? (
                row
              ) : (
                <DetailPopover
                  open={open}
                  onOpenChange={(next) => select(next ? key : null)}
                  title={email.subject}
                  description={`${email.from} · ${metaOf(email, language)}`}
                  body={
                    <Detail
                      email={email}
                      language={language}
                      ask={ask}
                      onRead={
                        onExpand && session && item && email.id
                          ? () => {
                              // The dialog's body picks the row up on mount.
                              lastSelection.set(item.id, key);
                              setSelected(null);
                              onExpand();
                            }
                          : undefined
                      }
                    />
                  }
                >
                  {row}
                </DetailPopover>
              )}
            </li>
          );
        })}
      </WidgetRows>
    );
    const empty = !all.length ? (
      <Nothing fill={expanded}>{t.nothing}</Nothing>
    ) : !emails.length ? (
      <Nothing fill={expanded}>{t.nothingFiltered}</Nothing>
    ) : null;
    if (!expanded)
      return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
          {!preview && toolbar}
          {empty ?? list}
        </div>
      );
    return (
      <SplitPane
        list={
          <>
            {toolbar}
            {empty ?? <div className="min-h-0 overflow-y-auto">{list}</div>}
          </>
        }
        detail={
          shown ? (
            <Reader
              email={shown.email}
              state={state}
              language={language}
              ask={ask}
            />
          ) : (
            <Nothing fill>{t.nothing}</Nothing>
          )
        }
      />
    );
  },
  Config: ({ config, onChange, disabled, language }) => {
    const t = text[language];
    return (
      <>
        <CountField
          label={t.count}
          value={config.count}
          max={12}
          disabled={disabled}
          onChange={(count) => onChange({ ...config, count })}
        />
        <SwitchField
          label={t.importantOnly}
          checked={config.importantOnly}
          disabled={disabled}
          onChange={(importantOnly) => onChange({ ...config, importantOnly })}
        />
      </>
    );
  },
});
