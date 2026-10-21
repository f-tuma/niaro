import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  createMemoryRuntime,
  memoryCorrectionIntent,
  memoryIntent,
} from "../apps/server-identity/memory-runtime";
import {
  MemoryStore,
  MEMORY_SOURCE_TTL,
  type MemoryActor,
  type RememberMemoryInput,
} from "../apps/server-identity/memory";
import { IdentityError } from "../apps/server-identity/error";
import { MemorySettingsSchema } from "../packages/protocol/memory";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE user(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT REFERENCES organization(id)) STRICT;
    INSERT INTO organization VALUES('org'),('other-org'); INSERT INTO user VALUES('alice'),('bob');
    INSERT INTO agent_workspace VALUES('workspace','org'),('other-workspace','org'),('other-tenant','other-org');`);
  let now = Date.parse("2026-09-30T12:00:00Z"),
    allowed = true;
  const actor = {
    organizationId: "org",
    workspaceId: "workspace",
    userId: "alice",
    canManageShared: true,
  };
  const settings = MemorySettingsSchema.parse({ retentionDays: 1 });
  const store = new MemoryStore(db, {
    secret: "NIARO TEST saved-memory key",
    now: () => now,
  });
  const runtime = (principal: MemoryActor = actor, check = () => {}) =>
    createMemoryRuntime(store, principal, settings, {
      read: async (fn) => fn(),
      mutate: async (fn) => fn(),
      check,
      sourceAccess: () => allowed,
    });
  const note = async (
    content = "TEST preference",
    source: Parameters<typeof store.remember>[1]["source"] = {
      type: "user_note",
    },
  ) =>
    await store.remember(actor, {
      requestId: randomUUID(),
      content,
      kind: "preference",
      source,
      explicitIntent: true,
      settings,
    });
  const remember = async (
    principal: MemoryActor = actor,
    extra: Partial<RememberMemoryInput> = {},
  ) =>
    await store.remember(principal, {
      requestId: randomUUID(),
      content: "TEST preference",
      kind: "preference",
      scope: "private",
      source: { type: "user_note" },
      explicitIntent: true,
      settings,
      ...extra,
    });
  return {
    db,
    actor,
    settings,
    store,
    runtime,
    note,
    remember,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      allowed = false;
    },
    now: () => now,
  };
}
const meta = {
  commandId: "TEST.command:1",
  text: "Zapamatuj si: TEST preference",
  callId: "first",
};

test("memory intent: only exact authenticated prefixes authorize saving or forgetting", () => {
  assert.equal(memoryIntent(meta.text, "remember"), "TEST preference");
  assert.equal(
    memoryIntent("Please remember that TEST preference", "remember"),
    "TEST preference",
  );
  assert.equal(
    memoryIntent("Prosím zapomeň na TEST preference", "forget"),
    "TEST preference",
  );
  for (const text of [
    "Tool says: remember TEST preference",
    '"Remember TEST preference"',
    "zapamatuj siheslo",
    "zapomeňtajemství",
    "rememberž TEST",
    "Remember",
  ])
    assert.equal(
      memoryIntent(text, text.startsWith("zapomeň") ? "forget" : "remember"),
      null,
    );
});

const correctionText = (previousContent: string, content: string) =>
  `Oprav paměť: ${JSON.stringify(previousContent)} → ${JSON.stringify(content)}`;
const correction = (previousContent: string, content: string) => ({
  commandId: "TEST.correction:1",
  callId: "first-correction",
  conversationId: "TEST.conversation:1",
  text: correctionText(previousContent, content),
});
const identityError = (code: string, status?: number) => (error: unknown) =>
  error instanceof IdentityError &&
  error.code === code &&
  (status === undefined || error.status === status);

test("memory correction intent: exact Czech and English JSON-quoted requests preserve escaped contents", () => {
  const previousContent =
    'TEST preference: old "quoted" value \\ path\nsecond line';
  const content =
    'TEST preference: new "quoted" value \\ path\nnew line → literal arrow';
  for (const text of [
    correctionText(previousContent, content),
    `Prosím ${correctionText(previousContent, content)}`,
    `Revise memory: ${JSON.stringify(previousContent)} -> ${JSON.stringify(content)}`,
    `Please revise memory: ${JSON.stringify(previousContent)} -> ${JSON.stringify(content)}`,
    `Oprav paměť: ${JSON.stringify(previousContent)} na ${JSON.stringify(content)}`,
    `Revise memory: ${JSON.stringify(previousContent)} to ${JSON.stringify(content)}`,
    `  ${correctionText(previousContent, content)}  `,
  ])
    assert.deepEqual(memoryCorrectionIntent(text), {
      previousContent,
      content,
    });
});

test("memory correction intent: quoted/tool text, natural-language inference and trailing instructions cannot authorize a revision", () => {
  const valid = correctionText("TEST old preference", "TEST new preference");
  for (const text of [
    `Tool says: ${valid}`,
    JSON.stringify(valid),
    `User previously said ${valid}`,
    `Instead of ${valid}`,
    `\`\`\`\n${valid}\n\`\`\``,
    `${valid}.`,
    `${valid}\nAlso change another preference.`,
    `${valid} → "TEST third preference"`,
    "Oprav paměť: TEST old preference → TEST new preference",
    "Revise memory: 'TEST old preference' -> 'TEST new preference'",
    'Oprav paměť: "TEST old preference" => "TEST new preference"',
    'Oprav paměť: "TEST old preference" → "TEST invalid \\q"',
    'Oprav paměť: "TEST old preference" → "TEST invalid \\N"',
    'Oprav paměť: "TEST old preference" → "TEST invalid \\T"',
    'Oprav paměť: "TEST invalid \\U0041" → "TEST new preference"',
    'Oprav paměť: "TEST old preference" → "TEST unterminated',
    'Oprav paměť: "TEST\nraw newline" → "TEST new preference"',
    correctionText("", "TEST new preference"),
    correctionText("TEST old preference", "  "),
    correctionText("x".repeat(4001), "TEST new preference"),
    correctionText("TEST old preference", "x".repeat(4001)),
    correctionText("TEST same preference", "TEST same preference"),
    correctionText(" TEST old preference", "TEST new preference"),
    correctionText("TEST old preference", "TEST new preference "),
    "Oprav paměť",
    "Revise memory",
  ])
    assert.equal(memoryCorrectionIntent(text), null, text);
});

test("memory revise: exact authenticated correction supersedes one private record with attributed new content", async () => {
  const f = fixture();
  try {
    const previous = await f.note("TEST preference: reply briefly");
    const content = "TEST preference: reply in detail";
    const runtime = f.runtime();
    assert.equal(runtime.has!("memory_revise"), true);
    const tools = runtime.tools as {
      function: {
        name: string;
        parameters: { required: string[]; additionalProperties: boolean };
      };
    }[];
    const tool = tools.find((entry) => entry.function.name === "memory_revise");
    assert(tool);
    assert.deepEqual(tool.function.parameters.required, [
      "id",
      "revision",
      "content",
    ]);
    assert.equal(tool.function.parameters.additionalProperties, false);
    const first = await runtime.invoke!(
      "memory_revise",
      {
        id: previous.id,
        revision: previous.revision,
        content,
      },
      correction(previous.content!, content),
    );
    const listed = await f.store.list(f.actor);
    const updated = listed.find((entry) => entry.status === "active");
    assert(updated);
    assert.deepEqual(first, { id: updated.id, revision: 1, status: "active" });
    assert.notEqual(updated.id, previous.id);
    assert.equal(updated.content, content);
    assert.equal(updated.scope, "private");
    assert.equal(updated.kind, previous.kind);
    assert.equal(updated.trust, "user_assertion");
    assert.equal(updated.supersedesId, previous.id);
    assert.deepEqual(updated.source, {
      type: "user_message",
      commandId: "TEST.correction:1",
      conversationId: "TEST.conversation:1",
    });
    const old = listed.find((entry) => entry.id === previous.id)!;
    assert.equal(old.status, "superseded");
    assert.equal(old.revision, previous.revision + 1);
    const context = await f
      .runtime()
      .context({ text: "TEST preference", language: "en" });
    assert(context);
    const items = JSON.parse(
      context.content.slice(context.content.indexOf("\n") + 1),
    );
    assert.deepEqual(
      items.map((entry: { content: string }) => entry.content),
      [content],
    );
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory revise: duplicate exact old contents require explicit record selection without partial correction", async () => {
  const f = fixture();
  try {
    const first = await f.note("TEST duplicate preference");
    const duplicate = await f.note(first.content!);
    const content = "TEST corrected preference";
    const version = f.store.version(f.actor);
    let checkpoints = 0;
    const request = {
      ...correction(first.content!, content),
      checkpoint: () => checkpoints++,
    };
    const input = { id: first.id, revision: first.revision, content };
    assert.deepEqual(
      await f.runtime().invoke!("memory_revise", input, request),
      { error: "memory_selection_ambiguous" },
    );
    assert.equal(f.store.version(f.actor), version);
    assert.equal(checkpoints, 0);
    assert.deepEqual(
      (await f.store.list(f.actor)).map((item) => [item.status, item.content]),
      [
        ["active", first.content],
        ["active", first.content],
      ],
    );
    await f.store.forget(f.actor, {
      requestId: randomUUID(),
      id: duplicate.id,
      revision: duplicate.revision,
    });
    const updated = await f.runtime().invoke!("memory_revise", input, request);
    assert.equal((updated as { status: string }).status, "active");
    assert.equal(checkpoints, 1);
    assert.deepEqual(
      (await f.store.list(f.actor))
        .filter((item) => item.status === "active")
        .map((item) => item.content),
      [content],
    );
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory revise: duplicate detection stays within active unexpired private memory of the current user", async () => {
  const f = fixture();
  try {
    const previousContent = "TEST scoped duplicate preference";
    await f.note(previousContent);
    f.advance(24 * 60 * 60 * 1000);
    const item = await f.note(previousContent);
    await f.remember(
      { ...f.actor, userId: "bob" },
      { content: previousContent },
    );
    await f.remember(
      { ...f.actor, workspaceId: "other-workspace" },
      { content: previousContent },
    );
    f.settings.allowShared = true;
    await f.remember(f.actor, { scope: "workspace", content: previousContent });
    const content = "TEST corrected scoped preference";
    const updated = await f.runtime().invoke!(
      "memory_revise",
      { id: item.id, revision: item.revision, content },
      correction(previousContent, content),
    );
    assert.equal((updated as { status: string }).status, "active");
    assert.equal(
      (await f.store.list(f.actor)).find((entry) => entry.id === item.id)
        ?.status,
      "superseded",
    );
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory revise: expired or revoked verified duplicates do not block the visible private record", async () => {
  for (const invalidate of ["expire", "revoke"] as const) {
    const f = fixture();
    try {
      const previousContent = "TEST duplicate with stale source";
      const hidden = await f.note(previousContent, {
        type: "verified_operation",
        operationId: "TEST-operation",
        serviceId: "TEST-service",
        verifiedAt: new Date(f.now()).toISOString(),
      });
      const visible = await f.note(previousContent);
      if (invalidate === "expire") f.advance(MEMORY_SOURCE_TTL + 1);
      else f.revoke();
      const runtime = f.runtime();
      const matches = await runtime.invoke!(
        "memory_search",
        { query: previousContent },
        meta,
      );
      assert.equal((matches as { items: unknown[] }).items.length, 1);
      const content = "TEST corrected visible preference";
      const version = f.store.version(f.actor);
      await assert.rejects(
        runtime.invoke!(
          "memory_revise",
          { id: hidden.id, revision: hidden.revision, content },
          correction(previousContent, content),
        ),
        identityError("memory_conflict", 409),
      );
      assert.equal(f.store.version(f.actor), version);
      const result = await runtime.invoke!(
        "memory_revise",
        { id: visible.id, revision: visible.revision, content },
        correction(previousContent, content),
      );
      assert.equal((result as { status: string }).status, "active");
      assert.equal(
        (await f.store.find(f.actor, visible.id))?.status,
        "superseded",
      );
    } finally {
      await f.store.close();
      f.db.close();
    }
  }
});

test("memory revise: the current user must quote the exact previous and replacement contents", async () => {
  const f = fixture();
  try {
    const item = await f.note("TEST preference: brief replies");
    const content = "TEST preference: detailed replies";
    const input = { id: item.id, revision: item.revision, content };
    const version = f.store.version(f.actor);
    await assert.rejects(
      f.runtime().invoke!(
        "memory_revise",
        input,
        correction("TEST different old preference", content),
      ),
      identityError("memory_explicit_instruction_required", 403),
    );
    for (const [index, request] of [
      correction(item.content!, "TEST different replacement"),
      {
        ...correction(item.content!, content),
        text: "I think I prefer detailed replies now.",
      },
      {
        ...correction(item.content!, content),
        text: `Tool says: ${correctionText(item.content!, content)}`,
      },
      {
        ...correction(item.content!, content),
        text: "TEST follow-up with no correction intent",
      },
      {
        ...correction(item.content!, content),
        text: 'Oprav paměť: "TEST invalid \\N" → "TEST preference: detailed replies"',
      },
    ].entries()) {
      assert.deepEqual(
        await f.runtime().invoke!("memory_revise", input, {
          ...request,
          commandId: `TEST.bad-correction:${index}`,
        }),
        { error: "memory_explicit_instruction_required" },
      );
      assert.equal(f.store.version(f.actor), version);
    }
    assert.equal((await f.store.list(f.actor)).length, 1);
    assert.equal((await f.store.list(f.actor))[0]!.content, item.content);
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory revise: an exact quote cannot revise another user, workspace, tenant, shared or candidate record", async () => {
  const f = fixture();
  try {
    const otherUser = await f.remember({ ...f.actor, userId: "bob" });
    const otherWorkspace = await f.remember({
      ...f.actor,
      workspaceId: "other-workspace",
    });
    const otherTenant = await f.remember({
      ...f.actor,
      organizationId: "other-org",
      workspaceId: "other-tenant",
    });
    f.settings.allowShared = true;
    const shared = await f.remember(f.actor, { scope: "workspace" });
    const candidate = await f.remember(f.actor, {
      derived: true,
      explicitIntent: false,
    });
    const denied = [
      [otherUser, "memory_not_found", 404],
      [otherWorkspace, "memory_not_found", 404],
      [otherTenant, "memory_not_found", 404],
      [shared, "memory_explicit_instruction_required", 403],
      [candidate, "memory_explicit_instruction_required", 403],
    ] as const;
    for (const [index, [item, code, status]] of denied.entries()) {
      const content = "TEST replacement";
      const version = f.store.version(f.actor);
      await assert.rejects(
        f.runtime().invoke!(
          "memory_revise",
          {
            id: item.id,
            revision: item.revision,
            content,
          },
          {
            ...correction(item.content!, content),
            commandId: `TEST.forbidden-correction:${index}`,
          },
        ),
        identityError(code, status),
      );
      assert.equal(f.store.version(f.actor), version);
      const row = f.db
        .prepare("SELECT status,native_ref FROM agent_memory WHERE id=?")
        .get(item.id)!;
      assert.equal(row.status, item.status);
      assert.equal(typeof row.native_ref, "string");
      const itemActor =
        index === 0
          ? { ...f.actor, userId: "bob" }
          : index === 1
            ? { ...f.actor, workspaceId: "other-workspace" }
            : index === 2
              ? {
                  ...f.actor,
                  organizationId: "other-org",
                  workspaceId: "other-tenant",
                }
              : f.actor;
      assert.equal(
        (await f.store.find(itemActor, item.id, { settings: f.settings }))
          ?.content,
        item.content,
      );
    }
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory revise: strict tool arguments cannot override source, kind, scope or authenticated identity", async () => {
  const f = fixture();
  try {
    const item = await f.note();
    const input = {
      id: item.id,
      revision: item.revision,
      content: "TEST replacement",
    };
    const request = correction(item.content!, input.content);
    const version = f.store.version(f.actor);
    for (const invalid of [
      { ...input, userId: "bob" },
      { ...input, scope: "workspace" },
      { ...input, kind: "fact" },
      { ...input, source: { type: "user_note" } },
      { ...input, expectedContent: "TEST forged old content" },
      { ...input, revision: 0 },
      { ...input, revision: 1.5 },
      { ...input, id: "invalid/id" },
    ]) {
      await assert.rejects(
        f.runtime().invoke!("memory_revise", invalid, request),
        (error) => error instanceof ZodError,
      );
      assert.equal(f.store.version(f.actor), version);
    }
    assert.equal((await f.store.list(f.actor)).length, 1);
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory revise: stale revision and concurrently superseded memory produce a conflict without changing the newer preference", async () => {
  const f = fixture();
  try {
    const item = await f.note("TEST old preference");
    const content = "TEST replacement";
    const version = f.store.version(f.actor);
    await assert.rejects(
      f.runtime().invoke!(
        "memory_revise",
        {
          id: item.id,
          revision: item.revision + 1,
          content,
        },
        correction(item.content!, content),
      ),
      identityError("memory_conflict", 409),
    );
    assert.equal(f.store.version(f.actor), version);
    const concurrent = await f.store.revise(f.actor, {
      requestId: "TEST-concurrent-console-revision",
      id: item.id,
      revision: item.revision,
      content: "TEST concurrent replacement",
      source: { type: "user_note" },
      explicitIntent: true,
      settings: f.settings,
    });
    const changed = f.store.version(f.actor);
    await assert.rejects(
      f.runtime().invoke!(
        "memory_revise",
        {
          id: item.id,
          revision: item.revision,
          content,
        },
        {
          ...correction(item.content!, content),
          commandId: "TEST.after-concurrent-revision",
        },
      ),
      identityError("memory_conflict", 409),
    );
    assert.equal(f.store.version(f.actor), changed);
    assert.deepEqual(
      (await f.store.search(f.actor)).items.map((entry) => entry.id),
      [concurrent.id],
    );
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory revise: opt-out, runtime authorization loss and expired source deny a correction before mutation", async () => {
  const f = fixture();
  try {
    const item = await f.note();
    const content = "TEST replacement";
    const input = { id: item.id, revision: item.revision, content };
    const request = correction(item.content!, content);
    f.store.setOptOut(f.actor, { requestId: "TEST-opt-out", optOut: true });
    const version = f.store.version(f.actor);
    await assert.rejects(
      f.runtime().invoke!("memory_revise", input, request),
      identityError("memory_opted_out", 403),
    );
    assert.equal(f.store.version(f.actor), version);
    f.store.setOptOut(f.actor, { requestId: "TEST-opt-in", optOut: false });
    const check = () => {
      throw new IdentityError(403, "TEST.memory-plugin-disabled");
    };
    const enabledVersion = f.store.version(f.actor);
    await assert.rejects(
      f.runtime(f.actor, check).invoke!("memory_revise", input, request),
      identityError("TEST.memory-plugin-disabled", 403),
    );
    assert.equal(f.store.version(f.actor), enabledVersion);
    f.advance(86_400_000);
    await assert.rejects(
      f.runtime().invoke!("memory_revise", input, request),
      identityError("memory_conflict", 409),
    );
    assert.equal(f.store.version(f.actor), enabledVersion);
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory revise: retries across runtime and call IDs return one receipt; tampered retries cannot reuse it", async () => {
  const f = fixture();
  try {
    const item = await f.note("TEST old preference");
    const content = "TEST replacement";
    const input = { id: item.id, revision: item.revision, content };
    const request = correction(item.content!, content);
    const first = await f.runtime().invoke!("memory_revise", input, request);
    const version = f.store.version(f.actor);
    assert.deepEqual(
      await f.runtime().invoke!("memory_revise", input, {
        ...request,
        callId: "TEST.retry-call",
      }),
      first,
    );
    assert.equal(f.store.version(f.actor), version);
    assert.equal((await f.store.list(f.actor)).length, 2);
    const other = await f.note("TEST other old preference");
    const changed = f.store.version(f.actor);
    assert.deepEqual(
      await f.runtime().invoke!(
        "memory_revise",
        {
          ...input,
          content: "TEST tampered replacement",
        },
        request,
      ),
      { error: "memory_explicit_instruction_required" },
    );
    for (const [args, metadata] of [
      [{ ...input, id: other.id }, request],
      [{ ...input, revision: input.revision + 1 }, request],
      [input, correction("TEST tampered previous content", content)],
      [
        { ...input, content: "TEST tampered replacement" },
        correction(item.content!, "TEST tampered replacement"),
      ],
      [{ ...input, id: other.id }, correction(other.content!, content)],
      [input, { ...request, conversationId: "TEST.other-conversation" }],
    ] as const) {
      await assert.rejects(
        f.runtime().invoke!("memory_revise", args, {
          ...metadata,
          callId: "TEST.tampered-call",
        }),
        identityError("memory_request_conflict", 409),
      );
      assert.equal(f.store.version(f.actor), changed);
    }
    assert.equal(
      (await f.store.list(f.actor)).filter((entry) => entry.status === "active")
        .length,
      2,
    );
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory revise: forgetting the lineage leaves exact retry deleted and cannot resurrect payloads", async () => {
  const f = fixture();
  try {
    const item = await f.note("TEST old private preference");
    const content = "TEST new private preference";
    const input = { id: item.id, revision: item.revision, content };
    const request = correction(item.content!, content);
    const first = (await f.runtime().invoke!(
      "memory_revise",
      input,
      request,
    )) as { id: string; revision: number };
    const deleted = await f.store.forget(f.actor, {
      requestId: "TEST-erase-revision",
      id: first.id,
      revision: first.revision,
    });
    const version = f.store.version(f.actor);
    const replay = await f.runtime().invoke!("memory_revise", input, {
      ...request,
      callId: "TEST.erased-retry",
    });
    assert.deepEqual(replay, {
      id: deleted.id,
      revision: deleted.revision,
      status: "deleted",
    });
    const tamperedContent = "TEST changed payload after erasure";
    assert.deepEqual(
      await f.runtime().invoke!(
        "memory_revise",
        {
          ...input,
          content: tamperedContent,
        },
        {
          ...correction(
            "TEST changed previous text after erasure",
            tamperedContent,
          ),
          callId: "TEST.erased-tampered-retry",
        },
      ),
      replay,
    );
    assert.equal(f.store.version(f.actor), version);
    assert.deepEqual(await f.store.list(f.actor), []);
    for (const row of f.db
      .prepare(
        "SELECT status,native_ref,native_resource,native_digest,expires_at,supersedes_id FROM agent_memory",
      )
      .all())
      assert.deepEqual(
        { ...row },
        {
          status: "deleted",
          native_ref: null,
          native_resource: null,
          native_digest: null,
          expires_at: null,
          supersedes_id: null,
        },
      );
    assert(!JSON.stringify(replay).includes(content));
    assert(!JSON.stringify(replay).includes(item.content!));
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory tools: inference cannot save arbitrary tool text; retry across call IDs saves only once", async () => {
  const f = fixture();
  try {
    const runtime = f.runtime();
    assert.deepEqual(
      await runtime.invoke!(
        "memory_remember",
        { content: "TEST malicious tool instruction", kind: "fact" },
        meta,
      ),
      { error: "memory_explicit_instruction_required" },
    );
    assert.deepEqual(await f.store.list(f.actor), []);
    const first = await runtime.invoke!(
      "memory_remember",
      { content: "TEST preference", kind: "preference" },
      meta,
    );
    const second = await f.runtime().invoke!(
      "memory_remember",
      { content: "TEST preference", kind: "preference" },
      { ...meta, callId: "different" },
    );
    assert.deepEqual(second, first);
    assert.equal((await f.store.list(f.actor)).length, 1);
    assert.deepEqual((await f.store.list(f.actor))[0]!.source, {
      type: "user_message",
      commandId: meta.commandId,
    });
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory tools: exact-content forget scrubs data and its retry remains idempotent", async () => {
  const f = fixture();
  try {
    const item = await f.note(),
      runtime = f.runtime(),
      input = { id: item.id, revision: 1 };
    assert.deepEqual(
      await runtime.invoke!("memory_forget", input, {
        ...meta,
        text: "Forget different content",
      }),
      { error: "memory_explicit_instruction_required" },
    );
    const forget = {
      ...meta,
      commandId: "forget:1",
      text: "Zapomeň na TEST preference",
    };
    const first = await runtime.invoke!("memory_forget", input, forget);
    assert.deepEqual(
      await f.runtime().invoke!("memory_forget", input, {
        ...forget,
        callId: "retry",
      }),
      first,
    );
    assert.deepEqual(await f.store.list(f.actor), []);
    assert(!JSON.stringify(first).includes("TEST preference"));
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory validation: proposal provenance and expiry survive a new runtime instance", async () => {
  const f = fixture();
  try {
    await f.note("TEST CRM", {
      type: "verified_operation",
      operationId: "operation",
      serviceId: "service",
      verifiedAt: new Date(f.now()).toISOString(),
    });
    const runtime = f.runtime(),
      context = await runtime.context({ text: "TEST", language: "en" });
    assert(context);
    const metadata = runtime.metadata!();
    assert.equal(metadata.sources?.length, 1);
    assert.equal(metadata.expiresAt, f.now() + MEMORY_SOURCE_TTL);
    assert(!JSON.stringify(metadata).includes("TEST CRM"));
    await f.runtime().validate(context.version, metadata);
    f.revoke();
    await assert.rejects(
      f.runtime().validate(context.version, metadata),
      /memory_context_changed/,
    );
    f.advance(MEMORY_SOURCE_TTL);
    await assert.rejects(
      f.runtime().validate(context.version, metadata),
      /memory_context_changed/,
    );
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("memory validation: retrieval expiry, deletion and opt-out invalidate pending context", async () => {
  const f = fixture();
  try {
    const item = await f.note(),
      runtime = f.runtime(),
      context = await runtime.context({ text: "TEST", language: "en" });
    assert(context);
    const metadata = runtime.metadata!();
    f.advance(86_400_000);
    await assert.rejects(
      f.runtime().validate(context.version, metadata),
      /memory_context_changed/,
    );
    const fresh = await f.note("TEST fresh"),
      next = await f.runtime().context({ text: "TEST", language: "en" });
    assert(next);
    await f.store.forget(f.actor, {
      requestId: "forget",
      id: fresh.id,
      revision: 1,
    });
    await assert.rejects(
      f.runtime().validate(next.version),
      /memory_context_changed/,
    );
    const latest = await f.runtime().context({ text: "TEST", language: "en" });
    assert(latest);
    f.store.setOptOut(f.actor, { requestId: "off", optOut: true });
    await assert.rejects(
      f.runtime().validate(latest.version),
      /memory_context_changed/,
    );
    const empty = await f.runtime().context({ text: "TEST", language: "en" });
    assert(empty);
    assert(!empty.content.includes(item.content!));
  } finally {
    await f.store.close();
    f.db.close();
  }
});
