import type { z } from "zod";
import { Link } from "@tanstack/react-router";
import { AudioLines } from "lucide-react";
import { StatusBadge } from "@admin/components/console/status";
import { meetingsWidget } from "../../../../../packages/protocol/widgets/meetings";
import {
  CountField,
  Nothing,
  WidgetRowContent,
  WidgetRows,
  formatWhen,
  rowLimit,
  widgetRowClass,
} from "./shared";
import { defineRenderer } from "./types";

type Data = z.infer<typeof meetingsWidget.data>;
type Config = z.infer<typeof meetingsWidget.config>;

const text = {
  cs: {
    count: "Nejvýš schůzek",
    nothing: "Zatím žádná nahraná schůzka.",
    processing: "Zpracovává se",
    failed: "Nepovedlo se",
    next: "Další:",
    tasks: (count: number) =>
      count === 1 ? "1 úkol" : count < 5 ? `${count} úkoly` : `${count} úkolů`,
  },
  en: {
    count: "Meetings at most",
    nothing: "No recorded meeting yet.",
    processing: "Processing",
    failed: "Failed",
    next: "Next:",
    tasks: (count: number) => (count === 1 ? "1 task" : `${count} tasks`),
  },
};

export default defineRenderer<Data, Config>({
  type: "meetings",
  icon: AudioLines,
  Body: ({ data, config, language, preview }) => {
    const t = text[language];
    // A meeting takes three lines: the preview has room for one.
    const meetings = data.meetings.slice(0, rowLimit(config.count, preview, 1));
    if (!meetings.length) return <Nothing>{t.nothing}</Nothing>;
    return (
      <WidgetRows>
        {meetings.map((meeting) => {
          const body = (
            <WidgetRowContent
              leading={
                <AudioLines
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              }
              title={meeting.title}
              badge={
                meeting.status !== "ready" ? (
                  <StatusBadge
                    tone={meeting.status === "failed" ? "danger" : "info"}
                  >
                    {meeting.status === "failed" ? t.failed : t.processing}
                  </StatusBadge>
                ) : undefined
              }
              // The preview's narrow row keeps its lines for the text.
              trailing={formatWhen(meeting.recordedAt, language, !preview)}
              detail={
                meeting.tasks > 0 ? (
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    <span className="tabular-nums">
                      {t.tasks(meeting.tasks)}
                    </span>
                    {meeting.next && ` · ${t.next} ${meeting.next}`}
                  </span>
                ) : undefined
              }
              gist={meeting.summary || undefined}
            />
          );
          return (
            <li key={meeting.id} data-testid="meeting-item">
              {preview ? (
                <div className={widgetRowClass}>{body}</div>
              ) : (
                <Link
                  to="/meetings/$meetingId"
                  params={{ meetingId: meeting.id }}
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
  },
  Config: ({ config, onChange, disabled, language }) => (
    <CountField
      label={text[language].count}
      value={config.count}
      max={8}
      disabled={disabled}
      onChange={(count) => onChange({ ...config, count })}
    />
  ),
});
