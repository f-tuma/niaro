import type { IncomingMessage, ServerResponse } from "node:http";
import { clientAddress } from "../server-identity/client-address";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  AdminOverviewSchema,
  type AdminService,
  type AdminTool,
} from "../../packages/protocol/admin";
import { PROFILE } from "../../packages/protocol";
import { AdminAuth, AdminAuthError } from "./auth";
import type { IdentityService } from "../server-identity/service";
import type { ServerConfig } from "../reference-server/config";

/** Web app pages served with the same shell as the console. */
export const APP_ROUTE =
  /^\/(?:|chat(?:\/[A-Za-z0-9_-]+)?|tasks|meetings(?:\/[A-Za-z0-9_-]+)?|processes(?:\/[A-Za-z0-9_-]+)?|skills(?:\/[A-Za-z0-9_-]+)?|connections(?:\/[A-Za-z0-9_-]+)?|search|me)\/?$/;
/** Public account pages: sign-in, invitation and password reset. */
export const ACCOUNT_ROUTE = /^\/account\/(?:login|invite|reset)$/;

export function createAdminHandler(
  config: ServerConfig,
  services: () => AdminService[],
  options: {
    assetsDirectory?: string;
    now?: () => number;
    identity?: IdentityService;
  } = {},
) {
  const settings = config.administration!;
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const auth = new AdminAuth(settings.keyFile, settings.sessionSeconds, now);
  // Exact asset allowlist: no filesystem path can be chosen by a request.
  const directory =
    options.assetsDirectory ?? resolve(process.cwd(), "dist-admin");
  const assets = new Map([
    [
      "/admin/",
      {
        body: readFileSync(resolve(directory, "index.html")),
        type: "text/html; charset=utf-8",
      },
    ],
    [
      "/admin/app.js",
      {
        body: readFileSync(resolve(directory, "app.js")),
        type: "text/javascript; charset=utf-8",
      },
    ],
    [
      "/admin/app.css",
      {
        body: readFileSync(resolve(directory, "app.css")),
        type: "text/css; charset=utf-8",
      },
    ],
  ]);
  const cookieName = "agent_admin_session";
  const publicOrigin = options.identity?.baseURL.startsWith("https:")
    ? options.identity.baseURL
    : undefined;
  const cookie = (token: string, maxAge: number) =>
    `${cookieName}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${publicOrigin ? "; Secure" : ""}`;
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    tools: AdminTool[],
  ) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // The web app (chat, tasks, processes, connections) shares this bundle.
    const appRoute = APP_ROUTE.test(url.pathname);
    if (
      url.pathname !== "/admin" &&
      !url.pathname.startsWith("/admin/") &&
      !ACCOUNT_ROUTE.test(url.pathname) &&
      !appRoute
    )
      return false;
    const security = {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; font-src data:; img-src 'self' data:; connect-src 'self'; media-src blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    };
    const respond = (
      status: number,
      value: unknown,
      headers: Record<string, string | string[]> = {},
    ) => {
      res.writeHead(status, {
        ...security,
        "Content-Type": "application/json",
        ...headers,
      });
      res.end(JSON.stringify(value));
      return true;
    };
    const port = req.socket.localPort;
    const host = req.headers.host;
    if (
      !(
        publicOrigin
          ? [new URL(publicOrigin).host]
          : [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]
      ).includes(host ?? "")
    )
      return respond(403, { error: "admin_origin_denied" });
    const expectedOrigin = publicOrigin ?? `http://${host}`;
    const uiRoute =
      appRoute ||
      ACCOUNT_ROUTE.test(url.pathname) ||
      /^\/admin\/processes(?:\/[A-Za-z0-9_-]+)?\/?$/.test(url.pathname) ||
      /^\/admin\/services\/[A-Za-z0-9_-]+\/processes\/[A-Za-z0-9_-]+\/?$/.test(
        url.pathname,
      ) ||
      /^\/admin\/(?:mcp(?:\/consent)?|device|service-connect|hosted|tools|access|settings|accounts|people|services|workspaces|audit|loops|ai|providers|auth-providers|routing|usage|plugins|skills|built-in|(?:services|plugins|providers|auth-providers|skills)\/[A-Za-z0-9_-]+|connections\/(?:model|voice|crm|calendar))\/?$/.test(
        url.pathname,
      );
    if (
      (req.headers.origin && req.headers.origin !== expectedOrigin) ||
      (req.headers["sec-fetch-site"] &&
        req.headers["sec-fetch-site"] !== "same-origin" &&
        req.headers["sec-fetch-site"] !== "none" &&
        !(
          req.method === "GET" &&
          // A document navigation from elsewhere (a link in mail or chat, the
          // address bar) may open any page of the app or the console; the
          // page then talks to the API same-origin. The provider also returns
          // here after consent.
          (uiRoute ||
            url.pathname === "/admin/" ||
            /^\/admin\/auth\/callback\/ap_[a-f0-9]{32}$/.test(url.pathname)) &&
          req.headers["sec-fetch-mode"] === "navigate" &&
          req.headers["sec-fetch-dest"] === "document"
        ))
    )
      return respond(403, { error: "admin_origin_denied" });
    if (req.method === "GET" && url.pathname === "/admin") {
      res.writeHead(302, { ...security, Location: "/admin/" });
      res.end();
      return true;
    }
    // Only known UI routes receive the SPA shell. Unknown/API/file paths stay 404.
    if (
      req.method === "GET" &&
      (uiRoute || url.pathname === "/admin/") &&
      options.identity &&
      expectedOrigin !== options.identity.baseURL
    ) {
      res.writeHead(302, {
        ...security,
        Location: `${options.identity.baseURL}${url.pathname}${url.search}`,
      });
      res.end();
      return true;
    }
    const asset = assets.get(uiRoute ? "/admin/" : url.pathname);
    if (req.method === "GET" && asset) {
      if (asset.type.startsWith("text/html")) {
        // Radix scroll locks generate styles at runtime. Authorize only this document's styles.
        const nonce = randomBytes(24).toString("base64");
        res.writeHead(200, {
          ...security,
          "Content-Security-Policy": security[
            "Content-Security-Policy"
          ].replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`),
          "Content-Type": asset.type,
        });
        res.end(
          asset.body
            .toString("utf8")
            .replace(
              "<head>",
              `<head><meta name="agent-style-nonce" content="${nonce}">`,
            ),
        );
      } else {
        res.writeHead(200, { ...security, "Content-Type": asset.type });
        res.end(asset.body);
      }
      return true;
    }
    for (const [key, value] of Object.entries(security))
      res.setHeader(key, value);
    if (req.method === "GET" && url.pathname === "/admin/api/auth-methods")
      return respond(200, { identity: !!options.identity });
    const token = (req.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    try {
      if (req.method === "POST") {
        if (
          req.headers.origin !== expectedOrigin ||
          req.headers["x-agent-admin"] !== "1" ||
          req.headers["content-type"] !== "application/json"
        )
          return respond(403, { error: "admin_origin_denied" });
        if (url.pathname === "/admin/api/login") {
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 4096)
              return respond(413, { error: "admin_invalid_input" });
            chunks.push(Buffer.from(chunk));
          }
          const { key } = z
            .strictObject({ key: z.string().max(100) })
            .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          const next = auth.login(key, clientAddress(req));
          auth.revoke(token);
          const personalCookies =
            (await options.identity?.revokeSession(req)) ?? [];
          return respond(
            200,
            { ok: true },
            {
              "Set-Cookie": [
                cookie(next, settings.sessionSeconds),
                ...personalCookies,
              ],
            },
          );
        }
        if (url.pathname === "/admin/api/logout") {
          auth.revoke(token);
          const personalCookies =
            (await options.identity?.revokeSession(req)) ?? [];
          return respond(
            200,
            { ok: true },
            { "Set-Cookie": [cookie("", 0), ...personalCookies] },
          );
        }
      }
      if (
        url.pathname.startsWith("/admin/auth/") ||
        url.pathname === "/admin/api/service-connect" ||
        url.pathname.startsWith("/admin/api/identity")
      ) {
        if (!options.identity) return respond(404, { error: "not_found" });
        const operator = () => {
          try {
            auth.authenticate(token);
            return true;
          } catch {
            return false;
          }
        };
        if (
          [
            "/admin/auth/sign-in/email",
            "/admin/api/identity/auth-providers/sign-in",
          ].includes(url.pathname)
        ) {
          auth.revoke(token);
          res.setHeader("Set-Cookie", cookie("", 0));
        }
        return options.identity.handle(req, res, operator);
      }
      const personal = options.identity
        ? await options.identity.session(req)
        : null;
      // Members only learn who they are, for the personal pages (device sign-in,
      // service connection, MCP consent); everything else needs an administrator.
      const member =
        !!personal && !options.identity!.canManageConsole(personal.user.id);
      if (
        member &&
        !(req.method === "GET" && url.pathname === "/admin/api/overview")
      )
        return respond(403, { error: "admin_forbidden" });
      const session = personal
        ? { expiresAt: personal.session.expiresAt.toISOString() }
        : auth.authenticate(token);
      if (req.method === "GET" && url.pathname === "/admin/api/overview")
        return respond(
          200,
          AdminOverviewSchema.parse({
            profile: "agent-server-admin/2",
            server: {
              name: config.name,
              workflowProfile: PROFILE,
              startedAt,
              sessionSeconds: config.sessionSeconds,
            },
            observedAt: new Date(now()).toISOString(),
            services: (personal ? [] : services()).map((service) => ({
              ...service,
              ...(service.expiresAt && Date.parse(service.expiresAt) <= now()
                ? { state: "expired" as const }
                : {}),
            })),
            tools: personal ? [] : tools,
            authentication: {
              current: personal ? "better-auth" : "admin-key",
              identityEnabled: !!options.identity,
              principalId: personal?.user.id ?? null,
              console: !member,
              oauth: "not_configured",
              backupKey: true,
              expiresAt: session.expiresAt,
            },
          }),
        );
      return respond(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof AdminAuthError)
        return respond(
          error.status,
          { error: error.code },
          error.status === 401
            ? { "Set-Cookie": cookie("", 0) }
            : { "Retry-After": "60" },
        );
      if (error instanceof SyntaxError || error instanceof z.ZodError)
        return respond(400, { error: "admin_invalid_input" });
      return respond(503, { error: "admin_unavailable" });
    }
  };
}
