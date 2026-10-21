const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The identity provider address a sign-in or account link may navigate to:
 * HTTPS (plain HTTP only on this machine, for development) and never with
 * credentials in the URL. Anything else throws, so the page shows an error
 * instead of following a script, data or look-alike URL.
 */
export function providerRedirect(raw: string): string {
  const url = new URL(raw);
  const allowed =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!allowed || url.username || url.password) throw Error("invalid_redirect");
  return url.href;
}
