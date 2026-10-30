import React, { useState } from "react";
import { usePresentationState } from "./generative-ui-presentation";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, {
  Circle,
  Line,
  Path,
  Rect,
  Text as SvgText,
} from "react-native-svg";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import { Text } from "../ui";
import {
  elements,
  formatNumber,
  list,
  num,
  str,
  useRuntime,
} from "./generative-ui-runtime";

type Props = { props: Record<string, unknown> };
type Series = { name: string; values: number[] };

const PLOT = 160;
const AXIS = 40;
/** Series keep their slot by position, never by rank. */
const color = (index: number) => t.color.chart[index % t.color.chart.length]!;

function seriesOf(props: Record<string, unknown>, count: number): Series[] {
  return elements(props.series, "Series")
    .slice(0, 6)
    .map((series) => ({
      name: str(series.props.name) ?? "",
      values: Array.from(
        { length: count },
        (_, index) => num(list(series.props.values)[index]) ?? 0,
      ),
    }));
}
const labelsOf = (props: Record<string, unknown>) =>
  list(props.labels).map((label) => str(label) ?? "");

/** "Revenue: Jul 380, Aug 410" per series: the chart for a screen reader. */
function summary(labels: string[], series: Series[], language: string) {
  return series
    .map((one) => {
      const points = labels
        .map(
          (label, index) =>
            `${label} ${formatNumber(one.values[index]!, language)}`,
        )
        .join(", ");
      return one.name ? `${one.name}: ${points}` : points;
    })
    .join("; ");
}

/** Rounded at the data end, square on the baseline. */
function barPath(x: number, base: number, end: number, width: number) {
  const r = Math.min(4, width / 2, Math.abs(base - end));
  const s = end < base ? 1 : -1;
  return `M${x},${base}V${end + s * r}Q${x},${end} ${x + r},${end}H${x + width - r}Q${x + width},${end} ${x + width},${end + s * r}V${base}Z`;
}

function niceStep(span: number) {
  const raw = span / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * power >= raw) ?? 10;
  return step * power;
}
function scale(values: number[]) {
  let low = Math.min(0, ...values);
  let high = Math.max(0, ...values);
  if (high === low) high = low + 1;
  const step = niceStep(high - low);
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let tick = low; tick <= high + step / 2; tick += step) ticks.push(tick);
  return {
    ticks,
    y: (value: number) => PLOT - ((value - low) / (high - low)) * PLOT,
  };
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <View style={styles.legend}>
      {series.map((one, index) => (
        <View key={index} style={styles.legendItem}>
          <View style={[styles.swatch, { backgroundColor: color(index) }]} />
          <Text role="meta" tone="secondary">
            {one.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The tapped point, written out: the phone's stand-in for a hover tooltip. */
function Readout({
  index,
  labels,
  series,
  language,
}: {
  index: number | null;
  labels: string[];
  series: Series[];
  language: string;
}) {
  return (
    <Text role="meta" tone="secondary" numberOfLines={2} style={styles.readout}>
      {index === null
        ? " "
        : `${labels[index]}: ${series
            .map((one) =>
              [one.name, formatNumber(one.values[index]!, language)]
                .filter(Boolean)
                .join(" "),
            )
            .join(" · ")}`}
    </Text>
  );
}

/** Category plot with a value axis, shared by vertical bars and lines. */
function CategoryPlot({
  labels,
  series,
  values,
  draw,
  selected,
  onSelect,
}: {
  labels: string[];
  series: Series[];
  values: number[];
  draw: (input: {
    band: number;
    x: (index: number) => number;
    y: (value: number) => number;
  }) => React.ReactNode;
  selected: number | null;
  onSelect: (index: number | null) => void;
}) {
  const { language } = useRuntime();
  const [width, setWidth] = useState(0);
  const plotWidth = Math.max(120, (width || 320) - AXIS);
  const band = plotWidth / Math.max(1, labels.length);
  const { ticks, y } = scale(values);
  const every = Math.ceil(
    labels.length / Math.max(1, Math.floor(plotWidth / 56)),
  );
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <View>
        <Svg width={plotWidth + AXIS} height={PLOT + 12}>
          {ticks.map((tick) => (
            <React.Fragment key={tick}>
              <Line
                x1={AXIS}
                x2={AXIS + plotWidth}
                y1={y(tick) + 4}
                y2={y(tick) + 4}
                stroke={tick === 0 ? t.color.text.disabled : t.color.border}
                strokeWidth={1}
              />
              <SvgText
                x={AXIS - 6}
                y={y(tick) + 8}
                fontSize={11}
                fill={t.color.text.secondary}
                textAnchor="end"
              >
                {formatNumber(tick, language)}
              </SvgText>
            </React.Fragment>
          ))}
          {draw({
            band,
            x: (index) => AXIS + band * (index + 0.5),
            y: (value) => y(value) + 4,
          })}
        </Svg>
        <View
          style={[styles.hits, { left: AXIS, width: plotWidth }]}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          {labels.map((_, index) => (
            <Pressable
              key={index}
              style={[styles.hit, selected === index && styles.hitSelected]}
              onPress={() => onSelect(selected === index ? null : index)}
            />
          ))}
        </View>
      </View>
      <View style={[styles.axisLabels, { marginLeft: AXIS, width: plotWidth }]}>
        {labels.map((label, index) => (
          <Text
            key={index}
            role="overline"
            tone="secondary"
            numberOfLines={1}
            style={styles.axisLabel}
          >
            {index % every === 0 ? label : ""}
          </Text>
        ))}
      </View>
      <Legend series={series} />
    </View>
  );
}

export function BarChartView({ props }: Props) {
  const { language } = useRuntime();
  const [selected, setSelected] = usePresentationState<number | null>(
    "selected",
    null,
  );
  const labels = labelsOf(props);
  const series = seriesOf(props, labels.length);
  if (!labels.length || !series.length) return null;
  const stacked = props.stacked === true;
  const label = summary(labels, series, language);
  if (props.horizontal === true)
    return (
      <HorizontalBars
        labels={labels}
        series={series}
        stacked={stacked}
        accessibilityLabel={label}
      />
    );
  const totals = stacked
    ? labels.map((_, index) =>
        series.reduce((sum, one) => sum + Math.max(0, one.values[index]!), 0),
      )
    : series.flatMap((one) => one.values);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label}>
      <Readout
        index={selected}
        labels={labels}
        series={series}
        language={language}
      />
      <CategoryPlot
        labels={labels}
        series={series}
        values={totals}
        selected={selected}
        onSelect={setSelected}
        draw={({ band, x, y }) =>
          labels.map((_, index) => {
            const group = Math.min(
              band * 0.72,
              stacked ? 32 : series.length * 24,
            );
            const left = x(index) - group / 2;
            if (stacked) {
              let base = 0;
              return series.map((one, position) => {
                const value = Math.max(0, one.values[index]!);
                const from = base;
                base += value;
                if (!value) return null;
                const top = series
                  .slice(position + 1)
                  .every((next) => next.values[index]! <= 0);
                // A 2 px surface gap between stacked segments.
                const end = y(base) + (top ? 0 : 1);
                const start = y(from) - (from ? 1 : 0);
                return top ? (
                  <Path
                    key={`${index}-${position}`}
                    d={barPath(left, start, end, group)}
                    fill={color(position)}
                  />
                ) : (
                  <Rect
                    key={`${index}-${position}`}
                    x={left}
                    y={end}
                    width={group}
                    height={Math.max(0, start - end)}
                    fill={color(position)}
                  />
                );
              });
            }
            const width = (group - 2 * (series.length - 1)) / series.length;
            return series.map((one, position) => (
              <Path
                key={`${index}-${position}`}
                d={barPath(
                  left + position * (width + 2),
                  y(0),
                  y(one.values[index]!),
                  width,
                )}
                fill={color(position)}
              />
            ));
          })
        }
      />
    </View>
  );
}

function HorizontalBars({
  labels,
  series,
  stacked,
  accessibilityLabel,
}: {
  labels: string[];
  series: Series[];
  stacked: boolean;
  accessibilityLabel: string;
}) {
  const { language } = useRuntime();
  const [width, setWidth] = useState(0);
  const length = Math.max(80, (width || 320) - 72);
  const sums = labels.map((_, index) =>
    series.reduce((sum, one) => sum + Math.max(0, one.values[index]!), 0),
  );
  const max = Math.max(
    1e-9,
    ...(stacked
      ? sums
      : series.flatMap((one) => one.values.map((v) => Math.max(0, v)))),
  );
  const thickness = stacked || series.length === 1 ? 12 : 8;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={styles.bars}
    >
      {labels.map((label, index) => {
        const rows = stacked ? [series] : series.map((one) => [one]);
        return (
          <View key={index} style={styles.barRow}>
            <Text role="meta" numberOfLines={1}>
              {label}
            </Text>
            {rows.map((row, line) => {
              let offset = 0;
              const value = row.reduce(
                (sum, one) => sum + Math.max(0, one.values[index]!),
                0,
              );
              return (
                <View key={line} style={styles.barLine}>
                  <Svg width={length} height={thickness}>
                    {row.map((one, segment) => {
                      const position = stacked ? segment : line;
                      const size =
                        (Math.max(0, one.values[index]!) / max) * length;
                      const x = offset;
                      offset += size;
                      if (!size) return null;
                      const last = segment === row.length - 1 || !stacked;
                      return last ? (
                        <Path
                          key={segment}
                          d={`M${x},0H${x + size - Math.min(4, size)}Q${x + size},0 ${x + size},${Math.min(4, size)}V${thickness - Math.min(4, size)}Q${x + size},${thickness} ${x + size - Math.min(4, size)},${thickness}H${x}Z`}
                          fill={color(position)}
                        />
                      ) : (
                        <Rect
                          key={segment}
                          x={x}
                          y={0}
                          width={Math.max(0, size - 2)}
                          height={thickness}
                          fill={color(position)}
                        />
                      );
                    })}
                  </Svg>
                  <Text role="meta" tone="secondary" style={styles.barValue}>
                    {formatNumber(
                      stacked ? value : row[0]!.values[index]!,
                      language,
                    )}
                  </Text>
                </View>
              );
            })}
          </View>
        );
      })}
      <Legend series={series} />
    </View>
  );
}

export function LineChartView({ props }: Props) {
  const { language } = useRuntime();
  const [selected, setSelected] = usePresentationState<number | null>(
    "selected",
    null,
  );
  const labels = labelsOf(props);
  const series = seriesOf(props, labels.length);
  if (!labels.length || !series.length) return null;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary(labels, series, language)}
    >
      <Readout
        index={selected}
        labels={labels}
        series={series}
        language={language}
      />
      <CategoryPlot
        labels={labels}
        series={series}
        values={series.flatMap((one) => one.values)}
        selected={selected}
        onSelect={setSelected}
        draw={({ x, y }) => (
          <>
            {selected === null ? null : (
              <Line
                x1={x(selected)}
                x2={x(selected)}
                y1={4}
                y2={PLOT + 4}
                stroke={t.color.text.disabled}
                strokeWidth={1}
              />
            )}
            {series.map((one, position) => (
              <React.Fragment key={position}>
                <Path
                  d={one.values
                    .map(
                      (value, index) =>
                        `${index ? "L" : "M"}${x(index)},${y(value)}`,
                    )
                    .join("")}
                  stroke={color(position)}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  fill="none"
                />
                {labels.length <= 24 || selected !== null
                  ? one.values.map((value, index) =>
                      labels.length <= 24 || index === selected ? (
                        <Circle
                          key={index}
                          cx={x(index)}
                          cy={y(value)}
                          r={index === selected ? 5 : 4}
                          fill={color(position)}
                          stroke={t.color.surface}
                          strokeWidth={2}
                        />
                      ) : null,
                    )
                  : null}
              </React.Fragment>
            ))}
          </>
        )}
      />
    </View>
  );
}

function arc(
  cx: number,
  cy: number,
  r: number,
  inner: number,
  from: number,
  to: number,
) {
  const point = (radius: number, angle: number) =>
    `${cx + radius * Math.sin(angle)},${cy - radius * Math.cos(angle)}`;
  const large = to - from > Math.PI ? 1 : 0;
  const outer = `M${point(r, from)}A${r},${r} 0 ${large} 1 ${point(r, to)}`;
  return inner
    ? `${outer}L${point(inner, to)}A${inner},${inner} 0 ${large} 0 ${point(inner, from)}Z`
    : `${outer}L${cx},${cy}Z`;
}

export function PieChartView({ props }: Props) {
  const { language } = useRuntime();
  const tr = translate(language);
  const labels = labelsOf(props);
  const values = list(props.values).map((value) =>
    Math.max(0, num(value) ?? 0),
  );
  let slices = labels
    .map((label, index) => ({ label, value: values[index] ?? 0 }))
    .filter((slice) => slice.value > 0);
  // At most eight slices: the rest is one "Other".
  if (slices.length > 8)
    slices = [
      ...slices.slice(0, 7),
      {
        label: tr("generativeOther"),
        value: slices.slice(7).reduce((sum, slice) => sum + slice.value, 0),
      },
    ];
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (!total) return null;
  const size = 160;
  const r = size / 2;
  const inner = props.donut === false ? 0 : r * 0.6;
  const percent = (value: number) =>
    new Intl.NumberFormat(language, {
      style: "percent",
      maximumFractionDigits: 0,
    }).format(value / total);
  let angle = 0;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={slices
        .map(
          (slice) =>
            `${slice.label} ${formatNumber(slice.value, language)} (${percent(slice.value)})`,
        )
        .join(", ")}
      style={styles.pie}
    >
      <Svg width={size} height={size}>
        {slices.length === 1 ? (
          <>
            <Circle cx={r} cy={r} r={r} fill={color(0)} />
            {inner ? (
              <Circle cx={r} cy={r} r={inner} fill={t.color.surface} />
            ) : null}
          </>
        ) : (
          slices.map((slice, index) => {
            const from = angle;
            angle += (slice.value / total) * Math.PI * 2;
            return (
              <Path
                key={index}
                d={arc(r, r, r, inner, from, angle)}
                fill={color(index)}
                stroke={t.color.surface}
                strokeWidth={2}
              />
            );
          })
        )}
      </Svg>
      <View style={styles.pieLegend}>
        {slices.map((slice, index) => (
          <View key={index} style={styles.pieRow}>
            <View style={[styles.swatch, { backgroundColor: color(index) }]} />
            <Text role="meta" style={styles.pieLabel}>
              {slice.label}
            </Text>
            <Text role="meta" tone="secondary" style={styles.tabular}>
              {`${formatNumber(slice.value, language)} · ${percent(slice.value)}`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabular: { fontVariant: ["tabular-nums"] },
  readout: { minHeight: 18, fontVariant: ["tabular-nums"] },
  hits: { position: "absolute", top: 0, bottom: 0, flexDirection: "row" },
  hit: { flex: 1 },
  hitSelected: { backgroundColor: t.color.pressed },
  axisLabels: { flexDirection: "row" },
  axisLabel: { flex: 1, textAlign: "center" },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: t.spacing.md,
    paddingTop: t.spacing.sm,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  bars: { gap: t.spacing.md },
  barRow: { gap: t.spacing.xs },
  barLine: { flexDirection: "row", alignItems: "center", gap: t.spacing.sm },
  barValue: { fontVariant: ["tabular-nums"], flexShrink: 1 },
  pie: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: t.spacing.lg,
  },
  pieLegend: { flex: 1, minWidth: 160, gap: t.spacing.xs },
  pieRow: { flexDirection: "row", alignItems: "center", gap: t.spacing.sm },
  pieLabel: { flex: 1, minWidth: 0 },
});
