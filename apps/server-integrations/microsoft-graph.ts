/**
 * Microsoft Graph refuses `$orderby` together with `$search` on messages
 * ("SearchWithOrderBy"): a search returns its matches by relevance. The
 * Microsoft 365 built-in's mail list tools pass both through unchanged, so
 * the model's call failed on every sorted search. The order is dropped here,
 * before dispatch; the search itself and every other parameter stay as sent.
 */
const MAIL_LIST_TOOLS = new Set([
  "list-mail-messages",
  "list-mail-folder-messages",
]);
// The server reads OData names in any case, with or without the `$`.
const odata = (key: string, name: string) =>
  key.replace(/^\$/, "").toLowerCase() === name;

export function graphMailArguments(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!MAIL_LIST_TOOLS.has(toolName)) return input;
  const searching = Object.entries(input).some(
    ([key, value]) =>
      odata(key, "search") && typeof value === "string" && !!value.trim(),
  );
  if (!searching) return input;
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !odata(key, "orderby")),
  );
}
