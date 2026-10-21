import type { z } from "zod";
import { Sparkles } from "lucide-react";
import { Markdown } from "@admin/components/ui/markdown";
import { briefingWidget } from "../../../../../packages/protocol/widgets/briefing";
import {
  AskAction,
  ChoiceField,
  Nothing,
  SourceLink,
  WidgetRowContent,
  WidgetRows,
  widgetRowClass,
} from "./shared";
import { defineRenderer } from "./types";

type Data = z.infer<typeof briefingWidget.data>;
type Config = z.infer<typeof briefingWidget.config>;

const text = {
  cs: {
    length: "Délka",
    lengths: { short: "Krátce", normal: "Víc" },
    nothing: "Nic nového.",
    open: "Otevřít",
    expand: "Rozveď to",
    expandText: (text: string, source: string | undefined) =>
      `Rozveď to: „${text}“${source ? ` (${source})` : ""}.`,
  },
  en: {
    length: "Length",
    lengths: { short: "Short", normal: "Longer" },
    nothing: "Nothing new.",
    open: "Open",
    expand: "Tell me more",
    expandText: (text: string, source: string | undefined) =>
      `Tell me more: "${text}"${source ? ` (${source})` : ""}.`,
  },
};

export default defineRenderer<Data, Config>({
  type: "briefing",
  icon: Sparkles,
  Body: ({ data, language, ask, preview }) => {
    const t = text[language];
    if (!data.summary && !data.highlights.length)
      return <Nothing>{t.nothing}</Nothing>;
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {data.summary && (
          <div className="leading-relaxed">
            <Markdown text={data.summary} />
          </div>
        )}
        {data.highlights.length > 0 && (
          <WidgetRows>
            {data.highlights.map((highlight, index) => (
              <li key={index} data-testid="briefing-highlight">
                <div className={widgetRowClass}>
                  <WidgetRowContent
                    leading={
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full bg-primary"
                      />
                    }
                    title={
                      <span className="whitespace-normal">
                        {highlight.text}
                      </span>
                    }
                    trailing={
                      <span className="flex items-center gap-1">
                        {highlight.source}
                        {!preview && (
                          <AskAction
                            iconOnly
                            label={t.expand}
                            onAsk={() =>
                              ask(
                                t.expandText(highlight.text, highlight.source),
                              )
                            }
                          />
                        )}
                        {highlight.link && (
                          <SourceLink href={highlight.link} label={t.open} />
                        )}
                      </span>
                    }
                  />
                </div>
              </li>
            ))}
          </WidgetRows>
        )}
      </div>
    );
  },
  Config: ({ config, onChange, disabled, language }) => {
    const t = text[language];
    return (
      <ChoiceField
        label={t.length}
        value={config.length}
        disabled={disabled}
        options={(["short", "normal"] as const).map((value) => ({
          value,
          label: t.lengths[value],
        }))}
        onChange={(length) => onChange({ ...config, length })}
      />
    );
  },
});
