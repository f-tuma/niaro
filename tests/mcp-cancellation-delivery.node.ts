import assert from "node:assert/strict";
import { test } from "node:test";
import { McpTasks } from "../apps/server-mcp/tasks";
import { McpAdmissionStore } from "../apps/server-mcp/admission";
import type { MobileRuntime } from "../apps/server-identity/mobile";
import type { ModelService } from "../apps/fixture-server/model-service";
import { LibSQLStore } from "@mastra/libsql";
import { DurableStepIds } from "@mastra/core/agent/durable";
import { nativeCatalogOwner } from "../apps/server-identity/mastra-runtime";
import { IdentityError } from "../apps/server-identity/error";
import { DomainCommandSchema } from "../apps/server-identity/mastra-domain";
import {
  createTrustHarness,
  toolResults,
  type TrustHarness,
} from "../tests/agent-trust/harness";

const actorFor = (h: TrustHarness) => ({
  grantId: "TEST-mcp-grant",
  memberId: "TEST-mcp-member",
  organizationId: "TEST-mcp-org",
  role: "owner" as const,
  scopes: ["native.view", "native.run"] as ("native.view" | "native.run")[],
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  userId: h.scope.userId,
  workspaceId: h.scope.workspaceId,
  serverId: h.scope.serverId,
});
const accessFor = (h: TrustHarness) =>
  ({
    run: <T>(fn: () => T) => h.context.serial(async () => fn()),
    integrations: h.runtime(),
    tools: {
      has: () => false,
      invoke: async () => {
        throw Error("Unexpected legacy tool");
      },
    },
  }) as unknown as MobileRuntime;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("passive unconfirmed native completion explains uncertainty and delivery failure instead of echoing the task", async () => {
  const h = createTrustHarness();
  let runner: McpTasks | undefined;
  try {
    h.onChat(() => ({ content: "TEST private completed answer" }));
    const store = new McpAdmissionStore(h.db);
    const actor = actorFor(h);
    runner = new McpTasks(
      {
        store,
        run: <T>(fn: () => T) => h.context.serial(async () => fn()),
        access: async () => accessFor(h),
      },
      h.workflow,
      h.model,
      () => "/approval",
    );
    const admission = await h.context.serial(async () =>
      store.submit(actor, {
        requestId: "TEST-unconfirmed-read",
        text: "TEST unique task goal",
        language: "en",
      }),
    );
    runner["launch"](admission);
    await runner["active"].get(admission.id)?.promise;
    const owner = await nativeCatalogOwner(h.controller);
    owner.proveRetired = async () => false;
    const calls = h.requests.length,
      dispatches = h.serviceRequests.length;
    const unconfirmed = await runner.get(actor, {
      taskId: admission.id,
      waitMs: 0,
    });
    assert.equal(unconfirmed.status, "waiting_system");
    assert.match(String(unconfirmed.reply), /completion is not confirmed/);
    assert(
      !JSON.stringify(unconfirmed).includes("TEST private completed answer"),
    );
    await h.context.serial(async () =>
      store.save({
        ...store.read(actor, admission.id),
        errorCode: "mcp_execution_unconfirmed",
      }),
    );
    const failed = await runner.get(actor, { taskId: admission.id, waitMs: 0 });
    assert.match(
      String(failed.reply),
      /could not finish with a confirmed result/,
    );
    assert.equal(
      (failed.error as { code: string }).code,
      "mcp_execution_unconfirmed",
    );
    assert.equal(h.requests.length, calls);
    assert.equal(h.serviceRequests.length, dispatches);
  } finally {
    await runner?.close();
    await h.close();
  }
});

test("revocation before delivery acknowledgement cannot pre-settle cancellation of a later question", async () => {
  const h = createTrustHarness();
  const delivery = deferred(),
    nativeDone = deferred();
  let runner: McpTasks | undefined;
  let revoked = "",
    executions = 0;
  try {
    h.onChat(() => h.call("ask_user", { question: "TEST what next?" }));
    const store = new McpAdmissionStore(h.db);
    const actor = actorFor(h);
    runner = new McpTasks(
      {
        store,
        run: <T>(fn: () => T) => h.context.serial(async () => fn()),
        access: async (grantId) => ({
          ...accessFor(h),
          run: <T>(fn: () => T) =>
            h.context.serial(async () => {
              if (grantId === revoked)
                throw new IdentityError(401, "mcp_unauthorized");
              return fn();
            }),
        }),
      },
      h.workflow,
      {
        execute: async (...args: Parameters<ModelService["execute"]>) => {
          const result = await h.model.execute(...args);
          if (++executions === 1) revoked = actor.grantId;
          else {
            nativeDone.resolve();
            await delivery.promise;
          }
          return result;
        },
        interrupt: (...args: Parameters<ModelService["interrupt"]>) =>
          h.model.interrupt(...args),
      } as unknown as ModelService,
      () => "/approval",
    );
    const admission = await h.context.serial(async () =>
      store.submit(actor, {
        requestId: "TEST-revoked-submit",
        text: "TEST ask",
        language: "en",
      }),
    );
    runner["launch"](admission);
    await runner["active"].get(admission.id)?.promise;
    const failed = store.read(actor, admission.id);
    assert.equal(failed.phase, "settled");
    assert.equal(failed.cancelRequested, false);
    assert.notEqual(failed.cancellationSettled, true);
    const current = await h.runtime().readTask!(admission.rootCommandId);
    assert(current?.native?.question);
    const fresh = { ...actor, grantId: "TEST-fresh-grant" };
    await runner.respond(fresh, {
      taskId: admission.id,
      requestId: "TEST-fresh-response",
      inputId: current.native.question.id,
      expectedRevision: current.native.question.revision,
      text: "Tomorrow.",
    });
    await nativeDone.promise;
    await runner.cancel(fresh, {
      taskId: admission.id,
      requestId: "TEST-fresh-cancel",
    });
    delivery.resolve();
    await runner["active"].get(admission.id)?.promise;
    await runner["deliver"]();
    await runner["active"].get(admission.id)?.promise;
    const closed = DomainCommandSchema.parse(
      h.catalog.turn(admission.workItemId, h.scope.workspaceId, h.scope.userId),
    );
    assert.equal(closed.pending, undefined);
    assert(closed.taskCancellation);
    assert.equal(store.read(fresh, admission.id).cancellationSettled, true);
    assert.equal(
      (await runner.get(fresh, { taskId: admission.id, waitMs: 0 })).status,
      "cancelled",
    );
  } finally {
    delivery.resolve();
    await runner?.close();
    await h.close();
  }
});

test(
  "a late failure of the old grant cannot block cancellation admitted with a fresh valid grant",
  { timeout: 15_000 },
  async () => {
    const h = createTrustHarness();
    const delivery = deferred(),
      nativeDone = deferred();
    let runner: McpTasks | undefined;
    let revoked = "";
    try {
      h.onChat(() => h.call("ask_user", { question: "TEST which day?" }));
      const store = new McpAdmissionStore(h.db);
      const actor = actorFor(h);
      runner = new McpTasks(
        {
          store,
          run: <T>(fn: () => T) => h.context.serial(async () => fn()),
          access: async (grantId) => ({
            ...accessFor(h),
            run: <T>(fn: () => T) =>
              h.context.serial(async () => {
                if (grantId === revoked)
                  throw new IdentityError(401, "mcp_unauthorized");
                return fn();
              }),
          }),
        },
        h.workflow,
        {
          execute: async (...args: Parameters<ModelService["execute"]>) => {
            const result = await h.model.execute(...args);
            nativeDone.resolve();
            await delivery.promise;
            return result;
          },
          interrupt: (...args: Parameters<ModelService["interrupt"]>) =>
            h.model.interrupt(...args),
        } as unknown as ModelService,
        () => "/approval",
      );
      const admission = await h.context.serial(async () =>
        store.submit(actor, {
          requestId: "TEST-rebind-submit",
          text: "TEST ask a question",
          language: "en",
        }),
      );
      runner["launch"](admission);
      await nativeDone.promise;
      const calls = h.requests.length,
        dispatches = h.serviceRequests.length;
      revoked = actor.grantId;
      const fresh = { ...actor, grantId: "TEST-rebind-fresh-grant" };
      await runner.cancel(fresh, {
        taskId: admission.id,
        requestId: "TEST-rebind-fresh-cancel",
      });
      // The old delivery still owns its captured credential. Its late 401
      // cannot revoke the newer cancellation admission's valid credential.
      delivery.resolve();
      await runner["active"].get(admission.id)?.promise;
      const rebound = store.read(fresh, admission.id);
      assert.equal(rebound.grantId, fresh.grantId);
      assert.notEqual(rebound.cancellationBlocked, true);
      await runner["deliver"]();
      await runner["active"].get(admission.id)?.promise;
      const closed = DomainCommandSchema.parse(
        h.catalog.turn(
          admission.workItemId,
          h.scope.workspaceId,
          h.scope.userId,
        ),
      );
      assert.equal(closed.pending, undefined);
      assert(closed.taskCancellation);
      assert.equal(store.read(fresh, admission.id).cancellationSettled, true);
      assert(!store.pending().some((task) => task.id === admission.id));
      assert.equal(
        (await runner.get(fresh, { taskId: admission.id, waitMs: 0 })).status,
        "cancelled",
      );
      assert.equal(h.requests.length, calls);
      assert.equal(h.serviceRequests.length, dispatches);
    } finally {
      delivery.resolve();
      await runner?.close();
      await h.close();
    }
  },
);

test("revoked cancellation delivery stops without claiming closure and a fresh explicit grant can close it", async () => {
  const h = createTrustHarness();
  let runner: McpTasks | undefined,
    revoked = "";
  try {
    h.onChat(() => h.call("ask_user", { question: "TEST retained question?" }));
    const store = new McpAdmissionStore(h.db);
    const actor = actorFor(h);
    runner = new McpTasks(
      {
        store,
        run: <T>(fn: () => T) => h.context.serial(async () => fn()),
        access: async (grantId) => {
          if (grantId === revoked)
            throw new IdentityError(401, "mcp_unauthorized");
          return accessFor(h);
        },
      },
      h.workflow,
      h.model,
      () => "/approval",
    );
    const admission = await h.context.serial(async () =>
      store.submit(actor, {
        requestId: "TEST-cancel-authority-submit",
        text: "TEST ask",
        language: "en",
      }),
    );
    runner["launch"](admission);
    await runner["active"].get(admission.id)?.promise;
    const calls = h.requests.length;
    await h.context.serial(async () =>
      store.cancel(actor, {
        taskId: admission.id,
        requestId: "TEST-old-authority-cancel",
      }),
    );
    revoked = actor.grantId;
    await runner["deliver"]();
    await runner["active"].get(admission.id)?.promise;
    const blocked = store.read(actor, admission.id);
    assert.equal(blocked.cancellationBlocked, true);
    assert.notEqual(blocked.cancellationSettled, true);
    assert(h.commandState(admission.rootCommandId).pending);
    assert.equal(store.pending().length, 0);
    const fresh = { ...actor, grantId: "TEST-fresh-cancel-authority" };
    const view = await runner.get(fresh, { taskId: admission.id, waitMs: 0 });
    assert.equal(view.status, "waiting_system");
    assert.equal((view.error as { code: string }).code, "mcp_unauthorized");
    assert.match(String(view.reply), /authorization is no longer valid/);
    await runner.cancel(fresh, {
      taskId: admission.id,
      requestId: "TEST-new-authority-cancel",
    });
    await runner["active"].get(admission.id)?.promise;
    assert.equal(h.commandState(admission.rootCommandId).pending, undefined);
    assert.equal(store.read(fresh, admission.id).cancellationSettled, true);
    assert.equal(store.read(fresh, admission.id).cancellationBlocked, false);
    assert.equal(h.requests.length, calls);
  } finally {
    await runner?.close();
    await h.close();
  }
});

test("retired native owner with a retained approval closes after cancellation recovery without dispatch", async () => {
  const h = createTrustHarness();
  let runner: McpTasks | undefined;
  let native: LibSQLStore | undefined;
  let store = new McpAdmissionStore(h.db);
  const open = () =>
    new McpTasks(
      {
        store,
        run: <T>(fn: () => T) => h.context.serial(async () => fn()),
        access: async () => accessFor(h),
      },
      h.workflow,
      h.model,
      () => "/approval",
    );
  try {
    h.onChat(h.writeScript);
    runner = open();
    const actor = actorFor(h);
    const admission = await h.context.serial(async () =>
      store.submit(actor, {
        requestId: "TEST-retired-approval-submit",
        text: "Create a meeting with Jane Test.",
        language: "en",
      }),
    );
    runner["launch"](admission);
    await runner["active"].get(admission.id)?.promise;
    const state = h.commandState(admission.rootCommandId);
    assert(state.pending?.operationId);
    const operationId = state.pending.operationId;
    assert.equal(
      (await h.runtime().readTask!(admission.rootCommandId))?.status,
      "waiting_approval",
    );
    const calls = h.requests.length,
      dispatches = h.serviceRequests.length;
    await runner.close();
    // Reproduce native checkpoint retirement before the pending domain journal
    // has closed. The bound retirement marker remains; only this fixture's exact
    // loop/execution rows are removed, so real passive native proof is required.
    native = new LibSQLStore({
      id: "TEST-retired-approval",
      url: h.catalog.nativeStorageUrl,
    });
    await native.init();
    const workflows = await native.getStore("workflows");
    assert(workflows);
    for (const workflowName of [
      DurableStepIds.AGENTIC_LOOP,
      DurableStepIds.AGENTIC_EXECUTION,
    ]) {
      await workflows.deleteWorkflowRunById({
        workflowName,
        runId: state.runId,
      });
    }
    const before = await h.runtime().readTask!(admission.rootCommandId);
    assert.equal(before?.status, "waiting_system");
    assert.equal(before?.cancellationPending, true);
    const owner = await nativeCatalogOwner(h.controller);
    assert.equal(owner.isSettled(state.runId), true);
    await h.context.serial(async () =>
      store.cancel(actor, {
        taskId: admission.id,
        requestId: "TEST-retired-approval-cancel",
      }),
    );
    await native.close();
    native = undefined;
    await h.restart();
    store = new McpAdmissionStore(h.db);
    runner = open();
    await runner["deliver"]();
    await runner["active"].get(admission.id)?.promise;
    assert.equal(h.commandState(admission.rootCommandId).pending, undefined);
    assert.equal(
      h.commandState(admission.rootCommandId).taskCancellation?.proofType,
      "retired",
    );
    assert.equal(
      h.catalog.invocation(operationId, h.scope.workspaceId, h.scope.userId)
        ?.status,
      "rejected",
    );
    assert.equal(store.read(actor, admission.id).cancellationSettled, true);
    assert.equal(
      (await runner.get(actor, { taskId: admission.id, waitMs: 0 })).status,
      "cancelled",
    );
    assert.equal(h.requests.length, calls);
    assert.equal(h.serviceRequests.length, dispatches);
  } finally {
    await native?.close();
    await runner?.close();
    await h.close();
  }
});

// Holds only the delivery acknowledgement after real native execution and the
// real ModelService command receipt have completed. This is the same boundary
// as a delayed identity queue between execute() and its phase-settled save.
test(
  "cancellation during delivery acknowledgement closes the already settled native question",
  { timeout: 15_000 },
  async () => {
    const h = createTrustHarness();
    const delivery = deferred(),
      nativeDone = deferred();
    let runner: McpTasks | undefined;
    try {
      h.onChat(() => h.call("ask_user", { question: "TEST which day?" }));
      const store = new McpAdmissionStore(h.db);
      const models = {
        execute: async (...args: Parameters<ModelService["execute"]>) => {
          const result = await h.model.execute(...args);
          nativeDone.resolve();
          await delivery.promise;
          return result;
        },
        interrupt: (...args: Parameters<ModelService["interrupt"]>) =>
          h.model.interrupt(...args),
      } as unknown as ModelService;
      runner = new McpTasks(
        {
          store,
          run: <T>(fn: () => T) => h.context.serial(async () => fn()),
          access: async () => accessFor(h),
        },
        h.workflow,
        models,
        () => "/approval",
      );
      const actor = actorFor(h);
      const admission = await h.context.serial(async () =>
        store.submit(actor, {
          requestId: "TEST-delivery-submit",
          text: "TEST ask a question",
          language: "en",
        }),
      );
      runner["launch"](admission);
      await nativeDone.promise;
      assert.equal(
        (await h.runtime().readTask!(admission.rootCommandId))?.status,
        "waiting_input",
      );
      await runner.cancel(actor, {
        taskId: admission.id,
        requestId: "TEST-delivery-cancel",
      });
      delivery.resolve();
      await runner["active"].get(admission.id)?.promise;
      await runner["deliver"]();
      await runner["active"].get(admission.id)?.promise;
      const state = h.commandState(admission.rootCommandId);
      assert.equal(
        state.pending,
        undefined,
        "native resume authority must be closed after delivery finishes",
      );
      assert(state.taskCancellation);
      assert.equal(
        (await runner.get(actor, { taskId: admission.id, waitMs: 0 })).status,
        "cancelled",
      );
    } finally {
      delivery.resolve();
      await runner?.close();
      await h.close();
    }
  },
);

test(
  "restart delivers cancellation admitted before native suspension closure without a client retry",
  { timeout: 15_000 },
  async () => {
    const h = createTrustHarness();
    let store = new McpAdmissionStore(h.db);
    let runner: McpTasks | undefined;
    const open = () =>
      new McpTasks(
        {
          store,
          run: <T>(fn: () => T) => h.context.serial(async () => fn()),
          access: async () => accessFor(h),
        },
        h.workflow,
        h.model,
        () => "/approval",
      );
    try {
      h.onChat(() =>
        h.call("ask_user", { question: "TEST persisted question?" }),
      );
      runner = open();
      const actor = actorFor(h);
      const admission = await h.context.serial(async () =>
        store.submit(actor, {
          requestId: "TEST-restart-submit",
          text: "TEST ask a question",
          language: "en",
        }),
      );
      runner["launch"](admission);
      await runner["active"].get(admission.id)?.promise;
      assert.equal(store.read(actor, admission.id).phase, "settled");
      assert.equal(
        (await h.runtime().readTask!(admission.rootCommandId))?.status,
        "waiting_input",
      );
      const calls = h.requests.length;
      // Durable admission succeeded. Crash before McpTasks invokes cancelTask.
      await h.context.serial(async () =>
        store.cancel(actor, {
          taskId: admission.id,
          requestId: "TEST-restart-cancel",
        }),
      );
      await runner.close();
      await h.restart();
      store = new McpAdmissionStore(h.db);
      runner = open();
      await runner["deliver"]();
      await runner["active"].get(admission.id)?.promise;
      const state = h.commandState(admission.rootCommandId);
      assert.equal(
        state.pending,
        undefined,
        "startup must close the admitted cancellation even with phase settled",
      );
      assert(state.taskCancellation);
      assert.equal(
        h.requests.length,
        calls,
        "cancellation recovery must not run inference",
      );
      assert.equal(
        (await runner.get(actor, { taskId: admission.id, waitMs: 0 })).status,
        "cancelled",
      );
    } finally {
      await runner?.close();
      await h.close();
    }
  },
);

test(
  "restart recognizes canonical cancelled unknown outcome after its acknowledgement was lost",
  { timeout: 15_000 },
  async () => {
    const h = createTrustHarness({ writeApproval: "never" });
    let store = new McpAdmissionStore(h.db);
    let runner: McpTasks | undefined;
    const open = () =>
      new McpTasks(
        {
          store,
          run: <T>(fn: () => T) => h.context.serial(async () => fn()),
          access: async () => accessFor(h),
        },
        h.workflow,
        h.model,
        () => "/approval",
      );
    try {
      h.writeResponse = "lost";
      h.onChat((body) =>
        toolResults(body).some(
          (result) =>
            result.currentTurn &&
            (result.data?.created || result.status === "unknown"),
        )
          ? h.call("ask_user", { question: "TEST what should happen next?" })
          : h.writeScript(body),
      );
      runner = open();
      const actor = actorFor(h);
      const admission = await h.context.serial(async () =>
        store.submit(actor, {
          requestId: "TEST-unknown-submit",
          text: "Create a meeting and ask what to do next.",
          language: "en",
        }),
      );
      runner["launch"](admission);
      await runner["active"].get(admission.id)?.promise;
      const work = await h.runtime().readTask!(admission.rootCommandId);
      assert.equal(work?.status, "waiting_input");
      await h.context.serial(async () =>
        store.cancel(actor, {
          taskId: admission.id,
          requestId: "TEST-unknown-cancel",
        }),
      );
      await h.runtime().cancelTask!({
        workItemId: admission.workItemId,
        expectedWorkRevision: work!.native!.revision,
        conversationId: admission.conversationId,
      });
      assert(h.commandState(admission.rootCommandId).taskCancellation);
      const calls = h.requests.length,
        dispatches = h.serviceRequests.length;
      // Crash after the canonical closure committed, before delivery marks it settled.
      await runner.close();
      await h.restart();
      store = new McpAdmissionStore(h.db);
      runner = open();
      await runner["deliver"]();
      await runner["active"].get(admission.id)?.promise;
      assert.equal(
        store.read(actor, admission.id).cancellationSettled,
        true,
        "canonical cancellation with an unknown historical effect must leave the delivery queue",
      );
      assert(!store.pending().some((task) => task.id === admission.id));
      const view = await runner.get(actor, { taskId: admission.id, waitMs: 0 });
      assert.equal(
        view.status,
        "unknown",
        "keep the unconfirmed effect visible",
      );
      assert.equal(h.requests.length, calls);
      assert.equal(h.serviceRequests.length, dispatches);
    } finally {
      await runner?.close();
      await h.close();
    }
  },
);
