import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@admin/components/ui/chart";
import type { HubChartKind } from "../../../../packages/protocol/hub";

import { hubSeriesRows, type HubChartSeries } from "./hub-chart-data";

type Point = { label: string; value: number };
/** Categorical hues in fixed order; the fifth (gray) is only "Other". */
const SLICES = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
];
const SWATCH = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4"];

/** A pie keeps four slices and folds the rest into "Other". */
export function hubPieSlices(points: Point[], other: string) {
  if (points.length <= SLICES.length) return points;
  const sorted = [...points].sort((a, b) => b.value - a.value);
  return [
    ...sorted.slice(0, SLICES.length - 1),
    {
      label: other,
      value: sorted
        .slice(SLICES.length - 1)
        .reduce((sum, point) => sum + point.value, 0),
    },
  ];
}

/**
 * One series from the widget's points, or several: bars and areas in the
 * chart hues, a 2 px line, a recessive grid and a tooltip on hover. Several
 * series get a legend; a pie names every slice beside it, so color is never
 * the only key.
 */
export default function HubChart({
  kind,
  points,
  series,
  stacked = false,
  label,
  other,
  language,
}: {
  kind: HubChartKind;
  points: Point[];
  /** Several named series over the same labels; wins over `points`. */
  series?: HubChartSeries[];
  /** Bars or areas of several series on top of each other. */
  stacked?: boolean;
  /** The values' name in the tooltip. */
  label: string;
  other: string;
  language: string;
}) {
  const number = new Intl.NumberFormat(language, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const exact = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  const multi = kind !== "pie" && !!series?.length ? series : null;
  const keys = multi ? multi.map((_, index) => `s${index}`) : ["value"];
  const config = multi
    ? (Object.fromEntries(
        multi.map((entry, index) => [
          `s${index}`,
          { label: entry.name, color: SLICES[index % SLICES.length] },
        ]),
      ) satisfies ChartConfig)
    : ({ value: { label, color: "var(--chart-1)" } } satisfies ChartConfig);
  const rows = multi ? hubSeriesRows(multi) : points;
  if (kind === "pie") {
    // A pie reads one series; a folded "Other" is always the gray slice.
    const source = points.length ? points : (series?.[0]?.points ?? []);
    const folded = source.length > SLICES.length;
    const slices = hubPieSlices(source, other).filter(
      (point) => point.value > 0,
    );
    return (
      <div className="flex min-h-0 flex-1 items-center gap-4">
        <ChartContainer
          config={config}
          className="aspect-square h-40 shrink-0 md:h-full md:max-h-56"
        >
          <PieChart>
            <ChartTooltip
              content={<ChartTooltipContent nameKey="label" hideLabel />}
            />
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              innerRadius="55%"
              strokeWidth={2}
              stroke="var(--card)"
              isAnimationActive={false}
            >
              {slices.map((slice, index) => (
                <Cell
                  key={slice.label + index}
                  fill={
                    folded && index === slices.length - 1
                      ? "var(--chart-5)"
                      : SLICES[index]
                  }
                />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        <ul className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
          {slices.map((slice, index) => (
            <li key={slice.label + index} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`size-2.5 shrink-0 rounded-xs ${folded && index === slices.length - 1 ? "bg-chart-5" : SWATCH[index]}`}
              />
              <span className="min-w-0 flex-1 truncate">{slice.label}</span>
              <span className="text-muted-foreground tabular-nums">
                {exact.format(slice.value)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis
        dataKey="label"
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        minTickGap={12}
      />
      <YAxis
        width={44}
        tickLine={false}
        axisLine={false}
        tickFormatter={(value: number) => number.format(value)}
      />
      <ChartTooltip
        cursor={kind === "bar"}
        content={
          <ChartTooltipContent indicator={kind === "bar" ? "dot" : "line"} />
        }
      />
      {multi && <ChartLegend content={<ChartLegendContent />} />}
    </>
  );
  const stackId = multi && stacked ? "stack" : undefined;
  return (
    <ChartContainer
      config={config}
      className="aspect-auto h-48 w-full md:h-full md:min-h-32"
    >
      {kind === "bar" ? (
        <BarChart data={rows} accessibilityLayer>
          {axes}
          {keys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              fill={`var(--color-${key})`}
              stackId={stackId}
              radius={!stackId || index === keys.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      ) : kind === "line" ? (
        <LineChart data={rows} accessibilityLayer>
          {axes}
          {keys.map((key) => (
            <Line
              key={key}
              dataKey={key}
              type="monotone"
              stroke={`var(--color-${key})`}
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      ) : (
        <AreaChart data={rows} accessibilityLayer>
          {axes}
          {keys.map((key) => (
            <Area
              key={key}
              dataKey={key}
              type="monotone"
              stroke={`var(--color-${key})`}
              fill={`var(--color-${key})`}
              fillOpacity={0.15}
              strokeWidth={2}
              stackId={stackId}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      )}
    </ChartContainer>
  );
}
