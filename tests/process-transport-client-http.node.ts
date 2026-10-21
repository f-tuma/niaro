import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, after } from "node:test";
import { ClientSession, commandTarget } from "../packages/client-core/session";
import {
  captureProcessStartTarget,
  captureProcessResolveTarget,
  processStartCommand,
  processResolveCommand,
} from "../packages/client-core/process-commands";
import {
  ProcessExecutionInventorySchema,
  ProcessInputCardSchema,
} from "../packages/protocol/process-execution";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../packages/protocol/process-questions";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import type { Credential } from "../packages/protocol";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import { processObject } from "./helpers/service-process";
import { askQuestion } from "./helpers/process-questions-runtime";

const suffix =
  "?profile=" + encodeURIComponent(PROCESS_QUESTION_EXECUTION_PROFILE);
// Share one isolated identity fixture so setup logins do not exhaust the real
// per-process auth limiter; every case creates its own pinned process and outbox.
const fixture = coordinatorHttpFixture({ allowOrdinaryRuntime: true });
after(async () => {
  await (await fixture).close();
});
async function reopenedFixture() {
  const h = await fixture;
  await h.restart();
  h.dispatches.length = 0;
  return h;
}
const storage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
};
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean) {
  const until = Date.now() + 5000;
  while (!check()) {
    assert(Date.now() < until, "TEST Session projection did not settle");
    await delay(10);
  }
}
const sessionFor = (
  h: Awaited<ReturnType<typeof coordinatorHttpFixture>>,
  credential: Credential,
  saved: ReturnType<typeof storage>,
  request: typeof fetch = fetch,
) =>
  new ClientSession(
    h.origin + "/v1/" + h.target.workspaceId,
    saved,
    credential,
    request,
    undefined,
    undefined,
    false,
    { processQuestions: true, processApprovals: true },
  );
async function prepared(
  h: Awaited<ReturnType<typeof coordinatorHttpFixture>>,
  credential: Credential,
  artifact: ReturnType<typeof h.activate>,
  input: Record<string, unknown> = { name: "TEST-input" },
) {
  const inventory = ProcessExecutionInventorySchema.parse(
    (await h.mobile(credential, "processes" + suffix)).data,
  );
  const entry = inventory.processes.find(
    (item) => item.processId === artifact.processId,
  );
  assert(entry?.availability === "ready", JSON.stringify(inventory));
  const id = randomUUID();
  const result = await h.mobile(credential, "processes/input" + suffix, {
    processId: artifact.processId,
    version: artifact.version,
    artifactDigest: artifact.digest,
    language: "en",
    origin: {
      type: "command",
      conversationId: "conversation-1",
      requestId: id,
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const card = ProcessInputCardSchema.parse(result.data);
  const target = captureProcessStartTarget(
    h.origin + "/v1/" + h.target.workspaceId,
    credential.scope,
    entry,
    card,
  );
  const command = processStartCommand(target, {
    commandId: id,
    idempotencyKey: id + "-key",
    input,
    language: "en",
  });
  return { inventory, card, target, command };
}
function trackedTransport(saved: ReturnType<typeof storage>) {
  const posts: {
    path: string;
    body: string;
    status: number;
    value: unknown;
  }[] = [];
  let lose = false;
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method !== "POST" || !path.endsWith("/processes/commands"))
      return fetch(url, init);
    const body = String(init.body);
    // The real server cannot see a command before its exact local bytes exist.
    assert(
      [...saved.values.values()].some((bytes) => {
        try {
          return JSON.parse(bytes).serializedCommand === body;
        } catch {
          return false;
        }
      }),
      "TEST exact pending envelope was not saved before dispatch",
    );
    const response = await fetch(url, init);
    const value = await response.clone().json();
    posts.push({ path: String(url), body, status: response.status, value });
    if (lose) {
      lose = false;
      await response.text();
      throw Error("TEST lost reply after real server commit");
    }
    return response;
  };
  return {
    request,
    posts,
    loseNext: () => {
      lose = true;
    },
  };
}

function storedCommandCount(
  h: Awaited<ReturnType<typeof coordinatorHttpFixture>>,
  table: "agent_process_start_command" | "agent_process_resolve_command",
  commandId: string,
) {
  return h.identity["db"]
    .prepare(
      `SELECT count(*) AS n FROM ${table} WHERE json_extract(data,'$.command.commandId')=?`,
    )
    .get(commandId)!.n;
}

test("actual paired Session starts through execution/2, projects native work and two client reopens stay passive", async () => {
  const h = await reopenedFixture();
  const sessions: ClientSession[] = [];
  try {
    const credential = await h.pair(),
      saved = storage(),
      transport = trackedTransport(saved);
    const preparedStart = await prepared(h, credential, h.activate());
    assert.equal(preparedStart.inventory.profile, "agent-process-execution/1");
    assert.equal(preparedStart.card.form.profile, "agent-process-input/1");
    const session = sessionFor(h, credential, saved, transport.request);
    sessions.push(session);
    await session.start(false);
    await session.send(preparedStart.command, false, preparedStart.target);
    assert.equal(session.getSnapshot().pending, null);
    assert.equal(
      session.getSnapshot().commandStates[commandTarget(preparedStart.command)],
      "accepted",
    );
    await waitFor(() => !session.getSnapshot().store!.stale);
    const result = ProcessRuntimeResponseSchema.parse(
      transport.posts[0]!.value,
    );
    assert(result.process?.parentRunId);
    assert.equal(
      session.getSnapshot().store!.workItems[result.process.parentRunId]!
        .status,
      "succeeded",
    );
    assert.equal(
      JSON.parse(transport.posts[0]!.body).profile,
      "agent-process-start/1",
    );
    assert.equal(
      new URL(transport.posts[0]!.path).searchParams.get("profile"),
      PROCESS_QUESTION_EXECUTION_PROFILE,
    );
    session.stop();
    for (let i = 0; i < 2; i++) {
      const reopened = sessionFor(h, credential, saved, transport.request);
      sessions.push(reopened);
      await reopened.start(false);
      assert.equal(reopened.getSnapshot().pending, null);
      assert.equal(
        reopened.getSnapshot().store!.workItems[result.process.parentRunId]!
          .status,
        "succeeded",
      );
      reopened.stop();
    }
    assert.equal(transport.posts.length, 1);
    assert.deepEqual(h.dispatches, ["GET"]);
    assert.equal(h.modelCount(), 0);
  } finally {
    sessions.forEach((s) => s.stop());
  }
});

test("lost real start response restores the original proof and retries exact bytes after client and server reopen", async () => {
  const h = await reopenedFixture();
  const sessions: ClientSession[] = [];
  try {
    const credential = await h.pair(),
      saved = storage(),
      transport = trackedTransport(saved);
    const start = await prepared(h, credential, h.activate());
    const first = sessionFor(h, credential, saved, transport.request);
    sessions.push(first);
    await first.start(false);
    transport.loseNext();
    await first.send(start.command, false, start.target);
    assert.deepEqual(first.getSnapshot().pending, start.command);
    assert.equal(first.getSnapshot().error, "network_error");
    first.stop();
    await h.restart();
    const reopened = sessionFor(h, credential, saved, transport.request);
    sessions.push(reopened);
    await reopened.start(false);
    assert.deepEqual(reopened.getSnapshot().pending, start.command);
    assert.equal(transport.posts.length, 1);
    assert.deepEqual(h.dispatches, ["GET"]);
    await reopened.retry();
    assert.equal(reopened.getSnapshot().pending, null);
    assert.equal(transport.posts.length, 2);
    assert.equal(transport.posts[1]!.body, transport.posts[0]!.body);
    assert.deepEqual(transport.posts[1]!.value, transport.posts[0]!.value);
    assert.deepEqual(h.dispatches, ["GET"]);
    assert.equal(
      storedCommandCount(
        h,
        "agent_process_start_command",
        start.command.commandId,
      ),
      1,
    );
    assert.equal(h.modelCount(), 0);
  } finally {
    sessions.forEach((s) => s.stop());
  }
});

test("actual approval A advances to B; lost A ACK and reopen retry cannot approve B or dispatch A twice", async () => {
  const h = await reopenedFixture();
  const sessions: ClientSession[] = [];
  try {
    const base = h.workflow();
    assert(base.kind === "workflow");
    const read = base.steps.find((step) => step.type === "action")!;
    assert(read.type === "action");
    const artifact = h.activate(
      ProcessDefinitionSchema.parse({
        ...base,
        steps: [
          { ...read, next: "writeA" },
          { ...read, id: "writeA", actionId: h.writeId, next: "writeB" },
          { ...read, id: "writeB", actionId: h.writeId, next: "done" },
          ...base.steps.filter((step) => step.type === "return"),
        ],
      }),
    );
    const credential = await h.pair(),
      saved = storage(),
      transport = trackedTransport(saved);
    const first = sessionFor(h, credential, saved, transport.request);
    sessions.push(first);
    await first.start(false);
    const start = await prepared(h, credential, artifact);
    await first.send(start.command, false, start.target);
    await waitFor(() => !first.getSnapshot().store!.stale);
    const initial = ProcessRuntimeResponseSchema.parse(
      transport.posts[0]!.value,
    );
    assert(initial.process?.approval);
    const parent = initial.process.parentRunId,
      operationA = initial.process.approval.operationId;
    const targetA = captureProcessResolveTarget(
      first.getSnapshot().store!,
      parent,
      operationA,
      start.command.conversationId,
    );
    const commandA = processResolveCommand(
      first.getSnapshot().store!,
      targetA,
      {
        commandId: "TEST-client-A",
        idempotencyKey: "TEST-client-A-key",
        approved: true,
        language: "en",
      },
    );
    transport.loseNext();
    await first.send(commandA, false, targetA);
    assert.deepEqual(first.getSnapshot().pending, commandA);
    const afterA = ProcessRuntimeResponseSchema.parse(
      transport.posts[1]!.value,
    );
    assert(afterA.process?.approval);
    assert.notEqual(afterA.process.approval.operationId, operationA);
    first.stop();
    await h.restart();
    const reopened = sessionFor(h, credential, saved, transport.request);
    sessions.push(reopened);
    await reopened.start(false);
    assert.equal(transport.posts.length, 2);
    const workB = reopened.getSnapshot().store!.workItems[parent]!;
    assert(
      workB.native!.process!.receipts.some(
        (receipt) =>
          receipt.operationId === afterA.process!.approval!.operationId &&
          receipt.status === "awaiting_approval",
      ),
    );
    assert.deepEqual(reopened.getSnapshot().pending, commandA);
    await reopened.retry();
    assert.equal(reopened.getSnapshot().pending, null);
    assert.equal(transport.posts.length, 3);
    assert.equal(transport.posts[2]!.body, transport.posts[1]!.body);
    assert.equal(
      JSON.parse(transport.posts[2]!.body).profile,
      "agent-process-execution/1",
    );
    assert.deepEqual(h.dispatches, ["GET", "POST"]);
    assert.equal(
      storedCommandCount(
        h,
        "agent_process_resolve_command",
        commandA.commandId,
      ),
      1,
    );
    await waitFor(() => !reopened.getSnapshot().store!.stale);
    const targetB = captureProcessResolveTarget(
      reopened.getSnapshot().store!,
      parent,
      afterA.process.approval.operationId,
      start.command.conversationId,
    );
    const denyB = processResolveCommand(
      reopened.getSnapshot().store!,
      targetB,
      {
        commandId: "TEST-client-deny-B",
        idempotencyKey: "TEST-client-deny-B-key",
        approved: false,
        language: "en",
      },
    );
    await reopened.send(denyB, false, targetB);
    assert.equal(reopened.getSnapshot().pending, null);
    assert.deepEqual(h.dispatches, ["GET", "POST"]);
    assert.equal(h.modelCount(), 0);
  } finally {
    sessions.forEach((s) => s.stop());
  }
});

test("actual 422 rejected start receipt settles delivery and explains input failure without native work", async () => {
  const h = await reopenedFixture();
  let session: ClientSession | undefined;
  try {
    const credential = await h.pair(),
      saved = storage(),
      transport = trackedTransport(saved);
    const start = await prepared(h, credential, h.activate(), {});
    session = sessionFor(h, credential, saved, transport.request);
    await session.start(false);
    await session.send(start.command, false, start.target);
    assert.equal(transport.posts[0]!.status, 422);
    assert.equal(
      ProcessRuntimeResponseSchema.parse(transport.posts[0]!.value).admission
        .status,
      "rejected",
    );
    assert.equal(session.getSnapshot().pending, null);
    assert.equal(session.getSnapshot().error, "process_input_invalid");
    assert.equal(
      session.getSnapshot().commandStates[commandTarget(start.command)],
      "rejected",
    );
    await waitFor(() => !session!.getSnapshot().store!.stale);
    assert.equal(
      Object.values(session.getSnapshot().store!.workItems).filter(
        (work) =>
          work.native?.process?.provenance.processId ===
          start.target.entry.processId,
      ).length,
      0,
    );
    assert.deepEqual(h.dispatches, []);
    assert.equal(h.modelCount(), 0);
    assert.equal(transport.posts.length, 1);
  } finally {
    session?.stop();
  }
});

test("actual compiler3 question agent starts with legacy body through Session execution/2", async () => {
  const h = await reopenedFixture();
  let session: ClientSession | undefined;
  let modelCalls = 0;
  try {
    const original = h.identity["catalog"].transport;
    Object.defineProperty(h.identity["catalog"], "transport", {
      value: async (request: Parameters<typeof original>[0]) => {
        if (new URL(request.url).origin !== "https://models.example.test")
          return original(request);
        assert(request.beforeDispatch);
        await request.beforeDispatch(() => {
          modelCalls++;
        });
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            choices: [{ message: askQuestion() }],
            usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00002 },
          }),
        };
      },
    });
    const base = h.workflow(),
      budget = h.identity["catalog"].store.inferenceBudget;
    const policy = budget.policy(h.target.organizationId, h.target.workspaceId);
    budget.savePolicy(
      h.target.organizationId,
      h.target.workspaceId,
      policy.revision,
      {
        ...policy.settings,
        prices: policy.settings.prices.map((price) => ({
          ...price,
          maxInputTokens: 50000,
          maxOutputTokens: 10000,
        })),
      },
    );
    const artifact = h.activate(
      ProcessDefinitionSchema.parse({
        schemaVersion: 1,
        kind: "agent",
        name: "TEST client question agent",
        description: "Offline Session transport fixture",
        trigger: "manual",
        inputSchema: base.inputSchema,
        outputSchema: processObject({ result: { type: "string" } }),
        limits: { ...base.limits, maxModelCalls: 4 },
        modelId: h.modelId,
        instructions: "TEST typed output",
        memory: "none",
        humanInput: "text",
        capabilities: [],
      }),
    );
    const credential = await h.pair("owner"),
      saved = storage(),
      transport = trackedTransport(saved);
    const start = await prepared(h, credential, artifact);
    session = sessionFor(h, credential, saved, transport.request);
    await session.start(false);
    await session.send(start.command, false, start.target);
    const result = ProcessRuntimeResponseSchema.parse(
      transport.posts[0]!.value,
    );
    assert(result.admission.status === "admitted", JSON.stringify(result));
    assert.equal(result.admission.compilerVersion, "niaro-native-workflow/3");
    assert(result.process?.question, JSON.stringify(result));
    assert.equal(modelCalls, 1);
    assert.equal(session.getSnapshot().pending, null);
    await waitFor(() => !session!.getSnapshot().store!.stale);
    assert.equal(
      session.getSnapshot().store!.workItems[result.process.parentRunId]!
        .status,
      "waiting_input",
    );
    assert.equal(
      JSON.parse(transport.posts[0]!.body).profile,
      "agent-process-start/1",
    );
    assert.deepEqual(h.dispatches, []);
  } finally {
    session?.stop();
  }
});

test("actual pre-admission interruption preserves the original start until its own delivery settles", async () => {
  const h = await reopenedFixture();
  let session: ClientSession | undefined;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  try {
    const credential = await h.pair(),
      saved = storage(),
      transport = trackedTransport(saved);
    const start = await prepared(h, credential, h.activate());
    const request: typeof fetch = async (url, init) => {
      if (
        init?.method === "POST" &&
        new URL(String(url)).pathname.endsWith("/processes/commands")
      ) {
        reached();
        await gate;
      }
      return transport.request(url, init);
    };
    session = sessionFor(h, credential, saved, request);
    await session.start(false);
    const delivery = session.send(start.command, false, start.target);
    await entered;
    assert.equal(await session.interruptPending(), false);
    assert.deepEqual(session.getSnapshot().pending, start.command);
    assert.equal(session.getSnapshot().error, "requestInterruptFailed");
    assert.equal(
      storedCommandCount(
        h,
        "agent_process_start_command",
        start.command.commandId,
      ),
      0,
    );
    assert.deepEqual(h.dispatches, []);
    release();
    await delivery;
    assert.equal(session.getSnapshot().pending, null);
    assert.equal(session.getSnapshot().error, null);
    assert.equal(
      storedCommandCount(
        h,
        "agent_process_start_command",
        start.command.commandId,
      ),
      1,
    );
    assert.deepEqual(h.dispatches, ["GET"]);
    assert.equal(transport.posts.length, 1);
  } finally {
    release();
    session?.stop();
  }
});

test("actual Session inventory and form readers preserve authenticated original selection without dispatch", async () => {
  const h = await reopenedFixture();
  let session: ClientSession | undefined;
  try {
    const credential = await h.pair(),
      saved = storage(),
      artifact = h.activate();
    const reads: { path: string; method: string; body: string | null }[] = [];
    const request: typeof fetch = async (url, init) => {
      const path = new URL(String(url));
      if (path.pathname.includes("/processes"))
        reads.push({
          path: path.pathname + path.search,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
      return fetch(url, init);
    };
    session = sessionFor(h, credential, saved, request);
    await session.start(false);
    const inventory = await session.loadProcessInventory();
    assert.equal(inventory.refreshed, false);
    assert.deepEqual(inventory.scope, credential.scope);
    assert(Object.isFrozen(inventory) && Object.isFrozen(inventory.processes));
    const entry = inventory.processes.find(
      (value) => value.processId === artifact.processId,
    );
    assert(entry?.availability === "ready");
    const inputRequest = {
      processId: artifact.processId,
      version: artifact.version,
      artifactDigest: artifact.digest,
      language: "cs" as const,
      origin: {
        type: "command" as const,
        conversationId: "conversation-1",
        requestId: randomUUID(),
      },
    };
    const target = await session.prepareProcessInput(inputRequest, entry);
    const replay = await session.prepareProcessInput(inputRequest, entry);
    assert.deepEqual(replay, target);
    assert.equal(target.card.form.language, "cs");
    assert.deepEqual(target.card.form.origin, inputRequest.origin);
    assert(
      Object.isFrozen(target) && Object.isFrozen(target.card.form.inputSchema),
    );
    assert.equal(session.getSnapshot().pending, null);
    assert.deepEqual(h.dispatches, []);
    assert(
      reads.some(
        (value) =>
          value.method === "GET" &&
          value.path.endsWith("processes?profile=agent-process-execution%2F1"),
      ),
    );
    const forms = reads.filter((value) => value.method === "POST");
    assert.equal(forms.length, 2);
    assert.equal(forms[0]!.path, forms[1]!.path);
    assert.equal(forms[0]!.body, forms[1]!.body);
    assert(
      forms.every((value) =>
        value.path.endsWith(
          "processes/input?profile=agent-process-execution%2F1",
        ),
      ),
    );
    assert(!reads.some((value) => value.path.includes("/commands")));
  } finally {
    session?.stop();
  }
});
