/**
 * Where a provider sign-in comes back to: the page it started on when the
 * server accepts it (personal console pages, public account pages and the
 * web app, so signing in at "/" returns to the chat), otherwise the console.
 */
export function providerReturnPath(path: string) {
  return /^(?:\/admin\/(?:device|settings|service-connect|mcp(?:\/consent)?)|\/account\/(?:login|invite)|\/(?:chat(?:\/[A-Za-z0-9_-]+)?|tasks|meetings(?:\/[A-Za-z0-9_-]+)?|processes(?:\/[A-Za-z0-9_-]+)?|skills(?:\/[A-Za-z0-9_-]+)?|connections(?:\/[A-Za-z0-9_-]+)?|search|me)?)(?:[?#].*)?$/.test(
    path,
  )
    ? path
    : "/admin/";
}
