import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import { currentRouting, routingCommand } from "./helpers/model-policy";

test(
  "public OAuth discovery, canonical fresh sign-in and a data-only grant read the person's Niaro data",
  { timeout: 60_000 },
  async () => {
    const h = await coordinatorHttpFixture();
    const client = new Client({
      name: "TEST Niaro OAuth client",
      version: "1",
    });
    let cookie = "";
    const browser = async (path: string, body?: unknown) => {
      const response = await fetch(h.origin + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        headers: {
          Cookie: cookie,
          Origin: h.origin,
          "X-Agent-Admin": "1",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const next = response.headers.getSetCookie();
      if (next.length)
        cookie = next.map((value) => value.split(";")[0]).join("; ");
      return response;
    };
    try {
      await h.catalog({
        ...routingCommand({
          ...currentRouting(
            h.identity["catalog"].store.readModelPolicy(
              h.target.organizationId,
              h.target.workspaceId,
            ),
          ),
          modelId: h.modelId,
        }),
      });
      const unauth = await fetch(h.origin + "/mcp", { method: "POST" });
      assert.equal(unauth.status, 401);
      const resource = h.origin + "/mcp";
      assert(
        unauth.headers.get("www-authenticate")?.includes("resource_metadata="),
      );
      const protectedResponse = await fetch(
        h.origin + "/.well-known/oauth-protected-resource/mcp",
      );
      assert.equal(protectedResponse.status, 200);
      const metadata = await protectedResponse.json();
      assert.equal(metadata.resource, resource);
      assert.deepEqual(metadata.authorization_servers, [
        h.origin + "/admin/auth",
      ]);
      assert.deepEqual(metadata.scopes_supported, [
        "data.read",
        "memory.write",
        "services.call",
      ]);
      const issuerResponse = await fetch(
        h.origin + "/.well-known/oauth-authorization-server/admin/auth",
      );
      assert.equal(
        issuerResponse.status,
        200,
        await issuerResponse.clone().text(),
      );
      const issuer = await issuerResponse.json();
      assert.equal(issuer.issuer, h.origin + "/admin/auth");
      assert.equal(
        issuer.authorization_endpoint,
        h.origin + "/admin/auth/oauth2/authorize",
      );
      assert.equal(issuer.client_id_metadata_document_supported, true);
      assert(issuer.grant_types_supported.includes("refresh_token"));
      assert(issuer.scopes_supported.includes("offline_access"));
      assert(!metadata.scopes_supported.includes("offline_access"));
      assert(!issuer.registration_endpoint);

      const password = "TEST-design-HTTP-password-only-2026";
      const credentials = { email: "owner@example.test", password };
      const signed = await browser("/admin/auth/sign-in/email", credentials);
      assert.equal(signed.status, 200);
      const register = await browser(
        "/admin/api/identity/mcp/oauth/client/register",
        {
          workspaceId: h.target.workspaceId,
          name: "TEST own client",
          redirectUris: ["https://client.example.test/callback"],
        },
      );
      assert.equal(register.status, 201, await register.clone().text());
      const registration = await register.json();
      const verifier = randomBytes(32).toString("base64url");
      const state = "TEST+oauth-state";
      const query = new URLSearchParams({
        client_id: registration.clientId,
        redirect_uri: "https://client.example.test/callback",
        response_type: "code",
        resource,
        scope: "data.read memory.write",
        max_age: "0",
        state,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      });
      const authorize = await browser("/admin/auth/oauth2/authorize?" + query);
      assert.equal(authorize.status, 302, await authorize.clone().text());
      const consentPage = new URL(authorize.headers.get("location")!, h.origin);
      assert.equal(consentPage.pathname, "/admin/mcp/consent");
      const oldQuery = consentPage.search.slice(1);
      const oldInfo = await browser("/admin/auth/mcp/oauth/consent-info", {
        oauth_query: oldQuery,
      });
      assert.equal(oldInfo.status, 200);
      assert.equal((await oldInfo.json()).requiresSignIn, true);
      const refused = await browser("/admin/auth/mcp/oauth/consent", {
        oauth_query: oldQuery,
        accept: true,
        workspaceId: h.target.workspaceId,
        scopes: ["data.read"],
      });
      assert.equal(refused.status, 401);
      const resumed = await browser("/admin/auth/sign-in/email", {
        ...credentials,
        oauth_query: oldQuery,
      });
      assert.equal(resumed.status, 200, await resumed.clone().text());
      const resume = await resumed.json();
      assert.equal(resume.ok, true);
      const normalized = new URL(resume.redirect);
      assert.equal(normalized.origin, h.origin);
      assert.equal(normalized.pathname, "/admin/mcp/consent");
      assert.equal(normalized.searchParams.has("max_age"), false);
      const oauthQuery = normalized.search.slice(1);
      const info = await browser("/admin/auth/mcp/oauth/consent-info", {
        oauth_query: oauthQuery,
      });
      assert.equal(info.status, 200);
      assert.equal((await info.json()).requiresSignIn, false);
      const accept = await browser("/admin/auth/mcp/oauth/consent", {
        oauth_query: oauthQuery,
        accept: true,
        workspaceId: h.target.workspaceId,
        scopes: ["data.read"],
      });
      assert.equal(accept.status, 200, await accept.clone().text());
      const callback = new URL((await accept.json()).redirect_uri);
      assert.equal(callback.origin, "https://client.example.test");
      assert.equal(callback.searchParams.get("state"), state);
      const exchange = await fetch(h.origin + "/admin/auth/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callback.searchParams.get("code")!,
          client_id: registration.clientId,
          redirect_uri: "https://client.example.test/callback",
          code_verifier: verifier,
          resource,
        }),
      });
      assert.equal(exchange.status, 200, await exchange.clone().text());
      const token = await exchange.json();
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          requestInit: {
            headers: { Authorization: "Bearer " + token.access_token },
          },
        }),
      );
      // Only the accepted scope's tools; they read Niaro without a model.
      const models = h.modelCount();
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
        [
          "niaro_meeting_get",
          "niaro_memory_list",
          "niaro_search",
          "niaro_tasks_list",
        ],
      );
      const listed = await client.callTool({
        name: "niaro_tasks_list",
        arguments: {},
      });
      assert.notEqual(listed.isError, true, JSON.stringify(listed));
      assert.equal(
        z
          .object({ status: z.literal("open"), tasks: z.array(z.unknown()) })
          .parse(listed.structuredContent).status,
        "open",
      );
      assert.equal(h.modelCount(), models);
      const logout = await browser("/admin/auth/sign-out", {});
      assert.equal(logout.status, 200);
      const kept = await fetch(resource, {
        method: "POST",
        headers: { Authorization: "Bearer " + token.access_token },
      });
      assert.notEqual(kept.status, 401);
      await client.listTools();
    } finally {
      await client.close();
      await h.close();
    }
  },
);

test(
  "an OAuth app is registered for a workspace and follows members' policy there",
  { timeout: 60_000 },
  async () => {
    const h = await coordinatorHttpFixture();
    try {
      const register = (
        role: "owner" | "admin" | "member",
        workspaceId: string = h.target.workspaceId,
      ) =>
        h.request(role, "api/identity/mcp/oauth/client/register", {
          workspaceId,
          name: `TEST ${role} app`,
          redirectUris: ["https://client.example.test/callback"],
        });
      const clients = () =>
        h.identity["db"]
          .prepare("SELECT count(*) AS n FROM agent_mcp_oauth_client")
          .get()!.n;
      const policy = async (value: string, revision: number) =>
        assert.equal(
          (
            await h.request("owner", "api/identity/mcp/admin/policy", {
              ...h.target,
              policy: value,
              revision,
            })
          ).status,
          200,
        );
      assert.equal(
        (
          await h.request("member", "api/identity/mcp/oauth/client/register", {
            name: "TEST no workspace",
            redirectUris: ["https://client.example.test/callback"],
          })
        ).status,
        400,
      );
      const requested = await register("member");
      assert.equal(requested.status, 201, JSON.stringify(requested.data));
      assert.equal(h.record(requested.data).state, "pending");
      const queue = h.record(
        (await h.request("admin", "api/identity/mcp/admin/list", h.target))
          .data,
      );
      const apps = h.record(queue.requests).apps as Record<string, unknown>[];
      assert.deepEqual(
        apps.map((app) => [app.clientId, h.record(app.requestedBy).email]),
        [[h.record(requested.data).clientId, "member@example.test"]],
      );
      // At the organization's 100 waiting requests a member's registration is
      // refused before any client exists, so no app is left without a state.
      const fill = h.identity["db"].prepare(
        `INSERT INTO agent_mcp_oauth_app (id,client_id,workspace_id,status,requested_at,revision)
        VALUES (?,?,?,'pending',0,1)`,
      );
      for (let index = 1; index < 100; index += 1)
        fill.run(
          `TEST-fill-${index}`,
          `TEST-fill-${index}`,
          h.target.workspaceId,
        );
      const full = clients();
      const limited = await register("member");
      assert.equal(limited.status, 429);
      assert.equal(h.record(limited.data).error, "identity_limit");
      assert.equal(clients(), full);
      h.identity["db"]
        .prepare("DELETE FROM agent_mcp_oauth_app WHERE id LIKE 'TEST-fill-%'")
        .run();
      const administrator = await register("admin");
      assert.equal(h.record(administrator.data).state, "approved");
      await policy("free", 0);
      assert.equal(h.record((await register("member")).data).state, "approved");
      await policy("off", 1);
      const before = clients();
      const off = await register("member");
      assert.equal(off.status, 403);
      assert.equal(h.record(off.data).error, "mcp_external_apps_off");
      assert.equal(clients(), before);
      // A workspace of the organization the member has no access to.
      assert.equal(
        (
          await h.request("owner", "api/identity/command", {
            organizationId: h.target.organizationId,
            type: "createWorkspace",
            name: "TEST closed workspace",
          })
        ).status,
        200,
      );
      const closed = String(
        h.identity["db"]
          .prepare("SELECT id FROM agent_workspace WHERE name=?")
          .get("TEST closed workspace")!.id,
      );
      assert.equal((await register("member", closed)).status, 403);
      assert.equal(clients(), before);
      const audit = h.record(
        (
          await h.request(
            "owner",
            `api/identity/audit?${new URLSearchParams(h.target)}`,
          )
        ).data,
      ).entries as { action: string }[];
      assert.equal(
        audit.filter((entry) => entry.action === "mcp.app_registered").length,
        3,
      );
      assert.equal(
        audit.filter((entry) => entry.action === "mcp.app_requested").length,
        1,
      );
    } finally {
      await h.close();
    }
  },
);
