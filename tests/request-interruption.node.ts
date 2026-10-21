import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelService } from "../apps/fixture-server/model-service";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { createFixtureServer } from "../apps/fixture-server/http";
import { issuePairingCode } from "../apps/fixture-server/auth";
import { IdentityError } from "../apps/server-identity/error";
import { nativeCatalogOwner } from "../apps/server-identity/mastra-runtime";
import {
  AUTH_PROFILE,
  PROFILE,
  CommandSchema,
  CredentialSchema,
} from "../packages/protocol";
import { messageCommand } from "../packages/client-core/commands";
import { translate } from "../packages/i18n";
import {
  REQUEST_INTERRUPTION_PROFILE,
  RequestInterruptionResponseSchema,
} from "../packages/protocol/request-interruption";
import { cardDeliveryPath } from "../packages/protocol/card-delivery";
import { replyCorrelationPath } from "../packages/protocol/reply-correlation";
import { scopeFor } from "../packages/test-fixtures";
import {
  createTrustHarness,
  toolResults,
  type ModelRequest,
} from "./agent-trust/harness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const run = <T>(fn: () => T) => Promise.resolve().then(fn);
const command = (id: string, text = "TEST inspect contacts") =>
  messageCommand(text, "en", id);

function holdModel(
  h: ReturnType<typeof createTrustHarness>,
  matches: (body: ModelRequest) => boolean = () => true,
) {
  const started = deferred<void>();
  const transport = h.controller.transport;
  let held = false;
  Object.defineProperty(h.controller, "transport", {
    value: async (request: Parameters<typeof transport>[0]) => {
      if (
        !held &&
        request.url.endsWith("/chat/completions") &&
        matches(request.body as ModelRequest)
      ) {
        held = true;
        await request.beforeDispatch?.(() => {});
        started.resolve();
        await new Promise<never>((_, reject) => {
          const abort = () => reject(request.signal!.reason);
          if (request.signal!.aborted) abort();
          else request.signal!.addEventListener("abort", abort, { once: true });
        });
      }
      return transport(request);
    },
    configurable: true,
  });
  return started.promise;
}

test("registration, exact duplicate binding and interruption settle one durable command", async () => {
  const root = mkdtempSync(join(tmpdir(), "request-interruption-"));
  const scope = { ...scopeFor("a"), userId: "alice" };
  const storage = new FixtureStorage(root, scope.serverId);
  const started = deferred<void>(),
    released = deferred<void>();
  let calls = 0;
  const model = new ModelService(storage, {
    timeZone: "UTC",
    decide: async () => {
      calls++;
      started.resolve();
      await released.promise;
      return {
        kind: "reply",
        contactId: null,
        title: null,
        localStart: null,
        durationMinutes: null,
        reply: "TEST normal answer",
      };
    },
  });
  try {
    const original = command("TEST-one");
    const delivery = model.execute(
      scope,
      original,
      () => {},
      new AbortController().signal,
    );
    const duplicate = model.execute(
      scope,
      original,
      () => {},
      new AbortController().signal,
    );
    await started.promise;
    await assert.rejects(
      model.execute(
        scope,
        { ...original, text: "TEST changed" },
        () => {},
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "idempotency_conflict",
    );
    await assert.rejects(
      model.interrupt(scope, { ...original, text: "TEST changed" }, run),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "idempotency_conflict",
    );
    const other = { ...scope, userId: "bob" };
    assert.equal(
      (await model.interrupt(other, original, run)).status,
      "unknown",
    );
    let acknowledged = false;
    const cancellation = model.interrupt(scope, original, run).then((value) => {
      acknowledged = true;
      return value;
    });
    await delay(10);
    assert.equal(
      acknowledged,
      false,
      "Abort alone must not acknowledge a live transport",
    );
    released.resolve();
    const result = await delivery;
    assert.deepEqual(await duplicate, result);
    const acknowledgement = await cancellation;
    assert.equal(acknowledgement.status, "settled");
    if (acknowledgement.status === "settled")
      assert.deepEqual(acknowledgement.result, result);
    assert.equal(calls, 1);
    assert.equal(
      result.snapshot.conversations[0]!.messages.filter(
        (message) => message.role === "user",
      ).length,
      1,
    );
    assert(
      result.snapshot.conversations[0]!.messages.at(-1)!.text.includes(
        translate(original.language)("requestInterrupted"),
      ),
    );
    assert.equal(
      (await model.interrupt(scope, original, run)).status,
      "settled",
    );
    await model.execute(
      scope,
      original,
      () => {},
      new AbortController().signal,
    );
    assert.equal(calls, 1);
    assert.equal(
      (await model.interrupt(scope, command("TEST-unseen"), run)).status,
      "unknown",
    );
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live idempotency key blocks nonmodel collisions before they can write a receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "request-idempotency-collision-"));
  const scope = scopeFor();
  const storage = new FixtureStorage(root, scope.serverId);
  const started = deferred<void>(),
    released = deferred<void>();
  let calls = 0;
  const model = new ModelService(storage, {
    timeZone: "UTC",
    decide: async () => {
      calls++;
      started.resolve();
      await released.promise;
      return {
        kind: "reply",
        contactId: null,
        title: null,
        localStart: null,
        durationMinutes: null,
        reply: "TEST original",
      };
    },
  });
  try {
    const original = command("TEST-live-idempotency");
    const delivery = model.execute(
      scope,
      original,
      () => {},
      new AbortController().signal,
    );
    await started.promise;
    const collision = CommandSchema.parse({
      type: "input.submit",
      commandId: "TEST-nonmodel-collision",
      idempotencyKey: original.idempotencyKey,
      conversationId: "conversation-1",
      workItemId: "missing-work",
      inputRequestId: "missing-input",
      expectedInputRevision: 1,
      answer: { selectedContactId: "missing" },
    });
    await assert.rejects(
      model.execute(scope, collision, () => {}, new AbortController().signal),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "idempotency_conflict",
    );
    assert.equal(
      storage.replay(scope, collision),
      undefined,
      "A rejected live-key collision must not create a workflow receipt",
    );
    await assert.rejects(
      model.interrupt(scope, collision, run),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "idempotency_conflict",
    );
    let acknowledged = false;
    const interrupted = model.interrupt(scope, original, run).then((ack) => {
      acknowledged = true;
      return ack;
    });
    await delay(10);
    assert.equal(acknowledged, false);
    released.resolve();
    const result = await delivery;
    const ack = await interrupted;
    assert.equal(result.status, "accepted");
    assert.equal(ack.status, "settled");
    if (ack.status === "settled") assert.deepEqual(ack.result, result);
    assert.equal(calls, 1);
    assert.equal(
      result.snapshot.conversations[0]!.messages.filter(
        (message) => message.role === "user",
      ).length,
      1,
    );
  } finally {
    released.resolve();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("nonmodel commands reserve idempotency before their first authorization await", async () => {
  const root = mkdtempSync(join(tmpdir(), "request-nonmodel-reservation-"));
  const scope = scopeFor();
  const storage = new FixtureStorage(root, scope.serverId);
  const validation = deferred<void>();
  let inference = 0;
  const model = new ModelService(storage, {
    timeZone: "UTC",
    decide: async () => {
      inference++;
      throw Error("No inference is authorized");
    },
  });
  try {
    const original = CommandSchema.parse({
      type: "input.submit",
      commandId: "TEST-nonmodel-original",
      idempotencyKey: "TEST-shared-key",
      conversationId: "conversation-1",
      workItemId: "missing-work",
      inputRequestId: "missing-input",
      expectedInputRevision: 1,
      answer: { selectedContactId: "missing" },
    });
    const delivery = model.execute(
      scope,
      original,
      () => validation.promise,
      new AbortController().signal,
    );
    const collision = CommandSchema.parse({
      ...command("TEST-model-collision"),
      idempotencyKey: original.idempotencyKey,
    });
    await assert.rejects(
      model.execute(scope, collision, () => {}, new AbortController().signal),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "idempotency_conflict",
    );
    assert.equal(storage.replay(scope, collision), undefined);
    assert.equal(inference, 0);
    validation.resolve();
    assert.equal((await delivery).code, "unknown_context");
  } finally {
    validation.resolve();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a conflicting stored replay never proves settlement of a live command", async () => {
  const root = mkdtempSync(join(tmpdir(), "request-conflicting-replay-"));
  const scope = scopeFor();
  const storage = new FixtureStorage(root, scope.serverId);
  const started = deferred<void>(),
    released = deferred<void>();
  const model = new ModelService(storage, {
    timeZone: "UTC",
    decide: async () => {
      started.resolve();
      await released.promise;
      return {
        kind: "reply",
        contactId: null,
        title: null,
        localStart: null,
        durationMinutes: null,
        reply: "TEST original",
      };
    },
  });
  try {
    const original = command("TEST-live-replay");
    const delivery = model.execute(
      scope,
      original,
      () => {},
      new AbortController().signal,
    );
    await started.promise;
    // Simulate a conflicting durable receipt left by an earlier server version.
    storage.execute(
      scope,
      CommandSchema.parse({
        type: "input.submit",
        commandId: "TEST-stored-collision",
        idempotencyKey: original.idempotencyKey,
        conversationId: "conversation-1",
        workItemId: "missing-work",
        inputRequestId: "missing-input",
        expectedInputRevision: 1,
        answer: { selectedContactId: "missing" },
      }),
    );
    let completed = false;
    const interrupted = model.interrupt(scope, original, run);
    void interrupted.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    await delay(10);
    assert.equal(
      completed,
      false,
      "A colliding receipt cannot acknowledge an unretired original",
    );
    released.resolve();
    await delivery;
    await assert.rejects(
      interrupted,
      (error: unknown) =>
        error instanceof IdentityError && error.code === "idempotency_conflict",
    );
    await assert.rejects(
      model.interrupt(scope, original, run),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "idempotency_conflict",
    );
  } finally {
    released.resolve();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interruption during the initial replay await cannot miss a registered command", async () => {
  const root = mkdtempSync(join(tmpdir(), "request-initial-await-"));
  const scope = { ...scopeFor("a"), userId: "alice" };
  const storage = new FixtureStorage(root, scope.serverId);
  const validation = deferred<void>();
  let inference = 0;
  const model = new ModelService(storage, {
    timeZone: "UTC",
    decide: async () => {
      inference++;
      throw Error("Inference must not start");
    },
  });
  try {
    const original = command("TEST-initial");
    const delivery = model.execute(
      scope,
      original,
      () => validation.promise,
      new AbortController().signal,
    );
    const interrupted = model.interrupt(scope, original, run);
    validation.resolve();
    assert.equal((await interrupted).status, "settled");
    assert.equal((await delivery).status, "accepted");
    assert.equal(inference, 0);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal completion wins a late interruption without an extra cancellation message", async () => {
  const root = mkdtempSync(join(tmpdir(), "request-completed-"));
  const scope = scopeFor();
  const storage = new FixtureStorage(root, scope.serverId);
  const model = new ModelService(storage, {
    timeZone: "UTC",
    decide: async () => ({
      kind: "reply",
      contactId: null,
      title: null,
      localStart: null,
      durationMinutes: null,
      reply: "TEST completed answer",
    }),
  });
  try {
    const original = command("TEST-completed");
    const completed = await model.execute(
      scope,
      original,
      () => {},
      new AbortController().signal,
    );
    const ack = await model.interrupt(scope, original, run);
    assert.equal(ack.status, "settled");
    if (ack.status === "settled") assert.deepEqual(ack.result, completed);
    assert.equal(completed.snapshot.conversations[0]!.messages.length, 2);
    assert.equal(
      completed.snapshot.conversations[0]!.messages.at(-1)!.text,
      "TEST completed answer",
    );
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling a queued answer cannot manufacture acceptance or mutate the pending question", async () => {
  const root = mkdtempSync(join(tmpdir(), "request-no-mutation-"));
  const scope = scopeFor();
  const storage = new FixtureStorage(root, scope.serverId);
  const validation = deferred<void>();
  const model = new ModelService(storage, undefined);
  try {
    const prepared = storage.execute(
      scope,
      command(
        "TEST-prepare-question",
        "schedule a meeting with Peter next week",
      ),
    );
    const input = prepared.snapshot.inputRequests[0]!;
    const original = CommandSchema.parse({
      type: "input.submit",
      commandId: "TEST-interrupted-answer",
      idempotencyKey: "TEST-interrupted-answer",
      conversationId: input.conversationId,
      workItemId: input.workItemId,
      inputRequestId: input.id,
      expectedInputRevision: input.revision,
      answer: { selectedContactId: input.options[0]!.id },
    });
    const delivery = model.execute(
      scope,
      original,
      () => validation.promise,
      new AbortController().signal,
    );
    void delivery.catch(() => {});
    const interrupted = model.interrupt(scope, original, run);
    validation.resolve();
    assert.equal((await interrupted).status, "unknown");
    await assert.rejects(delivery);
    assert.deepEqual(
      storage.snapshot(scope).inputRequests,
      prepared.snapshot.inputRequests,
    );
    assert.equal(storage.replay(scope, original), undefined);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "native model interruption preserves diagnostics and replay starts no inference, including restart",
  { timeout: 20000 },
  async () => {
    const h = createTrustHarness();
    try {
      const started = holdModel(h);
      const original = command("TEST-native-stop");
      const delivery = h.execute(original);
      await started;
      const ack = await h.model.interrupt(h.scope, original, run);
      assert.equal(ack.status, "settled");
      const result = await delivery;
      assert.equal(result.status, "accepted");
      assert.equal(
        h.commandState(original.commandId).trace?.status,
        "cancelled",
      );
      assert(
        result.snapshot.conversations[0]!.messages.at(-1)!.text.includes(
          translate(original.language)("requestInterrupted"),
        ),
      );
      const requests = h.requests.length;
      assert.deepEqual(
        (await h.execute(original)).snapshot.conversations[0]!.messages,
        result.snapshot.conversations[0]!.messages,
      );
      assert.equal(h.requests.length, requests);
      await h.restart();
      assert.equal(
        (await h.model.interrupt(h.scope, original, run)).status,
        "settled",
      );
      await h.execute(original);
      assert.equal(h.requests.length, requests);
    } finally {
      await h.close();
    }
  },
);

test(
  "completed native write survives interruption and is never dispatched twice",
  { timeout: 20000 },
  async () => {
    const h = createTrustHarness({ writeApproval: "never" });
    try {
      h.onChat(h.writeScript);
      const started = holdModel(h, (body) =>
        toolResults(body).some((result) => result.data?.created),
      );
      const original = command("TEST-completed-write", "TEST create a meeting");
      const delivery = h.execute(original);
      await started;
      const ack = await h.model.interrupt(h.scope, original, run);
      assert.equal(ack.status, "settled");
      const reply = (await delivery).snapshot.conversations[0]!.messages.at(
        -1,
      )!;
      assert.equal(reply.result?.type, "service.action");
      assert.equal(
        reply.result?.type === "service.action" && reply.result.status,
        "succeeded",
      );
      const network = h.network.length;
      await h.execute(original);
      await h.restart();
      await h.execute(original);
      assert.equal(h.network.length, network);
      assert.equal(
        h.commandState(original.commandId).trace?.status,
        "cancelled",
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "interrupting approved dispatch waits for its adapter and preserves the unknown write and approval",
  { timeout: 20000 },
  async () => {
    const h = createTrustHarness();
    const started = deferred<void>(),
      released = deferred<void>();
    try {
      h.onChat(h.writeScript);
      const proposed = await h.send("TEST create a meeting", {
        id: "TEST-approval-proposal",
      });
      const card = proposed.snapshot.conversations[0]!.messages.at(-1)!.result;
      assert(
        card?.type === "service.action" && card.status === "awaiting_approval",
      );
      h.onWrite(async () => {
        started.resolve();
        await released.promise;
      });
      const original = CommandSchema.parse({
        type: "service.resolve",
        commandId: "TEST-approved-stop",
        idempotencyKey: "TEST-approved-stop",
        conversationId: "conversation-1",
        operationId: card.operationId,
        approved: true,
        language: "en",
      });
      const delivery = h.execute(original);
      await started.promise;
      let done = false;
      const cancellation = h.model
        .interrupt(h.scope, original, run)
        .then((value) => {
          done = true;
          return value;
        });
      await delay(10);
      assert.equal(done, false);
      h.writeResponse = "lost";
      released.resolve();
      assert.equal((await cancellation).status, "settled");
      const result = await delivery;
      const shown = result.snapshot.conversations[0]!.messages.flatMap(
        (message) =>
          message.result?.type === "service.action" ? [message.result] : [],
      );
      assert(
        shown.some(
          (receipt) =>
            receipt.operationId === card.operationId &&
            receipt.status === "unknown",
        ),
      );
      assert.equal(
        h.catalog.invocation(
          card.operationId,
          h.scope.workspaceId,
          h.scope.userId,
        )?.status,
        "unknown",
      );
      const count = h.network.length;
      await h.execute(original);
      assert.equal(h.network.length, count);
      assert.equal(
        h.commandState("TEST-approval-proposal").trace?.status,
        "unknown",
      );
    } finally {
      released.resolve();
      await h.close();
    }
  },
);

test(
  "unproved native retirement returns unknown and retains the scope gate",
  { timeout: 20000 },
  async () => {
    const h = createTrustHarness();
    try {
      const started = holdModel(h);
      const runtime = await nativeCatalogOwner(h.controller);
      const proof = runtime.isSettled;
      runtime.isSettled = () => false;
      const original = command("TEST-unsettled");
      const delivery = h.execute(original);
      void delivery.catch(() => {});
      await started;
      const ack = await h.model.interrupt(h.scope, original, run);
      assert.equal(ack.status, "unknown");
      assert.equal(ack.status === "unknown" && ack.reason, "not_settled");
      await assert.rejects(delivery, /request_interruption_not_settled/);
      assert.equal(h.workflow.replay(h.scope, original), undefined);
      await assert.rejects(h.execute(command("TEST-next")), /model_busy/);
      runtime.isSettled = proof;
      const requests = h.requests.length,
        network = h.network.length;
      const retried = await h.model.interrupt(h.scope, original, run);
      assert.equal(retried.status, "settled");
      assert.equal(
        h.requests.length,
        requests,
        "Interruption retry must start no inference",
      );
      assert.equal(
        h.network.length,
        network,
        "Interruption retry must dispatch no service call",
      );
      assert.equal(
        h.commandState(original.commandId).trace?.status,
        "cancelled",
      );
      const replay = await h.execute(original);
      assert.equal(replay.status, "accepted");
      assert.equal(h.requests.length, requests);
      const next = await h.execute(command("TEST-next"));
      assert.equal(
        next.status,
        "accepted",
        "Passive settlement must release the scope gate",
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "revoked epoch cannot finalize a interrupted native result",
  { timeout: 20000 },
  async () => {
    const h = createTrustHarness();
    try {
      const started = holdModel(h);
      const original = command("TEST-revoked");
      const delivery = h.execute(original);
      void delivery.catch(() => {});
      await started;
      h.context.change(h.target.organizationId);
      assert.equal(
        (await h.model.interrupt(h.scope, original, run)).status,
        "unknown",
      );
      await assert.rejects(delivery, /identity_forbidden/);
      assert.equal(h.workflow.replay(h.scope, original), undefined);
    } finally {
      await h.close();
    }
  },
);

test("HTTP extension authenticates scope, validates its profile and returns the recorded result after original delivery is lost", async () => {
  const root = mkdtempSync(join(tmpdir(), "interrupt-http-"));
  const started = deferred<void>();
  let calls = 0;
  const server = createFixtureServer(root, [], {
    model: {
      timeZone: "UTC",
      decide: async (_, signal) => {
        calls++;
        started.resolve();
        return new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}/v1/a/`;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const pair = async (user: string) =>
    CredentialSchema.parse(
      await (
        await post("auth/pair", {
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: issuePairingCode(root, user, "a"),
        })
      ).json(),
    );
  try {
    const alice = await pair("alice"),
      bob = await pair("bob");
    const original = command("TEST-http-stop");
    const request = {
      profile: REQUEST_INTERRUPTION_PROFILE,
      command: original,
    };
    assert.equal((await post("commands/interrupt", request)).status, 401);
    assert.equal(
      (
        await post(
          "commands/interrupt",
          { ...request, profile: "invalid" },
          alice.accessToken,
        )
      ).status,
      400,
    );
    const delivery = post(
      replyCorrelationPath("commands"),
      original,
      alice.accessToken,
    );
    await started.promise;
    const cross = RequestInterruptionResponseSchema.parse(
      await (await post("commands/interrupt", request, bob.accessToken)).json(),
    );
    assert.equal(cross.status, "unknown");
    const ack = RequestInterruptionResponseSchema.parse(
      await (
        await post(
          cardDeliveryPath(replyCorrelationPath("commands/interrupt")),
          request,
          alice.accessToken,
        )
      ).json(),
    );
    assert.equal(ack.status, "settled");
    if (ack.status === "settled")
      assert.equal(
        ack.result.snapshot.conversations[0]!.messages.at(-1)!.replyToCommandId,
        original.commandId,
      );
    // Deliberately discard the original response: the interruption owns enough
    // durable evidence to release a client after lost original delivery.
    await delivery;
    assert.equal(
      (
        await (
          await post("commands/interrupt", request, alice.accessToken)
        ).json()
      ).status,
      "settled",
    );
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});
