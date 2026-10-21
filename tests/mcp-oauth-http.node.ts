import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

test(
  "public OAuth discovery, canonical fresh sign-in and run-only grant reach the same native MCP task",
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
        type: "saveRouting",
        routing: {
          ...h.identity["catalog"].store.routing(h.target.workspaceId),
          modelId: h.modelId,
        },
      });
      h.onModel(() => ({ content: "TEST OAuth native result" }));
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

      const password = "TEST-design-HTTP-password-only-2026";
      const credentials = { email: "owner@example.test", password };
      const signed = await browser("/admin/auth/sign-in/email", credentials);
      assert.equal(signed.status, 200);
      const register = await browser(
        "/admin/api/identity/mcp/oauth/client/register",
        {
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
        scope: "native.view native.run",
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
        scopes: ["native.run"],
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
        scopes: ["native.run"],
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
      const submitted = await client.callTool({
        name: "task_submit",
        arguments: {
          requestId: "TEST-OAuth-task",
          text: "TEST do native work",
          language: "en",
        },
      });
      assert.notEqual(submitted.isError, true, JSON.stringify(submitted));
      const task = z.object({
        taskId: z.string(),
        status: z.string(),
        reply: z.string(),
      });
      const ticket = task.parse(submitted.structuredContent);
      let result = ticket;
      const deadline = Date.now() + 10_000;
      while (result.status !== "succeeded" && Date.now() < deadline) {
        result = task.parse(
          (
            await client.callTool({
              name: "task_get",
              arguments: { taskId: ticket.taskId, waitMs: 1000 },
            })
          ).structuredContent,
        );
      }
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      assert.equal(result.reply, "TEST OAuth native result");
      const logout = await browser("/admin/auth/sign-out", {});
      assert.equal(logout.status, 200);
      const revoked = await fetch(resource, {
        method: "POST",
        headers: { Authorization: "Bearer " + token.access_token },
      });
      assert.equal(revoked.status, 401);
    } finally {
      await client.close();
      await h.close();
    }
  },
);
