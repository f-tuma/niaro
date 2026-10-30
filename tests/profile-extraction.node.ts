import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileCursorStore } from "../apps/server-identity/profile-cursor";
import { ProfileInference } from "../apps/server-identity/profile-inference";
import { ProfileExtractionSchema } from "../apps/server-agent/profile-extraction";
import { budgetedInferenceTransport } from "../apps/server-identity/inference-budget";
import {
  budgetTarget,
  budgetSelection,
  budgetSettings,
  openBudget,
} from "./helpers/inference-budget";
import type { IntegrationTransport } from "../apps/server-integrations/transport";

const valid = {
  add: [
    {
      statement: "TEST prefers concise answers",
      section: "style",
      personal: false,
      evidence: ["e1"],
    },
  ],
  refresh: [],
  update: [],
};
const response = (output: unknown = valid, usage = true) => ({
  status: 200,
  headers: {},
  text: JSON.stringify({
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(output) },
      },
    ],
    ...(usage
      ? { usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0002 } }
      : {}),
  }),
});
const progress = { chat: 0, chatOffset: 0, meeting: 0, meetingOffset: 0 };
function fixture(transport: IntegrationTransport, file = ":memory:") {
  const f = openBudget(file);
  let now = Date.now();
  f.store.savePolicy(budgetTarget.organizationId, budgetTarget.workspaceId, 0, {
    ...budgetSettings,
    prices: budgetSettings.prices.map((price) => ({
      ...price,
      maxInputTokens: 26000,
      maxOutputTokens: 2000,
    })),
    maxTokens: 40000,
    maxCostMicros: 100000,
  });
  const actor = { ...budgetTarget, canManageShared: false },
    cursor = new ProfileCursorStore(f.db, "TEST secret", () => now);
  cursor.markDirty(actor);
  const lease = cursor.acquire(actor)!;
  const batch = cursor.bind(
    actor,
    lease,
    { progress, refs: [] },
    "TEST-input",
    { ...progress, chat: 1 },
  );
  const inference = new ProfileInference(f.store, cursor, transport, () => now);
  const access = {
    selected: budgetSelection,
    settingsRevision: 0,
    policyVersion: 0,
    budgetRevision: 1,
    retentionDays: 30,
    check: () => {},
    useProvider: () => {},
    serial: async <T>(fn: () => Promise<T>) => fn(),
  };
  return {
    ...f,
    actor,
    cursor,
    lease,
    batch,
    inference,
    access,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("closed extraction: strict envelope and duplicate/conflicting targets", () => {
  assert(ProfileExtractionSchema.safeParse(valid).success);
  for (const output of [
    { ...valid, unknown: true },
    { add: [], refresh: [] },
    { ...valid, add: [{ ...valid.add[0], evidence: ["e1", "e1"] }] },
    {
      ...valid,
      refresh: [{ id: "TEST-id", revision: 1, evidence: ["e1"] }],
      update: [{ ...valid.add[0], id: "TEST-id", revision: 1 }],
    },
  ])
    assert(!ProfileExtractionSchema.safeParse(output).success);
});

test("actual closed agent plus ledger: valid result and missing usage are checkpointed before SDK parse", async () => {
  for (const usage of [true, false]) {
    let calls = 0;
    const f = fixture(async (request) => {
      await request.beforeDispatch!(() => calls++);
      assert(Buffer.byteLength(JSON.stringify(request.body)) <= 24576);
      assert.equal((request.body as { max_tokens: number }).max_tokens, 2000);
      return response(valid, usage);
    });
    try {
      assert.deepEqual(
        await f.inference.extract(
          f.actor,
          f.lease,
          f.batch,
          JSON.stringify({
            evidence: [{ id: "e1", text: "TEST prefers concise answers" }],
            prior: [],
          }),
          f.access,
          new AbortController().signal,
        ),
        valid,
      );
      assert.equal(calls, 1);
      const call = f.cursor.calls(f.batch)[0]!;
      assert.equal(call.state, "received");
      assert(call.ciphertext && !call.ciphertext.includes("concise"));
      assert.equal(
        f.store.attemptStatus(f.batch.root, f.actor, call.attemptId),
        usage ? "settled" : "unknown",
      );
      assert.deepEqual(
        await f.inference.extract(
          f.actor,
          f.lease,
          f.batch,
          JSON.stringify({
            evidence: [{ id: "e1", text: "TEST prefers concise answers" }],
            prior: [],
          }),
          f.access,
          new AbortController().signal,
        ),
        valid,
      );
      assert.equal(calls, 1);
    } finally {
      f.db.close();
    }
  }
});

test("actual closed agent: exactly one same-root schema repair, exhausted ordinal cannot be repaid", async () => {
  let calls = 0;
  const f = fixture(async (request) => {
    await request.beforeDispatch!(() => calls++);
    return response(calls === 1 ? { bad: true } : valid);
  });
  try {
    assert.deepEqual(
      await f.inference.extract(
        f.actor,
        f.lease,
        f.batch,
        "{}",
        f.access,
        new AbortController().signal,
      ),
      valid,
    );
    assert.equal(calls, 2);
    assert.equal(f.store.summary(f.batch.root).calls, 2);
    assert.deepEqual(
      f.cursor.calls(f.batch).map((call) => call.state),
      ["invalid", "received"],
    );
  } finally {
    f.db.close();
  }
});

for (const failure of ["504", "throw"] as const)
  test(`actual ledger unknown ${failure}: committed dispatch marker, restart and backoffs never redispatch`, async () => {
    const root = mkdtempSync(join(tmpdir(), "TEST-profile-ledger-")),
      file = join(root, "identity.sqlite");
    let calls = 0;
    const f = fixture(async (request) => {
      await request.beforeDispatch!(() => {
        calls++;
        const reader = new DatabaseSync(file);
        try {
          assert.equal(
            reader.prepare("SELECT state FROM agent_profile_call").get()!.state,
            "dispatched",
          );
          assert.equal(
            reader.prepare("SELECT status FROM agent_inference_attempt").get()!
              .status,
            "dispatched",
          );
        } finally {
          reader.close();
        }
      });
      if (failure === "throw") throw Error("TEST post-dispatch");
      return { status: 504, headers: {}, text: "TEST gateway timeout" };
    }, file);
    let reopened: ReturnType<typeof openBudget> | undefined;
    try {
      await assert.rejects(
        f.inference.extract(
          f.actor,
          f.lease,
          f.batch,
          "{}",
          f.access,
          new AbortController().signal,
        ),
      );
      assert.equal(calls, 1);
      assert.equal(f.store.summary(f.batch.root).unknownCalls, 1);
      f.cursor.defer(f.actor, f.lease, true);
      f.advance(3600001);
      f.cursor.markDirty(f.actor);
      const lease = f.cursor.acquire(f.actor)!;
      await assert.rejects(
        f.inference.extract(
          f.actor,
          lease,
          f.batch,
          "{}",
          f.access,
          new AbortController().signal,
        ),
        /profile_unknown_response/,
      );
      assert.equal(calls, 1);
      f.db.close();
      reopened = openBudget(file);
      const cursor = new ProfileCursorStore(
        reopened.db,
        "TEST secret",
        () => Date.now() + 86400000,
      );
      assert.equal(cursor.pending(f.actor)!.root, f.batch.root);
      assert.equal(cursor.read(f.actor).progress.chat, 0);
      const infer = new ProfileInference(
        reopened.store,
        cursor,
        async () => {
          calls++;
          return response();
        },
        () => Date.now() + 86400000,
      );
      const next = cursor.acquire(f.actor)!;
      await assert.rejects(
        infer.extract(
          f.actor,
          next,
          f.batch,
          "{}",
          f.access,
          new AbortController().signal,
        ),
        /profile_unknown_response/,
      );
      assert.equal(calls, 1);
    } finally {
      if (reopened) reopened.db.close();
      else f.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test("profile checkpoint failure prevents network, leaves normal no-hook accounting usable", async () => {
  let calls = 0;
  const f = fixture(async (request) => {
    await request.beforeDispatch!(() => calls++);
    return response();
  });
  try {
    const hook = f.cursor.checkpoint(f.actor, f.batch, 1, 86400000);
    hook.dispatched = () => {
      throw Error("TEST checkpoint rejected");
    };
    const wrapped = budgetedInferenceTransport(
      async (request) => {
        await request.beforeDispatch!(() => calls++);
        return response();
      },
      f.store,
      f.batch.root,
      f.actor,
      budgetSelection,
      "model",
      f.access.serial,
      async () => {},
      () => 0,
      undefined,
      hook,
    );
    await assert.rejects(
      wrapped({
        url: "https://provider.example.test",
        body: { messages: [] },
        beforeDispatch: async (start) => start(),
      }),
      /TEST checkpoint rejected/,
    );
    assert.equal(calls, 0);
    assert.equal(f.db.isTransaction, false);
    const normal = budgetedInferenceTransport(
      async (request) => {
        await request.beforeDispatch!(() => calls++);
        return response();
      },
      f.store,
      "TEST-normal",
      f.actor,
      budgetSelection,
      "model",
      f.access.serial,
      async () => {},
      () => 0,
    );
    await normal({
      url: "https://provider.example.test",
      body: { messages: [] },
      beforeDispatch: async (start) => start(),
    });
    assert.equal(calls, 1);
    assert.equal(f.store.summary("TEST-normal").unknownCalls, 0);
  } finally {
    f.db.close();
  }
});

test("checkpoint privacy and expiry retain paid binding; late callback cannot restore erased ciphertext", async () => {
  let calls = 0;
  const f = fixture(async (request) => {
    await request.beforeDispatch!(() => calls++);
    return response();
  });
  try {
    await f.inference.extract(
      f.actor,
      f.lease,
      f.batch,
      "{}",
      f.access,
      new AbortController().signal,
    );
    const call = f.cursor.calls(f.batch)[0]!,
      hook = f.cursor.checkpoint(f.actor, f.batch, 1, 86400000);
    f.cursor.privacyMutation(f.actor);
    assert.equal(f.cursor.calls(f.batch)[0]!.ciphertext, null);
    assert.throws(
      () => hook.received(call.attemptId, response()),
      /profile_response_changed/,
    );
    assert.equal(f.cursor.calls(f.batch)[0]!.ciphertext, null);
    f.advance(86400001);
    f.cursor.defer(f.actor, f.lease, false);
    f.advance(600001);
    f.cursor.markDirty(f.actor);
    const lease = f.cursor.acquire(f.actor)!;
    await assert.rejects(
      f.inference.extract(
        f.actor,
        lease,
        f.batch,
        "{}",
        f.access,
        new AbortController().signal,
      ),
      /profile_batch_unusable/,
    );
    assert.equal(calls, 1);
    assert.equal(f.cursor.pending(f.actor)!.root, f.batch.root);
  } finally {
    f.db.close();
  }
});

test("received settlement hook rollback retains an unknown ledger hold and normal no-hook remains usable", async () => {
  let calls = 0;
  const f = fixture(async () => response());
  try {
    const hook = f.cursor.checkpoint(f.actor, f.batch, 1, 86400000);
    hook.received = () => {
      throw Error("TEST response checkpoint failed");
    };
    const transport: IntegrationTransport = async (request) => {
      await request.beforeDispatch!(() => calls++);
      return response();
    };
    const wrapped = budgetedInferenceTransport(
      transport,
      f.store,
      f.batch.root,
      f.actor,
      budgetSelection,
      "model",
      f.access.serial,
      async () => {},
      () => 0,
      undefined,
      hook,
    );
    await assert.rejects(
      wrapped({
        url: "https://provider.example.test",
        body: { messages: [] },
        beforeDispatch: async (start) => start(),
      }),
      /TEST response checkpoint failed/,
    );
    assert.equal(calls, 1);
    assert.equal(f.store.summary(f.batch.root).unknownCalls, 1);
    assert.equal(f.cursor.calls(f.batch)[0]!.state, "unknown_response");
    assert.equal(f.db.isTransaction, false);
    const normal = budgetedInferenceTransport(
      transport,
      f.store,
      "TEST-normal-after-received-failure",
      f.actor,
      budgetSelection,
      "model",
      f.access.serial,
      async () => {},
      () => 0,
    );
    await normal({
      url: "https://provider.example.test",
      body: { messages: [] },
      beforeDispatch: async (start) => start(),
    });
    assert.equal(calls, 2);
    assert.equal(
      f.store.summary("TEST-normal-after-received-failure").unknownCalls,
      0,
    );
  } finally {
    f.db.close();
  }
});

test("actual agent consumes both invalid paid ordinals and never purchases a third", async () => {
  let calls = 0;
  const f = fixture(async (request) => {
    await request.beforeDispatch!(() => calls++);
    return response({ bad: true });
  });
  try {
    await assert.rejects(
      f.inference.extract(
        f.actor,
        f.lease,
        f.batch,
        "{}",
        f.access,
        new AbortController().signal,
      ),
    );
    assert.equal(calls, 2);
    await assert.rejects(
      f.inference.extract(
        f.actor,
        f.lease,
        f.batch,
        "{}",
        f.access,
        new AbortController().signal,
      ),
      /profile_schema_exhausted/,
    );
    assert.equal(calls, 2);
    assert.equal(f.store.summary(f.batch.root).calls, 2);
  } finally {
    f.db.close();
  }
});

test("full 300-row multilingual prior stays projected and actual first/repair requests fit admission", async () => {
  const { buildProfileMaterial } = await import(
      "../apps/server-identity/profile-material"
    ),
    { MemoryItemSchema } = await import("../packages/protocol/memory");
  const at = new Date().toISOString(),
    scope = {
      connectionId: "TEST-account",
      serverId: "TEST-server",
      workspaceId: "TEST-workspace",
      userId: "TEST-alice",
    };
  const ref = {
    type: "chat" as const,
    sequence: 1,
    sourceId: "38b4d4cd-d5e9-4bba-9eee-44111d477234",
    sourceVersion: 1,
    digest: "a".repeat(64),
    at,
    messageId: "TEST-message",
  };
  const observations = Array.from({ length: 300 }, (_, i) =>
    MemoryItemSchema.parse({
      id: `TEST-prior-${i}`,
      revision: 1,
      origin: "observed",
      scope: "private",
      kind: "fact",
      status: "active",
      content: `TEST přehled ${i} ` + "žluťoučký 🙂 ".repeat(15),
      source: {
        type: "observed",
        section: "projects",
        personal: false,
        sources: [
          {
            type: "chat",
            sourceId: ref.sourceId,
            messageId: ref.messageId,
            digest: ref.digest,
            at,
            removed: true,
            href: null,
          },
        ],
      },
      trust: "model_inference",
      createdAt: at,
      updatedAt: at,
      seenAt: at,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      supersedesId: null,
    }),
  );
  const material = buildProfileMaterial({
    scope,
    progress,
    chat: [ref],
    meetings: [],
    chatSource: () => ({
      scope,
      ref,
      text: "TEST vlastní přehled 🙂. ".repeat(2000),
      commandId: "TEST-command",
      conversationId: "TEST-chat",
    }),
    meetingSource: () => null,
    usedActions: () => [],
    observations,
    personalThings: "keep",
  });
  assert(material.prior.length > 0 && material.prior.length <= 24);
  assert(Buffer.byteLength(JSON.stringify(material.prior)) <= 6144);
  assert(Buffer.byteLength(material.userPayload) <= 12288);
  assert(material.next.chatOffset > 0);
  const bytes: number[] = [];
  const f = fixture(async (request) => {
    await request.beforeDispatch!(() =>
      bytes.push(Buffer.byteLength(JSON.stringify(request.body))),
    );
    return response(bytes.length === 1 ? { bad: true } : valid);
  });
  try {
    await f.inference.extract(
      f.actor,
      f.lease,
      f.batch,
      material.userPayload,
      f.access,
      new AbortController().signal,
    );
    assert.equal(bytes.length, 2);
    assert(bytes.every((size) => size <= 24576));
    assert.equal(f.store.summary(f.batch.root).calls, 2);
  } finally {
    f.db.close();
  }
});

test("MIR-01 durable dispatch checkpoint independently rejects privacy invalidation before network start", async () => {
  let starts = 0;
  let f: ReturnType<typeof fixture>;
  f = fixture(async (request) => {
    f.cursor.privacyMutation(f.actor);
    await request.beforeDispatch!(() => starts++);
    return response();
  });
  try {
    await assert.rejects(
      f.inference.extract(
        f.actor,
        f.lease,
        f.batch,
        "{}",
        f.access,
        new AbortController().signal,
      ),
      /profile_privacy_changed/,
    );
    assert.equal(starts, 0);
    const call = f.cursor.calls(f.batch)[0]!;
    assert.equal(call.state, "unpaid");
    assert.equal(
      f.store.attemptStatus(f.batch.root, f.actor, call.attemptId),
      "cancelled",
    );
    assert.equal(f.cursor.pending(f.actor)!.state, "unusable");
  } finally {
    f.db.close();
  }
});

test("MIR-02 a cancelled same-root repair can retry while both actual paid ordinals stay capped", async () => {
  let requests = 0,
    starts = 0;
  const f = fixture(async (request) => {
    requests++;
    if (requests === 2) throw Error("TEST repair cancelled locally");
    await request.beforeDispatch!(() => starts++);
    return response(starts === 1 ? { bad: true } : valid);
  });
  try {
    await assert.rejects(
      f.inference.extract(
        f.actor,
        f.lease,
        f.batch,
        "{}",
        f.access,
        new AbortController().signal,
      ),
      /TEST repair cancelled locally/,
    );
    assert.equal(starts, 1);
    assert.equal(f.cursor.calls(f.batch)[1]!.state, "unpaid");
    f.cursor.defer(f.actor, f.lease, true);
    f.advance(3600001);
    const lease = f.cursor.acquire(f.actor)!;
    f.inference.prepareRecovery(f.actor, lease);
    assert.deepEqual(
      await f.inference.extract(
        f.actor,
        lease,
        f.batch,
        "{}",
        f.access,
        new AbortController().signal,
      ),
      valid,
    );
    assert.equal(starts, 2);
    assert.equal(f.cursor.pending(f.actor)!.root, f.batch.root);
    assert.equal(f.store.summary(f.batch.root).calls, 3);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM agent_inference_attempt WHERE run_id=? AND status<>'cancelled'",
        )
        .get(f.batch.root)!.n,
      2,
    );
    assert.equal(f.store.neverDispatched(f.batch.root, f.actor), false);
  } finally {
    f.db.close();
  }
});

test("MIR-02 ordinary no-hook callers keep existing cancelled-call accounting and owner proof is strict", async () => {
  let starts = 0;
  const f = fixture(async () => response());
  try {
    const caps = { maxTokens: 40000, maxCostMicros: 100000, maxModelCalls: 2 };
    const normal = budgetedInferenceTransport(
      async () => {
        throw Error("TEST no-hook local cancellation");
      },
      f.store,
      "TEST-normal-cancelled",
      f.actor,
      budgetSelection,
      "model",
      f.access.serial,
      async () => {},
      () => 0,
      caps,
    );
    const request = {
      url: "https://provider.example.test",
      body: { messages: [] },
      beforeDispatch: async (start: () => void) => {
        starts++;
        start();
      },
    };
    await assert.rejects(normal(request), /TEST no-hook local cancellation/);
    await assert.rejects(normal(request), /TEST no-hook local cancellation/);
    await assert.rejects(normal(request), /catalog_budget_exhausted/);
    assert.equal(starts, 0);
    assert.equal(f.store.summary("TEST-normal-cancelled").calls, 2);
    assert.equal(
      f.store.neverDispatched("TEST-normal-cancelled", f.actor),
      true,
    );
    assert.throws(
      () =>
        f.store.neverDispatched("TEST-normal-cancelled", {
          ...f.actor,
          userId: "TEST-bob",
        }),
      /identity_forbidden/,
    );
  } finally {
    f.db.close();
  }
});

test("MIR-04 startup scrubs expired received bytes while preserving unknown usage and original paid root", async () => {
  let starts = 0;
  const f = fixture(async (request) => {
    await request.beforeDispatch!(() => starts++);
    return response(valid, false);
  });
  try {
    await f.inference.extract(
      f.actor,
      f.lease,
      f.batch,
      "{}",
      f.access,
      new AbortController().signal,
    );
    assert(f.cursor.calls(f.batch)[0]!.ciphertext);
    new ProfileCursorStore(
      f.db,
      "TEST secret",
      () => Date.now() + 2 * 86400000,
    );
    assert.equal(f.cursor.calls(f.batch)[0]!.ciphertext, null);
    assert.equal(f.cursor.calls(f.batch)[0]!.state, "received");
    assert.equal(f.cursor.pending(f.actor)!.root, f.batch.root);
    assert.equal(f.store.summary(f.batch.root).unknownCalls, 1);
    assert.equal(starts, 1);
  } finally {
    f.db.close();
  }
});

test("MIR-02 missing or contradictory ledger evidence never authorizes an unpaid replacement", async () => {
  const f = fixture(async () => {
    throw Error("TEST before dispatch");
  });
  try {
    await assert.rejects(
      f.inference.extract(
        f.actor,
        f.lease,
        f.batch,
        "{}",
        f.access,
        new AbortController().signal,
      ),
    );
    const call = f.cursor.calls(f.batch)[0]!;
    assert.equal(
      f.store.attemptStatus(f.batch.root, f.actor, call.attemptId),
      "cancelled",
    );
    f.db
      .prepare("DELETE FROM agent_inference_run WHERE id=?")
      .run(f.batch.root);
    assert.equal(f.inference.proveUnpaid(f.actor, f.lease, f.batch), false);
    assert.equal(f.cursor.pending(f.actor)!.root, f.batch.root);
    assert.equal(f.store.neverDispatched("TEST-absent", f.actor), false);
  } finally {
    f.db.close();
  }
  const paid = fixture(async (request) => {
    await request.beforeDispatch!(() => {});
    return response(valid, false);
  });
  try {
    await paid.inference.extract(
      paid.actor,
      paid.lease,
      paid.batch,
      "{}",
      paid.access,
      new AbortController().signal,
    );
    paid.db
      .prepare(
        "UPDATE agent_profile_call SET state='unpaid',ciphertext=NULL WHERE batch_id=?",
      )
      .run(paid.batch.id);
    assert.equal(
      paid.inference.proveUnpaid(paid.actor, paid.lease, paid.batch),
      false,
    );
    assert.equal(paid.store.summary(paid.batch.root).unknownCalls, 1);
    assert.equal(paid.cursor.pending(paid.actor)!.root, paid.batch.root);
  } finally {
    paid.db.close();
  }
});

test("MIR-04 received TTL starts at receipt even when the wholly unpaid plan is older than a day", async () => {
  const f = fixture(async (request) => {
    await request.beforeDispatch!(() => {});
    return response();
  });
  try {
    f.advance(25 * 3600000);
    f.cursor.defer(f.actor, f.lease, false);
    f.advance(600001);
    const lease = f.cursor.acquire(f.actor)!;
    await f.inference.extract(
      f.actor,
      lease,
      f.batch,
      "{}",
      f.access,
      new AbortController().signal,
    );
    const call = f.cursor.calls(f.batch)[0]!;
    assert(call.expiresAt > Date.now() + 25 * 3600000);
    assert(f.cursor.response(f.actor, f.batch, call));
  } finally {
    f.db.close();
  }
});
