import { useState } from "react";
import type { z } from "zod";
import { ArrowDownWideNarrow, UserRoundCheck } from "lucide-react";
import { StatusBadge } from "@admin/components/console/status";
import { Button } from "@admin/components/ui/button";
import { followupsWidget } from "../../../../../packages/protocol/widgets/followups";
import {
  AskAction,
  CountField,
  DetailPopover,
  Nothing,
  SourceLink,
  WidgetRow,
  WidgetRows,
  WidgetToolbar,
  formatWhen,
} from "./shared";
import { defineRenderer } from "./types";

type Data = z.infer<typeof followupsWidget.data>;
type Config = z.infer<typeof followupsWidget.config>;

const text = {
  cs: {
    count: "Nejvýš položek",
    nothing: "Nikdo nečeká.",
    urgent: "Spěchá",
    last: "naposledy",
    byPriority: "Spěchající první",
    write: "Napiš follow-up",
    writeText: (who: string, reason: string) =>
      `Napiš follow-up pro ${who}. Důvod: ${reason}`,
    open: "Otevřít",
  },
  en: {
    count: "Items at most",
    nothing: "Nobody waits.",
    urgent: "Urgent",
    last: "last",
    byPriority: "Urgent first",
    write: "Write a follow-up",
    writeText: (who: string, reason: string) =>
      `Write a follow-up for ${who}. Reason: ${reason}`,
    open: "Open",
  },
};

export default defineRenderer<Data, Config>({
  type: "followups",
  icon: UserRoundCheck,
  tall: true,
  Body: ({ data, config, language, ask, preview }) => {
    const t = text[language];
    const [byPriority, setByPriority] = useState(false);
    const [selected, setSelected] = useState<number | null>(null);
    const all = data.items.slice(0, config.count);
    const mixed =
      all.some((item) => item.priority === "high") &&
      all.some((item) => item.priority !== "high");
    const items = all.map((item, index) => ({ item, index }));
    if (byPriority)
      items.sort(
        (a, b) =>
          Number(b.item.priority === "high") -
          Number(a.item.priority === "high"),
      );
    if (!all.length) return <Nothing>{t.nothing}</Nothing>;
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
        {!preview && mixed && (
          <WidgetToolbar
            end={
              <Button
                variant="ghost"
                size="xs"
                aria-pressed={byPriority}
                data-testid="followups-sort"
                onClick={() => setByPriority((value) => !value)}
              >
                <ArrowDownWideNarrow
                  data-icon="inline-start"
                  aria-hidden="true"
                />
                {t.byPriority}
              </Button>
            }
          />
        )}
        <WidgetRows>
          {items.map(({ item, index }) => {
            const open = selected === index;
            const row = (
              <WidgetRow
                selected={open}
                onClick={() => setSelected(open ? null : index)}
                emphasis={item.priority === "high"}
                title={item.who}
                badge={
                  item.priority === "high" ? (
                    <StatusBadge tone="warning">{t.urgent}</StatusBadge>
                  ) : undefined
                }
                trailing={
                  item.lastContact
                    ? formatWhen(item.lastContact, language)
                    : undefined
                }
                gist={item.reason}
              />
            );
            return (
              <li
                key={index}
                data-testid="followup-item"
                data-priority={item.priority ?? "normal"}
                className="min-w-0"
              >
                {preview ? (
                  row
                ) : (
                  <DetailPopover
                    open={open}
                    onOpenChange={(next) => setSelected(next ? index : null)}
                    title={item.who}
                    description={
                      item.lastContact &&
                      `${t.last} ${formatWhen(item.lastContact, language)}` +
                        (item.source ? ` · ${item.source}` : "")
                    }
                    lines={[item.reason]}
                    actions={
                      <>
                        <AskAction
                          label={t.write}
                          onAsk={() => ask(t.writeText(item.who, item.reason))}
                        />
                        {item.link && (
                          <SourceLink href={item.link} label={t.open} />
                        )}
                      </>
                    }
                  >
                    {row}
                  </DetailPopover>
                )}
              </li>
            );
          })}
        </WidgetRows>
      </div>
    );
  },
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
