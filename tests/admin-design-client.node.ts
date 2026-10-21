import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProcessDesignClient,
  type DesignTransport,
  type DesignClientScope,
} from "../apps/server-admin/web/lib/process-design-client";
import { ApiError } from "../apps/server-admin/web/lib/api";
import {
  DESIGN_PROFILE,
  WORKSPACE_DESIGN_PROFILE,
  DesignTurnStartSchema,
  DesignUpdateSchema,
  type OwnedDesignReview as DesignReview,
  type DesignTurn,
} from "../packages/protocol/process-design";
import { type ProcessDefinition } from "../packages/protocol/service-processes";
import {
  designUiTarget,
  designUiCapabilities,
  designUiReview,
  designUiTurn,
  designUiCandidate,
} from "./admin-design-fixtures";

function fixture(
  sessionId: string | null = "test_design",
  workspaceOwned = false,
) {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };
  const scope: DesignClientScope = {
    ...designUiTarget,
    authority: "TEST-authority",
    serviceId: workspaceOwned ? "" : "test_service",
    ...(sessionId ? { sessionId } : {}),
  };
  const {
    profile: _profile,
    serviceId: _serviceId,
    ...sharedReview
  } = structuredClone(designUiReview);
  let review: DesignReview = workspaceOwned
    ? {
        ...sharedReview,
        profile: WORKSPACE_DESIGN_PROFILE,
        owner: { type: "workspace" },
      }
    : structuredClone(designUiReview);
  const profile = workspaceOwned ? WORKSPACE_DESIGN_PROFILE : DESIGN_PROFILE;
  let turns: DesignTurn[] = [];
  let caps = structuredClone(designUiCapabilities);
  const posts: { path: string; body: unknown }[] = [];
  let post: DesignTransport["request"] = async (_path, body) => {
    const command = body as {
      requestId: string;
      text?: string;
      language?: "en" | "cs";
    };
    const turn = {
      ...structuredClone(designUiTurn),
      requestId: command.requestId,
      userText: command.text!,
      language: command.language!,
    };
    turns = [turn];
    return { profile, turn };
  };
  const transport: DesignTransport = {
    capabilities: async () => caps,
    request: async (path, body, signal) => {
      if (body !== undefined) {
        // Immutable command must already be durable at admission.
        assert(
          [...memory.values()].some(
            (raw) =>
              JSON.parse(raw).pending?.body.requestId ===
              (body as { requestId: string }).requestId,
          ),
        );
        posts.push({ path, body: structuredClone(body) });
        return post(path, body, signal);
      }
      if (path.includes("/turns/list?"))
        return { profile, turns: structuredClone(turns) };
      if (path.includes("/turns?")) {
        const id = new URLSearchParams(path.split("?")[1]).get("requestId");
        const turn = turns.find((t) => t.requestId === id);
        if (!turn) throw new ApiError(404, "process_design_not_found");
        return { profile, turn };
      }
      return { profile, review: structuredClone(review) };
    },
  };
  const client = () => new ProcessDesignClient(scope, storage, transport);
  return {
    memory,
    storage,
    scope,
    transport,
    posts,
    client,
    setPost: (fn: typeof post) => {
      post = fn;
    },
    setReview: (r: DesignReview) => {
      review = r;
    },
    setTurns: (ts: DesignTurn[]) => {
      turns = ts;
    },
    setCaps: (c: typeof caps) => {
      caps = c;
    },
  };
}

function candidateUpdateReply(review: DesignReview, raw: unknown) {
  const command = DesignUpdateSchema.parse(raw);
  const updated = {
    ...review,
    revision: command.revision + 1,
    brief: command.brief,
    candidate: command.candidate,
    reviewDigest: "e".repeat(64),
  };
  return {
    profile: review.profile,
    review: updated,
    receipt: {
      profile: DESIGN_PROFILE,
      ...designUiTarget,
      sessionId: review.id,
      requestId: command.requestId,
      revision: updated.revision,
      kind: "updated",
      processId: null,
    },
  };
}

function startReply(workspaceOwned: boolean, raw: unknown) {
  const {
    serviceId: _serviceId,
    profile: _profile,
    ...shared
  } = structuredClone(designUiReview);
  const review: DesignReview = workspaceOwned
    ? {
        ...shared,
        profile: WORKSPACE_DESIGN_PROFILE,
        owner: { type: "workspace" },
      }
    : structuredClone(designUiReview);
  return {
    profile: workspaceOwned ? WORKSPACE_DESIGN_PROFILE : DESIGN_PROFILE,
    review,
    receipt: {
      profile: DESIGN_PROFILE,
      ...designUiTarget,
      sessionId: review.id,
      requestId: (raw as { requestId: string }).requestId,
      revision: review.revision,
      kind: "started",
      processId: null,
    },
  };
}

function firstMessageTransport(
  f: ReturnType<typeof fixture>,
  workspaceOwned = false,
  baseline?: NonNullable<DesignReview["baseline"]>,
) {
  f.setPost(async (path, raw) => {
    if (path.includes("/start")) {
      const result = startReply(workspaceOwned, raw);
      if (baseline) result.review.baseline = baseline;
      f.setReview(result.review);
      return result;
    }
    const command = DesignTurnStartSchema.parse(raw);
    const turn = {
      ...structuredClone(designUiTurn),
      requestId: command.requestId,
      userText: command.text,
      language: command.language,
    };
    f.setTurns([turn]);
    return {
      profile: workspaceOwned ? WORKSPACE_DESIGN_PROFILE : DESIGN_PROFILE,
      turn,
    };
  });
}

test("one explicit first message durably starts its owner session then sends the exact original intent", async () => {
  for (const workspaceOwned of [false, true]) {
    const f = fixture(null, workspaceOwned),
      c = f.client();
    firstMessageTransport(f, workspaceOwned);
    await c.refresh();
    assert.equal(f.posts.length, 0);
    c.setComposer("  TEST first\n\nmessage  ");
    assert.equal(c.canSend, false, "a model remains required for inference");
    c.setModel("test_model");
    assert.equal(c.canSend, true);
    const snapshots: ReturnType<typeof c.getSnapshot>[] = [];
    c.subscribe(() => snapshots.push(c.getSnapshot()));
    await c.send("cs");
    assert.equal(f.posts.length, 2);
    assert(f.posts[0]!.path.includes("/start"));
    assert(f.posts[1]!.path.includes("/turns"));
    const starting = snapshots.find((s) => s.firstMessage)!;
    assert(starting);
    const command = DesignTurnStartSchema.parse(f.posts[1]!.body);
    assert.equal(command.requestId, starting.firstMessage!.requestId);
    assert.equal(command.text, "  TEST first\n\nmessage  ");
    assert.equal(command.language, "cs");
    assert.equal(command.modelId, "test_model");
    assert.equal(command.sessionId, "test_design");
    assert.equal(command.revision, designUiReview.revision);
    const admitted = snapshots.find((s) => s.pending?.kind === "turns")!;
    assert(
      admitted.initializing,
      "navigation stays fenced between the two commands",
    );
    assert.equal(c.getSnapshot().initializing, false);
    assert.equal(c.getSnapshot().firstMessage, null);
    assert.equal(c.getSnapshot().pending, null);
    assert.equal(c.getSnapshot().composer, "");
    assert.equal(c.getSnapshot().fresh, true);
    assert.equal(
      c.getSnapshot().review?.profile,
      workspaceOwned ? WORKSPACE_DESIGN_PROFILE : DESIGN_PROFILE,
    );
    c.dispose();
  }
});

test("typing during session creation does not replace the first message or erase newer composer text", async () => {
  const f = fixture(null),
    c = f.client();
  firstMessageTransport(f);
  const request = f.transport.request;
  let finish!: () => void;
  f.transport.request = async (path, body, signal) => {
    if (body !== undefined && path.includes("/start"))
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return request(path, body, signal);
  };
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("  TEST initial message  ");
  const sending = c.send("cs");
  assert.equal(c.getSnapshot().initializing, true);
  c.setComposer("TEST next message");
  c.setModel("TEST-other-model");
  await c.send("en");
  finish();
  await sending;
  assert.equal(f.posts.length, 2);
  const turn = DesignTurnStartSchema.parse(f.posts[1]!.body);
  assert.equal(turn.text, "  TEST initial message  ");
  assert.equal(turn.language, "cs");
  assert.equal(turn.modelId, "test_model");
  assert.equal(c.getSnapshot().composer, "TEST next message");
  c.dispose();
});

test("unknown initial start acknowledgement reloads read-only and explicit retry continues the immutable original message", async () => {
  for (const workspaceOwned of [false, true]) {
    const f = fixture(null, workspaceOwned),
      c = f.client();
    await c.refresh();
    c.setModel("test_model");
    c.setComposer("  TEST preserved first\nmessage  ");
    f.setPost(async () => {
      throw Error("TEST lost start acknowledgement");
    });
    await c.send("cs");
    const originalStart = structuredClone(f.posts[0]);
    const originalIntent = structuredClone(c.getSnapshot().firstMessage);
    assert.equal(c.getSnapshot().pending?.kind, "start");
    assert.equal(c.getSnapshot().initializing, false);
    c.dispose();
    const restored = f.client();
    restored.attach();
    await restored.retry();
    assert.equal(
      f.posts.length,
      1,
      "retry still requires a passive fresh read",
    );
    await restored.refresh();
    await restored.refresh();
    assert.equal(
      f.posts.length,
      1,
      "reload and polling never replay start or turn",
    );
    assert.deepEqual(restored.getSnapshot().firstMessage, originalIntent);
    restored.setComposer("TEST later draft");
    firstMessageTransport(f, workspaceOwned);
    await restored.retry();
    assert.equal(f.posts.length, 3);
    assert.deepEqual(f.posts[1], originalStart);
    const turn = DesignTurnStartSchema.parse(f.posts[2]!.body);
    assert.deepEqual(
      {
        requestId: turn.requestId,
        modelId: turn.modelId,
        text: turn.text,
        language: turn.language,
      },
      originalIntent,
    );
    assert.equal(restored.getSnapshot().composer, "TEST later draft");
    assert.equal(restored.getSnapshot().pending, null);
    restored.dispose();
  }
});

test("remount after known start acknowledgement restores the queued turn at the original route without posting", async () => {
  const f = fixture(null),
    c = f.client();
  firstMessageTransport(f);
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("  TEST exact queued turn  ");
  c.subscribe(() => {
    if (c.getSnapshot().sessionId) c.dispose();
  });
  await c.send("en");
  assert.equal(f.posts.length, 1, "the disposed explicit call cannot continue");
  const originalTurn = structuredClone(c.getSnapshot().pending);
  assert.equal(originalTurn?.kind, "turns");
  const restored = f.client();
  assert.equal(restored.getSnapshot().sessionId, "test_design");
  assert.deepEqual(restored.getSnapshot().pending, originalTurn);
  await restored.refresh();
  assert.equal(f.posts.length, 1);
  await restored.retry();
  assert.equal(f.posts.length, 2);
  assert.deepEqual(f.posts[1]!.body, originalTurn!.body);
  restored.dispose();
  const sessionClient = new ProcessDesignClient(
    { ...f.scope, sessionId: "test_design" },
    f.storage,
    f.transport,
  );
  await sessionClient.refresh();
  assert.equal(f.posts.length, 2);
  sessionClient.dispose();
  const freshConversation = f.client();
  await freshConversation.refresh();
  assert.equal(
    freshConversation.getSnapshot().sessionId,
    null,
    "New conversation must not reopen the completed handoff",
  );
  assert.equal(freshConversation.getSnapshot().pending, null);
  assert.equal(f.posts.length, 2);
  freshConversation.dispose();
});

test("remount while initial start is in flight retains the exact start and first-message intent", async () => {
  const f = fixture(null),
    c = f.client();
  let finish!: (value: unknown) => void;
  f.setPost(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("TEST first before remount");
  const sending = c.send("cs");
  const originalStart = structuredClone(f.posts[0]);
  const originalIntent = structuredClone(c.getSnapshot().firstMessage);
  c.dispose();
  finish(startReply(false, originalStart!.body));
  await sending;
  const restored = f.client();
  await restored.refresh();
  assert.equal(f.posts.length, 1);
  assert.equal(restored.getSnapshot().sessionId, null);
  assert.deepEqual(restored.getSnapshot().firstMessage, originalIntent);
  firstMessageTransport(f);
  await restored.retry();
  assert.deepEqual(f.posts[1], originalStart);
  assert.equal(
    DesignTurnStartSchema.parse(f.posts[2]!.body).requestId,
    originalIntent!.requestId,
  );
  restored.dispose();
});

test("lost first-turn acknowledgement and remount preserve exact replay while all recovery reads stay passive", async () => {
  const f = fixture(null),
    c = f.client();
  f.setPost(async (path, raw) => {
    if (path.includes("/start")) return startReply(false, raw);
    throw Error("TEST lost first turn acknowledgement");
  });
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("  TEST exact first turn  ");
  await c.send("cs");
  assert.equal(f.posts.length, 2);
  const originalTurn = structuredClone(f.posts[1]);
  c.dispose();
  const restored = f.client();
  await restored.refresh();
  restored.attach();
  await restored.refresh();
  assert.equal(f.posts.length, 2);
  assert.equal(restored.getSnapshot().sessionId, "test_design");
  assert.equal(restored.getSnapshot().pending?.kind, "turns");
  firstMessageTransport(f);
  await restored.retry();
  assert.deepEqual(f.posts[2], originalTurn);
  assert.equal(restored.getSnapshot().pending, null);
  restored.dispose();
});

test("remount during first-turn dispatch cannot continue or replay the disposed operation", async () => {
  const f = fixture(null),
    c = f.client();
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const turnEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setPost(async (path, raw) => {
    if (path.includes("/start")) return startReply(false, raw);
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("TEST first turn before remount");
  const sending = c.send("cs");
  await turnEntered;
  const originalTurn = structuredClone(f.posts[1]);
  const command = DesignTurnStartSchema.parse(originalTurn!.body);
  c.dispose();
  finish({
    profile: DESIGN_PROFILE,
    turn: {
      ...designUiTurn,
      requestId: command.requestId,
      userText: command.text,
      language: command.language,
    },
  });
  await sending;
  const restored = f.client();
  await restored.refresh();
  assert.equal(f.posts.length, 2);
  assert.equal(restored.getSnapshot().initializing, false);
  assert.deepEqual(restored.getSnapshot().pending?.body, originalTurn!.body);
  firstMessageTransport(f);
  await restored.retry();
  assert.deepEqual(f.posts[2], originalTurn);
  restored.dispose();
});

test("invalid start acknowledgement retains initial intent and never dispatches its turn", async () => {
  for (const mismatch of ["request", "scope", "baseline"] as const) {
    const f = fixture(null),
      c = f.client();
    f.setPost(async (_path, raw) => {
      const result = startReply(false, raw);
      if (mismatch === "request")
        result.receipt.requestId = "TEST-other-request";
      if (mismatch === "scope")
        result.review.workspaceId = "TEST-other-workspace";
      if (mismatch === "baseline")
        result.review.baseline = {
          processId: "TEST-other-process",
          registryRevision: 1,
          version: 1,
          definition: designUiCandidate,
        };
      return result;
    });
    await c.refresh();
    c.setModel("test_model");
    c.setComposer("TEST unverified initial message");
    await c.send("en");
    assert.equal(f.posts.length, 1, mismatch);
    assert.equal(c.getSnapshot().sessionId, null, mismatch);
    assert.equal(c.getSnapshot().pending?.kind, "start", mismatch);
    assert.equal(
      c.getSnapshot().firstMessage?.text,
      "TEST unverified initial message",
      mismatch,
    );
    assert.equal(c.getSnapshot().error, "response_invalid", mismatch);
    c.dispose();
  }
});

test("storage failure before initial start or before its turn migration prevents the corresponding POST", async () => {
  for (const failAt of ["start", "turn"] as const) {
    const f = fixture(null),
      c = f.client();
    firstMessageTransport(f);
    await c.refresh();
    c.setModel("test_model");
    c.setComposer("TEST durable first message");
    const setItem = f.storage.setItem;
    f.storage.setItem = (key, raw) => {
      const pending = JSON.parse(raw).pending;
      if (pending?.kind === (failAt === "start" ? "start" : "turns"))
        throw Error("TEST storage unavailable");
      setItem(key, raw);
    };
    await c.send("en");
    assert.equal(f.posts.length, failAt === "start" ? 0 : 1);
    assert.equal(c.getSnapshot().initializing, false);
    assert.equal(c.getSnapshot().error, "recovery_storage_unavailable");
    if (failAt === "turn") {
      const originalStart = structuredClone(f.posts[0]);
      const intent = structuredClone(c.getSnapshot().firstMessage);
      assert.equal(c.getSnapshot().pending?.kind, "start");
      f.storage.setItem = setItem;
      await c.refresh();
      await c.retry();
      assert.deepEqual(f.posts[1], originalStart);
      assert.equal(
        DesignTurnStartSchema.parse(f.posts[2]!.body).requestId,
        intent!.requestId,
      );
    }
    c.dispose();
  }
});

test("manual blank-session creation requires no model and durably hands off without later reopening on New conversation", async () => {
  const f = fixture(null),
    c = f.client();
  f.setCaps({ ...designUiCapabilities, models: [] });
  f.setPost(async (_path, raw) => startReply(false, raw));
  await c.refresh();
  assert.equal(c.canSend, false);
  await c.start();
  assert.equal(f.posts.length, 1);
  c.dispose();
  const restored = f.client();
  await restored.refresh();
  assert.equal(restored.getSnapshot().sessionId, "test_design");
  assert.equal(restored.getSnapshot().modelId, "");
  assert.equal(f.posts.length, 1);
  restored.dispose();
  const sessionClient = new ProcessDesignClient(
    { ...f.scope, sessionId: "test_design" },
    f.storage,
    f.transport,
  );
  sessionClient.dispose();
  const newConversation = f.client();
  assert.equal(newConversation.getSnapshot().sessionId, null);
  newConversation.dispose();
});

test("initial message recovery keeps baseline routes separate and never accepts an unmarked session mismatch", async () => {
  const f = fixture(null),
    c = f.client();
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("TEST original scope");
  f.setPost(async () => {
    throw Error("TEST lost start");
  });
  await c.send("en");
  c.dispose();
  const other = new ProcessDesignClient(
    { ...f.scope, processId: "TEST-other-process" },
    f.storage,
    f.transport,
  );
  await other.refresh();
  await other.retry();
  assert.equal(f.posts.length, 1);
  assert.equal(other.getSnapshot().firstMessage, null);
  other.dispose();
  const [key, raw] = [...f.memory.entries()][0]!;
  const saved = JSON.parse(raw);
  saved.sessionId = "TEST-unmarked-session";
  saved.pending = null;
  saved.firstMessage = null;
  f.memory.set(key, JSON.stringify(saved));
  const invalid = f.client();
  assert.equal(invalid.getSnapshot().error, "recovery_storage_invalid");
  await invalid.refresh();
  await invalid.retry();
  assert.equal(f.posts.length, 1);
  invalid.dispose();
});

test("first-message start and route handoff preserve the exact process baseline", async () => {
  const f = fixture(null);
  f.scope.processId = "TEST-process-baseline";
  f.scope.baselineVersion = 3;
  const baseline = {
    processId: f.scope.processId,
    registryRevision: 4,
    version: 3,
    definition: designUiCandidate,
  };
  firstMessageTransport(f, false, baseline);
  const c = f.client();
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("TEST refine the requested version");
  await c.send("en");
  assert.equal(f.posts.length, 2);
  assert.equal(
    (f.posts[0]!.body as { processId: string }).processId,
    baseline.processId,
  );
  assert.equal(
    (f.posts[0]!.body as { baselineVersion: number }).baselineVersion,
    3,
  );
  c.dispose();
  const otherBaseline = new ProcessDesignClient(
    { ...f.scope, baselineVersion: 2 },
    f.storage,
    f.transport,
  );
  await otherBaseline.refresh();
  assert.equal(otherBaseline.getSnapshot().sessionId, null);
  otherBaseline.dispose();
  const restored = f.client();
  await restored.refresh();
  assert.deepEqual(restored.getSnapshot().review?.baseline, baseline);
  assert.equal(f.posts.length, 2);
  restored.dispose();
  const {
    processId: _processId,
    baselineVersion: _baselineVersion,
    ...sessionScope
  } = f.scope;
  const sessionClient = new ProcessDesignClient(
    { ...sessionScope, sessionId: "test_design" },
    f.storage,
    f.transport,
  );
  await sessionClient.refresh();
  sessionClient.dispose();
  const fresh = f.client();
  assert.equal(fresh.getSnapshot().sessionId, null);
  assert.equal(f.posts.length, 2);
  fresh.dispose();
});

test("definite first-start rejection clears its intent and requires another explicit message", async () => {
  const f = fixture(null),
    c = f.client();
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("TEST rejected initial start");
  f.setPost(async () => {
    throw new ApiError(409, "process_design_conflict");
  });
  await c.send("en");
  assert.equal(c.getSnapshot().pending, null);
  assert.equal(c.getSnapshot().firstMessage, null);
  assert.equal(c.getSnapshot().composer, "TEST rejected initial start");
  assert.equal(c.getSnapshot().initializing, false);
  await c.refresh();
  await c.retry();
  assert.equal(f.posts.length, 1);
  firstMessageTransport(f);
  await c.send("cs");
  assert.equal(f.posts.length, 3);
  assert.notEqual(
    (f.posts[1]!.body as { requestId: string }).requestId,
    (f.posts[0]!.body as { requestId: string }).requestId,
  );
  c.dispose();
});

test("manual candidate updates preserve the brief and owner target and dispatch only the schema-validated update", async () => {
  for (const workspaceOwned of [false, true]) {
    const f = fixture("test_design", workspaceOwned),
      client = f.client();
    // Manual edits do not require a model choice or dispatch readiness.
    f.setCaps({ ...designUiCapabilities, models: [] });
    await client.refresh();
    const shown = client.getSnapshot().review!;
    const candidate = { ...designUiCandidate, name: "TEST manually edited" };
    f.setPost(async (_path, raw) => {
      const result = candidateUpdateReply(shown, raw);
      f.setReview(result.review);
      return result;
    });
    await client.updateCandidate(shown, candidate);
    assert.equal(f.posts.length, 1);
    assert.equal(
      f.posts[0]!.path,
      "identity/catalog/processes/design/update" +
        (workspaceOwned
          ? "?profile=" + encodeURIComponent(WORKSPACE_DESIGN_PROFILE)
          : ""),
    );
    const body = DesignUpdateSchema.parse(f.posts[0]!.body);
    assert.deepEqual(body, {
      ...designUiTarget,
      sessionId: shown.id,
      requestId: body.requestId,
      revision: shown.revision,
      brief: shown.brief,
      candidate,
    });
    assert.equal(client.getSnapshot().pending, null);
    assert.equal(client.getSnapshot().fresh, true);
    assert.deepEqual(client.getSnapshot().review?.candidate, candidate);
    assert.deepEqual(client.getSnapshot().turns, []);
    assert.equal(client.getSnapshot().modelId, "");
    client.dispose();
  }
});

test("manual candidate updates reject invalid definitions before persisting or posting", async () => {
  const f = fixture(),
    client = f.client();
  await client.refresh();
  const invalid = {
    ...designUiCandidate,
    trigger: "automatic",
  } as unknown as ProcessDefinition;
  await assert.rejects(
    client.updateCandidate(client.getSnapshot().review!, invalid),
  );
  assert.equal(f.posts.length, 0);
  assert.equal(f.memory.size, 0);
  assert.equal(client.getSnapshot().pending, null);
  assert.equal(client.getSnapshot().fresh, true);
  client.dispose();
});

test("manual creation can supply a human purpose while preserving questions and assumptions from the started brief", async () => {
  const f = fixture(),
    client = f.client();
  f.setReview({
    ...designUiReview,
    candidate: null,
    brief: {
      ...designUiReview.brief,
      purpose: "",
      questions: [{ id: "contact_source", text: "Which contact source?" }],
    },
    blockers: ["candidate_missing", "purpose_missing"],
  });
  await client.refresh();
  const shown = client.getSnapshot().review!;
  const brief = { ...shown.brief, purpose: "TEST human workflow purpose" };
  f.setPost(async (_path, raw) => {
    const result = candidateUpdateReply(shown, raw);
    f.setReview(result.review);
    return result;
  });
  await client.updateCandidate(shown, designUiCandidate, brief);
  const body = DesignUpdateSchema.parse(f.posts[0]!.body);
  assert.deepEqual(body.brief, brief);
  assert.deepEqual(body.brief.questions, shown.brief.questions);
  assert.deepEqual(body.brief.assumptions, shown.brief.assumptions);
  assert.deepEqual(body.candidate, designUiCandidate);
  assert.equal(shown.brief.purpose, "");
  assert.equal(shown.candidate, null);
  assert.equal(client.getSnapshot().pending, null);
  client.dispose();
});

test("manual candidate updates block stale revision, digest, capabilities, scope, running turns and accepted reviews", async () => {
  for (const mode of [
    "revision",
    "digest",
    "capabilities",
    "scope",
    "running",
    "accepted",
    "unrefreshed",
  ] as const) {
    const f = fixture(),
      client = f.client();
    if (mode === "scope")
      f.setReview({ ...designUiReview, workspaceId: "TEST-foreign" });
    if (mode === "running")
      f.setTurns([{ ...designUiTurn, status: "running" }]);
    if (mode === "accepted")
      f.setReview({ ...designUiReview, acceptedProcessId: "TEST-process" });
    if (mode !== "unrefreshed") await client.refresh();
    const expected = {
      ...designUiReview,
      ...(mode === "revision" ? { revision: 2 } : {}),
      ...(mode === "digest" ? { reviewDigest: "f".repeat(64) } : {}),
      ...(mode === "capabilities"
        ? { capabilityFingerprint: "f".repeat(64) }
        : {}),
    };
    await client.updateCandidate(expected, designUiCandidate);
    assert.equal(f.posts.length, 0, mode);
    assert.equal(client.getSnapshot().pending, null, mode);
    client.dispose();
  }
});

test("manual update lost ACK recovery remains passive and explicitly replays the immutable original after refreshed review changes", async () => {
  for (const workspaceOwned of [false, true]) {
    const f = fixture("test_design", workspaceOwned),
      client = f.client();
    await client.refresh();
    const shown = structuredClone(client.getSnapshot().review!);
    const candidate = { ...designUiCandidate, name: "TEST original edit" };
    f.setPost(async () => {
      throw Error("TEST lost update acknowledgement");
    });
    await client.updateCandidate(shown, candidate);
    const original = structuredClone(f.posts[0]!);
    assert.equal(client.getSnapshot().pending?.kind, "update");
    candidate.name = "TEST later local change";
    shown.brief.purpose = "TEST later local brief";
    await client.updateCandidate(shown, candidate);
    assert.equal(f.posts.length, 1, "a pending edit cannot be replaced");
    client.dispose();
    const restored = f.client();
    await restored.retry();
    assert.equal(f.posts.length, 1, "retry requires passive recovery");
    const updated = candidateUpdateReply(
      { ...shown, brief: designUiReview.brief },
      original.body,
    );
    f.setReview({
      ...updated.review,
      revision: 3,
      brief: { ...updated.review.brief, purpose: "TEST refreshed brief" },
      reviewDigest: "f".repeat(64),
      capabilityFingerprint: "d".repeat(64),
      acceptedProcessId: "TEST-process",
    });
    f.setCaps({ ...designUiCapabilities, fingerprint: "d".repeat(64) });
    await restored.refresh();
    assert.equal(f.posts.length, 1);
    assert.equal(restored.getSnapshot().pending?.kind, "update");
    f.setPost(async () => updated);
    await restored.retry();
    assert.deepEqual(f.posts[1], original);
    assert.equal(restored.getSnapshot().pending, null);
    assert.equal(restored.getSnapshot().fresh, true);
    restored.dispose();
  }
});

test("a definitely rejected manual candidate update clears recovery and requires a new explicit command after fresh review", async () => {
  const f = fixture(),
    client = f.client();
  await client.refresh();
  const shown = client.getSnapshot().review!;
  f.setPost(async () => {
    f.setReview({
      ...designUiReview,
      revision: 2,
      reviewDigest: "f".repeat(64),
    });
    throw new ApiError(409, "process_design_conflict");
  });
  await client.updateCandidate(shown, designUiCandidate);
  assert.equal(client.getSnapshot().pending, null);
  assert.equal(client.getSnapshot().fresh, true);
  assert.equal(client.getSnapshot().error, "process_design_conflict");
  assert.deepEqual(client.getSnapshot().rejectedTurns, []);
  client.dispose();
  const restored = f.client();
  await restored.refresh();
  await restored.retry();
  await restored.updateCandidate(shown, designUiCandidate);
  assert.equal(f.posts.length, 1);
  const current = restored.getSnapshot().review!;
  f.setPost(async (_path, raw) => {
    const result = candidateUpdateReply(current, raw);
    f.setReview(result.review);
    return result;
  });
  await restored.updateCandidate(current, designUiCandidate);
  assert.equal(f.posts.length, 2);
  assert.notEqual(
    DesignUpdateSchema.parse(f.posts[1]!.body).requestId,
    DesignUpdateSchema.parse(f.posts[0]!.body).requestId,
  );
  assert.equal(DesignUpdateSchema.parse(f.posts[1]!.body).revision, 2);
  assert.equal(restored.getSnapshot().pending, null);
  restored.dispose();
});

test("manual update storage failure prevents dispatch and a mismatched receipt preserves the pending command", async () => {
  const f = fixture(),
    client = f.client();
  await client.refresh();
  const shown = client.getSnapshot().review!;
  const setItem = f.storage.setItem;
  f.storage.setItem = () => {
    throw Error("TEST storage unavailable");
  };
  await client.updateCandidate(shown, designUiCandidate);
  assert.equal(f.posts.length, 0);
  assert.equal(client.getSnapshot().pending, null);
  assert.equal(client.getSnapshot().error, "recovery_storage_unavailable");
  f.storage.setItem = setItem;
  await client.refresh();
  f.setPost(async (_path, raw) => {
    const result = candidateUpdateReply(shown, raw);
    return { ...result, receipt: { ...result.receipt, kind: "acknowledged" } };
  });
  await client.updateCandidate(shown, designUiCandidate);
  assert.equal(f.posts.length, 1);
  assert.equal(client.getSnapshot().pending?.kind, "update");
  assert.equal(client.getSnapshot().error, "response_invalid");
  assert.equal(client.getSnapshot().fresh, false);
  client.dispose();
});

test("workspace designer restores and replays the original explicit owner command without colliding with service recovery", async () => {
  const f = fixture(null, true),
    client = f.client();
  await client.refresh();
  f.setPost(async () => {
    throw Error("TEST lost workspace start acknowledgement");
  });
  await client.start();
  assert.equal(f.posts.length, 1);
  const original = structuredClone(f.posts[0]);
  assert(original);
  assert(
    original.path.endsWith(
      "?profile=" + encodeURIComponent(WORKSPACE_DESIGN_PROFILE),
    ),
  );
  const body = original.body as {
    profile: string;
    owner: { type: string };
    serviceId?: string;
  };
  assert.equal(body.profile, WORKSPACE_DESIGN_PROFILE);
  assert.deepEqual(body.owner, { type: "workspace" });
  assert.equal(body.serviceId, undefined);
  assert([...f.memory.keys()].every((k) => k.includes("~workspace")));
  client.dispose();
  const restored = f.client();
  await restored.refresh();
  assert.equal(f.posts.length, 1);
  const {
    profile: _profile,
    serviceId: _serviceId,
    ...sharedReview
  } = structuredClone(designUiReview);
  const globalReview = {
    ...sharedReview,
    profile: WORKSPACE_DESIGN_PROFILE,
    owner: { type: "workspace" as const },
  };
  f.setPost(async (_path, raw) => ({
    profile: WORKSPACE_DESIGN_PROFILE,
    review: globalReview,
    receipt: {
      profile: DESIGN_PROFILE,
      ...designUiTarget,
      sessionId: globalReview.id,
      requestId: (raw as { requestId: string }).requestId,
      revision: globalReview.revision,
      kind: "started",
      processId: null,
    },
  }));
  await restored.retry();
  assert.deepEqual(f.posts[1], original);
  assert.equal(restored.getSnapshot().pending, null);
  assert.equal(
    restored.getSnapshot().review?.profile,
    WORKSPACE_DESIGN_PROFILE,
  );
  assert.equal(restored.getSnapshot().fresh, true);
  restored.dispose();
});

test("personal designer starts a user-owned process with its own recovery and refuses a workspace review", async () => {
  const f = fixture(null, true);
  const client = new ProcessDesignClient(
    { ...f.scope, owner: "user" },
    f.storage,
    f.transport,
  );
  await client.refresh();
  f.setPost(async () => {
    throw Error("TEST lost personal start acknowledgement");
  });
  await client.start();
  assert.equal(f.posts.length, 1);
  assert.deepEqual((f.posts[0]!.body as { owner: unknown }).owner, {
    type: "user",
  });
  assert([...f.memory.keys()].every((k) => k.includes("~personal")));
  client.dispose();
  // The console's workspace scope never restores or replays the personal start.
  const workspace = f.client();
  await workspace.refresh();
  assert.equal(workspace.getSnapshot().pending, null);
  assert.equal(f.posts.length, 1);
  workspace.dispose();

  const g = fixture("test_design", true);
  const personal = () =>
    new ProcessDesignClient({ ...g.scope, owner: "user" }, g.storage, g.transport);
  const foreign = personal();
  await foreign.refresh();
  assert.equal(foreign.getSnapshot().fresh, false);
  assert.equal(foreign.getSnapshot().review, null);
  foreign.dispose();
  const {
    profile: _profile,
    serviceId: _serviceId,
    ...sharedReview
  } = structuredClone(designUiReview);
  g.setReview({
    ...sharedReview,
    profile: WORKSPACE_DESIGN_PROFILE,
    owner: { type: "user", userId: "test_user" },
  });
  const own = personal();
  await own.refresh();
  assert.equal(own.getSnapshot().fresh, true);
  assert.equal(own.getSnapshot().review?.id, sharedReview.id);
  own.dispose();
});

test("designer passive history rejects a response from the other owner profile", async () => {
  for (const workspaceOwned of [false, true]) {
    const f = fixture("test_design", workspaceOwned),
      request = f.transport.request;
    const client = new ProcessDesignClient(f.scope, f.storage, {
      ...f.transport,
      request: async (path, body, signal) => {
        const result = await request(path, body, signal);
        return path.includes("/turns/list?")
          ? {
              ...(result as object),
              profile: workspaceOwned
                ? DESIGN_PROFILE
                : WORKSPACE_DESIGN_PROFILE,
            }
          : result;
      },
    });
    await client.refresh();
    assert.equal(client.getSnapshot().fresh, false);
    assert.equal(client.getSnapshot().error, "response_invalid");
    assert.deepEqual(client.getSnapshot().turns, []);
    assert.equal(f.posts.length, 0);
    client.dispose();
  }
});
test("reload is passive; an unknown turn retains its exact command and whitespace for explicit replay", async () => {
  const f = fixture();
  const c = f.client();
  await c.refresh();
  c.setModel("test_model");
  const original = "  TEST original\n\n**Markdown**  ";
  c.setComposer(original);
  f.setPost(async () => {
    throw new Error("TEST network loss");
  });
  await c.send("cs");
  const sent = structuredClone(f.posts[0]);
  c.dispose();
  const recovered = f.client();
  await recovered.retry();
  assert.equal(f.posts.length, 1, "cannot replay before passive recovery");
  await recovered.refresh();
  assert.equal(f.posts.length, 1);
  assert.equal(recovered.getSnapshot().composer, original);
  assert.equal(recovered.getSnapshot().pending?.kind, "turns");
  assert(recovered.blocked);
  await recovered.retry();
  assert.deepEqual(f.posts[1], sent);
  f.setTurns([
    {
      ...designUiTurn,
      requestId: (sent!.body as { requestId: string }).requestId,
      userText: original,
      language: "cs",
      status: "interrupted",
      failure: "process_design_server_restarted",
    },
  ]);
  await recovered.refresh();
  assert.equal(recovered.getSnapshot().pending, null);
  assert.equal(recovered.getSnapshot().turns[0]?.userText, original);
  assert.equal(recovered.getSnapshot().turns[0]?.status, "interrupted");
  assert.equal(f.posts.length, 2);
});
test("newly typed composer text survives completion and failed turns retain their original model pin", async () => {
  const f = fixture();
  const c = f.client();
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("TEST first");
  let finish!: () => void;
  f.setPost(async (_p, body) => {
    const cmd = body as { requestId: string; text: string };
    await new Promise<void>((r) => {
      finish = r;
    });
    f.setTurns([
      {
        ...designUiTurn,
        requestId: cmd.requestId,
        userText: cmd.text,
        status: "failed",
        failure: "process_design_turn_failed",
      },
    ]);
    return {
      profile: DESIGN_PROFILE,
      turn: {
        ...designUiTurn,
        requestId: cmd.requestId,
        userText: cmd.text,
        status: "failed",
        failure: "process_design_turn_failed",
      },
    };
  });
  const send = c.send("en");
  c.setComposer("TEST next");
  finish();
  await send;
  assert.equal(c.getSnapshot().composer, "TEST next");
  assert.equal(c.getSnapshot().pending, null);
  f.setCaps({ ...designUiCapabilities, models: [] });
  await c.refresh();
  await c.send("en");
  assert.equal(f.posts.length, 1);
  assert.equal(c.getSnapshot().turns[0]?.model.id, "test_model");
});
test("storage failure prevents dispatch; revocation clears private state even when deletion fails", async () => {
  const f = fixture();
  const c = f.client();
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("TEST private");
  f.storage.setItem = () => {
    throw Error("TEST storage unavailable");
  };
  await c.send("en");
  assert.equal(f.posts.length, 0);
  f.storage.removeItem = () => {
    throw Error("TEST remove unavailable");
  };
  f.transport.request = async () => {
    throw new ApiError(403);
  };
  await c.refresh();
  assert(c.getSnapshot().denied);
  assert.equal(c.getSnapshot().review, null);
  assert.deepEqual(c.getSnapshot().turns, []);
  assert.equal(c.getSnapshot().composer, "");
  assert.equal(c.getSnapshot().pending, null);
});
test("start recovery is bound to its exact baseline route; no automatic start or replay", async () => {
  const f = fixture(null);
  f.scope.processId = "TEST-process-A"; // process-bound route
  const c = f.client();
  await c.refresh();
  assert.equal(f.posts.length, 0);
  f.setPost(async () => {
    throw Error("TEST lost start");
  });
  await c.start();
  c.dispose();
  const other = new ProcessDesignClient(
    { ...f.scope, processId: "TEST-process-B" },
    f.storage,
    f.transport,
  );
  await other.refresh();
  await other.retry();
  assert.equal(f.posts.length, 1);
  assert.equal(other.getSnapshot().pending, null);
  const original = f.client();
  await original.refresh();
  await original.retry();
  assert.deepEqual(f.posts[1], f.posts[0]);
});
test("human ACK and accept never substitute a refreshed proposal digest or assumption", async () => {
  const f = fixture();
  const c = f.client();
  await c.refresh();
  const shown = c.getSnapshot().review!;
  f.setReview({
    ...designUiReview,
    revision: 2,
    reviewDigest: "e".repeat(64),
    assumptions: [
      { id: "read_only", digest: "f".repeat(64), acknowledged: false },
    ],
    blockers: [],
  });
  await c.refresh();
  await c.acknowledge(shown, [{ id: "read_only", digest: "b".repeat(64) }]);
  await c.accept(shown);
  assert.equal(f.posts.length, 0);
  await c.acknowledge(c.getSnapshot().review!, [
    { id: "read_only", digest: "b".repeat(64) },
  ]);
  assert.equal(f.posts.length, 0);
});
test("lost accept reply retains its original digest and exact explicit replay", async () => {
  const f = fixture();
  f.setReview({
    ...designUiReview,
    blockers: [],
    assumptions: [{ ...designUiReview.assumptions[0]!, acknowledged: true }],
  });
  const c = f.client();
  await c.refresh();
  f.setPost(async () => {
    throw Error("TEST lost accept");
  });
  await c.accept(c.getSnapshot().review!);
  const command = f.posts[0];
  f.setReview({
    ...designUiReview,
    revision: 2,
    reviewDigest: "e".repeat(64),
    blockers: [],
    acceptedProcessId: "TEST-process",
  });
  await c.refresh();
  assert.equal(c.getSnapshot().pending?.kind, "accept");
  await c.retry();
  assert.deepEqual(f.posts[1], command);
});
test("running or inconsistent snapshots prevent approvals and source mismatches never expose history", async () => {
  for (const mode of ["running", "ahead", "pin", "scope"] as const) {
    const f = fixture();
    f.setReview({ ...designUiReview, blockers: [] });
    f.setTurns(
      mode === "pin"
        ? [
            designUiTurn,
            {
              ...designUiTurn,
              requestId: "TEST-second",
              model: { ...designUiTurn.model, providerRevision: 2 },
            },
          ]
        : [
            {
              ...designUiTurn,
              ...(mode === "running"
                ? { status: "running" as const }
                : mode === "ahead"
                  ? { revision: 2 }
                  : mode === "scope"
                    ? { workspaceId: "TEST-foreign" }
                    : {}),
            },
          ],
    );
    const c = f.client();
    await c.refresh();
    await c.accept(designUiReview);
    await c.acknowledge(designUiReview, []);
    assert.equal(f.posts.length, 0);
    if (mode !== "running") {
      assert.equal(c.getSnapshot().fresh, false);
      assert.deepEqual(c.getSnapshot().turns, []);
    }
  }
});
test("disposed scope ignores late completions, and StrictMode reattach remains passive", async () => {
  const f = fixture();
  const c = f.client();
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("TEST original");
  let finish!: (value: unknown) => void;
  f.setPost(
    async () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const sending = c.send("en");
  const pending = c.getSnapshot().pending!;
  c.dispose();
  c.attach();
  await c.refresh();
  finish({
    profile: DESIGN_PROFILE,
    turn: { ...designUiTurn, requestId: pending.body.requestId },
  });
  await sending;
  assert.equal(f.posts.length, 1);
  assert.equal(c.getSnapshot().pending?.body.requestId, pending.body.requestId);
  assert.equal(c.getSnapshot().sessionId, "test_design");
});

test("definitely rejected messages remain visible even after the composer has changed and after reload", async () => {
  const f = fixture();
  const c = f.client();
  await c.refresh();
  c.setModel("test_model");
  c.setComposer("TEST sent original");
  f.setPost(async () => {
    c.setComposer("TEST next draft");
    throw new ApiError(409, "process_design_conflict");
  });
  await c.send("en");
  assert.equal(c.getSnapshot().pending, null);
  assert.equal(c.getSnapshot().composer, "TEST next draft");
  assert.equal(
    c.getSnapshot().rejectedTurns[0]?.command.text,
    "TEST sent original",
  );
  c.dispose();
  const reloaded = f.client();
  await reloaded.refresh();
  assert.equal(
    reloaded.getSnapshot().rejectedTurns[0]?.command.text,
    "TEST sent original",
  );
  assert.equal(f.posts.length, 1);
});
test("corrupt stored commands block dispatch instead of silently discarding recovery", async () => {
  const f = fixture();
  const c = f.client();
  c.setComposer("TEST");
  c.dispose();
  const key = [...f.memory.keys()][0]!;
  f.memory.set(key, "{invalid");
  const recovered = f.client();
  recovered.setComposer("TEST overwrite attempt");
  recovered.setModel("test_model");
  assert.equal(f.memory.get(key), "{invalid");
  await recovered.refresh();
  await recovered.start();
  await recovered.send("en");
  await recovered.retry();
  assert.equal(recovered.getSnapshot().error, "recovery_storage_invalid");
  assert(recovered.blocked);
  assert.equal(f.posts.length, 0);
  const again = f.client();
  await again.refresh();
  assert.equal(again.getSnapshot().error, "recovery_storage_invalid");
});

test("same-account authority reset always rotates, even when storage cleanup and writes fail", async (t) => {
  const { designAuthority, resetDesignAuthority } = await import(
    "../apps/server-admin/web/lib/design-authority"
  );
  const oldDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      length: 1,
      key: () => "agent-admin-design/1/TEST-old",
      getItem: () => "TEST-old-authority",
      removeItem: () => {
        throw Error("TEST remove fault");
      },
      setItem: () => {
        throw Error("TEST write fault");
      },
    },
  });
  t.after(() => {
    if (oldDescriptor)
      Object.defineProperty(globalThis, "sessionStorage", oldDescriptor);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  });
  const previous = designAuthority();
  const rotated = resetDesignAuthority();
  assert.notEqual(rotated, previous);
  assert.equal(designAuthority(), rotated);
});
