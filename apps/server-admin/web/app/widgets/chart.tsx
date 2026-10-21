import { useState } from "react";
import type { z } from "zod";
import { ChartColumn, Table2 } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import { chartWidget } from "../../../../../packages/protocol/widgets/chart";
import HubChart from "../hub-chart";
import { hubSeriesRows, type HubChartSeries } from "../hub-chart-data";
import { ChoiceField, Nothing, SwitchField, WidgetToolbar } from "./shared";
import { defineRenderer, type WidgetLanguage } from "./types";

type Data = z.infer<typeof chartWidget.data>;
type Config = z.infer<typeof chartWidget.config>;

const text = {
  cs: {
    kind: "Typ grafu",
    kinds: { bar: "Sloupce", line: "Čára", area: "Plocha", pie: "Koláč" },
    stacked: "Skládat na sebe",
    stackedShort: "skládané",
    values: "Hodnoty",
    other: "Ostatní",
    nothing: "Žádná data.",
    table: "Tabulka",
  },
  en: {
    kind: "Chart type",
    kinds: { bar: "Bars", line: "Line", area: "Area", pie: "Pie" },
    stacked: "Stack",
    stackedShort: "stacked",
    values: "Values",
    other: "Other",
    nothing: "No data.",
    table: "Table",
  },
};

/** The chart's numbers as a compact table: one row per label, one column per series. */
function ValuesTable({
  data,
  series,
  valueLabel,
  language,
}: {
  data: Data;
  series: HubChartSeries[] | null;
  valueLabel: string;
  language: WidgetLanguage;
}) {
  const format = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  const columns = series ? series.map((entry) => entry.name) : [valueLabel];
  const rows: Record<string, string | number | null>[] = series
    ? hubSeriesRows(series)
    : data.points.map((point) => ({ label: point.label, s0: point.value }));
  const keys = columns.map((_, index) => `s${index}`);
  return (
    <Table scroll>
      <TableHeader sticky>
        <TableRow>
          <TableHead />
          {columns.map((column, index) => (
            <TableHead key={index} className="text-right">
              {column}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index} data-testid="chart-table-row">
            <TableCell>{row.label}</TableCell>
            {keys.map((key) => {
              const value = row[key];
              return (
                <TableCell key={key} className="text-right">
                  <span className="tabular-nums">
                    {typeof value === "number" ? format.format(value) : ""}
                  </span>
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default defineRenderer<Data, Config>({
  type: "chart",
  icon: ChartColumn,
  tall: true,
  describe: (config, language) =>
    text[language].kinds[config.kind] +
    (config.stacked && config.kind !== "pie" && config.kind !== "line"
      ? `, ${text[language].stackedShort}`
      : ""),
  Body: ({ data, config, language, preview, expanded }) => {
    const t = text[language];
    const [showTable, setShowTable] = useState(false);
    const series =
      config.kind !== "pie" && data.series?.length ? data.series : null;
    if (!data.points.length && !series) return <Nothing>{t.nothing}</Nothing>;
    const valueLabel = data.valueLabel ?? t.values;
    const table = !preview && (expanded || showTable);
    const chart = (
      <HubChart
        kind={config.kind}
        points={data.points}
        series={series ?? undefined}
        stacked={config.stacked}
        label={valueLabel}
        other={t.other}
        language={language}
      />
    );
    return (
      <div
        // The gallery's preview has no grid cell to fill: a fixed height.
        className={
          preview
            ? "flex h-32 flex-col gap-2"
            : "flex min-h-0 min-w-0 flex-1 flex-col gap-2"
        }
      >
        {!preview && !expanded && (
          <WidgetToolbar
            end={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t.table}
                aria-pressed={showTable}
                data-testid="chart-table-toggle"
                onClick={() => setShowTable((value) => !value)}
              >
                <Table2 aria-hidden="true" />
              </Button>
            }
          />
        )}
        {expanded ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col">{chart}</div>
            <div className="flex max-h-64 min-h-0 flex-col">
              <ValuesTable
                data={data}
                series={series}
                valueLabel={valueLabel}
                language={language}
              />
            </div>
          </>
        ) : table ? (
          <ValuesTable
            data={data}
            series={series}
            valueLabel={valueLabel}
            language={language}
          />
        ) : (
          chart
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
        <ChoiceField
          label={t.kind}
          value={config.kind}
          disabled={disabled}
          options={(["bar", "line", "area", "pie"] as const).map((value) => ({
            value,
            label: t.kinds[value],
          }))}
          onChange={(kind) => onChange({ ...config, kind })}
        />
        {(config.kind === "bar" || config.kind === "area") && (
          <SwitchField
            label={t.stacked}
            checked={config.stacked}
            disabled={disabled}
            onChange={(stacked) => onChange({ ...config, stacked })}
          />
        )}
      </>
    );
  },
});
