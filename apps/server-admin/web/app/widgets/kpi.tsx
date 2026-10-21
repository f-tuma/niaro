import type { z } from "zod";
import { Gauge, TrendingDown, TrendingUp } from "lucide-react";
import { Progress } from "@admin/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import { kpiWidget } from "../../../../../packages/protocol/widgets/kpi";
import { ChoiceField, TextField, formatWhen } from "./shared";
import { defineRenderer, type WidgetLanguage } from "./types";

type Data = z.infer<typeof kpiWidget.data>;
type Config = z.infer<typeof kpiWidget.config>;

const text = {
  cs: {
    unit: "Jednotka",
    goal: "Lepší je",
    goals: { up: "Víc", down: "Míň" },
    target: "Cíl",
    ofTarget: (target: string) => `z ${target}`,
    asOf: "k",
    point: "Bod",
    value: "Hodnota",
  },
  en: {
    unit: "Unit",
    goal: "Better is",
    goals: { up: "More", down: "Less" },
    target: "Target",
    ofTarget: (target: string) => `of ${target}`,
    asOf: "as of",
    point: "Point",
    value: "Value",
  },
};

/** A tiny trend line; the points fill the box, oldest on the left. */
export function Sparkline({
  points,
  tall,
}: {
  points: number[];
  /** The expanded widget: a taller box with the same line. */
  tall?: boolean;
}) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const line = points
    .map(
      (value, index) =>
        `${((index / (points.length - 1)) * 100).toFixed(2)},${(28 - ((value - min) / span) * 26).toFixed(2)}`,
    )
    .join(" ");
  return (
    <svg
      data-testid="kpi-sparkline"
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={tall ? "h-40 w-full text-primary" : "h-8 w-full text-primary"}
    >
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

const format = (value: number, language: WidgetLanguage) =>
  new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);

export default defineRenderer<Data, Config>({
  type: "kpi",
  icon: Gauge,
  Body: ({ data, config, language, expanded }) => {
    const t = text[language];
    const unit = data.unit ?? (config.unit || undefined);
    const delta = data.delta;
    const good =
      delta === undefined || delta === 0
        ? null
        : delta > 0 === (config.goal === "up");
    const Trend = delta !== undefined && delta < 0 ? TrendingDown : TrendingUp;
    const target = data.target;
    const percent =
      target !== undefined && target > 0 && data.value !== null
        ? Math.max(0, Math.min(100, Math.round((data.value / target) * 100)))
        : null;
    return (
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-1">
        <p
          data-testid="kpi-value"
          className="text-3xl font-semibold tracking-tight tabular-nums"
        >
          {data.value === null ? "–" : format(data.value, language)}
          {unit && (
            <span className="ml-1 text-base font-normal text-muted-foreground">
              {unit}
            </span>
          )}
        </p>
        <p className="flex min-w-0 items-baseline gap-2 text-sm text-muted-foreground">
          <span className="truncate">{data.label}</span>
          {data.asOf && (
            <span className="shrink-0 text-xs tabular-nums">
              {t.asOf} {formatWhen(data.asOf, language)}
            </span>
          )}
        </p>
        {delta !== undefined && (
          <p
            data-testid="kpi-delta"
            data-good={good === null ? "neutral" : String(good)}
            className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums data-[good=false]:text-destructive data-[good=true]:text-success"
          >
            {delta !== 0 && <Trend aria-hidden="true" className="size-3.5" />}
            {delta > 0 ? "+" : ""}
            {format(delta, language)}
            {data.deltaLabel && (
              <span className="text-muted-foreground">{data.deltaLabel}</span>
            )}
          </p>
        )}
        {percent !== null && target !== undefined && (
          <div
            data-testid="kpi-target"
            data-percent={percent}
            className="flex items-center gap-2"
          >
            <Progress value={percent} aria-label={t.target} />
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {percent} % {t.ofTarget(format(target, language))}
            </span>
          </div>
        )}
        {data.points && <Sparkline points={data.points} tall={expanded} />}
        {expanded && data.points && data.points.length > 0 && (
          <div className="flex max-h-64 min-h-0 flex-col">
            <Table scroll>
              <TableHeader sticky>
                <TableRow>
                  <TableHead className="text-right">{t.point}</TableHead>
                  <TableHead className="text-right">{t.value}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.points.map((point, index) => (
                  <TableRow key={index} data-testid="kpi-point">
                    <TableCell className="text-right">
                      <span className="tabular-nums">{index + 1}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="tabular-nums">
                        {format(point, language)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {data.note && (
          <p className="text-xs text-muted-foreground">{data.note}</p>
        )}
      </div>
    );
  },
  Config: ({ config, onChange, disabled, language }) => {
    const t = text[language];
    return (
      <>
        <TextField
          label={t.unit}
          value={config.unit}
          max={16}
          disabled={disabled}
          onChange={(unit) => onChange({ ...config, unit })}
        />
        <ChoiceField
          label={t.goal}
          value={config.goal}
          disabled={disabled}
          options={(["up", "down"] as const).map((value) => ({
            value,
            label: t.goals[value],
          }))}
          onChange={(goal) => onChange({ ...config, goal })}
        />
      </>
    );
  },
});
