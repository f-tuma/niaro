import type { z } from "zod";
import { Link } from "@tanstack/react-router";
import { MessageCircleQuestion, ShieldCheck } from "lucide-react";
import { approvalsWidget } from "../../../../../packages/protocol/widgets/approvals";
import type { ClientSession } from "../../../../../packages/client-core/session";
import type { Store } from "../../../../../packages/client-core/store";
import { useSessionState } from "../menu-page";
import {
  CountField,
  Nothing,
  WidgetRowContent,
  WidgetRows,
  widgetRowClass,
} from "./shared";
import { defineRenderer, type WidgetLanguage } from "./types";

type Data = z.infer<typeof approvalsWidget.data>;
type Config = z.infer<typeof approvalsWidget.config>;
type Waiting = {
  id: string;
  title: string;
  kind: "approval" | "question";
  conversationId: string;
};

const text = {
  cs: {
    count: "Nejvýš položek",
    nothing: "Nic na tebe nečeká.",
    approval: "Schválení",
    question: "Otázka",
    sample: ["Odeslat nabídku Acme", "Který termín schůzky?"],
  },
  en: {
    count: "Items at most",
    nothing: "Nothing waits for you.",
    approval: "Approval",
    question: "Question",
    sample: ["Send the Acme proposal", "Which meeting time?"],
  },
};

/** Work in any chat that waits for the person's approval or answer. */
export function waitingWork(
  workItems: Store["workItems"] | undefined,
): Waiting[] {
  return Object.values(workItems ?? {}).flatMap((work) =>
    work.status === "waiting_approval" || work.status === "waiting_input"
      ? [
          {
            id: work.id,
            title: work.title,
            kind:
              work.status === "waiting_approval"
                ? ("approval" as const)
                : ("question" as const),
            conversationId: work.conversationId,
          },
        ]
      : [],
  );
}

function Rows({
  items,
  language,
  preview,
}: {
  items: Waiting[];
  language: WidgetLanguage;
  preview?: boolean;
}) {
  const t = text[language];
  if (!items.length) return <Nothing>{t.nothing}</Nothing>;
  return (
    <WidgetRows>
      {items.map((item) => {
        const Icon =
          item.kind === "approval" ? ShieldCheck : MessageCircleQuestion;
        const body = (
          <WidgetRowContent
            leading={
              <Icon
                aria-label={item.kind === "approval" ? t.approval : t.question}
                className="size-4 text-muted-foreground"
              />
            }
            title={item.title}
            trailing={item.kind === "approval" ? t.approval : t.question}
          />
        );
        return (
          <li key={item.id} data-testid="approval-item" data-kind={item.kind}>
            {preview ? (
              <div className={widgetRowClass}>{body}</div>
            ) : (
              <Link
                to="/chat/$conversationId"
                params={{ conversationId: item.conversationId }}
                className={widgetRowClass}
              >
                {body}
              </Link>
            )}
          </li>
        );
      })}
    </WidgetRows>
  );
}

function Live({
  session,
  config,
  language,
}: {
  session: ClientSession;
  config: Config;
  language: WidgetLanguage;
}) {
  const state = useSessionState(session);
  return (
    <Rows
      items={waitingWork(state.store?.workItems).slice(0, config.count)}
      language={language}
    />
  );
}

export default defineRenderer<Data, Config>({
  type: "approvals",
  icon: ShieldCheck,
  Body: ({ config, language, session, preview }) =>
    session && !preview ? (
      <Live session={session} config={config} language={language} />
    ) : (
      <Rows
        preview
        language={language}
        items={text[language].sample.map((title, index) => ({
          id: String(index),
          title,
          kind: index === 0 ? "approval" : "question",
          conversationId: "",
        }))}
      />
    ),
  Config: ({ config, onChange, disabled, language }) => (
    <CountField
      label={text[language].count}
      value={config.count}
      max={12}
      disabled={disabled}
      onChange={(count) => onChange({ ...config, count })}
    />
  ),
});
