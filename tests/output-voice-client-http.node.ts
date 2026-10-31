import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { openIdentity } from "../apps/server-identity/service";
import { authRequest } from "../packages/client-core/auth";
import { ClientSession } from "../packages/client-core/session";
import { CredentialSchema, type Credential } from "../packages/protocol";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import {
  OUTPUT_VOICE_PROFILE,
  type OutputVoiceChoice,
  type OutputVoiceSnapshot,
} from "../packages/protocol/output-voice";
import { CatalogSchema } from "../packages/protocol/service-catalog";

test(
  "actual ClientSession shares own mobile/browser voice through reference HTTP without provider or workflow calls",
  { timeout: 20000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "output-voice-client-http-"));
    let app: ReturnType<typeof createReferenceServer> | undefined;
    let identity: Awaited<ReturnType<typeof openIdentity>> | undefined;
    const server = createServer((req, res) => app!.emit("request", req, res));
    const sessions: ClientSession[] = [];
    let providerCalls = 0;
    t.after(async () => {
      sessions.forEach((session) => session.stop());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app?.emit("close");
      await identity?.close();
      rmSync(root, { recursive: true, force: true });
      assert.equal(providerCalls, 0);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const config = ServerConfigSchema.parse({
      version: 1,
      name: "TEST voice client HTTP",
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
    identity = await openIdentity(config, {
      integrationTransport: async () => {
        providerCalls++;
        throw Error("Settings must never call a provider");
      },
    });
    app = createReferenceServer(config, {}, identity);
    const cookies = new Map<string, string>();
    const admin = async (path: string, input?: unknown): Promise<unknown> => {
      const response = await fetch(`${origin}/admin/${path}`, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!,
          index = pair.indexOf("=");
        cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      const value: unknown = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    const observed: { method: string; path: string }[] = [];
    const make = (
      credential: Credential,
      rewrite?: (url: string) => string,
    ) => {
      const session = new ClientSession(
        `${origin}/v1/${credential.scope.workspaceId}`,
        { getItem: async () => null, setItem: async () => {} },
        credential,
        async (input, init) => {
          const url = new URL(rewrite ? rewrite(String(input)) : String(input));
          assert.equal(url.origin, origin);
          observed.push({
            method: init?.method ?? "GET",
            path: url.pathname + url.search,
          });
          return fetch(url, init);
        },
      );
      sessions.push(session);
      return session;
    };
    const signal = () => new AbortController().signal;
    const read = async (session: ClientSession) => {
      const snapshot = await session.outputVoiceSettings(signal());
      assert(snapshot);
      return snapshot;
    };
    const update = (
      snapshot: OutputVoiceSnapshot,
      choice: OutputVoiceChoice,
    ) => ({
      profile: OUTPUT_VOICE_PROFILE,
      requestId: randomUUID(),
      expectedRevision: snapshot.revision,
      catalogueRevision: snapshot.catalogueRevision,
      choice,
    });
    const workflow = async (credential: Credential) => {
      const response = await fetch(
        `${origin}/v1/${credential.scope.workspaceId}/snapshot`,
        {
          headers: { Authorization: `Bearer ${credential.accessToken}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      assert.equal(response.status, 200);
      return response.json();
    };

    await admin("api/login", { key });
    const email = "client-voice@example.test",
      password = "TEST-local-client-voice-2026";
    await admin("api/identity/bootstrap", {
      name: "TEST Voice Client",
      email,
      password,
      organizationName: "TEST Voice Client Org",
    });
    await admin("auth/sign-in/email", { email, password });
    const state = IdentityStateSchema.parse(await admin("api/identity"));
    const organizationId = state.organizations[0]!.id;
    for (const name of ["TEST Voice One", "TEST Voice Two"])
      await admin("api/identity/command", {
        type: "createWorkspace",
        organizationId,
        name,
      });
    const detail = OrganizationDetailSchema.parse(
      await admin(`api/identity/organization?id=${organizationId}`),
    );
    const workspaceId = detail.workspaces[0]!.id,
      otherWorkspaceId = detail.workspaces[1]!.id;
    const target = { organizationId, workspaceId };
    const command = (input: object) =>
      admin("api/identity/catalog/command", { ...target, ...input });
    const provider = (await command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST reader provider",
        url: "https://openrouter.ai/api/v1",
        enabled: true,
        dailyRequestLimit: 5,
      },
      apiKey: "TEST-no-network-key",
    })) as { id: string };
    const model = (await command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId: provider.id,
        name: "TEST reader",
        model: "openai/gpt-audio-mini",
        kind: "chat",
        audioOutput: true,
        tools: false,
        enabled: true,
      },
    })) as { id: string };
    const inventory = async () =>
      CatalogSchema.parse(
        await admin(`api/identity/catalog?${new URLSearchParams(target)}`),
      );
    await command({
      type: "saveRouting",
      routing: {
        ...(await inventory()).routing,
        speech: {
          modelId: model.id,
          method: "reader",
          voice: "cedar",
          zeroDataRetention: false,
        },
      },
    });
    const issue = async (ws = workspaceId) => {
      const issued = (await admin("api/identity/app/session", {
        organizationId,
        workspaceId: ws,
      })) as { credential: unknown };
      return CredentialSchema.parse(issued.credential);
    };
    const grant = (await admin("api/identity/mobile/pairing", target)) as {
      address: string;
      code: string;
    };
    assert.equal(new URL(grant.address).origin, origin);
    const mobileCredential = CredentialSchema.parse(
      await authRequest(grant.address, "pair", fetch, undefined, grant.code),
    );
    const browserCredential = await issue();
    const mobile = make(mobileCredential),
      browser = make(browserCredential),
      other = make(await issue(otherWorkspaceId));
    const workflowBefore = await workflow(browserCredential);
    const initial = await read(mobile);
    assert.equal(initial.revision, 0);
    assert.deepEqual(await read(browser), initial);
    const echo = initial.options.find((option) => option.label === "Echo");
    assert(echo);
    const first = update(initial, {
      kind: "catalogue",
      optionId: echo.optionId,
    });
    const saved = await mobile.saveOutputVoiceSettings(first, signal());
    assert.equal(saved.revision, 1);
    assert.equal(saved.effective.label, "Echo");
    assert.deepEqual(await read(browser), saved);
    assert.deepEqual(
      await browser.saveOutputVoiceSettings(first, signal()),
      saved,
    );
    await assert.rejects(
      browser.saveOutputVoiceSettings(
        update(initial, { kind: "server-default" }),
        signal(),
      ),
      /output_voice_conflict/,
    );
    const otherState = await read(other);
    assert.equal(otherState.saved, null);
    assert.equal(otherState.revision, 0);
    assert.notEqual(otherState.catalogueRevision, saved.catalogueRevision);
    await assert.rejects(
      other.saveOutputVoiceSettings(first, signal()),
      /output_voice_catalogue_changed/,
    );
    assert.deepEqual(await read(mobile), saved);
    const reset = await browser.saveOutputVoiceSettings(
      update(saved, { kind: "server-default" }),
      signal(),
    );
    assert.equal(reset.revision, 2);
    assert.deepEqual(await read(mobile), reset);
    assert.equal(reset.saved?.choice.kind, "server-default");

    // Only the URL is rewritten: the refusal still comes from the real HTTP handler.
    const unsupported = make(browserCredential, (url) =>
      url.replace(OUTPUT_VOICE_PROFILE, "unsupported/1"),
    );
    assert.equal(await unsupported.outputVoiceSettings(signal()), null);
    // A corrupt local actor claim must not accept an honest server's foreign scope.
    const wrongActor = make({
      ...browserCredential,
      scope: { ...browserCredential.scope, userId: "TEST-foreign-local-claim" },
    });
    await assert.rejects(
      wrongActor.outputVoiceSettings(signal()),
      /output_voice_context_changed/,
    );
    const revokedCredential = await issue(),
      revoked = make(revokedCredential);
    await identity.revokeMobile(`Bearer ${revokedCredential.accessToken}`);
    await assert.rejects(revoked.outputVoiceSettings(signal()), /auth_expired/);
    assert.deepEqual(await workflow(browserCredential), workflowBefore);
    assert.equal(providerCalls, 0);
    assert.equal((await inventory()).providers[0]!.requestsToday, 0);
    assert(
      observed.every(
        (call) =>
          call.path.endsWith(
            `/voice/output-settings?profile=${OUTPUT_VOICE_PROFILE}`,
          ) ||
          call.path.endsWith("/voice/output-settings?profile=unsupported/1"),
      ),
    );
    assert.equal(observed.filter((call) => call.method === "POST").length, 5);
  },
);
