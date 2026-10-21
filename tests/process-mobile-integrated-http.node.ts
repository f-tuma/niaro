import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { ClientSession, commandTarget } from "../packages/client-core/session";
import {
  captureProcessAnswerTarget,
  processAnswerCommand,
} from "../packages/client-core/process-answers";
import {
  captureProcessResolveTarget,
  processStartCommand,
  processResolveCommand,
} from "../packages/client-core/process-commands";
import { LoopDetailSchema, LoopPageSchema } from "../packages/protocol/loops";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import {
  mobileHttpChildFixture,
  type MobileFixtureSetup,
} from "./helpers/process-mobile-http-child";

const fixture = mobileHttpChildFixture({
  testAllowedOrigins: ["http://localhost:8087"],
});
after(async () => {
  await (await fixture).close();
});
const ids = () => {
  const commandId = randomUUID();
  return {
    commandId,
    idempotencyKey: commandId + "-key",
    language: "cs" as const,
  };
};
async function waitFor(check: () => boolean) {
  const until = Date.now() + 10_000;
  while (!check()) {
    assert(Date.now() < until, "TEST actual Session did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function fileStorage(
  root = mkdtempSync(join(tmpdir(), "niaro-mobile-outbox-")),
) {
  const values = new Map<string, string>();
  const path = (key: string) =>
    join(root, createHash("sha256").update(key).digest("hex"));
  return {
    root,
    values,
    getItem: async (key: string) => {
      const value = existsSync(path(key))
        ? readFileSync(path(key), "utf8")
        : null;
      if (value !== null) values.set(key, value);
      return value;
    },
    setItem: async (key: string, value: string) => {
      writeFileSync(path(key), value);
      values.set(key, value);
    },
  };
}
function trackedTransport(saved: ReturnType<typeof fileStorage>) {
  const posts: { body: string; status: number; value: unknown }[] = [];
  let lose = false,
    offline = false,
    split = false;
  const request: typeof fetch = async (url, init) => {
    if (offline) throw Error("TEST transport offline");
    if (
      init?.method !== "POST" ||
      !new URL(String(url)).pathname.endsWith("/processes/commands")
    )
      return fetch(url, init);
    const body = String(init.body);
    assert(
      readdirSync(saved.root)
        .map((name) => readFileSync(join(saved.root, name), "utf8"))
        .some((raw) => {
          try {
            const value = JSON.parse(raw);
            return (
              value.serializedCommand === body ||
              value.attempts?.some(
                (a: { command: unknown }) => JSON.stringify(a.command) === body,
              )
            );
          } catch {
            return false;
          }
        }),
      "TEST exact command was not persisted before actual dispatch",
    );
    let wire = init;
    if (split) {
      split = false;
      const bytes = Buffer.from(body, "utf8");
      const boundary = bytes.indexOf(Buffer.from("ž", "utf8")) + 1;
      assert(boundary > 0, "TEST requires an actual split Unicode codepoint");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, boundary));
          setTimeout(() => {
            controller.enqueue(bytes.subarray(boundary));
            controller.close();
          }, 5);
        },
      });
      wire = { ...init, body: stream, duplex: "half" } as RequestInit & {
        duplex: "half";
      };
    }
    const response = await fetch(url, wire);
    const value: unknown = await response.clone().json();
    posts.push({ body, value, status: response.status });
    if (lose) {
      lose = false;
      await response.text();
      throw Error("TEST lost response after real server processing");
    }
    return response;
  };
  return {
    request,
    posts,
    loseNext: () => {
      lose = true;
    },
    setOffline: (value: boolean) => {
      offline = value;
    },
    splitNextBody: () => {
      split = true;
    },
  };
}
const newSession = (
  setup: MobileFixtureSetup,
  saved: ReturnType<typeof fileStorage>,
  request: typeof fetch,
) =>
  new ClientSession(
    setup.endpoint,
    saved,
    setup.credential,
    request,
    undefined,
    undefined,
    false,
    { processQuestions: true, processApprovals: true },
  );
async function prepare(session: ClientSession, setup: MobileFixtureSetup) {
  const inventory = await session.loadProcessInventory();
  const entry = inventory.processes.find(
    (p) => p.processId === setup.artifact.processId,
  );
  assert(entry?.availability === "ready", JSON.stringify(inventory));
  return session.prepareProcessInput(
    {
      processId: entry.processId,
      version: setup.artifact.version,
      artifactDigest: setup.artifact.digest,
      language: "cs",
      origin: {
        type: "command",
        conversationId: "conversation-1",
        requestId: randomUUID(),
      },
    },
    entry,
  );
}
const findWork = (session: ClientSession, setup: MobileFixtureSetup) => {
  const work = Object.values(session.getSnapshot().store!.workItems).find(
    (w) => w.native?.process?.provenance.processId === setup.artifact.processId,
  );
  assert(work, "TEST native admitted work was not projected");
  return work;
};
async function settle(session: ClientSession) {
  await waitFor(
    () => !!session.getSnapshot().store && !session.getSnapshot().store!.stale,
  );
}
async function answer(
  session: ClientSession,
  setup: MobileFixtureSetup,
  index: number,
) {
  const work = findWork(session, setup);
  const target = captureProcessAnswerTarget(
    session.getSnapshot().store!,
    work.id,
    "conversation-1",
  );
  const command = processAnswerCommand(session.getSnapshot().store!, target, {
    ...ids(),
    answer: `  TEST exact answer ${index}\n`,
  });
  await session.send(command);
  await settle(session);
  return { target, command };
}
async function resolve(
  session: ClientSession,
  setup: MobileFixtureSetup,
  approved = true,
) {
  const work = findWork(session, setup);
  const target = captureProcessResolveTarget(
    session.getSnapshot().store!,
    work.id,
    undefined,
    "conversation-1",
    work,
  );
  const command = processResolveCommand(session.getSnapshot().store!, target, {
    ...ids(),
    approved,
  });
  await session.send(command, false, target);
  await settle(session);
  return { target, command };
}

test("actual paired HTTP child runs two questions, two guarded writes and typed output; file-backed client/server reopen and Loops reads are passive", async () => {
  const h = await fixture;
  await h.restart();
  const before = await h.inspect();
  const setup = await h.configure();
  const saved = fileStorage(),
    transport = trackedTransport(saved);
  let session = newSession(setup, saved, transport.request);
  try {
    await session.start(false);
    const target = await prepare(session, setup);
    const prepared = await h.inspect();
    assert.equal(prepared.modelCalls, before.modelCalls);
    assert.deepEqual(prepared.serviceDispatches, before.serviceDispatches);
    await session.send(
      processStartCommand(target, {
        ...ids(),
        input: { name: "TEST typed input" },
      }),
      false,
      target,
    );
    await settle(session);
    assert.equal(
      transport.posts.length,
      1,
      JSON.stringify({
        error: session.getSnapshot().error,
        pending: session.getSnapshot().pending,
      }),
    );
    assert.equal(
      transport.posts[0]!.status,
      202,
      JSON.stringify(transport.posts[0]!.value),
    );
    assert.equal(
      ProcessRuntimeResponseSchema.parse(transport.posts[0]!.value).admission
        .status,
      "admitted",
      JSON.stringify(transport.posts[0]!.value),
    );
    const workId = findWork(session, setup).id;
    for (let index = 1; index <= 2; index++) {
      const work = findWork(session, setup);
      assert.equal(work.status, "waiting_input");
      assert.equal(
        work.native!.process!.question!.question,
        `TEST question ${index}?`,
      );
      await answer(session, setup, index);
    }
    for (let index = 1; index <= 2; index++) {
      const work = findWork(session, setup);
      assert.equal(work.status, "waiting_approval");
      assert.equal(
        JSON.parse(work.native!.process!.approval!.result.inputJson!).name,
        `TEST write ${index}`,
      );
      await resolve(session, setup);
    }
    const work = findWork(session, setup);
    assert.equal(work.status, "succeeded");
    assert.equal(
      work.native!.process!.provenance.artifactDigest,
      setup.artifact.digest,
    );
    assert.equal(
      work.native!.process!.provenance.actorId,
      setup.credential.scope.userId,
    );
    assert.deepEqual(
      work.native!.process!.receipts.map((r) => r.status),
      ["succeeded", "succeeded"],
    );
    assert(JSON.stringify(work).includes("TEST integrated result"));
    const counts = await h.inspect();
    assert.equal(counts.modelCalls - before.modelCalls, 5);
    assert.deepEqual(
      counts.serviceDispatches.slice(before.serviceDispatches.length),
      ["POST", "POST"],
    );
    assert.equal(counts.commandPosts - before.commandPosts, 5);
    assert.equal(counts.ordinaryCommandPosts, 0);
    assert.equal(transport.posts.length, 5);
    assert(
      counts.requests.some((r) =>
        r.path.includes("tasks=agent-process-work%2F3"),
      ),
    );
    assert(
      counts.requests
        .filter((r) => r.path.includes("/processes/commands?"))
        .every((r) => r.path.includes("profile=agent-process-execution%2F2")),
    );
    const loops = await h.loops();
    assert.equal(loops.status, 200);
    const entry = LoopPageSchema.parse(loops.data).entries.find(
      (e) => e.process?.processId === setup.artifact.processId,
    );
    assert(entry);
    const detail = await h.loops(entry.id);
    assert.equal(detail.status, 200);
    const loop = LoopDetailSchema.parse(detail.data);
    assert.equal(loop.run.process?.artifactDigest, setup.artifact.digest);
    assert.equal(loop.run.status, "succeeded");
    assert.equal((await h.loops(undefined, "member")).status, 403);
    assert.equal((await h.loops(entry.id, "anonymous")).status, 401);
    session.stop();
    await h.restart();
    session = newSession(setup, fileStorage(saved.root), transport.request);
    await session.start(false);
    assert.equal(session.getSnapshot().pending, null);
    assert.equal(
      session.getSnapshot().store!.workItems[workId]!.status,
      "succeeded",
    );
    await session.refresh();
    const reopened = await h.inspect();
    assert.equal(reopened.modelCalls, counts.modelCalls);
    assert.deepEqual(reopened.serviceDispatches, counts.serviceDispatches);
    assert.equal(reopened.commandPosts, counts.commandPosts);
    assert.equal(transport.posts.length, 5);
  } finally {
    session.stop();
    rmSync(saved.root, { recursive: true, force: true });
  }
});

for (const retirement of [
  "refresh",
  "sync",
  "retry",
  "discard",
  "stop",
  "revoke",
] as const)
  test(`consumed answer retirement through ${retirement} preserves live native resume authority`, async () => {
    const h = await mobileHttpChildFixture();
    const saved = fileStorage(),
      transport = trackedTransport(saved);
    let session: ClientSession | undefined,
      delivery: Promise<void> | undefined,
      answerSignal: AbortSignal | null | undefined;
    try {
      const setup = await h.configure({ questions: 1, writes: 1 });
      const { refresh: _refresh, ...accessCredential } = setup.credential;
      // This harness has no credential renewal callback; use the actual access
      // credential so a revoked device exercises the terminal 401 gate.
      const sessionSetup =
        retirement === "revoke"
          ? { ...setup, credential: accessCredential }
          : setup;
      session = newSession(sessionSetup, saved, async (url, init) => {
        if (
          init?.method === "POST" &&
          String(url).includes("/processes/commands") &&
          JSON.parse(String(init.body)).type === "process.answer"
        )
          answerSignal = init.signal;
        return transport.request(url, init);
      });
      await session.start(false);
      const startTarget = await prepare(session, setup);
      await session.send(
        processStartCommand(startTarget, {
          ...ids(),
          input: { name: "TEST passive answer retirement" },
        }),
        false,
        startTarget,
      );
      await session.refresh();
      const work = findWork(session, setup);
      const target = captureProcessAnswerTarget(
        session.getSnapshot().store!,
        work.id,
        "conversation-1",
      );
      const command = processAnswerCommand(
        session.getSnapshot().store!,
        target,
        {
          ...ids(),
          answer: "TEST answer consumed before resume finishes",
        },
      );
      // Consumption commits before the next model call. Keep that resume and
      // its HTTP response live while a passive read observes the exact answer.
      await h.hold("model");
      delivery = session.send(command);
      const until = Date.now() + 10_000;
      while (
        !(await h.inspect()).held.some(
          (held) => held.stage === "model" && held.entered,
        )
      ) {
        assert(
          Date.now() < until,
          "TEST answer resume did not reach the model gate",
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const passiveRead = retirement === "sync" ? "sync" : "refresh";
      if (retirement === "retry" || retirement === "discard") {
        const setItem = saved.setItem;
        saved.setItem = async (key, value) => {
          if (key.includes("agent-client.process-answer-attempts.v1:"))
            throw Error("TEST consumed answer cleanup storage failure");
          return setItem(key, value);
        };
        await session[passiveRead]();
        assert.equal(
          session.getSnapshot().pending?.commandId,
          command.commandId,
        );
        assert.equal(
          session.getSnapshot().answerAttempts[0]?.outcome,
          "accepted",
        );
        assert.equal(session.getSnapshot().error, "storage_error");
        saved.setItem = setItem;
        if (retirement === "retry") await session.retry();
        else
          assert(await session.discardProcessAnswerAttempt(command.commandId));
      } else await session[passiveRead]();
      assert.equal(session.getSnapshot().pending, null);
      assert(
        session
          .getSnapshot()
          .answerAttempts.every((attempt) => attempt.outcome === "accepted"),
      );
      assert.equal(
        findWork(session, setup).native!.process!.answerHistory?.at(-1)
          ?.commandId,
        command.commandId,
      );
      assert(answerSignal, "TEST answer transport was not admitted");
      assert.equal(
        answerSignal.aborted,
        false,
        "consumption retires local answer text without aborting the live resume",
      );
      await delivery;
      if (retirement === "stop" || retirement === "revoke") {
        if (retirement === "stop") session.stop();
        else {
          await h.revokeDevice();
          await session.refresh();
          assert.equal(session.getSnapshot().status, "unauthorized");
        }
        assert.equal(
          answerSignal.aborted,
          true,
          "retired transport remains tracked for stop and authority revocation",
        );
        assert.deepEqual((await h.inspect()).serviceDispatches, []);
        return;
      }
      await h.release("model");
      const settledUntil = Date.now() + 10_000;
      while (
        !transport.posts.some(
          (post) => JSON.parse(post.body).commandId === command.commandId,
        )
      ) {
        assert(
          Date.now() < settledUntil,
          "TEST retired answer HTTP response did not settle",
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await session.refresh();
      const waiting = findWork(session, setup);
      assert.equal(waiting.status, "waiting_approval");
      assert.equal(waiting.native!.process!.status, "waiting");
      const before = await h.inspect();
      assert.equal(before.modelCalls, 2);
      assert.equal(before.commandPosts, 2);
      assert.deepEqual(before.serviceDispatches, []);
      assert.equal(before.canonicalReceipts[0]?.status, "awaiting_approval");
      assert.equal(before.processJournals[0]?.status, "waiting");
      const exact = structuredClone(waiting.native!.process);
      await session[passiveRead]();
      assert.deepEqual(findWork(session, setup).native!.process, exact);
      const after = await h.inspect();
      assert.deepEqual(after.canonicalReceipts, before.canonicalReceipts);
      assert.equal(after.commandPosts, before.commandPosts);
      assert.equal(after.modelCalls, before.modelCalls);
      assert.deepEqual(after.serviceDispatches, []);
    } finally {
      await h.release();
      await delivery;
      session?.stop();
      await h.close();
      rmSync(saved.root, { recursive: true, force: true });
    }
  });

test("test-only CORS accepts the selected local browser origin and rejects other origins without widening production defaults", async () => {
  const h = await fixture;
  const setup = await h.configure({ questions: 0, writes: 0 });
  const allowed = await fetch(
    setup.endpoint + "/processes?profile=agent-process-execution%2F1",
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:8087",
        "Access-Control-Request-Method": "GET",
      },
    },
  );
  assert.equal(
    allowed.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:8087",
  );
  const denied = await fetch(
    setup.endpoint + "/processes?profile=agent-process-execution%2F1",
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:8088",
        "Access-Control-Request-Method": "GET",
      },
    },
  );
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
});

test("lost question A acknowledgement retains exact file-backed A across server reopen; retry cannot answer current B and a fresh stale A is rejected", async () => {
  const h = await fixture;
  await h.restart();
  const before = await h.inspect(),
    setup = await h.configure();
  const saved = fileStorage(),
    transport = trackedTransport(saved);
  let session = newSession(setup, saved, transport.request);
  try {
    await session.start(false);
    const start = await prepare(session, setup);
    await session.send(
      processStartCommand(start, {
        ...ids(),
        input: { name: "TEST loss answer input" },
      }),
      false,
      start,
    );
    await settle(session);
    const work = findWork(session, setup);
    const targetA = captureProcessAnswerTarget(
      session.getSnapshot().store!,
      work.id,
      "conversation-1",
    );
    const commandA = processAnswerCommand(
      session.getSnapshot().store!,
      targetA,
      {
        ...ids(),
        answer:
          "  TEST přesná žluťoučká odpověď 🦊\n" +
          "žluťoučký kůň 🦊 ".repeat(120),
      },
    );
    transport.splitNextBody();
    transport.loseNext();
    await session.send(commandA);
    assert.deepEqual(session.getSnapshot().pending, commandA);
    assert.equal(session.getSnapshot().error, "network_error");
    const replyA = ProcessRuntimeResponseSchema.parse(
      transport.posts[1]!.value,
    );
    assert.equal(replyA.process?.question?.question, "TEST question 2?");
    await h.restart();
    assert.deepEqual(session.getSnapshot().pending, commandA);
    const reopened = await h.inspect();
    assert.equal(reopened.modelCalls - before.modelCalls, 2);
    assert.equal(reopened.commandPosts - before.commandPosts, 2);
    await session.retry();
    assert.equal(
      transport.posts.length,
      3,
      JSON.stringify({
        error: session.getSnapshot().error,
        pending: session.getSnapshot().pending,
        status: session.getSnapshot().status,
      }),
    );
    await settle(session);
    assert.equal(session.getSnapshot().pending, null);
    assert.equal(transport.posts[2]!.body, transport.posts[1]!.body);
    assert.deepEqual(transport.posts[2]!.value, transport.posts[1]!.value);
    const loggedAnswers = (await h.inspect()).requests.filter((r) =>
      r.body?.includes(commandA.commandId),
    );
    assert.equal(loggedAnswers.length, 2);
    assert(loggedAnswers.every((r) => r.body === transport.posts[1]!.body));
    assert.equal((await h.inspect()).modelCalls, reopened.modelCalls);
    const stale = await fetch(
      setup.endpoint +
        "/processes/commands?profile=agent-process-execution%2F2",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + setup.credential.accessToken,
        },
        body: JSON.stringify({
          ...commandA,
          ...ids(),
          answer: "TEST stale fresh A",
        }),
      },
    );
    assert.equal(stale.status, 409);
    assert.equal((await h.inspect()).modelCalls, reopened.modelCalls);
    assert.equal(
      findWork(session, setup).native!.process!.question!.questionId,
      replyA.process!.question!.questionId,
    );
    await answer(session, setup, 2);
    await resolve(session, setup);
    await resolve(session, setup);
    const finished = findWork(session, setup);
    assert.equal(finished.status, "succeeded");
    assert.equal(
      finished.native!.process!.answerHistory![0]!.answer,
      commandA.answer,
    );
    assert.deepEqual(
      (await h.inspect()).serviceDispatches.slice(
        before.serviceDispatches.length,
      ),
      ["POST", "POST"],
    );
    assert.equal((await h.inspect()).modelCalls - before.modelCalls, 5);
    session.stop();
    session = newSession(setup, fileStorage(saved.root), transport.request);
    await session.start(false);
    assert.equal(findWork(session, setup).status, "succeeded");
    assert.equal(transport.posts.length, 6);
  } finally {
    session.stop();
    rmSync(saved.root, { recursive: true, force: true });
  }
});

test("fresh real work/3 answer history passively confirms lost A on file-backed client/server reopen while B stays current", async () => {
  const h = await fixture;
  await h.restart();
  const before = await h.inspect(),
    setup = await h.configure({ writes: 0 });
  const saved = fileStorage(),
    transport = trackedTransport(saved);
  let session = newSession(setup, saved, transport.request);
  try {
    await session.start(false);
    const target = await prepare(session, setup);
    await session.send(
      processStartCommand(target, {
        ...ids(),
        input: { name: "TEST passive answer history" },
      }),
      false,
      target,
    );
    await settle(session);
    const work = findWork(session, setup);
    const answerTarget = captureProcessAnswerTarget(
      session.getSnapshot().store!,
      work.id,
      "conversation-1",
    );
    const command = processAnswerCommand(
      session.getSnapshot().store!,
      answerTarget,
      { ...ids(), answer: "  TEST proof-matched answer A\n" },
    );
    transport.loseNext();
    await session.send(command);
    assert.deepEqual(session.getSnapshot().pending, command);
    session.stop();
    await h.restart();
    session = newSession(setup, fileStorage(saved.root), transport.request);
    await session.start(false);
    assert.equal(session.getSnapshot().pending, null);
    assert.equal(
      session.getSnapshot().commandStates[commandTarget(command)],
      "accepted",
    );
    const b = findWork(session, setup);
    assert.equal(b.native!.process!.question!.question, "TEST question 2?");
    assert.equal(b.native!.process!.answerHistory![0]!.answer, command.answer);
    await session.retry();
    const counts = await h.inspect();
    assert.equal(counts.commandPosts - before.commandPosts, 2);
    assert.equal(counts.modelCalls - before.modelCalls, 2);
    assert.deepEqual(counts.serviceDispatches, before.serviceDispatches);
    assert.equal(transport.posts.length, 2);
  } finally {
    session.stop();
    rmSync(saved.root, { recursive: true, force: true });
  }
});

test("lost approval A acknowledgement restores its full original work/3 target while B is current; exact retry and denial of B preserve A's write", async () => {
  const h = await fixture;
  await h.restart();
  const before = await h.inspect(),
    setup = await h.configure({ questions: 0, writes: 2 });
  const saved = fileStorage(),
    transport = trackedTransport(saved);
  let session = newSession(setup, saved, transport.request);
  try {
    await session.start(false);
    const start = await prepare(session, setup);
    await session.send(
      processStartCommand(start, {
        ...ids(),
        input: { name: "TEST loss approval input" },
      }),
      false,
      start,
    );
    await settle(session);
    const work = findWork(session, setup);
    const targetA = captureProcessResolveTarget(
      session.getSnapshot().store!,
      work.id,
      undefined,
      "conversation-1",
      work,
    );
    const commandA = processResolveCommand(
      session.getSnapshot().store!,
      targetA,
      { ...ids(), approved: true },
    );
    transport.loseNext();
    await session.send(commandA, false, targetA);
    assert.deepEqual(session.getSnapshot().pending, commandA);
    const replyA = ProcessRuntimeResponseSchema.parse(
      transport.posts[1]!.value,
    );
    assert(replyA.process?.approval);
    assert.notEqual(replyA.process.approval.operationId, commandA.operationId);
    session.stop();
    await h.restart();
    session = newSession(setup, fileStorage(saved.root), transport.request);
    await session.start(false);
    assert.deepEqual(session.getSnapshot().pending, commandA);
    assert.deepEqual(session.getSnapshot().processPending?.target, targetA);
    assert.equal(
      findWork(session, setup).native!.process!.approval!.result.operationId,
      replyA.process.approval.operationId,
    );
    const reopened = await h.inspect();
    await session.retry();
    await settle(session);
    assert.equal(session.getSnapshot().pending, null);
    assert.equal(transport.posts[2]!.body, transport.posts[1]!.body);
    assert.deepEqual(transport.posts[2]!.value, transport.posts[1]!.value);
    assert.equal((await h.inspect()).modelCalls, reopened.modelCalls);
    assert.deepEqual(
      (await h.inspect()).serviceDispatches,
      reopened.serviceDispatches,
    );
    const stale = await fetch(
      setup.endpoint +
        "/processes/commands?profile=agent-process-execution%2F2",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + setup.credential.accessToken,
        },
        body: JSON.stringify({ ...commandA, ...ids() }),
      },
    );
    assert.equal(stale.status, 409);
    assert.deepEqual(
      (await h.inspect()).serviceDispatches,
      reopened.serviceDispatches,
    );
    await resolve(session, setup, false);
    const ended = findWork(session, setup);
    assert.equal(ended.status, "cancelled");
    assert.deepEqual(
      ended.native!.process!.receipts.map((r) => r.status),
      ["succeeded", "rejected"],
    );
    assert.deepEqual(
      (await h.inspect()).serviceDispatches.slice(
        before.serviceDispatches.length,
      ),
      ["POST"],
    );
    assert.equal((await h.inspect()).modelCalls - before.modelCalls, 2);
  } finally {
    session.stop();
    rmSync(saved.root, { recursive: true, force: true });
  }
});

for (const failure of ["known_marker", "clear"] as const) {
  test(`actual accepted start survives ${failure} storage failure; offline Retry only settles the local acknowledged outbox`, async () => {
    const h = await fixture;
    await h.restart();
    const before = await h.inspect(),
      setup = await h.configure({ questions: 0, writes: 0 });
    const saved = fileStorage(),
      transport = trackedTransport(saved);
    const write = saved.setItem;
    let failing = true;
    saved.setItem = async (key, value) => {
      if (
        failing &&
        (failure === "clear"
          ? value === "null"
          : value !== "null" &&
            JSON.parse(value).profile === "agent-client.process-command/1" &&
            JSON.parse(value).outcome === "accepted")
      )
        throw Error("TEST failed local ACK persistence");
      await write(key, value);
    };
    const session = newSession(setup, saved, transport.request);
    try {
      await session.start(false);
      const target = await prepare(session, setup);
      const command = processStartCommand(target, {
        ...ids(),
        input: { name: "TEST local ACK input" },
      });
      await session.send(command, false, target);
      assert.equal(session.getSnapshot().error, "storage_error");
      assert.deepEqual(session.getSnapshot().pending, command);
      assert.equal(session.getSnapshot().processPending?.outcome, "accepted");
      failing = false;
      transport.setOffline(true);
      await session.retry();
      assert.equal(session.getSnapshot().pending, null);
      assert.equal(session.getSnapshot().error, "connection_failed");
      assert.equal(transport.posts.length, 1);
      const after = await h.inspect();
      assert.equal(after.modelCalls - before.modelCalls, 1);
      assert.equal(after.commandPosts - before.commandPosts, 1);
      assert.deepEqual(after.serviceDispatches, before.serviceDispatches);
    } finally {
      session.stop();
      rmSync(saved.root, { recursive: true, force: true });
    }
  });
}

for (const outcome of [
  "service_failed",
  "service_unknown",
  "invalid_output",
] as const) {
  test(`actual ${outcome} after an earlier succeeded write retains both real receipts through passive reopen`, async () => {
    const h = await fixture;
    await h.restart();
    const before = await h.inspect(),
      setup = await h.configure({ questions: 0, writes: 2, outcome });
    const saved = fileStorage(),
      transport = trackedTransport(saved);
    let session = newSession(setup, saved, transport.request);
    try {
      await session.start(false);
      const target = await prepare(session, setup);
      await session.send(
        processStartCommand(target, {
          ...ids(),
          input: { name: "TEST prior write fault input" },
        }),
        false,
        target,
      );
      await settle(session);
      await resolve(session, setup);
      assert.equal(
        findWork(session, setup).native!.process!.receipts[0]!.status,
        "succeeded",
      );
      await resolve(session, setup);
      const final = findWork(session, setup);
      assert.equal(
        final.status,
        outcome === "service_unknown" ? "waiting_system" : "failed",
        JSON.stringify(final),
      );
      assert.equal(
        final.native!.process!.status,
        outcome === "service_unknown" ? "unknown" : "failed",
      );
      assert.equal(final.native!.process!.receipts[0]!.status, "succeeded");
      assert.equal(
        final.native!.process!.receipts[1]!.status,
        outcome === "invalid_output"
          ? "succeeded"
          : outcome === "service_unknown"
            ? "unknown"
            : "failed",
      );
      if (outcome === "invalid_output")
        assert(JSON.stringify(final).includes("process_output_invalid"));
      const counts = await h.inspect();
      assert.deepEqual(
        counts.serviceDispatches.slice(before.serviceDispatches.length),
        outcome === "service_failed" ? ["POST"] : ["POST", "POST"],
      );
      assert.equal(counts.commandPosts - before.commandPosts, 3);
      assert.equal(
        counts.modelCalls - before.modelCalls,
        outcome === "invalid_output" ? 3 : 2,
      );
      session.stop();
      await h.restart();
      session = newSession(setup, fileStorage(saved.root), transport.request);
      await session.start(false);
      assert.equal(findWork(session, setup).status, final.status);
      assert.deepEqual(
        findWork(session, setup).native!.process!.receipts,
        final.native!.process!.receipts,
      );
      assert.equal((await h.inspect()).commandPosts, counts.commandPosts);
      assert.equal((await h.inspect()).modelCalls, counts.modelCalls);
      assert.deepEqual(
        (await h.inspect()).serviceDispatches,
        counts.serviceDispatches,
      );
    } finally {
      session.stop();
      rmSync(saved.root, { recursive: true, force: true });
    }
  });
}

for (const gate of [
  "disableService",
  "disableAction",
  "disableModel",
  "disableMemory",
] as const) {
  test(`actual current ${gate} gate rejects an already prepared process start before any model or service dispatch`, async () => {
    const h = await mobileHttpChildFixture({
      testSavedMemory: gate === "disableMemory",
    });
    const saved = fileStorage(),
      transport = trackedTransport(saved);
    let session: ClientSession | undefined;
    try {
      const setup = await h.configure({
        memory: gate === "disableMemory" ? "saved" : "none",
      });
      session = newSession(setup, saved, transport.request);
      await session.start(false);
      const target = await prepare(session, setup);
      await h[gate]();
      await session.send(
        processStartCommand(target, {
          ...ids(),
          input: { name: "TEST gated saved form" },
        }),
        false,
        target,
      );
      assert.equal(transport.posts.length, 1);
      const receipt = ProcessRuntimeResponseSchema.parse(
        transport.posts[0]!.value,
      );
      assert.equal(receipt.admission.status, "rejected");
      assert.equal(session.getSnapshot().pending, null);
      const counts = await h.inspect();
      assert.equal(counts.modelCalls, 0);
      assert.deepEqual(counts.serviceDispatches, []);
      assert.equal(counts.commandPosts, 1);
      assert.equal(counts.ordinaryCommandPosts, 0);
      assert.equal(
        Object.values(session.getSnapshot().store!.workItems).filter(
          (w) =>
            w.native?.process?.provenance.processId ===
            setup.artifact.processId,
        ).length,
        0,
      );
    } finally {
      session?.stop();
      await h.close();
      rmSync(saved.root, { recursive: true, force: true });
    }
  });
}

test("a stale qualification refuses a prepared start with a durable receipt instead of a retryable error", async () => {
  const h = await mobileHttpChildFixture();
  const saved = fileStorage(),
    transport = trackedTransport(saved);
  let session: ClientSession | undefined;
  try {
    const setup = await h.configure({});
    session = newSession(setup, saved, transport.request);
    await session.start(false);
    const target = await prepare(session, setup);
    // Changes the pinned test environment without touching any source revision.
    await h.exhaustBudget();
    await session.send(
      processStartCommand(target, {
        ...ids(),
        input: { name: "TEST stale qualification start" },
      }),
      false,
      target,
    );
    assert.equal(transport.posts.length, 1);
    assert.equal(transport.posts[0]!.status, 422);
    const receipt = ProcessRuntimeResponseSchema.parse(
      transport.posts[0]!.value,
    );
    assert.equal(receipt.admission.status, "rejected");
    if (receipt.admission.status === "rejected")
      assert.equal(receipt.admission.reason, "process_qualification_stale");
    assert.equal(session.getSnapshot().pending, null);
    const counts = await h.inspect();
    assert.equal(counts.modelCalls, 0);
    assert.deepEqual(counts.serviceDispatches, []);
  } finally {
    session?.stop();
    await h.close();
    rmSync(saved.root, { recursive: true, force: true });
  }
});

test("actual frozen run budget exhaustion after the first succeeded write prevents the next model turn and preserves its canonical receipt", async () => {
  const h = await mobileHttpChildFixture();
  const saved = fileStorage(),
    transport = trackedTransport(saved);
  let session: ClientSession | undefined;
  let delivery: Promise<unknown> | undefined;
  try {
    // Set the limit before freeze and qualification. A mid-flight policy change
    // would instead invalidate qualification before the service result commit.
    const setup = await h.configure({
      questions: 0,
      writes: 2,
      maxModelCalls: 1,
    });
    assert.equal(setup.artifact.definition.limits.maxModelCalls, 1);
    const policy = (await h.inspect()).budgetPolicy;
    session = newSession(setup, saved, transport.request);
    await session.start(false);
    const target = await prepare(session, setup);
    await session.send(
      processStartCommand(target, {
        ...ids(),
        input: { name: "TEST current budget gate" },
      }),
      false,
      target,
    );
    await settle(session);
    const operationId = findWork(session, setup).native!.process!.approval!
      .result.operationId;
    await h.hold("after_service");
    delivery = resolve(session, setup);
    const until = Date.now() + 10_000;
    while (
      !(await h.inspect()).held.some(
        (held) => held.stage === "after_service" && held.entered,
      )
    ) {
      assert(
        Date.now() < until,
        "TEST dispatched write did not reach held response",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await h.release("after_service");
    await delivery;
    const response = transport.posts.at(-1)!;
    assert.equal(response.status, 202, JSON.stringify(response.value));
    const outcome = ProcessRuntimeResponseSchema.parse(response.value).process;
    assert.equal(outcome?.status, "failed", JSON.stringify(response.value));
    assert.equal(outcome.failure?.code, "catalog_budget_exhausted");
    // send resolves before the background snapshot is necessarily published.
    await session.refresh();
    await settle(session);
    const work = findWork(session, setup);
    assert.equal(work.status, "failed", JSON.stringify(work));
    assert.deepEqual(
      work.native!.process!.receipts.map((r) => r.status),
      ["succeeded"],
    );
    const counts = await h.inspect();
    assert.deepEqual(counts.budgetPolicy, policy);
    assert.deepEqual(counts.canonicalReceipts, [
      {
        operationId,
        status: "succeeded",
        effect: "write",
        input: { name: "TEST write 1" },
        result: { value: "TEST saved write 1" },
      },
    ]);
    assert.equal(counts.modelCalls, 1);
    assert.deepEqual(counts.serviceDispatches, ["POST"]);
    assert.equal(counts.commandPosts, 2);
    assert.equal(counts.ordinaryCommandPosts, 0);
  } finally {
    await h.release();
    await delivery;
    session?.stop();
    await h.close();
    rmSync(saved.root, { recursive: true, force: true });
  }
});

test("actual policy drift after dispatch refuses stale qualification, preserves the unknown write and replays the exact decision without further effects", async () => {
  const h = await mobileHttpChildFixture();
  const saved = fileStorage(),
    transport = trackedTransport(saved);
  let session: ClientSession | undefined;
  let delivery: Promise<unknown> | undefined;
  try {
    const setup = await h.configure({ questions: 0, writes: 2 });
    const policy = (await h.inspect()).budgetPolicy;
    session = newSession(setup, saved, transport.request);
    await session.start(false);
    const target = await prepare(session, setup);
    await session.send(
      processStartCommand(target, {
        ...ids(),
        input: { name: "TEST qualification policy drift" },
      }),
      false,
      target,
    );
    await settle(session);
    const pending = findWork(session, setup);
    const operationId = pending.native!.process!.approval!.result.operationId;
    const provenance = structuredClone(pending.native!.process!.provenance);
    await h.hold("after_service");
    delivery = resolve(session, setup);
    const until = Date.now() + 10_000;
    while (
      !(await h.inspect()).held.some(
        (held) => held.stage === "after_service" && held.entered,
      )
    ) {
      assert(
        Date.now() < until,
        "TEST policy drift did not reach dispatched response hold",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The write has dispatched, but its provider result has not been committed.
    await h.exhaustBudget();
    await h.release("after_service");
    await delivery;
    const response = transport.posts.at(-1)!;
    assert.equal(response.status, 409, JSON.stringify(response.value));
    assert.deepEqual(response.value, { error: "process_qualification_stale" });
    assert.equal(session.getSnapshot().processPending?.outcome, "unknown");
    await session.refresh();
    await settle(session);
    const work = findWork(session, setup);
    assert.equal(work.status, "waiting_system", JSON.stringify(work));
    assert.equal(work.native!.process!.status, "unknown");
    assert.equal(work.native!.process!.journalStatus, "unknown");
    assert.equal(work.native!.process!.approval, undefined);
    assert.deepEqual(work.native!.process!.provenance, provenance);
    assert.deepEqual(
      work.native!.process!.receipts.map((receipt) => receipt.status),
      ["unknown"],
    );
    assert(JSON.stringify(work).includes("action_failed"));
    const counts = await h.inspect();
    assert.equal(counts.budgetPolicy.revision, policy.revision + 1);
    assert.deepEqual(counts.budgetPolicy.settings, {
      ...policy.settings,
      maxTokens: 1,
    });
    assert.deepEqual(counts.canonicalReceipts, [
      {
        operationId,
        status: "unknown",
        effect: "write",
        input: { name: "TEST write 1" },
        failureCode: "action_failed",
      },
    ]);
    assert.deepEqual(counts.processJournals, [
      {
        parentRunId: pending.id,
        processId: setup.artifact.processId,
        status: "unknown",
        failureCode: "action_failed",
      },
    ]);
    assert.equal(counts.modelCalls, 1);
    assert.deepEqual(counts.serviceDispatches, ["POST"]);
    assert.equal(counts.commandPosts, 2);
    assert.equal(counts.ordinaryCommandPosts, 0);
    // The uncorrelated 409 retained exact delivery. Its already-bound terminal
    // replay proves unknown and cannot dispatch a second write or model call.
    await session.retry();
    await session.refresh();
    await settle(session);
    const replay = transport.posts.at(-1)!;
    assert.equal(replay.status, 202, JSON.stringify(replay.value));
    assert.equal(replay.body, response.body);
    const replayed = ProcessRuntimeResponseSchema.parse(replay.value).process;
    assert.equal(replayed?.status, "unknown");
    assert.equal(replayed.failure?.code, "action_failed");
    assert.equal(session.getSnapshot().pending, null);
    assert.equal(session.getSnapshot().error, "action_failed");
    const after = await h.inspect();
    assert.equal(after.modelCalls, counts.modelCalls);
    assert.deepEqual(after.serviceDispatches, counts.serviceDispatches);
    assert.deepEqual(after.canonicalReceipts, counts.canonicalReceipts);
    assert.deepEqual(after.processJournals, counts.processJournals);
    assert.deepEqual(after.budgetPolicy, counts.budgetPolicy);
    assert.equal(after.commandPosts, counts.commandPosts + 1);
  } finally {
    await h.release();
    await delivery;
    session?.stop();
    await h.close();
    rmSync(saved.root, { recursive: true, force: true });
  }
});

for (const gate of ["device", "membership"] as const) {
  test(`actual current ${gate} revocation during a held approval reaches the final authority guard with zero write dispatch`, async () => {
    const h = await mobileHttpChildFixture();
    const saved = fileStorage(),
      transport = trackedTransport(saved);
    let session: ClientSession | undefined;
    let delivery: Promise<void> | undefined;
    try {
      const setup = await h.configure(
        { questions: 0, writes: 1 },
        gate === "membership" ? "member" : "owner",
      );
      session = newSession(setup, saved, transport.request);
      await session.start(false);
      const target = await prepare(session, setup);
      await session.send(
        processStartCommand(target, {
          ...ids(),
          input: { name: "TEST held authority guard" },
        }),
        false,
        target,
      );
      await settle(session);
      const work = findWork(session, setup);
      const review = captureProcessResolveTarget(
        session.getSnapshot().store!,
        work.id,
        undefined,
        "conversation-1",
        work,
      );
      const command = processResolveCommand(
        session.getSnapshot().store!,
        review,
        { ...ids(), approved: true },
      );
      await h.hold("before_service");
      delivery = session.send(command, false, review);
      const until = Date.now() + 10_000;
      while (
        !(await h.inspect()).held.some(
          (held) => held.stage === "before_service" && held.entered,
        )
      ) {
        assert(
          Date.now() < until,
          "TEST authority guard did not reach held transport",
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (gate === "device") await h.revokeDevice();
      else await h.revokeMembership();
      await h.release("before_service");
      await delivery;
      assert(
        [401, 403, 404].includes(transport.posts[1]!.status),
        JSON.stringify(transport.posts[1]!.value),
      );
      const counts = await h.inspect();
      assert.equal(counts.modelCalls, 1);
      assert.deepEqual(counts.serviceDispatches, []);
      assert.equal(counts.commandPosts, 2);
      assert.equal(counts.ordinaryCommandPosts, 0);
    } finally {
      await h.release();
      await delivery;
      session?.stop();
      await h.close();
      rmSync(saved.root, { recursive: true, force: true });
    }
  });
}
