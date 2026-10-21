export type HubChartPoint = { label: string; value: number };
export type HubChartSeries = { name: string; points: HubChartPoint[] };

/**
 * Several series over one set of labels: the labels in the order the first
 * series has them, then any the others add; a row holds every series'
 * value under its key (s0, s1…), missing ones as null.
 */
export function hubSeriesRows(series: HubChartSeries[]) {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const entry of series)
    for (const point of entry.points)
      if (!seen.has(point.label)) {
        seen.add(point.label);
        labels.push(point.label);
      }
  return labels.map((label) => {
    const row: Record<string, string | number | null> = { label };
    series.forEach((entry, index) => {
      row[`s${index}`] =
        entry.points.find((point) => point.label === label)?.value ?? null;
    });
    return row;
  });
}
