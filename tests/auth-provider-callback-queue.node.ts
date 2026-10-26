import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthProvider } from "@better-auth/core/oauth2";
import { openIdentity } from "../apps/server-identity/service";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { ServerConfigSchema } from "../apps/reference-server/config";

/**
 * A slow sign-in provider must not hold the identity queue (NIAR-22): while
 * its code exchange waits, other identity requests are answered.
 */
test("a provider callback waiting on the provider does not block other identity requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-callback-queue-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Callback queue",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    administration: {
      keyFile: join(root, "key"),
      identity: { directory: join(root, "identity"), baseURL: origin },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  const key = issueAdminKey(config.administration!.keyFile);
  const remote = { exchanges: 0, waitMs: 0, nonce: "" };
  const factory = (): OAuthProvider => ({
    id: "google",
    name: "google",
    options: { clientId: "TEST-client", clientSecret: "TEST-secret" },
    accountSubject: ({ profile }) => String((profile as { sub: string }).sub),
    createAuthorizationURL(data) {
      remote.nonce = data.idTokenNonce ?? "";
      const url = new URL("https://provider.example.test/authorize");
      url.searchParams.set("state", data.state);
      url.searchParams.set("redirect_uri", data.redirectURI);
      return url;
    },
    async validateAuthorizationCode() {
      remote.exchanges++;
      await new Promise((resolve) => setTimeout(resolve, remote.waitMs));
      return {
        accessToken: "synthetic-access-secret",
        refreshToken: "synthetic-refresh-secret",
        idToken: "synthetic-id-secret",
        scopes: ["openid", "profile", "email"],
      };
    },
    idToken: {
      verify: async (token, nonce) =>
        token === "synthetic-id-secret" && nonce === remote.nonce,
    },
    async getUserInfo() {
      return {
        user: {
          email: "nobody@example.test",
          emailVerified: true,
          name: "Nobody",
        },
        data: { sub: "provider-nobody" },
      };
    },
  });
  const identity = await openIdentity(config, { authProviderFactory: factory });
  app = createReferenceServer(config, {}, identity);
  function client() {
    const cookies = new Map<string, string>();
    const headers = () => ({
      Origin: origin,
      "X-Agent-Admin": "1",
      "Content-Type": "application/json",
      Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    });
    const remember = (res: Response) => {
      for (const cookie of res.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!,
          i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
    };
    const call = async (path: string, payload?: unknown) => {
      const res = await fetch(`${origin}/admin/${path}`, {
        method: payload === undefined ? "GET" : "POST",
        headers: headers(),
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      remember(res);
      return { status: res.status, data: await res.json() };
    };
    const raw = async (path: string) => {
      const res = await fetch(`${origin}/admin/${path}`, {
        headers: headers(),
        redirect: "manual",
      });
      remember(res);
      return res;
    };
    return Object.assign(call, { raw });
  }
  const operator = client(),
    owner = client(),
    visitor = client();
  const password = "TEST-auth-password-123";
  try {
    assert.equal((await operator("api/login", { key })).status, 200);
    assert.equal(
      (
        await operator("api/identity/bootstrap", {
          name: "TEST Owner",
          email: "owner@example.test",
          password,
          organizationName: "TEST Org",
        })
      ).status,
      200,
    );
    await owner("auth/sign-in/email", {
      email: "owner@example.test",
      password,
    });
    const organizationId = (await owner("api/identity")).data.organizations[0]
      .id;
    const prepared = await owner("api/identity/auth-providers/draft", {
      organizationId,
    });
    assert.equal(prepared.status, 200);
    const saved = await owner("api/identity/auth-providers/save", {
      organizationId,
      providerId: null,
      creationId: prepared.data.providerId,
      revision: 0,
      input: {
        kind: "google",
        name: "TEST Google",
        enabled: true,
        clientId: "TEST-client",
        clientSecret: "TEST-secret",
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const providerId = prepared.data.providerId as string;

    const started = await visitor("api/identity/auth-providers/sign-in", {
      providerId,
      returnPath: "/chat",
    });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    const state = new URL(started.data.authorizationUrl).searchParams.get(
      "state",
    )!;
    assert(state);

    // The provider takes its time with the code; meanwhile the owner asks
    // the identity service for the provider list, which goes through the
    // serialised queue.
    remote.waitMs = 700;
    const callbackStarted = Date.now();
    const callback = visitor.raw(
      `auth/callback/${providerId}?state=${encodeURIComponent(state)}&code=synthetic-code`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const listStarted = Date.now();
    const list = await owner("api/identity/auth-providers/list", {
      organizationId,
    });
    const listTook = Date.now() - listStarted;
    assert.equal(list.status, 200);
    assert(
      listTook < 350,
      `the list waited ${listTook} ms behind the provider`,
    );
    const response = await callback;
    const callbackTook = Date.now() - callbackStarted;
    assert(callbackTook >= 650, `callback took ${callbackTook} ms`);
    assert.equal(response.status, 302);
    assert.equal(remote.exchanges, 1);
    // Nobody is linked to this subject and sign-ups are off, so the person is
    // sent back with the reason; the exchange itself still happened once.
    assert.match(response.headers.get("location") ?? "", /error=/);
  } finally {
    await identity.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
