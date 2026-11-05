import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { openIdentity } from "../apps/server-identity/service";
import { ConversationHistory } from "../apps/fixture-server/conversation-history";
import {
  chatExportFile,
  memoryExportFile,
} from "../apps/server-identity/member-export";
import {
  CredentialSchema,
  ConversationSchema,
  type Scope,
} from "../packages/protocol";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import { MemoryItemSchema } from "../packages/protocol/memory";
import { seedIdentityFixture } from "./helpers/identity-seed";

const password = "TEST-member-export-password-2026";
const sha = "a".repeat(64);
/** What the chat shows, plus fields only the runtime uses. */
const conversation = (id: string) =>
  ConversationSchema.parse({
    id,
    revision: 3,
    messages: [
      {
        id: "TEST-m1",
        role: "user",
        text: "TEST plan the Friday review",
        logicalMessageId: "TEST-logical-1",
        createdAt: "2026-11-05T09:00:00.000Z",
        attachments: [
          {
            contentId: randomUUID(),
            filename: "TEST agenda.pdf",
            mediaType: "application/pdf",
            size: 1200,
            sha256: sha,
            availability: "available",
          },
        ],
      },
      {
        id: "TEST-m2",
        role: "assistant",
        text: "TEST Here is the plan.",
        replyToCommandId: "TEST-internal-command",
        workItemId: "TEST-internal-work-item",
        createdAt: "2026-11-05T09:00:05.000Z",
        ui: {
          type: "openui.program",
          version: 1,
          library: "niaro-ui@1",
          program: 'root = Card(["TEST-program-internals"])',
        },
      },
      {
        id: "TEST-m3",
        role: "user",
        text: "TEST and the follow-up",
        humanTask: { id: "TEST-task-1", title: "TEST Prepare slides" },
      },
    ],
  });

test("member export: chat as Markdown and JSON shows only what the chat shows; memory holds only the person's own entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "member-export-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Export",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    plugins: {
      enabled: ["datetime", "memory"],
      timeZone: "UTC",
      memory: {
        retentionDays: 365,
        maxContextChars: 8000,
        maxItems: 10,
        allowShared: true,
      },
    },
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
  const identity = await openIdentity(config, {
    integrationTransport: async () => {
      throw new Error("Exports never call a model or a service");
    },
  });
  app = createReferenceServer(config, {}, identity);
  const client = () => {
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
      for (const cookie of res.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!,
          split = pair.indexOf("=");
        cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
      return {
        status: res.status,
        headers: res.headers,
        text: await res.text(),
      };
    };
  };
  const owner = client(),
    member = client(),
    operator = client();
  const json = async (who: typeof owner, path: string, input?: unknown) => {
    const result = await who(path, input);
    assert.equal(result.status, 200, result.text);
    return JSON.parse(result.text);
  };
  try {
    await json(operator, "api/login", { key });
    await json(operator, "api/identity/bootstrap", {
      name: "TEST Owner",
      email: "owner-export@example.test",
      password,
      organizationName: "TEST Export",
    });
    await json(operator, "api/login", { key });
    await json(owner, "auth/sign-in/email", {
      email: "owner-export@example.test",
      password,
    });
    const organizationId = IdentityStateSchema.parse(
      await json(owner, "api/identity"),
    ).organizations[0]!.id;
    await json(owner, "api/identity/command", {
      type: "createWorkspace",
      organizationId,
      name: "TEST Workspace",
    });
    await seedIdentityFixture(identity, {
      type: "createAccount",
      organizationId,
      name: "TEST Member",
      email: "member-export@example.test",
      password,
      role: "member",
    });
    const detail = OrganizationDetailSchema.parse(
      await json(owner, `api/identity/organization?id=${organizationId}`),
    );
    const workspaceId = detail.workspaces[0]!.id;
    await seedIdentityFixture(identity, {
      type: "setWorkspaceMember",
      organizationId,
      workspaceId,
      memberId: detail.members.find((entry) => entry.role === "member")!.id,
      allowed: true,
    });
    await json(member, "auth/sign-in/email", {
      email: "member-export@example.test",
      password,
    });
    const target = { organizationId, workspaceId };

    // The owner's chat, written the way the chat history stores it.
    const web = await json(owner, "api/identity/app/session", target);
    const credential = CredentialSchema.parse(web.credential);
    const scope: Scope = {
      connectionId: `account-${workspaceId}`,
      serverId: credential.scope.serverId,
      workspaceId,
      userId: credential.scope.userId,
    };
    const workflow = new DatabaseSync(
      join(config.dataDirectory, "workflow.sqlite"),
    );
    workflow.exec("PRAGMA busy_timeout=2000");
    new ConversationHistory(workflow, Date.now).save(
      scope,
      conversation("TEST-chat-1"),
    );
    workflow.close();

    const chatPath = (changes: Record<string, string> = {}) =>
      `api/identity/conversations/export?${new URLSearchParams({
        ...target,
        conversationId: "TEST-chat-1",
        ...changes,
      })}`;
    const markdown = await owner(chatPath());
    assert.equal(markdown.status, 200, markdown.text);
    assert.match(markdown.headers.get("content-type")!, /^text\/markdown/);
    assert.match(
      markdown.headers.get("content-disposition")!,
      /^attachment; filename="chat-test-plan-the-friday-review-\d{4}-\d{2}-\d{2}\.md"/,
    );
    assert.equal(markdown.headers.get("cache-control"), "no-store");
    for (const visible of [
      "# TEST plan the Friday review",
      "### You · 2026-11-05 09:00 UTC",
      "TEST plan the Friday review",
      "Attachments: TEST agenda.pdf",
      "### Assistant · 2026-11-05 09:00 UTC",
      "TEST Here is the plan.",
      "_Interactive view not included._",
      "_About: TEST Prepare slides_",
      "TEST and the follow-up",
    ])
      assert(markdown.text.includes(visible), visible);
    for (const internal of [
      "TEST-internal-command",
      "TEST-internal-work-item",
      "TEST-program-internals",
      "TEST-logical-1",
      sha,
      "application/pdf",
    ]) {
      assert(!markdown.text.includes(internal), internal);
    }
    const czech = await owner(chatPath({ lang: "cs" }));
    assert(czech.text.includes("### Ty · 2026-11-05 09:00 UTC"));

    const exported = await owner(chatPath({ format: "json" }));
    assert.equal(exported.status, 200, exported.text);
    assert.match(exported.headers.get("content-type")!, /^application\/json/);
    assert.match(
      exported.headers.get("content-disposition")!,
      /filename="chat-[a-z0-9-]+\.json"/,
    );
    const body = JSON.parse(exported.text);
    assert.equal(body.profile, "niaro-chat-export");
    assert.equal(body.version, 1);
    assert.deepEqual(body.messages, [
      {
        role: "user",
        at: "2026-11-05T09:00:00.000Z",
        text: "TEST plan the Friday review",
        attachments: ["TEST agenda.pdf"],
      },
      {
        role: "assistant",
        at: "2026-11-05T09:00:05.000Z",
        text: "TEST Here is the plan.",
        interactiveView: "omitted",
      },
      {
        role: "user",
        at: null,
        text: "TEST and the follow-up",
        task: "TEST Prepare slides",
      },
    ]);

    // Someone else's chat does not exist for the member, and nobody else
    // gets in: no session, the recovery key, another method.
    assert.equal((await member(chatPath())).status, 404);
    assert.equal(
      (await owner(chatPath({ conversationId: "TEST-none" }))).status,
      404,
    );
    assert.equal((await client()(chatPath())).status, 401);
    assert.equal((await operator(chatPath())).status, 403);
    assert.equal(
      (await owner("api/identity/conversations/export", target)).status,
      405,
    );
    assert.equal((await owner(chatPath({ format: "pdf" }))).status, 400);

    // Memory: the owner's private note, the member's own, and a shared note.
    const remember = (
      who: typeof owner,
      content: string,
      scope: "private" | "workspace" = "private",
    ) =>
      json(who, "api/identity/memory", {
        ...target,
        requestId: randomUUID(),
        type: "remember",
        content,
        kind: "fact",
        scope,
      });
    await remember(owner, "TEST owner private fact");
    await remember(owner, "TEST shared workspace note", "workspace");
    await remember(member, "TEST member private fact");
    const memoryPath = (changes: Record<string, string> = {}) =>
      `api/identity/memory/export?${new URLSearchParams({ ...target, ...changes })}`;
    const mine = await member(memoryPath({ format: "json" }));
    assert.equal(mine.status, 200, mine.text);
    assert.match(
      mine.headers.get("content-disposition")!,
      /^attachment; filename="memory-\d{4}-\d{2}-\d{2}\.json"/,
    );
    const memories = JSON.parse(mine.text);
    assert.equal(memories.profile, "niaro-memory-export");
    assert.deepEqual(
      memories.memories.map((m: { text: string; origin: string }) => [
        m.text,
        m.origin,
      ]),
      [["TEST member private fact", "saved"]],
    );
    const ownerMarkdown = await owner(memoryPath());
    assert.equal(ownerMarkdown.status, 200, ownerMarkdown.text);
    assert.match(ownerMarkdown.headers.get("content-type")!, /^text\/markdown/);
    assert(ownerMarkdown.text.includes("- TEST owner private fact _(Fact, "));
    assert(!ownerMarkdown.text.includes("TEST shared workspace note"));
    assert(!ownerMarkdown.text.includes("TEST member private fact"));
    assert.equal((await operator(memoryPath())).status, 403);
    assert.equal((await client()(memoryPath())).status, 401);
  } finally {
    app.emit("close");
    await identity.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("member export files: observations, earlier versions and nothing of other scopes", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const base = {
    revision: 1,
    createdAt: at,
    updatedAt: at,
    expiresAt: null,
    supersedesId: null,
  };
  const items = [
    MemoryItemSchema.parse({
      ...base,
      id: randomUUID(),
      scope: "private",
      kind: "fact",
      status: "active",
      content: "TEST works on the pilot",
      origin: "observed",
      seenAt: at,
      trust: "model_inference",
      source: {
        type: "observed",
        section: "projects",
        personal: false,
        sources: [
          {
            type: "chat",
            sourceId: randomUUID(),
            at,
            digest: "b".repeat(64),
            messageId: "TEST-source-message",
            removed: false,
            href: "/chat/TEST-chat",
          },
        ],
      },
    }),
    MemoryItemSchema.parse({
      ...base,
      id: randomUUID(),
      scope: "private",
      kind: "preference",
      status: "superseded",
      content: "TEST old preference",
      trust: "user_assertion",
      source: { type: "user_note" },
    }),
    MemoryItemSchema.parse({
      ...base,
      id: randomUUID(),
      scope: "workspace",
      kind: "note",
      status: "active",
      content: "TEST shared note",
      trust: "user_assertion",
      source: { type: "user_note" },
    }),
  ];
  const md = memoryExportFile(items, "md", "en", new Date(at)).body;
  assert(
    md.includes(
      "## Observations\n\n- TEST works on the pilot _(Projects, 2026-11-01)_",
    ),
  );
  assert(
    md.includes(
      "- TEST old preference _(Preference, 2026-11-01, earlier version)_",
    ),
  );
  assert(!md.includes("TEST shared note"));
  assert(!md.includes("b".repeat(64)) && !md.includes("TEST-source-message"));
  const cs = memoryExportFile(items, "md", "cs", new Date(at)).body;
  assert(cs.includes("## Poznatky"));
  const file = chatExportFile(
    {
      id: "TEST-chat",
      revision: 1,
      title: "Žluťoučký kůň",
      createdAt: at,
      updatedAt: at,
      messageCount: 0,
      readOnly: false,
    },
    [],
    "md",
    "cs",
  );
  assert.equal(file.filename, "chat-zlutoucky-kun-2026-11-01.md");
});
