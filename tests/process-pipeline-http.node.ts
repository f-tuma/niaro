import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClientSession } from "../packages/client-core/session";
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
  pipelineHttpChildFixture,
  type PipelineFixtureComplete,
} from "./helpers/process-pipeline-http-child";

const ids = () => {
  const commandId = randomUUID();
  return {
    commandId,
    idempotencyKey: commandId + "-key",
    language: "cs" as const,
  };
};
function fileStorage(
  root = mkdtempSync(join(tmpdir(), "niaro-pipeline-outbox-")),
) {
  const path = (key: string) =>
    join(root, createHash("sha256").update(key).digest("hex"));
  return {
    root,
    getItem: async (key: string) =>
      existsSync(path(key)) ? readFileSync(path(key), "utf8") : null,
    setItem: async (key: string, value: string) => {
      writeFileSync(path(key), value);
    },
  };
}
function trackedTransport(saved: ReturnType<typeof fileStorage>) {
  const posts: { body: string; status: number; data: unknown }[] = [];
  let lose = false;
  const request: typeof fetch = async (url, init) => {
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
          const value = JSON.parse(raw);
          return (
            value.serializedCommand === body ||
            value.attempts?.some(
              (a: { command: unknown }) => JSON.stringify(a.command) === body,
            )
          );
        }),
      "TEST exact command was not persisted before dispatch",
    );
    const response = await fetch(url, init);
    posts.push({
      body,
      status: response.status,
      data: await response.clone().json(),
    });
    if (lose) {
      lose = false;
      await response.text();
      throw Error("TEST lost ACK after actual server processing");
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
const sessionStarts = new WeakMap<ClientSession, string>();
const sessionRoots = new WeakMap<ClientSession, string>();
const savedStarts = new Map<string, string>();
const newSession = (
  setup: PipelineFixtureComplete,
  saved: ReturnType<typeof fileStorage>,
  request: typeof fetch,
) => {
  const session = new ClientSession(
    setup.endpoint,
    saved,
    setup.credential,
    request,
    undefined,
    undefined,
    false,
    { processOutputs: true },
  );
  sessionRoots.set(session, saved.root);
  const commandId = savedStarts.get(saved.root);
  if (commandId) sessionStarts.set(session, commandId);
  return session;
};
async function settle(session: ClientSession) {
  const until = Date.now() + 10_000;
  while (!session.getSnapshot().store || session.getSnapshot().store!.stale) {
    assert(Date.now() < until, "TEST actual Session did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const findWork = (session: ClientSession, setup: PipelineFixtureComplete) => {
  const work = Object.values(session.getSnapshot().store!.workItems).find(
    (w) =>
      w.native?.process?.provenance.processId === setup.artifact.processId &&
      w.native.process.provenance.commandId === sessionStarts.get(session),
  );
  assert(work, "TEST admitted native pipeline work is not projected");
  return work;
};
async function prepare(session: ClientSession, setup: PipelineFixtureComplete) {
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
async function start(
  session: ClientSession,
  setup: PipelineFixtureComplete,
  input: object = setup.input,
) {
  const target = await prepare(session, setup);
  const command = processStartCommand(target, { ...ids(), input });
  sessionStarts.set(session, command.commandId);
  savedStarts.set(sessionRoots.get(session)!, command.commandId);
  await session.send(command, false, target);
  await settle(session);
}
async function answer(session: ClientSession, setup: PipelineFixtureComplete) {
  const work = findWork(session, setup);
  assert.equal(work.status, "waiting_input");
  assert.equal(work.native!.process!.question!.question, setup.question);
  const target = captureProcessAnswerTarget(
    session.getSnapshot().store!,
    work.id,
    "conversation-1",
  );
  const command = processAnswerCommand(session.getSnapshot().store!, target, {
    ...ids(),
    answer: setup.answer,
  });
  await session.send(command);
  await settle(session);
  return command;
}
async function approve(
  session: ClientSession,
  setup: PipelineFixtureComplete,
  approved = true,
) {
  const work = findWork(session, setup);
  assert.equal(work.status, "waiting_approval");
  assert.deepEqual(
    JSON.parse(work.native!.process!.approval!.result.inputJson!),
    setup.createInput,
  );
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
  return command;
}

test("native designer qualification and public paired Session preserve the exact concrete meeting pipeline", async (t) => {
  const h = await pipelineHttpChildFixture({
    testAllowedOrigins: ["http://localhost:8087"],
  });
  let setup!: PipelineFixtureComplete;
  try {
    await t.test(
      "setup is passive; native designer, human acceptance, all six families and explicit activation share immutable provenance",
      async () => {
        const prepared = await h.setupOnly();
        const before = await h.inspect();
        assert.equal(before.processes.length, 0);
        assert.equal(before.modelCalls, 0);
        assert.deepEqual(before.serviceDispatches, []);
        assert.equal(prepared.definition.kind, "workflow");
        assert.deepEqual(Object.keys(prepared.input), [
          "contactId",
          "name",
          "email",
          "calendarId",
          "title",
          "start",
          "end",
          "timeZone",
        ]);
        setup = await h.completePipeline();
        assert.equal(setup.design.turn.status, "completed");
        assert.deepEqual(
          setup.design.turn.toolReceipts.map((r) => r.name),
          ["design_update_proposal"],
        );
        assert(setup.design.review.assumptions.every((a) => a.acknowledged));
        assert.deepEqual(setup.artifact.definition, prepared.definition);
        assert.equal(
          setup.job.stamp.compilerVersion,
          "niaro-native-workflow/3",
        );
        assert.equal(setup.job.status, "completed");
        assert.equal(setup.job.report?.observations.length, 12);
        assert.deepEqual(
          new Set(setup.job.report?.observations.map((o) => o.scenario)),
          new Set([
            "success",
            "rejection",
            "missing_input",
            "failure",
            "unknown",
            "restart",
          ]),
        );
        assert(
          setup.job.report!.observations.every(
            (o) => o.passed && o.assertions.length === 0,
          ),
        );
        assert.equal(setup.job.qualification?.status, "qualified");
        assert.equal(setup.job.qualification?.liveAcceptance, false);
        assert.equal(
          setup.activation.acknowledgement,
          "controlled_native_test_only",
        );
        assert.equal(setup.activation.testId, setup.job.testId);
        assert.equal(
          setup.activation.qualificationDigest,
          setup.job.qualification?.qualificationDigest,
        );
        assert.equal(setup.job.stamp.artifactDigest, setup.artifact.digest);
        assert.equal(setup.activation.artifactDigest, setup.artifact.digest);
        assert.equal(setup.activation.processId, setup.artifact.processId);
        const after = await h.inspect();
        assert.equal(after.modelCalls, 2);
        assert.deepEqual(after.serviceDispatches, []);
        assert.deepEqual(after.receipts, []);
        assert(
          !after.requests.some((r) => r.body?.includes('"type":"saveDraft"')),
        );
      },
    );
    for (const outcome of [
      "success",
      "rejection",
      "failure",
      "unknown",
    ] as const) {
      await t.test(
        `public meeting ${outcome} uses canonical receipts and stops effects at the exact boundary`,
        async () => {
          // Independent cases reopen the real fixture owner. This retains the
          // exact disk artifact and honors the ordinary ten-command window.
          await h.restart();
          await h.runtimeScenario(
            outcome === "rejection" ? "success" : outcome,
          );
          const before = await h.inspect();
          const saved = fileStorage(),
            transport = trackedTransport(saved);
          const session = newSession(setup, saved, transport.request);
          try {
            await session.start(false);
            await start(session, setup);
            assert.equal(
              transport.posts.at(-1)!.status,
              202,
              JSON.stringify(transport.posts.at(-1)),
            );
            assert.equal(findWork(session, setup).status, "waiting_input");
            assert.equal(
              (await h.inspect()).serviceDispatches.length -
                before.serviceDispatches.length,
              1,
            );
            await answer(session, setup);
            const waiting = await h.inspect();
            assert.equal(findWork(session, setup).status, "waiting_approval");
            assert.equal(
              waiting.serviceDispatches.length -
                before.serviceDispatches.length,
              2,
            );
            assert.equal(
              waiting.serviceDispatches
                .slice(before.serviceDispatches.length)
                .filter((d) => d.method === "POST").length,
              0,
            );
            await approve(session, setup, outcome !== "rejection");
            const work = findWork(session, setup);
            const counts = await h.inspect();
            const dispatches = counts.serviceDispatches.slice(
              before.serviceDispatches.length,
            );
            assert.equal(
              dispatches.filter((d) => d.method === "POST").length,
              outcome === "rejection" || outcome === "failure" ? 0 : 1,
            );
            assert.equal(
              dispatches.filter((d) => d.path.endsWith("/readback")).length,
              outcome === "success" ? 1 : 0,
            );
            assert.equal(counts.modelCalls - before.modelCalls, 2);
            assert.equal(
              work.native!.process!.provenance.artifactDigest,
              setup.artifact.digest,
            );
            assert.equal(
              work.native!.process!.provenance.actorId,
              setup.credential.scope.userId,
            );
            assert.equal(
              work.native!.process!.answerHistory![0]!.answer,
              setup.answer,
            );
            const receipts = work.native!.process!.receipts;
            const canonical = receipts.map((receipt) => {
              const saved = counts.receipts.find(
                (row) => row.id === receipt.operationId,
              );
              assert(
                saved,
                "TEST projected receipt has no canonical invocation",
              );
              assert.equal(saved.status, receipt.status);
              assert.equal(saved.effect, receipt.effect);
              assert.equal(saved.userId, setup.credential.scope.userId);
              return saved;
            });
            assert.deepEqual(
              canonical.find((row) => row.actionId === setup.actionIds.create)!
                .input,
              setup.createInput,
            );
            assert.deepEqual(
              receipts.map((r) => r.status),
              outcome === "success"
                ? ["succeeded", "succeeded", "succeeded", "succeeded"]
                : [
                    "succeeded",
                    "succeeded",
                    outcome === "rejection"
                      ? "rejected"
                      : outcome === "failure"
                        ? "failed"
                        : "unknown",
                  ],
            );
            if (outcome === "success") {
              assert.equal(work.status, "succeeded");
              assert.deepEqual(
                canonical.find(
                  (row) => row.actionId === setup.actionIds.readback,
                )!.result,
                setup.expectedResult,
              );
              assert(
                session
                  .getSnapshot()
                  .store!.conversations[
                    "conversation-1"
                  ]!.messages.some((message) => message.workItemId === work.id),
              );
              const reference = work.native!.process!.output;
              assert(
                reference,
                "TEST complete output must identify the original run",
              );
              const page = await session.loadProcessOutputPage({
                reference,
                path: [],
                cursor: null,
              });
              assert.equal(page.nextCursor, null);
              assert.deepEqual(
                Object.fromEntries(
                  page.children.map((child) => {
                    assert.equal(child.node.kind, "string");
                    return [
                      child.label,
                      "value" in child.node ? child.node.value : undefined,
                    ];
                  }),
                ),
                setup.expectedResult,
              );
              for (const value of Object.values(setup.input))
                assert(
                  page.children.some(
                    (child) =>
                      "value" in child.node && child.node.value === value,
                  ),
                  value,
                );
              assert.deepEqual(
                ProcessRuntimeResponseSchema.parse(transport.posts.at(-1)!.data)
                  .process?.output,
                setup.expectedResult,
              );
              const loops = LoopPageSchema.parse((await h.loops()).data);
              const entry = loops.entries.find(
                (e) =>
                  e.process?.runId === work.native!.process!.provenance.runId,
              );
              assert(entry);
              const detail = LoopDetailSchema.parse(
                (await h.loops(entry.id)).data,
              );
              assert.equal(
                detail.run.process?.artifactDigest,
                setup.artifact.digest,
              );
              assert.equal(
                detail.run.process?.processId,
                setup.artifact.processId,
              );
              assert.equal(detail.run.status, "succeeded");
            } else
              assert.equal(
                work.status,
                outcome === "unknown"
                  ? "waiting_system"
                  : outcome === "rejection"
                    ? "cancelled"
                    : "failed",
              );
            assert.equal(
              work.native!.process!.status,
              outcome === "rejection"
                ? "cancelled"
                : outcome === "success"
                  ? "succeeded"
                  : outcome === "unknown"
                    ? "unknown"
                    : "failed",
            );
            await session.refresh();
            assert.deepEqual(
              (await h.inspect()).serviceDispatches,
              counts.serviceDispatches,
            );
            assert.equal((await h.inspect()).modelCalls, counts.modelCalls);
            assert.equal(
              counts.requests.filter(
                (r) =>
                  r.method === "POST" &&
                  r.path.split("?")[0]?.endsWith("/commands") &&
                  !r.path.includes("/processes/"),
              ).length,
              0,
            );
          } finally {
            session.stop();
            rmSync(saved.root, { recursive: true, force: true });
          }
        },
      );
    }
    await t.test(
      "an unavailable Calendar slot returns typed unavailable without proposing or dispatching a write",
      async () => {
        await h.restart();
        await h.runtimeScenario("unavailable");
        const before = await h.inspect();
        const saved = fileStorage(),
          transport = trackedTransport(saved),
          session = newSession(setup, saved, transport.request);
        try {
          await session.start(false);
          await start(session, setup);
          await answer(session, setup);
          const work = findWork(session, setup);
          assert.equal(work.status, "succeeded");
          assert.equal(work.native!.process!.approval, undefined);
          assert.deepEqual(
            work.native!.process!.receipts.map((r) => r.status),
            ["succeeded", "succeeded"],
          );
          assert.deepEqual(
            ProcessRuntimeResponseSchema.parse(transport.posts.at(-1)!.data)
              .process?.output,
            setup.unavailableResult,
          );
          const after = await h.inspect();
          assert.equal(after.modelCalls - before.modelCalls, 2);
          assert.deepEqual(
            after.serviceDispatches
              .slice(before.serviceDispatches.length)
              .map((d) => d.method),
            ["GET", "GET"],
          );
          await session.refresh();
          assert.deepEqual(
            (await h.inspect()).serviceDispatches,
            after.serviceDispatches,
          );
        } finally {
          session.stop();
          rmSync(saved.root, { recursive: true, force: true });
        }
      },
    );
    await t.test(
      "missing typed input rejects admission before any model or service dispatch",
      async () => {
        await h.restart();
        await h.runtimeScenario("success");
        const before = await h.inspect();
        const saved = fileStorage(),
          transport = trackedTransport(saved),
          session = newSession(setup, saved, transport.request);
        try {
          await session.start(false);
          await start(session, setup, {});
          assert.equal(transport.posts[0]!.status, 422);
          assert.equal(
            ProcessRuntimeResponseSchema.parse(transport.posts[0]!.data)
              .admission.status,
            "rejected",
          );
          const after = await h.inspect();
          assert.equal(after.modelCalls, before.modelCalls);
          assert.deepEqual(after.serviceDispatches, before.serviceDispatches);
        } finally {
          session.stop();
          rmSync(saved.root, { recursive: true, force: true });
        }
      },
    );
    for (const boundary of ["answer", "approval"] as const) {
      await t.test(
        `lost ${boundary} ACK and server reopen preserve original file-backed command bytes without repeating effects`,
        async () => {
          await h.restart();
          await h.runtimeScenario("success");
          const saved = fileStorage(),
            transport = trackedTransport(saved);
          let session = newSession(setup, saved, transport.request);
          try {
            await session.start(false);
            await start(session, setup);
            if (boundary === "approval") await answer(session, setup);
            transport.loseNext();
            const command =
              boundary === "answer"
                ? await answer(session, setup)
                : await approve(session, setup);
            assert.deepEqual(session.getSnapshot().pending, command);
            assert.equal(session.getSnapshot().error, "network_error");
            const original = transport.posts.at(-1)!;
            const before = await h.inspect();
            await h.restart();
            await session.retry();
            await settle(session);
            assert.equal(transport.posts.at(-1)!.body, original.body);
            assert.deepEqual(transport.posts.at(-1)!.data, original.data);
            const after = await h.inspect();
            assert.equal(after.modelCalls, before.modelCalls);
            assert.deepEqual(after.serviceDispatches, before.serviceDispatches);
            const received = after.requests.filter((r) =>
              r.body?.includes(command.commandId),
            );
            assert.equal(received.length, 2);
            assert(received.every((r) => r.body === original.body));
            if (boundary === "answer") await approve(session, setup);
            assert.equal(findWork(session, setup).status, "succeeded");
            session.stop();
            session = newSession(
              setup,
              fileStorage(saved.root),
              transport.request,
            );
            await session.start(false);
            assert.equal(session.getSnapshot().pending, null);
            assert.equal(findWork(session, setup).status, "succeeded");
            const final = await h.inspect();
            await session.refresh();
            assert.equal((await h.inspect()).modelCalls, final.modelCalls);
            assert.deepEqual(
              (await h.inspect()).serviceDispatches,
              final.serviceDispatches,
            );
          } finally {
            session.stop();
            rmSync(saved.root, { recursive: true, force: true });
          }
        },
      );
    }
  } finally {
    await h.close();
  }
});

for (const kind of ["service", "model", "permission"] as const)
  test(`qualified pipeline ${kind} drift blocks a new effect from the original approval`, async () => {
    const h = await pipelineHttpChildFixture();
    let session: ClientSession | undefined;
    const saved = fileStorage();
    try {
      const setup = await h.completePipeline();
      const transport = trackedTransport(saved);
      session = newSession(setup, saved, transport.request);
      await session.start(false);
      await start(session, setup);
      await answer(session, setup);
      const work = findWork(session, setup);
      const target = captureProcessResolveTarget(
        session.getSnapshot().store!,
        work.id,
        undefined,
        "conversation-1",
        work,
      );
      const command = processResolveCommand(
        session.getSnapshot().store!,
        target,
        { ...ids(), approved: true },
      );
      const before = await h.inspect();
      await h.drift(kind);
      await session.send(command, false, target);
      const response = transport.posts.at(-1)!;
      assert(
        [400, 401, 403, 409, 422].includes(response.status),
        JSON.stringify(response),
      );
      if (response.status === 400)
        assert.equal(
          (response.data as { error: string }).error,
          "process_definition_invalid",
        );
      const after = await h.inspect();
      assert.deepEqual(after.serviceDispatches, before.serviceDispatches);
      assert.equal(after.modelCalls, before.modelCalls);
      assert.equal(
        after.serviceDispatches.filter((d) => d.method === "POST").length,
        0,
      );
    } finally {
      session?.stop();
      rmSync(saved.root, { recursive: true, force: true });
      await h.close();
    }
  });
