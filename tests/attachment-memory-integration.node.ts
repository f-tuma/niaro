import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { openIdentity } from "../apps/server-identity/service";
import { issueAdminKey } from "../apps/server-admin/auth";
import { loadAttachmentConfiguration } from "../apps/server-attachments/schema";
import { syntheticS3 } from "./helpers/storage-s3";
import { ATTACHMENT_PROFILE } from "../packages/protocol/attachments";
import {
  CommandSchema,
  CredentialSchema,
  type Scope,
} from "../packages/protocol";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import { authRequest } from "../packages/client-core/auth";
import { ClientSession } from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const config = loadAttachmentConfiguration({
  NIARO_ATTACHMENTS_ENABLED: "true",
});
const workspaceId = randomUUID();
const scope: Scope = {
  connectionId: `account-${workspaceId}`,
  serverId: "TEST-server",
  userId: "TEST-person",
  workspaceId,
};
const command = (type: string, conversationId = "conversation-1") => ({
  type,
  conversationId,
  commandId: randomUUID(),
  idempotencyKey: randomUUID(),
});

// The object transport is synthetic; acceptance, history, source indexing and SQLite transactions are production code.
test("joint acceptance rolls back source/message/bindings together, replays once, and moves immutable lineage through archive and erasure", async () => {
  const root = mkdtempSync(join(tmpdir(), "TEST-joint-lineage-")),
    s3 = await syntheticS3();
  let fail = false;
  const store = new FixtureStorage(
    root,
    scope.serverId,
    Date.now,
    (stage, change) => {
      if (fail && stage === "before_commit" && change === "command")
        throw Error("TEST joint commit cut");
    },
    undefined,
    config,
  );
  try {
    store.initializeObjectStorage({ state: "configured", config: s3.config });
    const generation =
      store.snapshot(scope).conversations[0]!.attachmentGeneration!;
    const draft = store.attachments.createDraft(scope, {
      profile: ATTACHMENT_PROFILE,
      requestId: randomUUID(),
      target: {
        conversationId: "conversation-1",
        expectedGeneration: generation,
        mode: "current",
      },
    }).draft;
    const bytes = Buffer.from("TEST immutable source"),
      upload = store.attachments.createUpload(scope, draft.draftId, {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        expectedRevision: draft.revision,
        filename: "source.txt",
        mediaType: "text/plain",
        size: bytes.length,
        sha256: digest(bytes),
      });
    const receive = store.attachments.beginReceive(
      scope,
      upload.upload.contentId,
    );
    store.attachments.markPutting(scope, receive.id, receive.token!);
    await store.attachments
      .objectStore()
      .put(store.attachments.handle(receive), bytes);
    store.attachments.finishTransfer(scope, receive.id, receive.token!);
    const send = CommandSchema.parse({
      ...command("message.send"),
      text: "TEST I maintain purple gardens",
      language: "en",
      attachments: {
        profile: ATTACHMENT_PROFILE,
        draftId: draft.draftId,
        draftRevision: upload.draft.revision,
        generation,
        items: [{ contentId: receive.id, sha256: digest(bytes) }],
      },
    });
    fail = true;
    assert.throws(() => store.execute(scope, send), /joint commit cut/);
    assert.equal(store.profileRefs(scope, 0).length, 0);
    assert.equal(store.snapshot(scope).conversations[0]!.messages.length, 0);
    assert.equal(store.attachments.draft(scope, draft.draftId).state, "open");
    assert.equal(
      store.attachments.db
        .prepare("SELECT count(*) n FROM attachment_bindings")
        .get()!.n,
      0,
    );
    fail = false;
    assert.equal(store.execute(scope, send).status, "accepted");
    const ref = store.profileRefs(scope, 0)[0]!;
    assert(
      ref,
      "accepted attachment caption must be a committed memory source",
    );
    assert.equal(
      store.profileChat(scope, ref)?.text,
      "TEST I maintain purple gardens",
    );
    assert.equal(store.execute(scope, send).status, "accepted");
    assert.equal(store.profileRefs(scope, 0).length, 1);
    assert.equal(
      store.attachments.db
        .prepare("SELECT count(*) n FROM attachment_bindings")
        .get()!.n,
      1,
    );
    store.startSession(scope, "conversation-1");
    const moved = store.profileRefs(scope, 0)[0]!;
    assert.equal(moved.sourceId, ref.sourceId);
    assert.equal(moved.digest, ref.digest);
    assert(moved.sourceVersion > ref.sourceVersion);
    assert.equal(store.profileChat(scope, ref), null);
    const archivedId = decodeURIComponent(
      store.profileSource(scope, moved.sourceId)!.href.slice("/chat/".length),
    );
    assert(archivedId.startsWith("archived-"));
    const archivedGeneration = store.attachments.generation(scope, archivedId)!;
    assert.equal(archivedGeneration.generation_id, generation);
    assert.equal(
      store.profileChat(scope, moved)?.conversationId,
      "conversation-1",
      "native source identity remains immutable while public locator moves",
    );
    const fresh = store
      .snapshot(scope)
      .conversations.find(
        (c) => c.id === "conversation-1",
      )!.attachmentGeneration!;
    assert.notEqual(fresh, generation);
    store.execute(
      scope,
      CommandSchema.parse(command("conversation.delete", archivedId)),
    );
    assert.equal(store.profileChat(scope, moved), null);
    assert.equal(store.profileSource(scope, moved.sourceId), null);
    assert.equal(
      store.attachments.generation(scope, "conversation-1")!.generation_id,
      fresh,
    );
    assert.equal(
      store.execute(
        scope,
        CommandSchema.parse({
          ...command("message.send"),
          text: "TEST new generation survives",
          language: "en",
        }),
        {
          decision: {
            kind: "reply",
            contactId: null,
            localStart: null,
            title: null,
            durationMinutes: null,
            reply: "TEST local reply",
          },
          expectedCursor: store.snapshot(scope).cursor,
          timeZone: "UTC",
        },
      ).status,
      "accepted",
    );
    assert.equal(store.profileRefs(scope, 0).length, 2);
    assert.equal(s3.calls.filter((c) => c.method === "PUT").length, 1);
  } finally {
    store.close();
    await s3.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function productionHttp() {
  const root = mkdtempSync(join(tmpdir(), "TEST-joint-http-")),
    s3 = await syntheticS3();
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const serverConfig = ServerConfigSchema.parse({
    version: 1,
    name: "TEST joint",
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
  const key = issueAdminKey(serverConfig.administration!.keyFile);
  const identity = await openIdentity(serverConfig, {
    integrationTransport: async () => {
      providerCalls++;
      throw Error("TEST provider forbidden");
    },
  });
  app = createReferenceServer(serverConfig, {}, identity, {
    attachments: config,
    objectStorage: { state: "configured", config: s3.config },
  });
  const jar = new Map<string, string>();
  async function admin(path: string, input?: unknown) {
    const r = await fetch(origin + "/admin/" + path, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        "X-Agent-Admin": "1",
        "Content-Type": "application/json",
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    for (const c of r.headers.getSetCookie()) {
      const pair = c.split(";")[0]!,
        at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  }
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.emit("close");
    await identity.close();
    await s3.close();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await admin("api/login", { key });
    await admin("api/identity/bootstrap", {
      name: "TEST Joint Owner",
      email: "joint@example.test",
      password: "TEST-joint-password-2026",
      organizationName: "TEST Joint",
    });
    const state = IdentityStateSchema.parse(await admin("api/identity")),
      organizationId = state.organizations[0]!.id;
    await admin("api/identity/command", {
      type: "createWorkspace",
      organizationId,
      name: "TEST workspace",
    });
    const detail = OrganizationDetailSchema.parse(
        await admin(`api/identity/organization?id=${organizationId}`),
      ),
      workspaceId = detail.workspaces[0]!.id;
    const issued = await admin("api/identity/mobile/pairing", {
      organizationId,
      workspaceId,
    });
    const actor = CredentialSchema.parse(
      await authRequest(
        String(issued.address),
        "pair",
        fetch,
        undefined,
        String(issued.code),
        false,
        true,
      ),
    );
    const sources = identity["profileSources"];
    assert(sources instanceof FixtureStorage);
    return {
      base: origin + "/v1/" + workspaceId,
      actor,
      s3,
      sources,
      providerCalls: () => providerCalls,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

test("production account HTTP/S3 and ClientSession retain originals across explicit file-only send, unknown command replay, Edit/Again pin recovery and protocol refusal", async () => {
  const h = await productionHttp(),
    values = new Map<string, string>();
  let loseCommand = true;
  let referenceFailure: "uncorrelated503" | "validated503" | null = null;
  let referenceSeen = 0;
  const requests: { url: string; body: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input),
      body = typeof init?.body === "string" ? init.body : "";
    if (url.includes("/commands") || url.includes("/references"))
      requests.push({ url, body });
    const r = await fetch(input, init);
    if (
      r.ok &&
      init?.method === "POST" &&
      url.includes("/references") &&
      ++referenceSeen === 2 &&
      referenceFailure
    ) {
      const failure = referenceFailure;
      referenceFailure = null;
      await r.arrayBuffer();
      return new Response(
        JSON.stringify(
          failure === "uncorrelated503"
            ? { label: "TEST accepted pin response lost" }
            : {
                error: "attachment_unavailable",
                retryable: false,
                retryAfterSeconds: null,
              },
        ),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    if (
      r.ok &&
      init?.method === "POST" &&
      loseCommand &&
      url.includes("/commands") &&
      body.includes('"message.send"')
    ) {
      loseCommand = false;
      await r.arrayBuffer();
      throw Error("TEST accepted response lost");
    }
    return r;
  };
  const session = new ClientSession(
    h.base,
    {
      getItem: async (k) => values.get(k) ?? null,
      setItem: async (k, v) => {
        values.set(k, v);
      },
    },
    h.actor,
    transport,
    undefined,
    undefined,
    false,
    { attachments: true, attachmentId: randomUUID },
  );
  try {
    await session.start(false);
    const generation =
      session.getSnapshot().store!.conversations["conversation-1"]!
        .attachmentGeneration!;
    session.attachments.select({
      conversationId: "conversation-1",
      expectedGeneration: generation,
      mode: "current",
    });
    const bytes = Buffer.from("TEST production transport original");
    for (const name of ["A", "B", "C"]) {
      assert.equal(
        await session.attachments.add(
          {
            filename: `${name}.txt`,
            mediaType: "text/plain",
            size: bytes.length,
            read: async () => bytes,
            release: () => {},
          },
          async (b) => digest(b),
        ),
        true,
      );
    }
    const send = messageCommand(
      "",
      "en",
      randomUUID(),
      undefined,
      session.attachments.takeForSend(),
    );
    await session.send(send);
    await session.send(send);
    assert.deepEqual(session.getSnapshot().pending, send);
    await session.refresh();
    await session.sync();
    assert.equal(
      requests.filter((r) => r.body.includes(send.commandId)).length,
      1,
      "passive refresh never resends",
    );
    await session.retry();
    const history = await session.readConversation("conversation-1"),
      source = history.messages.find((m) => m.role === "user")!;
    assert.equal(history.messages.filter((m) => m.role === "user").length, 1);
    assert.equal(source.text, "");
    assert.equal(source.processing!.state, "blocked_capability");
    const firstSends = requests.filter((r) => r.body.includes(send.commandId));
    assert(firstSends.length >= 2);
    assert(firstSends.every((r) => r.body === firstSends[0]!.body));
    let downloaded: Uint8Array | undefined;
    await session.attachments.download(
      source.attachments![0]!,
      async (b) => digest(b),
      async (b) => {
        downloaded = b;
      },
    );
    assert.deepEqual(Buffer.from(downloaded!), bytes);
    const headers = { Authorization: `Bearer ${h.actor.accessToken}` };
    const old = await fetch(
      h.base + "/snapshot?conversationId=conversation-1",
      { headers },
    );
    assert.equal(old.status, 406);
    const oldHistory = await fetch(
      h.base +
        "/conversations/messages?profile=agent-conversations%2F1&conversationId=conversation-1",
      { headers },
    );
    assert.equal(oldHistory.status, 406);
    for (const action of ["Edit", "Again"]) {
      session.attachments.select({
        conversationId: "conversation-1",
        expectedGeneration: generation,
        mode: "current",
      });
      referenceFailure = action === "Edit" ? "uncorrelated503" : "validated503";
      referenceSeen = 0;
      const pinStart = requests.length;
      await assert.rejects(
        session.attachments.reuse({
          conversationId: "conversation-1",
          messageId: source.id,
          files: source.attachments!,
        }),
      );
      const blocked = session.attachments.getSnapshot();
      assert.equal(session.attachments.ready, false);
      assert.deepEqual(
        blocked.entries.map((entry) => entry.filename),
        ["A.txt", "B.txt", "C.txt"],
      );
      const failed = blocked.entries.find(
        (entry) => entry.filename === "B.txt",
      )!;
      assert.equal(failed.state, "failed");
      assert.equal(
        failed.retryable,
        true,
        "an uncertain frozen reference must expose explicit recovery",
      );
      const before = h.sources.snapshot(h.actor.scope).conversations[0]!
        .messages.length;
      await session.attachments.retry(failed.id);
      assert.equal(session.attachments.ready, true);
      const pins = requests
        .slice(pinStart)
        .filter((call) => call.url.includes("/references"));
      assert.equal(pins.length, 4);
      assert.equal(
        pins[1]!.body,
        pins[2]!.body,
        "retry reuses the exact accepted-but-unacknowledged B pin",
      );
      assert.equal(
        h.sources.snapshot(h.actor.scope).conversations[0]!.messages.length,
        before,
        "pin retry never sends",
      );
      await session.send(
        messageCommand(
          `TEST ${action} caption`,
          "en",
          randomUUID(),
          undefined,
          session.attachments.takeForSend(),
        ),
      );
    }
    assert.equal(
      (await session.readConversation("conversation-1")).messages.filter(
        (m) => m.role === "user",
      ).length,
      3,
    );
    assert.equal(h.sources.profileRefs(h.actor.scope, 0).length, 3);
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 3);
    assert.equal(h.providerCalls(), 0);
  } finally {
    session.stop();
    await h.close();
  }
});
