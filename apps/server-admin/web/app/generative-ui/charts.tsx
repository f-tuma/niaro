import {
  Bar,
  BarChart as BarPlot,
  CartesianGrid,
  Cell,
  Line,
  LineChart as LinePlot,
  Pie,
  PieChart as PiePlot,
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
import { hubPieSlices } from "../hub-chart";
import { useChatCopy } from "../chat-copy";
import { elements, text, type View } from "./scope";

/** The overview's categorical hues in fixed order; gray is only "Other". */
const HUES = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
];

type Series = { name: string; values: number[] };
function seriesOf(value: unknown): Series[] {
  return elements(value).map((series) => ({
    name: text(series.props.name),
    values: Array.isArray(series.props.values)
      ? series.props.values.filter((v): v is number => typeof v === "number")
      : [],
  }));
}
/** One row per label, each series' value under its key (s0, s1…). */
function rowsOf(labels: string[], series: Series[]) {
  return labels.map((label, index) => {
    const row: Record<string, string | number | null> = { label };
    series.forEach((entry, key) => {
      row[`s${key}`] = entry.values[index] ?? null;
    });
    return row;
  });
}
const configOf = (series: Series[]) =>
  Object.fromEntries(
    series.map((entry, index) => [
      `s${index}`,
      { label: entry.name, color: HUES[index % HUES.length] },
    ]),
  ) satisfies ChartConfig;
/** What a screen reader hears instead of the plot: kind, series, range. */
const summary = (kind: string, labels: string[], series: Series[]) =>
  [
    kind,
    series
      .map((entry) => entry.name)
      .filter(Boolean)
      .join(", "),
    labels.length > 1 ? `${labels[0]}–${labels.at(-1)}` : labels[0],
  ]
    .filter(Boolean)
    .join(": ");

function useCompact() {
  const { language } = useChatCopy();
  return new Intl.NumberFormat(language, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
}

export const BarChart: View<{
  labels: string[];
  series: unknown[];
  horizontal: boolean;
  stacked: boolean;
}> = ({ props }) => {
  const { copy } = useChatCopy();
  const number = useCompact();
  const labels = (props.labels ?? []).map(text);
  const series = seriesOf(props.series);
  if (!labels.length || !series.length) return null;
  const stackId = props.stacked && series.length > 1 ? "stack" : undefined;
  const horizontal = !!props.horizontal;
  const valueAxis = {
    tickLine: false,
    axisLine: false,
    tickFormatter: (value: number) => number.format(value),
  };
  return (
    <figure
      aria-label={summary(copy.generated.barChart, labels, series)}
      className="min-w-0"
    >
      <ChartContainer
        config={configOf(series)}
        data-size={horizontal && labels.length > 6 ? "tall" : "default"}
        className="aspect-auto h-56 w-full data-[size=tall]:h-96"
      >
        <BarPlot
          data={rowsOf(labels, series)}
          layout={horizontal ? "vertical" : "horizontal"}
          accessibilityLayer
        >
          <CartesianGrid vertical={horizontal} horizontal={!horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" {...valueAxis} />
              <YAxis
                type="category"
                dataKey="label"
                width={96}
                tickLine={false}
                axisLine={false}
              />
            </>
          ) : (
            <>
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={12}
              />
              <YAxis width={44} {...valueAxis} />
            </>
          )}
          <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
          {series.length > 1 && (
            <ChartLegend content={<ChartLegendContent />} />
          )}
          {series.map((_, index) => {
            const end = !stackId || index === series.length - 1;
            return (
              <Bar
                key={index}
                dataKey={`s${index}`}
                fill={`var(--color-s${index})`}
                stackId={stackId}
                radius={end ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0}
                isAnimationActive={false}
              />
            );
          })}
        </BarPlot>
      </ChartContainer>
    </figure>
  );
};

export const LineChart: View<{ labels: string[]; series: unknown[] }> = ({
  props,
}) => {
  const { copy } = useChatCopy();
  const number = useCompact();
  const labels = (props.labels ?? []).map(text);
  const series = seriesOf(props.series);
  if (!labels.length || !series.length) return null;
  return (
    <figure
      aria-label={summary(copy.generated.lineChart, labels, series)}
      className="min-w-0"
    >
      <ChartContainer
        config={configOf(series)}
        className="aspect-auto h-56 w-full"
      >
        <LinePlot data={rowsOf(labels, series)} accessibilityLayer>
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
          <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
          {series.length > 1 && (
            <ChartLegend content={<ChartLegendContent />} />
          )}
          {series.map((_, index) => (
            <Line
              key={index}
              dataKey={`s${index}`}
              type="monotone"
              stroke={`var(--color-s${index})`}
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LinePlot>
      </ChartContainer>
    </figure>
  );
};

/** Shares as a ring with every slice named beside it, so color is never the
 * only key. Like the overview, small slices beyond four fold into "Other". */
export const PieChart: View<{
  labels: string[];
  values: number[];
  donut: boolean;
}> = ({ props }) => {
  const { copy, language } = useChatCopy();
  const exact = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  const labels = (props.labels ?? []).map(text);
  const points = labels.flatMap((label, index) => {
    const value = props.values?.[index];
    return typeof value === "number" && value > 0 ? [{ label, value }] : [];
  });
  if (!points.length) return null;
  const folded = points.length > HUES.length;
  const slices = hubPieSlices(points, copy.generated.other);
  /** The chart hue of a slice, 1–4, or 5 for a folded "Other". */
  const hue = (index: number) =>
    folded && index === slices.length - 1 ? 5 : index + 1;
  return (
    <figure
      aria-label={[
        copy.generated.pieChart,
        slices
          .map((slice) => `${slice.label} ${exact.format(slice.value)}`)
          .join(", "),
      ].join(": ")}
      className="flex min-w-0 flex-wrap items-center gap-4"
    >
      <ChartContainer
        config={{ value: { label: copy.generated.pieChart } }}
        className="aspect-square h-40 shrink-0"
      >
        <PiePlot>
          <ChartTooltip
            content={<ChartTooltipContent nameKey="label" hideLabel />}
          />
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            innerRadius={props.donut === false ? 0 : "55%"}
            strokeWidth={2}
            stroke="var(--card)"
            isAnimationActive={false}
          >
            {slices.map((slice, index) => (
              <Cell
                key={slice.label + index}
                fill={`var(--chart-${hue(index)})`}
              />
            ))}
          </Pie>
        </PiePlot>
      </ChartContainer>
      <ul className="flex min-w-40 flex-1 flex-col gap-1.5">
        {slices.map((slice, index) => (
          <li key={slice.label + index} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              data-hue={hue(index)}
              className="size-2.5 shrink-0 rounded-xs data-[hue=1]:bg-chart-1 data-[hue=2]:bg-chart-2 data-[hue=3]:bg-chart-3 data-[hue=4]:bg-chart-4 data-[hue=5]:bg-chart-5"
            />
            <span className="min-w-0 flex-1 truncate">{slice.label}</span>
            <span className="text-muted-foreground tabular-nums">
              {exact.format(slice.value)}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
};
