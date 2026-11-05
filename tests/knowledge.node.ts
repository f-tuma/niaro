import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import {
  KnowledgeSettings,
  type KnowledgeSourceValue,
} from "../packages/protocol/knowledge";
import { emptyWorkspacePolicy } from "../packages/protocol/model-policy";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import { createTransport } from "../apps/server-integrations/transport";
import {
  chunkText,
  Knowledge,
  knowledgeEmbedder,
  KnowledgeStore,
  resultText,
  type KnowledgeFile,
  type KnowledgeTarget,
} from "../apps/server-identity/knowledge";
import { openKnowledgeIndex } from "../apps/server-agent/knowledge-index";
import { answerReceipts } from "../apps/server-identity/answer-receipts";
import { AnswerReceiptSchema } from "../packages/protocol/answer-receipts";
import { knowledgeSection } from "../apps/server-identity/config-bundle/sections/knowledge";
import {
  SectionOutcome,
  type WorkspaceContext,
} from "../apps/server-identity/config-bundle/registry";
import { storedTurn } from "./helpers/answer-receipts";

const organizationId = "org";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const at = (userId: string): KnowledgeTarget => ({
  organizationId,
  workspaceId,
  userId,
});
const TOPICS = ["price", "complaint", "holiday"];
/** A stand-in embedding: one axis per topic word, plus a constant axis. */
const vectorOf = (text: string) => [
  ...TOPICS.map((topic) => text.toLowerCase().split(topic).length - 1 + 0.01),
  0.1,
];

/** A local OpenAI-compatible `/v1/embeddings`: no real network. */
async function embeddingServer() {
  const seen: { path: string; body: { model: string; input: string[] } }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({ path: req.url ?? "/", body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: (body.input as string[]).map((text, index) => ({
            object: "embedding",
            index,
            embedding: vectorOf(text),
          })),
          model: body.model,
          usage: { prompt_tokens: 12, total_tokens: 12 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function harness(
  options: {
    embedding?: boolean;
    dailyRequestLimit?: number;
    free?: boolean;
  } = {},
) {
  const server = await embeddingServer();
  const db = new DatabaseSync(":memory:");
  db.exec(
    `PRAGMA foreign_keys=ON; CREATE TABLE organization(id TEXT PRIMARY KEY); CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT);CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);INSERT INTO organization VALUES ('${organizationId}');INSERT INTO agent_workspace VALUES ('${workspaceId}','${organizationId}');`,
  );
  const catalog = new ServiceCatalogStore(db, "test-only-secret", [
    server.origin,
  ]);
  const command = (body: object) =>
    catalog.command(
      CatalogCommand.parse({ organizationId, workspaceId, ...body }),
    );
  const providerId = command({
    type: "saveProvider",
    revision: 0,
    settings: {
      name: "TEST local embeddings",
      url: `${server.origin}/v1`,
      enabled: true,
      dailyRequestLimit: options.dailyRequestLimit ?? 1000,
      auth: { type: "none" },
      free: options.free ?? false,
    },
  });
  const addModel = (model: string) =>
    command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId,
        name: `TEST ${model}`,
        model,
        enabled: true,
        tools: false,
        kind: "embedding",
      },
    });
  const modelId = addModel("TEST-embed-small");
  const routeEmbedding = (id: string | null) =>
    command({
      type: "saveWorkspaceModelPolicy",
      revision: catalog.modelPolicies(organizationId, workspaceId).workspace
        .revision,
      policy: {
        ...emptyWorkspacePolicy(),
        roles: id ? { embedding: { models: [id] } } : {},
      },
    });
  if (options.embedding !== false) routeEmbedding(modelId);
  // A shared service with one read action that needs no input: a source.
  const serviceId = command({
    type: "saveService",
    revision: 0,
    settings: {
      name: "TEST Wiki",
      url: "https://wiki.example.test/api",
      protocol: "openapi",
      icon: "folder",
      auth: { type: "none" },
      enabled: true,
    },
  });
  const actionId = command({
    type: "saveAction",
    serviceId,
    serviceRevision: catalog.service(workspaceId, serviceId).revision,
    revision: 0,
    settings: {
      name: "TEST procedures",
      description: "TEST",
      inputSchema: { type: "object", properties: {} },
      binding: {
        type: "http",
        method: "GET",
        path: "/procedures",
        parameters: [],
        body: false,
      },
      effect: "read",
      approval: "never",
      enabled: true,
      policy: { roles: ["member"], users: [] },
    },
  });
  const source: KnowledgeSourceValue = { serviceId, actionId };
  const members = new Set(["admin", "alice", "bob", "carol"]);
  const grants = new Set(["admin", "carol"]);
  const files = new Map<
    string,
    KnowledgeFile & { text?: string; available: boolean }
  >();
  let sourceText = "Complaint procedure: Petra handles every complaint.";
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  };
  const index = await openKnowledgeIndex(":memory:");
  const store = new KnowledgeStore(db);
  const knowledge = new Knowledge({
    store,
    index: async () => index,
    serial,
    files: () => ({
      list: () => [...files.values()].filter((file) => file.available),
      available: (_workspace, userId, contentId) => {
        const file = files.get(contentId);
        return !!file && file.available && file.userId === userId;
      },
      read: async (file) => files.get(file.contentId)?.text,
    }),
    embedding: (org, workspace) => catalog.resolveEmbedding(org, workspace),
    embed: knowledgeEmbedder({
      transport: createTransport([server.origin]),
      catalog,
      serial: (run) => serial(run),
    }),
    readSource: async () => ({
      name: "TEST Wiki · TEST procedures",
      text: sourceText,
    }),
    candidates: () => [
      {
        serviceId,
        serviceName: "TEST Wiki",
        actions: [{ id: actionId, name: "TEST procedures" }],
      },
    ],
    sourceVisible: (target, value) =>
      grants.has(target.userId) &&
      value.serviceId === serviceId &&
      value.actionId === actionId,
    member: (target) => {
      if (!members.has(target.userId)) throw new Error("identity_forbidden");
    },
    filesReadable: () => true,
  });
  const addFile = (
    contentId: string,
    userId: string,
    name: string,
    text: string | undefined,
  ) =>
    files.set(contentId, {
      contentId,
      userId,
      name,
      sha256: contentId.padEnd(64, "0").slice(0, 64),
      text,
      available: true,
    });
  const selected = () => catalog.resolveEmbedding(organizationId, workspaceId)!;
  const search = async (userId: string, question: string) =>
    knowledge.search({
      target: at(userId),
      selected: selected(),
      vector: Float32Array.from(vectorOf(question)),
      limit: 8,
    });
  return {
    db,
    server,
    catalog,
    command,
    providerId,
    modelId,
    addModel,
    routeEmbedding,
    source,
    members,
    grants,
    files,
    addFile,
    setSourceText: (text: string) => {
      sourceText = text;
    },
    index,
    store,
    knowledge,
    search,
    selected,
    close: async () => {
      await knowledge.close();
      await index.close();
      db.close();
      await server.close();
    },
  };
}

test("passages end at a paragraph or sentence and overlap; service results read as text", () => {
  const text =
    "First paragraph about prices. It has two sentences.\n\n" +
    "Second paragraph about complaints and who handles them. ".repeat(12) +
    "\n\nLast one.";
  const chunks = chunkText(text, { size: 300, overlap: 60 });
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
  assert.ok(chunks[0]!.startsWith("First paragraph about prices."));
  assert.ok(chunks.every((chunk) => /[.]$/.test(chunk)));
  // Consecutive passages share words so a split sentence is found in either.
  const tail = chunks[1]!.slice(-30);
  assert.ok(chunks[2]!.includes(tail.split(" ").slice(-2).join(" ")));
  assert.deepEqual(chunkText("   ", { size: 300, overlap: 0 }), []);
  assert.equal(
    resultText({
      content: [{ type: "text", text: JSON.stringify({ title: "Refunds" }) }],
    }),
    "title: Refunds",
  );
  assert.equal(
    resultText({ items: [{ name: "A", owner: { name: "Petra" } }] }),
    "items:\n  name: A\n  owner:\n    name: Petra",
  );
});

test("without an embedding model there is no index and no search", async () => {
  const h = await harness({ embedding: false });
  try {
    h.addFile("file-a", "alice", "prices.pdf", "The price is 100.");
    await h.knowledge.sync(at("admin"), false);
    const view = await h.knowledge.view(organizationId, workspaceId);
    assert.equal(view.status.state, "off");
    assert.equal(view.status.model, null);
    assert.equal(view.status.chunks, 0);
    assert.equal(h.server.seen.length, 0);
    await h.knowledge.indexFiles(at("alice"), [
      {
        contentId: "file-b",
        name: "x.txt",
        sha256: "b".repeat(64),
        text: "price",
      },
    ]);
    assert.equal(h.server.seen.length, 0);
    assert.deepEqual(await h.index.documents(workspaceId), []);
  } finally {
    await h.close();
  }
});

test("files are found only by their sender, and only while they may still open them", async () => {
  const h = await harness();
  try {
    h.addFile(
      "file-a",
      "alice",
      "alice-prices.pdf",
      "Our price for installation is 12000.",
    );
    h.addFile(
      "file-b",
      "bob",
      "bob-prices.pdf",
      "Bob's secret price list: 9000.",
    );
    await h.knowledge.sync(at("admin"), false);
    // Every request went to the administrator's embedding model, by name.
    assert.ok(h.server.seen.length >= 2);
    assert.ok(
      h.server.seen.every(
        (request) =>
          request.path === "/v1/embeddings" &&
          request.body.model === "TEST-embed-small",
      ),
    );
    const alice = await h.search("alice", "price");
    assert.deepEqual(
      alice.map((hit) => hit.name),
      ["alice-prices.pdf"],
    );
    assert.equal(alice[0]!.ownerUserId, "alice");
    // Bob's file never reaches Alice, Alice's never reaches Bob.
    assert.deepEqual(
      (await h.search("bob", "price")).map((hit) => hit.name),
      ["bob-prices.pdf"],
    );
    // Carol sent nothing and finds nothing.
    assert.deepEqual(await h.search("carol", "price"), []);
    // A deleted chat makes the file unavailable: no hit, even before a sync.
    h.files.get("file-a")!.available = false;
    assert.deepEqual(await h.search("alice", "price"), []);
    h.files.get("file-a")!.available = true;
    // Someone who left the workspace gets nothing at all.
    h.members.delete("alice");
    assert.deepEqual(await h.search("alice", "price"), []);
    h.members.add("alice");
    // Files turned off: none are searched.
    const { revision, settings } = h.store.read(organizationId, workspaceId);
    await h.knowledge.save(at("admin"), revision, {
      ...settings,
      files: false,
    });
    await h.knowledge.idle();
    assert.deepEqual(await h.search("alice", "price"), []);
  } finally {
    await h.close();
  }
});

test("service sources are off until picked and follow each person's grant", async () => {
  const h = await harness();
  try {
    assert.deepEqual(
      h.store.read(organizationId, workspaceId).settings.sources,
      [],
    );
    await h.knowledge.sync(at("admin"), false);
    assert.deepEqual(await h.search("carol", "complaint"), []);
    // Only a candidate may be a source.
    await assert.rejects(
      h.knowledge.save(at("admin"), 0, {
        ...KnowledgeSettings.parse({}),
        sources: [{ serviceId: h.source.serviceId, actionId: "TEST-other" }],
      }),
      /knowledge_source_unavailable/,
    );
    await h.knowledge.save(at("admin"), 0, {
      ...KnowledgeSettings.parse({}),
      sources: [h.source],
    });
    await h.knowledge.idle();
    const carol = await h.search("carol", "complaint");
    assert.equal(carol.length, 1);
    assert.equal(carol[0]!.kind, "service");
    assert.equal(carol[0]!.name, "TEST Wiki · TEST procedures");
    assert.match(carol[0]!.text, /Petra handles every complaint/);
    // Bob may not use the action: the source never reaches him.
    assert.deepEqual(await h.search("bob", "complaint"), []);
    // Carol loses the grant: her next search finds nothing.
    h.grants.delete("carol");
    assert.deepEqual(await h.search("carol", "complaint"), []);
    h.grants.add("carol");
    // Unpicked: gone from searches and, after the pass, from the index.
    await h.knowledge.save(at("admin"), 1, KnowledgeSettings.parse({}));
    await h.knowledge.idle();
    assert.deepEqual(await h.search("carol", "complaint"), []);
    assert.deepEqual(await h.index.documents(workspaceId), []);
  } finally {
    await h.close();
  }
});

test("a pass skips what has not changed, a rebuild starts over, and the status tells where the index stands", async () => {
  const h = await harness();
  try {
    h.addFile(
      "file-a",
      "alice",
      "prices.pdf",
      "Holiday price list for winter.",
    );
    h.addFile("file-empty", "alice", "scan.png", undefined);
    await h.knowledge.save(at("admin"), 0, {
      ...KnowledgeSettings.parse({}),
      sources: [h.source],
    });
    await h.knowledge.idle();
    const first = h.server.seen.length;
    const ids = (await h.search("alice", "holiday")).map((hit) => hit.id);
    assert.equal(ids.length, 1);
    let view = await h.knowledge.view(organizationId, workspaceId);
    assert.equal(view.status.state, "idle");
    assert.equal(view.status.model, "TEST TEST-embed-small");
    assert.equal(view.status.documents, 2);
    assert.ok(view.status.chunks >= 2);
    assert.ok(view.status.lastSync);
    // The unreadable file is named with a code, never its content.
    assert.deepEqual(
      view.status.errors.map((error) => [error.source, error.error]),
      [["scan.png", "knowledge_empty"]],
    );
    // Nothing changed: nothing is embedded again.
    await h.knowledge.sync(at("admin"), false);
    assert.equal(h.server.seen.length, first);
    // A changed source is embedded again on the next pass.
    h.setSourceText("Complaint procedure: Jana handles complaints now.");
    await h.knowledge.sync(at("admin"), false);
    assert.equal(h.server.seen.length, first + 1);
    assert.match((await h.search("carol", "complaint"))[0]!.text, /Jana/);
    // A rebuild drops everything and embeds it again; passage ids stay, so
    // receipts keep their citations.
    const before = h.server.seen.length;
    await h.knowledge.rebuild(at("admin"));
    assert.ok(h.server.seen.length >= before + 2);
    assert.deepEqual(
      (await h.search("alice", "holiday")).map((hit) => hit.id),
      ids,
    );
    // Another embedding model: the old passages are stale and not searched.
    const other = h.addModel("TEST-embed-large");
    h.routeEmbedding(other);
    view = await h.knowledge.view(organizationId, workspaceId);
    assert.equal(view.status.chunks, 0);
    assert.ok(view.status.stale >= 2);
    assert.deepEqual(await h.search("alice", "holiday"), []);
    await h.knowledge.rebuild(at("admin"));
    view = await h.knowledge.view(organizationId, workspaceId);
    assert.equal(view.status.stale, 0);
    assert.equal((await h.search("alice", "holiday")).length, 1);
  } finally {
    await h.close();
  }
});

test("embedding calls go through the usage limits and the provider's daily limit", async () => {
  const h = await harness({ dailyRequestLimit: 3, free: true });
  try {
    h.addFile("file-a", "alice", "prices.pdf", "price ".repeat(10));
    await h.knowledge.sync(at("admin"), false);
    const attempts = h.db
      .prepare(
        "SELECT a.kind,a.status,a.input_tokens,a.output_tokens,r.id AS run,r.user_id FROM agent_inference_attempt a JOIN agent_inference_run r ON r.id=a.run_id",
      )
      .all();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.kind, "embedding");
    // An embedding reports its input alone; a free provider's zero price
    // settles it as a known call.
    assert.equal(attempts[0]!.status, "settled");
    assert.equal(attempts[0]!.input_tokens, 12);
    assert.equal(attempts[0]!.output_tokens, 0);
    assert.match(String(attempts[0]!.run), /^knowledge\//);
    // The file's pass runs as its sender.
    assert.equal(attempts[0]!.user_id, "alice");
    assert.equal(
      h.catalog.provider(organizationId, h.providerId).provider.requestsToday,
      1,
    );
    // No longer free: stopping at the limit needs a price for the model.
    h.command({
      type: "saveProvider",
      id: h.providerId,
      revision: 1,
      settings: {
        name: "TEST local embeddings",
        url: `${h.server.origin}/v1`,
        enabled: true,
        dailyRequestLimit: 3,
        auth: { type: "none" },
        free: false,
      },
    });
    h.catalog.inferenceBudget.savePolicy(organizationId, workspaceId, 0, {
      mode: "enforce",
      maxTokens: 1_000_000,
      maxCostMicros: 1_000_000,
      prices: [],
    });
    h.addFile("file-b", "alice", "more.pdf", "holiday plans");
    const sent = h.server.seen.length;
    await h.knowledge.sync(at("admin"), false);
    assert.equal(h.server.seen.length, sent);
    let view = await h.knowledge.view(organizationId, workspaceId);
    assert.deepEqual(
      view.status.errors.map((error) => error.error),
      ["catalog_budget_price_required"],
    );
    h.catalog.inferenceBudget.savePolicy(organizationId, workspaceId, 1, {
      mode: "observe",
      maxTokens: 1_000_000,
      maxCostMicros: 1_000_000,
      prices: [],
    });
    // The provider's daily limit holds for embeddings like any model call.
    h.addFile("file-c", "alice", "c.pdf", "complaint");
    h.addFile("file-d", "alice", "d.pdf", "complaint again");
    await h.knowledge.sync(at("admin"), false);
    assert.equal(
      h.catalog.provider(organizationId, h.providerId).provider.requestsToday,
      3,
    );
    view = await h.knowledge.view(organizationId, workspaceId);
    assert.ok(
      view.status.errors.some(
        (error) => error.error === "catalog_provider_limit",
      ),
    );
  } finally {
    await h.close();
  }
});

test("files a person sends in chat are indexed for them alone while files are on", async () => {
  const h = await harness();
  try {
    h.addFile("file-chat", "bob", "offer.docx", "The offer price is 5000.");
    await h.knowledge.indexFiles(at("bob"), [
      {
        contentId: "file-chat",
        name: "offer.docx",
        sha256: h.files.get("file-chat")!.sha256,
        text: "The offer price is 5000.",
      },
    ]);
    assert.deepEqual(
      (await h.search("bob", "price")).map((hit) => hit.name),
      ["offer.docx"],
    );
    assert.deepEqual(await h.search("alice", "price"), []);
    // Already indexed with the same content: a later pass embeds nothing.
    const sent = h.server.seen.length;
    await h.knowledge.sync(at("admin"), false);
    assert.equal(h.server.seen.length, sent);
  } finally {
    await h.close();
  }
});

test("receipts cite the passages an answer was given, as the asker may read them now", async () => {
  const h = await harness();
  try {
    h.addFile("file-a", "alice", "prices.pdf", "The holiday price is 300.");
    h.addFile("file-b", "bob", "bob.pdf", "Bob's holiday notes.");
    await h.knowledge.sync(at("admin"), false);
    const mine = (await h.search("alice", "holiday"))[0]!;
    const bobs = (await h.search("bob", "holiday"))[0]!;
    const turn = storedTurn("command-1", "conv-1", {
      knowledge: { searches: 1, passages: [mine.id, bobs.id] },
    });
    const receipts = (userId: string) =>
      answerReceipts({
        run: async (fn) => fn(),
        turns: () => [turn],
        invocation: () => undefined,
        usableServices: () => new Set(),
        modelName: () => undefined,
        skills: () => new Map(),
        meetingTitle: () => undefined,
        taskTitle: () => undefined,
        memories: async () => new Map(),
        passages: async (ids) =>
          new Map(
            [...(await h.knowledge.passages(at(userId), ids))].map(
              ([id, hit]) => [
                id,
                { kind: hit.kind, name: hit.name, text: hit.text },
              ],
            ),
          ),
      });
    const [receipt] = await receipts("alice");
    AnswerReceiptSchema.parse(receipt);
    // Bob's passage never shows in Alice's receipt.
    assert.deepEqual(receipt!.sources, [
      {
        kind: "file",
        id: mine.id,
        title: "prices.pdf",
        passage: "The holiday price is 300.",
      },
    ]);
    // Once the file is gone for her, the citation leaves the receipt.
    h.files.get("file-a")!.available = false;
    assert.deepEqual((await receipts("alice"))[0]!.sources, []);
  } finally {
    await h.close();
  }
});

test("the configuration bundle carries what is indexed, by name, never the index", async () => {
  const h = await harness();
  try {
    await h.knowledge.save(at("admin"), 0, {
      files: false,
      chunking: { size: 800, overlap: 100 },
      sources: [h.source],
    });
    await h.knowledge.idle();
    const resynced: string[] = [];
    const after: (() => void)[] = [];
    const ctx = {
      db: h.db,
      catalog: h.catalog,
      organizationId,
      workspaceId,
      actor: { organizationId, userId: "admin", role: "owner" },
      workspaceActor: {
        organizationId,
        userId: "admin",
        role: "owner",
        workspaceId,
      },
      afterCommit: (run: () => void) => after.push(run),
      knowledge: {
        store: h.store,
        candidates: () => [
          {
            serviceId: h.source.serviceId,
            serviceName: "TEST Wiki",
            actions: [{ id: h.source.actionId, name: "TEST procedures" }],
          },
        ],
        resync: (_org: string, workspace: string) => resynced.push(workspace),
      },
    } as unknown as WorkspaceContext;
    const exported = knowledgeSection.export(ctx)!;
    assert.deepEqual(exported, {
      version: 1,
      files: false,
      chunking: { size: 800, overlap: 100 },
      sources: [{ service: "TEST Wiki", action: "TEST procedures" }],
    });
    // Nothing of the index travels: no passage, vector or document.
    assert.doesNotMatch(JSON.stringify(exported), /Petra|embedding|passage/);
    // The same settings import as unchanged; different ones save and resync after commit.
    let outcome = new SectionOutcome(h.db);
    knowledgeSection.apply(ctx, exported, outcome);
    assert.deepEqual(outcome.unchanged, ["Workspace knowledge"]);
    outcome = new SectionOutcome(h.db);
    knowledgeSection.apply(ctx, { ...exported, files: true }, outcome);
    assert.deepEqual(outcome.changed, ["Workspace knowledge"]);
    assert.equal(
      h.store.read(organizationId, workspaceId).settings.files,
      true,
    );
    assert.deepEqual(resynced, []);
    after.forEach((run) => run());
    assert.deepEqual(resynced, [workspaceId]);
    // A source missing here is refused, and nothing else changes.
    outcome = new SectionOutcome(h.db);
    knowledgeSection.apply(
      ctx,
      { ...exported, sources: [{ service: "TEST Gone", action: "TEST x" }] },
      outcome,
    );
    assert.equal(outcome.conflicts[0]!.reason, "reference_missing");
  } finally {
    await h.close();
  }
});
