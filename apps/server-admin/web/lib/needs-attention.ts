/** Share of today's AI request limit from which the overview warns. */
export const REQUEST_WARNING_SHARE = 0.8;

/** Today's requests as a whole percentage of the limit; null without a limit. */
export function requestShare(requests: number, limit: number) {
  return limit > 0 ? Math.round((requests / limit) * 100) : null;
}

/** Today's AI requests have reached the warning share of the limit. */
export function requestsWarning(requests: number, limit: number) {
  return limit > 0 && requests >= limit * REQUEST_WARNING_SHARE;
}

/** Entries recorded since local midnight of `now`. */
export function countToday(
  entries: readonly { createdAt: string }[],
  now: number,
) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return entries.filter((e) => Date.parse(e.createdAt) >= midnight.getTime())
    .length;
}

export type AttentionRow =
  | { key: "failed"; count: number }
  | { key: "retest"; count: number }
  | { key: "requests"; percent: number };

/**
 * What an administrator should look at first, in this order: failed actions
 * today, processes blocked until a new test, and AI requests close to today's
 * limit. Unknown inputs (null, still loading or not visible) add no row.
 */
export function needsAttention(input: {
  failedToday: number | null;
  retests: number | null;
  requests: number;
  limit: number;
}): AttentionRow[] {
  const rows: AttentionRow[] = [];
  if (input.failedToday) rows.push({ key: "failed", count: input.failedToday });
  if (input.retests) rows.push({ key: "retest", count: input.retests });
  if (requestsWarning(input.requests, input.limit))
    rows.push({
      key: "requests",
      percent: requestShare(input.requests, input.limit)!,
    });
  return rows;
}
