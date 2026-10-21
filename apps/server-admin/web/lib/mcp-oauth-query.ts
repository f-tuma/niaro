function signature(query: string) {
  const values = new URLSearchParams(query).getAll("sig");
  return values.length === 1 && values[0] ? values[0] : null;
}
function isConsentPath(pathname: string) {
  return pathname.replace(/\/$/, "") === "/admin/mcp/consent";
}
// Module imports run before createRouter can normalize the signed URL's values.
const original =
  typeof window !== "undefined" && isConsentPath(window.location.pathname)
    ? {
        query: window.location.search.slice(1),
        signature: signature(window.location.search.slice(1)),
      }
    : null;

/** Restore only this document's signed request, never a different request. */
export function readMcpOAuthQuery(): string {
  if (typeof window === "undefined") return "";
  const current = window.location.search.slice(1);
  return original?.signature &&
    isConsentPath(window.location.pathname) &&
    signature(current) === original.signature
    ? original.query
    : current;
}
