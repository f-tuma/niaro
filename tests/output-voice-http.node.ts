import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { openIdentity } from "../apps/server-identity/service";
import {
  AuthError,
  FixtureAuth,
  issuePairingCode,
} from "../apps/fixture-server/auth";
import { IdentityError } from "../apps/server-identity/error";
import { authRequest } from "../packages/client-core/auth";
import { CredentialSchema, type Credential } from "../packages/protocol";
import { CatalogSchema } from "../packages/protocol/service-catalog";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import {
  OUTPUT_VOICE_PROFILE,
  OutputVoiceSnapshotSchema,
  type OutputVoiceSnapshot,
} from "../packages/protocol/output-voice";
import { SpeechCapabilitiesSchema } from "../packages/protocol/speech";
import { seedIdentityFixture } from "./helpers/identity-seed";

test("output settings: actual reference HTTP derives own mobile/browser actors without provider I/O", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "output-voice-http-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST output settings",
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
  let providerCalls = 0;
  const identity = await openIdentity(config, {
    integrationTransport: async () => {
      providerCalls++;
      throw Error(
        "Settings must never invoke inference, speech, discovery or preview",
      );
    },
  });
  const key = issueAdminKey(config.administration!.keyFile);
  app = createReferenceServer(config, {}, identity);
  const password = "TEST-output-voice-password-2026";
  function browser() {
    const cookies = new Map<string, string>();
    return async (path: string, input?: unknown) => {
      const res = await fetch(`${origin}/admin/${path}`, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";")[0]!,
          i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      const data: unknown = await res.json();
      assert.equal(res.status, 200, JSON.stringify(data));
      return data;
    };
  }
  const owner = browser(),
    admin = browser(),
    member = browser();
  const profilePath = `voice/output-settings?profile=${OUTPUT_VOICE_PROFILE}`;
  const call = (
    credential: Credential,
    path = profilePath,
    input?: unknown,
    method = input === undefined ? "GET" : "POST",
  ) =>
    fetch(`${origin}/v1/${credential.scope.workspaceId}/${path}`, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "Content-Type": "application/json",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  const read = async (credential: Credential): Promise<OutputVoiceSnapshot> => {
    const response = await call(credential);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert(Buffer.byteLength(text) <= 32768);
    return OutputVoiceSnapshotSchema.parse(JSON.parse(text));
  };
  const mutation = (
    snapshot: OutputVoiceSnapshot,
    choice = snapshot.options[0]
      ? { kind: "catalogue" as const, optionId: snapshot.options[0].optionId }
      : { kind: "server-default" as const },
  ) => ({
    profile: OUTPUT_VOICE_PROFILE,
    requestId: randomUUID(),
    expectedRevision: snapshot.revision,
    catalogueRevision: snapshot.catalogueRevision,
    choice,
  });
  const error = async (response: Response, status: number, code: string) => {
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  };
  try {
    await owner("api/login", { key });
    await owner("api/identity/bootstrap", {
      name: "TEST Owner",
      email: "owner-voice@example.test",
      password,
      organizationName: "TEST Voice Org",
    });
    await owner("auth/sign-in/email", {
      email: "owner-voice@example.test",
      password,
    });
    const state = IdentityStateSchema.parse(await owner("api/identity"));
    const organizationId = state.organizations[0]!.id;
    for (const name of ["TEST Voice One", "TEST Voice Two"])
      await owner("api/identity/command", {
        type: "createWorkspace",
        organizationId,
        name,
      });
    for (const role of ["admin", "member"] as const)
      await seedIdentityFixture(identity, {
        type: "createAccount",
        organizationId,
        name: `TEST ${role}`,
        email: `${role}-voice@example.test`,
        password,
        role,
      });
    let detail = OrganizationDetailSchema.parse(
      await owner(`api/identity/organization?id=${organizationId}`),
    );
    const workspaceId = detail.workspaces[0]!.id,
      secondWorkspaceId = detail.workspaces[1]!.id;
    const memberRow = detail.members.find((m) => m.role === "member")!;
    await seedIdentityFixture(identity, {
      type: "setWorkspaceMember",
      organizationId,
      workspaceId,
      memberId: memberRow.id,
      allowed: true,
    });
    await admin("auth/sign-in/email", {
      email: "admin-voice@example.test",
      password,
    });
    await member("auth/sign-in/email", {
      email: "member-voice@example.test",
      password,
    });
    const target = { organizationId, workspaceId };
    const inventory = async () =>
      CatalogSchema.parse(
        await owner(`api/identity/catalog?${new URLSearchParams(target)}`),
      );
    const command = (input: object) =>
      owner("api/identity/catalog/command", { ...target, ...input });
    const providerResult = await command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST OR",
        url: "https://openrouter.ai/api/v1",
        enabled: true,
        dailyRequestLimit: 10,
      },
      apiKey: "TEST-no-real-provider-key",
    });
    const providerId = (providerResult as { id: string }).id;
    const modelResult = await command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId,
        name: "TEST reader",
        model: "openai/gpt-audio-mini",
        kind: "chat",
        audioOutput: true,
        tools: false,
        enabled: true,
      },
    });
    const modelId = (modelResult as { id: string }).id;
    const configure = async (voice = "cedar", enabled = true) =>
      command({
        type: "saveRouting",
        routing: {
          ...(await inventory()).routing,
          speech: {
            modelId: enabled ? modelId : null,
            method: "reader",
            voice,
            zeroDataRetention: false,
          },
        },
      });
    await configure();
    const issue = async (who = owner, ws = workspaceId) => {
      const result = (await who("api/identity/app/session", {
        organizationId,
        workspaceId: ws,
      })) as { credential: unknown };
      return CredentialSchema.parse(result.credential);
    };
    const grant = (await owner("api/identity/mobile/pairing", target)) as {
      address: string;
      code: string;
    };
    const mobile = CredentialSchema.parse(
      await authRequest(grant.address, "pair", fetch, undefined, grant.code),
    );
    const web = await issue(),
      adminWeb = await issue(admin),
      memberWeb = await issue(member),
      secondWeb = await issue(owner, secondWorkspaceId);
    const workflowBefore = await call(web, "snapshot").then((r) => r.json());
    const memberGrant = (await member(
      "api/identity/mobile/pairing",
      target,
    )) as { address: string; code: string };
    const memberMobile = CredentialSchema.parse(
      await authRequest(
        memberGrant.address,
        "pair",
        fetch,
        undefined,
        memberGrant.code,
      ),
    );
    let current!: OutputVoiceSnapshot;
    await t.test(
      "negotiated strict GET and identical mobile/browser own state",
      async () => {
        current = await read(mobile);
        assert.equal(current.scope.userId, state.user!.id);
        assert.equal(current.availability, "selectable");
        assert.equal(current.serverDefault!.label, "Cedar");
        assert.deepEqual(
          current.options.map((o) => o.label),
          ["Alloy", "Echo", "Shimmer"],
        );
        assert.deepEqual(await read(web), current);
      },
    );
    await t.test(
      "own save, browser sync, exact replay, competing CAS and ID collision",
      async () => {
        const update = mutation(current);
        const result = await call(mobile, profilePath, update);
        assert.equal(result.status, 200);
        const saved = OutputVoiceSnapshotSchema.parse(await result.json());
        assert.equal(saved.revision, 1);
        assert.equal(saved.effective.label, "Alloy");
        assert.deepEqual(await read(web), saved);
        assert.equal((await call(web, profilePath, update)).status, 200);
        await error(
          await call(web, profilePath, {
            ...mutation(current),
            choice: { kind: "server-default" },
          }),
          409,
          "output_voice_conflict",
        );
        await error(
          await call(web, profilePath, {
            ...update,
            choice: { kind: "server-default" },
          }),
          409,
          "output_voice_conflict",
        );
        current = saved;
      },
    );
    await t.test(
      "admin/member/second workspace cannot obtain or replay owner options",
      async () => {
        for (const credential of [adminWeb, memberWeb, secondWeb]) {
          const own = await read(credential);
          assert.equal(own.revision, 0);
          assert.equal(own.saved, null);
          assert.notEqual(own.catalogueRevision, current.catalogueRevision);
          await error(
            await call(credential, profilePath, mutation(current)),
            409,
            "output_voice_catalogue_changed",
          );
          await error(
            await call(credential, profilePath, {
              ...mutation(own),
              choice: current.saved!.choice,
            }),
            422,
            "output_voice_choice_unavailable",
          );
          assert.equal((await read(credential)).revision, 0);
        }
        assert.deepEqual(await read(web), current);
      },
    );
    await t.test(
      "strict profile/method/body statuses; auth happens first",
      async () => {
        const demoCode = issuePairingCode(
          config.dataDirectory,
          "demo-user",
          "a",
        );
        const demo = CredentialSchema.parse(
          await authRequest(
            `${origin}/v1/a`,
            "pair",
            fetch,
            undefined,
            demoCode,
          ),
        );
        await error(await call(demo), 404, "not_found");
        const forbidden = await fetch(
          `${origin}/v1/${secondWorkspaceId}/${profilePath}`,
          { headers: { Authorization: `Bearer ${memberWeb.accessToken}` } },
        );
        assert.equal(forbidden.status, 403);
        for (const path of [
          "voice/output-settings",
          "voice/output-settings?profile=old",
          `voice/output-settings?profile=${OUTPUT_VOICE_PROFILE}&profile=${OUTPUT_VOICE_PROFILE}`,
        ])
          await error(
            await call(web, path),
            406,
            "output_voice_profile_unsupported",
          );
        await error(
          await call(web, profilePath, undefined, "DELETE"),
          405,
          "method_not_allowed",
        );
        const unauthorized = await fetch(
          `${origin}/v1/${workspaceId}/voice/output-settings?profile=bad`,
          { method: "POST", body: "not JSON" },
        );
        assert.equal(unauthorized.status, 401);
        for (const extra of [
          { voice: "alloy" },
          { providerId },
          { modelId },
          { userId: memberRow.userId },
          { organizationId },
          { workspaceId },
          { scope: current.scope },
          { catalogue: current.options },
        ])
          await error(
            await call(web, profilePath, { ...mutation(current), ...extra }),
            400,
            "invalid_payload",
          );
        for (const choice of [
          { kind: "catalogue", optionId: "alloy" },
          { kind: "server-default", voice: "echo" },
        ])
          await error(
            await call(web, profilePath, { ...mutation(current), choice }),
            400,
            "invalid_payload",
          );
        await error(
          await call(web, profilePath, {
            ...mutation(current),
            choice: { kind: "catalogue", optionId: `ov_${"0".repeat(64)}` },
          }),
          422,
          "output_voice_choice_unavailable",
        );
        await error(
          await call(web, `${profilePath}&userId=${memberRow.userId}`),
          400,
          "invalid_payload",
        );
      },
    );
    await t.test(
      "raw UTF-8 bytes, whitespace, duplicate keys and malformed JSON are bounded before save",
      async () => {
        const valid = JSON.stringify(
          mutation(current, { kind: "server-default" }),
        );
        const raw = async (body: string) =>
          fetch(`${origin}/v1/${workspaceId}/${profilePath}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${web.accessToken}`,
              "Content-Type": "application/json",
            },
            body,
          });
        await error(
          await raw(" ".repeat(2049) + valid),
          400,
          "invalid_payload",
        );
        await error(
          await raw(
            JSON.stringify({ ...mutation(current), padding: "é".repeat(900) }),
          ),
          400,
          "invalid_payload",
        );
        await error(
          await raw('{"profile":"x","profile":"agent-output-voice/1"}'),
          400,
          "invalid_payload",
        );
        await error(await raw("{"), 400, "invalid_payload");
        // Chunked transfer has no Content-Length; count actual bytes, not parsed JSON.
        const chunked = await new Promise<{ status: number; value: unknown }>(
          (resolve, reject) => {
            const req = httpRequest(
              `${origin}/v1/${workspaceId}/${profilePath}`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${web.accessToken}` },
              },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () =>
                  resolve({
                    status: res.statusCode!,
                    value: JSON.parse(Buffer.concat(chunks).toString()),
                  }),
                );
              },
            );
            req.on("error", reject);
            req.write(" ".repeat(1024));
            req.end(" ".repeat(1025) + valid);
          },
        );
        assert.deepEqual(chunked, {
          status: 400,
          value: { error: "invalid_payload" },
        });
        assert.deepEqual(await read(web), current);
        const exact = valid.padEnd(2048, " ");
        assert.equal((await raw(exact)).status, 200);
        current = await read(web);
        assert.equal(current.saved!.choice.kind, "server-default");
      },
    );
    await t.test(
      "catalogue conflict, stale saved Reset and unavailable Reset use no synthesis",
      async () => {
        let selected = await read(web);
        assert.equal(
          (await call(web, profilePath, mutation(selected))).status,
          200,
        );
        selected = await read(web);
        await configure("echo");
        await error(
          await call(
            web,
            profilePath,
            mutation(selected, { kind: "server-default" }),
          ),
          409,
          "output_voice_catalogue_changed",
        );
        assert.equal((await read(web)).effective.reason, "selected");
        await configure("echo", false);
        const unavailable = await read(web);
        assert.equal(unavailable.availability, "speech-unavailable");
        assert.equal(unavailable.saved!.choice.kind, "catalogue");
        assert.equal(
          (
            await call(
              web,
              profilePath,
              mutation(unavailable, { kind: "server-default" }),
            )
          ).status,
          200,
        );
        const reset = await read(web);
        assert.equal(reset.revision, unavailable.revision + 1);
        assert.equal(reset.saved!.choice.kind, "server-default");
        assert.equal(reset.effective.reason, "speech-unavailable");
        await configure();
        assert.equal((await read(web)).effective.label, "Cedar");
      },
    );
    await t.test(
      "held settings saves classify the current catalogue after an administrator route edit",
      async () => {
        const before = await read(web);
        const retained = await identity.mobileAccess(
          `Bearer ${web.accessToken}`,
          workspaceId,
          new FixtureAuth(config.dataDirectory).serverId,
        );
        const update = mutation(before, {
          kind: "catalogue",
          optionId: before.options[0]!.optionId,
        });
        const held = await holdSave(web, update);
        try {
          await configure("shimmer");
          const response = await held.finish();
          assert.deepEqual(response, {
            status: 409,
            value: { error: "output_voice_catalogue_changed" },
          });
          const after = await read(mobile);
          assert.equal(after.revision, before.revision);
          assert.deepEqual(after.saved, before.saved);
          assert.notEqual(after.catalogueRevision, before.catalogueRevision);
          assert.equal(after.serverDefault!.label, "Shimmer");
          assert.deepEqual(await retained.outputVoiceSettings!.read(), after);
          await assert.rejects(
            retained.run(() => {}),
            {
              message: "model_unavailable",
            },
          );
          assert.equal(providerCalls, 0);
        } finally {
          held.close();
          await configure();
        }
      },
    );
    await t.test(
      "a held exact receipt replay returns current catalogue state and still requires current authentication",
      async () => {
        const before = await read(web);
        const update = mutation(before, {
          kind: "catalogue",
          optionId: before.options[0]!.optionId,
        });
        const committed = await call(web, profilePath, update);
        assert.equal(committed.status, 200);
        const saved = OutputVoiceSnapshotSchema.parse(await committed.json());
        assert.equal(saved.revision, before.revision + 1);
        const held = await holdSave(mobile, update);
        try {
          await configure("shimmer");
          const response = await held.finish();
          assert.equal(response.status, 200);
          const replay = OutputVoiceSnapshotSchema.parse(response.value);
          assert.equal(replay.revision, saved.revision);
          assert.equal(replay.serverDefault!.label, "Shimmer");
          assert.equal(replay.effective.label, "Alloy");
          assert.notEqual(replay.catalogueRevision, saved.catalogueRevision);
          assert.deepEqual(replay, await read(web));
        } finally {
          held.close();
          await configure();
        }
        const temporary = await issue();
        const revoked = await holdSave(temporary, update);
        try {
          await identity.revokeMobile(`Bearer ${temporary.accessToken}`);
          assert.deepEqual(await revoked.finish(), {
            status: 401,
            value: { error: "auth_expired" },
          });
          const after = await read(web);
          assert.equal(after.revision, saved.revision);
          assert.deepEqual(after.saved, saved.saved);
          assert.equal(providerCalls, 0);
        } finally {
          revoked.close();
        }
      },
    );
    async function holdSave(
      credential: Credential,
      update: ReturnType<typeof mutation>,
    ) {
      let admitted!: () => void;
      const admission = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      const originalAccess = identity.mobileAccess.bind(identity);
      identity.mobileAccess = async (...args) => {
        const access = await originalAccess(...args);
        if (args[0] === `Bearer ${credential.accessToken}`) admitted();
        return access;
      };
      const payload = JSON.stringify(update);
      let request!: ReturnType<typeof httpRequest>;
      const response = new Promise<{ status: number; value: unknown }>(
        (resolve, reject) => {
          request = httpRequest(
            `${origin}/v1/${workspaceId}/${profilePath}`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${credential.accessToken}` },
              signal: AbortSignal.timeout(10000),
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk) => chunks.push(chunk));
              res.on("end", () =>
                resolve({
                  status: res.statusCode!,
                  value: JSON.parse(Buffer.concat(chunks).toString()),
                }),
              );
            },
          );
          request.on("error", reject);
          request.write(payload.slice(0, 1));
        },
      );
      try {
        await admission;
      } finally {
        identity.mobileAccess = originalAccess;
      }
      return {
        finish: () => {
          request.end(payload.slice(1));
          return response;
        },
        close: () => request.destroy(),
      };
    }
    await t.test(
      "second organization has isolated state even for the same authenticated person",
      async () => {
        const db = identity["db"],
          now = new Date().toISOString(),
          otherOrg = randomUUID();
        // Synthetic fixture only: enrollment APIs deliberately do not create extra organizations.
        db.prepare(
          'INSERT INTO organization (id,name,slug,"createdAt") VALUES (?,?,?,?)',
        ).run(otherOrg, "TEST Other Voice Org", `test-${otherOrg}`, now);
        db.prepare(
          'INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES (?,?,?,?,?)',
        ).run(randomUUID(), otherOrg, state.user!.id, "owner", now);
        await owner("api/identity/command", {
          type: "createWorkspace",
          organizationId: otherOrg,
          name: "TEST Other Voice Workspace",
        });
        const otherDetail = OrganizationDetailSchema.parse(
          await owner(`api/identity/organization?id=${otherOrg}`),
        );
        const issued = (await owner("api/identity/app/session", {
          organizationId: otherOrg,
          workspaceId: otherDetail.workspaces[0]!.id,
        })) as { credential: unknown };
        const own = await read(CredentialSchema.parse(issued.credential));
        assert.equal(own.saved, null);
        assert.equal(own.revision, 0);
        assert.notEqual(
          own.catalogueRevision,
          (await read(web)).catalogueRevision,
        );
      },
    );
    await t.test(
      "credential revocation blocks retained callbacks while membership remains valid",
      async () => {
        const temporary = await issue();
        const header = `Bearer ${temporary.accessToken}`;
        const runtime = await identity.mobileAccess(
          header,
          workspaceId,
          new FixtureAuth(config.dataDirectory).serverId,
        );
        const snapshot = await runtime.outputVoiceSettings!.read();
        await identity.revokeMobile(header);
        const expired = (e: unknown) =>
          e instanceof AuthError &&
          e.status === 401 &&
          e.code === "auth_expired";
        await assert.rejects(runtime.outputVoiceSettings!.read(), expired);
        await assert.rejects(
          runtime.outputVoiceSettings!.save(mutation(snapshot)),
          expired,
        );
        await error(await call(temporary), 401, "auth_expired");
        assert.equal((await read(web)).scope.userId, snapshot.scope.userId);
      },
    );
    await t.test(
      "current membership revocation refuses held runtime callbacks and both grant types",
      async () => {
        const runtime = await identity.mobileAccess(
          `Bearer ${memberWeb.accessToken}`,
          workspaceId,
          new FixtureAuth(config.dataDirectory).serverId,
        );
        assert(runtime.outputVoiceSettings);
        const before = await runtime.outputVoiceSettings.read();
        // Hold a real POST after authentication but before its complete JSON body arrives.
        let admitted!: () => void;
        const admission = new Promise<void>((resolve) => {
          admitted = resolve;
        });
        const originalAccess = identity.mobileAccess.bind(identity);
        identity.mobileAccess = async (...args) => {
          const access = await originalAccess(...args);
          if (args[0] === `Bearer ${memberWeb.accessToken}`) admitted();
          return access;
        };
        const heldBody = JSON.stringify(mutation(before));
        let heldRequest!: ReturnType<typeof httpRequest>;
        const heldResponse = new Promise<number>((resolve, reject) => {
          heldRequest = httpRequest(
            `${origin}/v1/${workspaceId}/${profilePath}`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${memberWeb.accessToken}` },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode!));
            },
          );
          heldRequest.on("error", reject);
          heldRequest.write(heldBody.slice(0, 1));
        });
        await admission;
        await owner("api/identity/command", {
          type: "setWorkspaceMember",
          ...target,
          memberId: memberRow.id,
          allowed: false,
        });
        heldRequest.end(heldBody.slice(1));
        assert([401, 403].includes(await heldResponse));
        identity.mobileAccess = originalAccess;
        await assert.rejects(
          runtime.outputVoiceSettings.read(),
          (e: unknown) =>
            (e instanceof AuthError || e instanceof IdentityError) &&
            [401, 403].includes(e.status),
        );
        await assert.rejects(
          runtime.outputVoiceSettings.save(mutation(before)),
          (e: unknown) =>
            (e instanceof AuthError || e instanceof IdentityError) &&
            [401, 403].includes(e.status),
        );
        assert([401, 403].includes((await call(memberWeb)).status));
        assert([401, 403].includes((await call(memberMobile)).status));
        detail = OrganizationDetailSchema.parse(
          await owner(`api/identity/organization?id=${organizationId}`),
        );
        assert.equal(
          detail.members.find((m) => m.id === memberRow.id)!.role,
          "member",
        );
      },
    );
    await t.test(
      "legacy speech capabilities keep strict field keys and settings leave workflow untouched",
      async () => {
        const caps = await call(web, "voice/speech").then((r) => r.json());
        SpeechCapabilitiesSchema.parse(caps);
        assert.deepEqual(Object.keys(caps).sort(), [
          "enabled",
          "maxTextLength",
          "model",
          "processing",
          "profile",
        ]);
        const snapshot = await call(web, "snapshot").then((r) => r.json());
        assert.deepEqual(snapshot, workflowBefore);
        assert.equal(snapshot.cursor, 0);
        assert.equal((await inventory()).providers[0]!.requestsToday, 0);
        assert.equal(providerCalls, 0);
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app!.emit("close");
    await identity.close();
    rmSync(root, { recursive: true, force: true });
    assert.equal(
      providerCalls,
      0,
      "all settings and refusal paths must be passive",
    );
  }
});
