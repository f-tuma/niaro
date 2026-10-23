import { useState } from "react";
import type { z } from "zod";
import { List } from "lucide-react";
import { listWidget } from "../../../../../packages/protocol/widgets/list";
import {
  AskAction,
  CountField,
  DetailPopover,
  FilterInput,
  Nothing,
  SourceLink,
  WidgetRow,
  WidgetRows,
  WidgetToolbar,
  matchesQuery,
  rowLimit,
} from "./shared";
import { defineRenderer } from "./types";

type Data = z.infer<typeof listWidget.data>;
type Config = z.infer<typeof listWidget.config>;

const text = {
  cs: {
    count: "Nejvýš řádků",
    nothing: "Nic k zobrazení.",
    nothingFiltered: "Nic takového.",
    filter: "Filtrovat…",
    rows: (shown: number, total: number) => `${shown} z ${total}`,
    more: "Řekni mi víc",
    moreText: (title: string, detail: string | undefined) =>
      `Řekni mi víc o „${title}“${detail ? ` (${detail})` : ""}.`,
    open: "Otevřít",
  },
  en: {
    count: "Rows at most",
    nothing: "Nothing to show.",
    nothingFiltered: "Nothing like that.",
    filter: "Filter…",
    rows: (shown: number, total: number) => `${shown} of ${total}`,
    more: "Tell me more",
    moreText: (title: string, detail: string | undefined) =>
      `Tell me more about "${title}"${detail ? ` (${detail})` : ""}.`,
    open: "Open",
  },
};

export default defineRenderer<Data, Config>({
  type: "list",
  icon: List,
  tall: true,
  Body: ({ data, config, language, ask, preview, expanded }) => {
    const t = text[language];
    const [selected, setSelected] = useState<number | null>(null);
    const [query, setQuery] = useState("");
    const all = data.items.slice(0, rowLimit(config.count, preview));
    const items = all
      .map((item, index) => ({ item, index }))
      .filter(({ item }) =>
        matchesQuery(query, item.title, item.detail, item.meta),
      );
    if (!all.length) return <Nothing>{t.nothing}</Nothing>;
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
        {expanded && !preview && (
          <WidgetToolbar
            start={
              <div className="w-full max-w-xs">
                <FilterInput
                  value={query}
                  label={t.filter}
                  onChange={setQuery}
                />
              </div>
            }
            end={
              items.length !== all.length ? (
                <span>{t.rows(items.length, all.length)}</span>
              ) : undefined
            }
          />
        )}
        {!items.length ? (
          <Nothing fill={expanded}>{t.nothingFiltered}</Nothing>
        ) : (
          <WidgetRows>
            {items.map(({ item, index }) => {
              const open = selected === index;
              const row = (
                <WidgetRow
                  selected={open}
                  onClick={() => setSelected(open ? null : index)}
                  title={item.title}
                  gist={item.detail}
                  trailing={item.meta}
                />
              );
              return (
                <li key={index} data-testid="list-item" className="min-w-0">
                  {preview ? (
                    row
                  ) : (
                    <DetailPopover
                      open={open}
                      onOpenChange={(next) => setSelected(next ? index : null)}
                      title={item.title}
                      description={[item.meta, item.source]
                        .filter(Boolean)
                        .join(" · ")}
                      lines={[item.detail]}
                      actions={
                        <>
                          <AskAction
                            label={t.more}
                            onAsk={() =>
                              ask(t.moreText(item.title, item.detail))
                            }
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
        )}
      </div>
    );
  },
  Config: ({ config, onChange, disabled, language }) => (
    <CountField
      label={text[language].count}
      value={config.count}
      max={20}
      disabled={disabled}
      onChange={(count) => onChange({ ...config, count })}
    />
  ),
});
