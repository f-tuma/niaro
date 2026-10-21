import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ClientSession } from "../packages/client-core/session";
import { authRequest } from "../packages/client-core/auth";
import { CredentialSchema, type WorkItem } from "../packages/protocol";
import {
  captureProcessResolveTarget,
  processResolveCommand,
  processStartCommand,
} from "../packages/client-core/process-commands";
import {
  PROCESS_VERSION_PROFILE,
  ProcessVersionListSchema,
} from "../packages/protocol/process-versions";
import {
  ProcessRecordSchema,
  ProcessVersionSchema,
} from "../packages/protocol/service-processes";
import {
  activationHttpFixture,
  activationHttpPath,
} from "./helpers/process-activation-http";
import { designHttpFixture } from "./helpers/process-design-http";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../packages/protocol/process-questions";
import {
  NativeTestToolsSchema,
  PROCESS_NATIVE_TEST_PROFILE,
} from "../packages/protocol/process-native-testing";

test("an incomplete copied reopen keeps its original error and cleanup removes both private roots and the listener", async () => {
  const h = await designHttpFixture();
  const original = h.root;
  rmSync(join(original, "identity", "secret"));
  try {
    await assert.rejects(h.restoreCopy(), /requires its original secret/);
    assert.notEqual(
      dirname(h.config.administration!.identity!.directory),
      original,
    );
  } finally {
    await h.close();
  }
  assert.equal(existsSync(original), false);
  assert.equal(
    existsSync(dirname(h.config.administration!.identity!.directory)),
    false,
  );
  await assert.rejects(fetch(h.origin, { signal: AbortSignal.timeout(1000) }));
});

// Every stored credential and business response is synthetic. Public lifecycle
// HTTP, Session commands, native Mastra and all SQLite files are real.
test("a copied stopped identity/workflow/native tuple preserves public pinned approvals through qualified v2 activation and v1 rollback", async () => {
  const h = await activationHttpFixture();
  const dispatches: string[] = [];
  const install = () => {
    Object.defineProperty(h.identity["catalog"], "transport", {
      value: async (
        request: Parameters<typeof h.scriptedModelTransport>[0],
      ) => {
        if (new URL(request.url).origin === "https://models.example.test")
          return h.scriptedModelTransport(request);
        assert.equal(
          new URL(request.url).origin,
          "https://services.example.test",
        );
        assert(request.beforeDispatch);
        await request.beforeDispatch(() =>
          dispatches.push(request.method ?? "GET"),
        );
        return { status: 200, headers: {}, text: '{"value":"TEST-result"}' };
      },
      configurable: true,
    });
  };
  const activate = async (
    input: Awaited<ReturnType<typeof h.fresh>>,
    expected: number | null,
  ) => {
    const job = await h.runNative(input);
    const command = {
      ...h.command(input, job, randomUUID()),
      expectedActiveVersion: expected,
    };
    const response = await h.request("owner", activationHttpPath, command);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return { command, receipt: h.receipt(response.data), job };
  };
  const saved = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => saved.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  let session: ClientSession | undefined;
  try {
    const first = await h.fresh();
    const v1 = await activate(first, null);
    const toolResponse = await h.request(
      "owner",
      "api/identity/catalog/processes/tests/native/tools?" +
        new URLSearchParams({
          ...h.target,
          profile: PROCESS_NATIVE_TEST_PROFILE,
          processId: first.processId,
          version: String(first.version),
          genericModelId: h.modelId,
        }),
    );
    assert.equal(toolResponse.status, 200);
    const tools = NativeTestToolsSchema.parse(toolResponse.data);
    const writeTool = tools.configured
      .flatMap((node) => node.tools)
      .find((tool) => "actionId" in tool && tool.actionId === h.writeId);
    assert(
      writeTool,
      "TEST immutable tool inventory must bind the actual write action",
    );
    const pairing = h.record(
      (await h.request("owner", "api/identity/mobile/pairing", h.target)).data,
    );
    const credential = CredentialSchema.parse(
      await authRequest(
        String(pairing.address),
        "pair",
        fetch,
        undefined,
        String(pairing.code),
        false,
        true,
      ),
    );
    const endpoint = String(pairing.address);
    const makeSession = () =>
      new ClientSession(
        endpoint,
        storage,
        credential,
        fetch,
        undefined,
        undefined,
        false,
        { processQuestions: true, processApprovals: true },
      );
    session = makeSession();
    await session.start(false);
    install();
    h.onModel((request) =>
      (request.messages ?? []).some((m) => m.role === "tool")
        ? { content: '{"result":"TEST-result"}' }
        : {
            tool_calls: [
              {
                id: randomUUID(),
                type: "function",
                function: {
                  name: writeTool.name,
                  arguments: '{"name":"TEST-input"}',
                },
              },
            ],
          },
    );
    const settle = async () => {
      const end = Date.now() + 15000;
      while (
        !session!.getSnapshot().store ||
        session!.getSnapshot().store!.stale
      ) {
        assert(
          Date.now() < end,
          "TEST restored public Session failed to settle",
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const start = async (input: typeof first) => {
      const inventory = await session!.loadProcessInventory();
      const entry = inventory.processes.find(
        (p) => p.processId === input.processId,
      )!;
      assert.equal(entry.availability, "ready");
      const card = await session!.prepareProcessInput(
        {
          processId: input.processId,
          version: input.version,
          artifactDigest: input.artifactDigest,
          language: "en",
          origin: {
            type: "command",
            conversationId: "conversation-1",
            requestId: randomUUID(),
          },
        },
        entry,
      );
      const command = processStartCommand(card, {
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        language: "en",
        input: { name: "TEST-input" },
      });
      await session!.send(command, false, card);
      await settle();
      return command.commandId;
    };
    const work = (id: string): WorkItem => {
      const item = Object.values(session!.getSnapshot().store!.workItems).find(
        (w) => w.native?.process?.provenance.commandId === id,
      );
      assert(item, "TEST pinned process projection is missing");
      return item;
    };
    const a = await start(first);
    assert.equal(work(a).status, "waiting_approval");
    const aPin = structuredClone(work(a).native!.process!.provenance);
    const aApproval = structuredClone(work(a).native!.process!.approval);
    assert.equal(aPin.version, 1);
    assert.equal(dispatches.length, 0);

    // Edit/freeze using actual HTTP without changing the already frozen budget
    // policy: an unrelated policy revision would correctly invalidate v1.
    const current = await h.process(first.processId);
    const edited = await h.request(
      "owner",
      "api/identity/catalog/processes/command",
      {
        ...h.target,
        type: "saveDraft",
        id: first.processId,
        serviceId: h.serviceId,
        revision: current.revision,
        definition: { ...current.draft, name: current.name + " v2" },
      },
    );
    assert.equal(edited.status, 200);
    const draft = ProcessRecordSchema.parse(h.record(edited.data).process);
    const frozen = await h.request(
      "owner",
      "api/identity/catalog/processes/command",
      {
        ...h.target,
        type: "freezeDraft",
        id: first.processId,
        revision: draft.revision,
      },
    );
    assert.equal(frozen.status, 200);
    const second = h.nativeRequest(
      ProcessVersionSchema.parse(h.record(frozen.data).version),
      ProcessRecordSchema.parse(h.record(frozen.data).process).revision,
    );
    const v2 = await activate(second, 1);
    const b = await start(second);
    assert.equal(work(b).status, "waiting_approval");
    const bPin = structuredClone(work(b).native!.process!.provenance);
    const bApproval = structuredClone(work(b).native!.process!.approval);
    assert.equal(bPin.version, 2);
    assert.equal(dispatches.length, 0);
    session.stop();
    const modelCalls = h.modelCount();
    const restored = await h.restoreCopy();
    assert.notEqual(restored.source, restored.destination);
    assert.deepEqual(restored.copyHashes, restored.sourceHashes);
    assert(restored.copyHashes["identity/secret"]);
    assert(restored.copyHashes["identity/identity.sqlite"]);
    assert(
      Object.keys(restored.copyHashes).some((path) =>
        path.endsWith("server-id"),
      ),
    );
    assert(
      Object.keys(restored.copyHashes).some((path) =>
        path.endsWith("workflow.sqlite"),
      ),
    );
    assert(
      Object.keys(restored.copyHashes).some((path) =>
        path.endsWith("identity.sqlite.mastra.sqlite"),
      ),
      "TEST copied tuple must contain the native Mastra storage",
    );
    assert(restored.copyHashes["TEST-server-config.json"]);
    assert.equal(
      restored.integrity.length,
      Object.keys(restored.copyHashes).filter((path) =>
        path.endsWith(".sqlite"),
      ).length,
    );
    for (const item of restored.integrity) {
      assert.deepEqual(item.checks, ["ok"], item.path);
      assert.deepEqual(item.foreignKeys, [], item.path);
    }
    assert.equal(
      h.identity["catalog"].store.provider(
        h.target.organizationId,
        h.providerId,
      ).key,
      "TEST-HTTP-provider-key",
    );
    assert.equal(h.modelCount(), modelCalls);
    assert.equal(dispatches.length, 0);
    install();
    const rollback = {
      ...h.command(first, v1.job, randomUUID()),
      type: "rollback",
      revision: (await h.process(first.processId)).revision,
      expectedActiveVersion: 2,
    };
    const rolled = await h.request("owner", activationHttpPath, rollback);
    assert.equal(rolled.status, 200, JSON.stringify(rolled.data));
    assert.equal((await h.process(first.processId)).activeVersion, 1);
    for (const original of [v1, v2]) {
      const replay = await h.request(
        "owner",
        activationHttpPath,
        original.command,
      );
      assert.equal(replay.status, 200);
      assert.deepEqual(h.receipt(replay.data), original.receipt);
      assert.equal((await h.process(first.processId)).activeVersion, 1);
    }
    session = makeSession();
    await session.start(false);
    await settle();
    assert.deepEqual(work(a).native!.process!.provenance, aPin);
    assert.deepEqual(work(b).native!.process!.provenance, bPin);
    assert.deepEqual(work(a).native!.process!.approval, aApproval);
    assert.deepEqual(work(b).native!.process!.approval, bApproval);
    assert.equal(h.modelCount(), modelCalls);
    assert.equal(dispatches.length, 0);
    const decide = async (id: string, approved: boolean) => {
      const item = work(id);
      const target = captureProcessResolveTarget(
        session!.getSnapshot().store!,
        item.id,
        undefined,
        "conversation-1",
        item,
      );
      const command = processResolveCommand(
        session!.getSnapshot().store!,
        target,
        {
          commandId: randomUUID(),
          idempotencyKey: randomUUID(),
          language: "en",
          approved,
        },
      );
      await session!.send(command, false, target);
      await settle();
      assert.equal(work(id).status, approved ? "succeeded" : "cancelled");
      return command;
    };
    const decisionA = await decide(a, true);
    const decisionB = await decide(b, true);
    assert.equal(work(a).native!.process!.provenance.version, 1);
    assert.equal(work(b).native!.process!.provenance.version, 2);
    assert.deepEqual(dispatches, ["POST", "POST"]);
    const c = await start(first);
    assert.equal(work(c).status, "waiting_approval");
    assert.equal(work(c).native!.process!.provenance.version, 1);
    assert.equal(
      work(c).native!.process!.provenance.artifactDigest,
      first.artifactDigest,
    );
    await decide(c, false);
    assert.deepEqual(dispatches, ["POST", "POST"]);
    const after = h.modelCount();
    await h.restart();
    install();
    session.stop();
    session = makeSession();
    await session.start(false);
    await settle();
    assert.equal(work(a).status, "succeeded");
    assert.equal(work(b).status, "succeeded");
    assert.equal(work(c).status, "cancelled");
    assert.equal(h.modelCount(), after);
    assert.deepEqual(dispatches, ["POST", "POST"]);
    // Session correctly refuses a new decision on an already resolved target.
    // Replay the original exact bytes through paired HTTP to exercise the
    // server's durable command receipt, rather than claim a local refusal as
    // evidence that a second request reached the server.
    for (const command of [decisionA, decisionB]) {
      const replay = await fetch(
        endpoint +
          "/processes/commands?profile=" +
          encodeURIComponent(PROCESS_QUESTION_EXECUTION_PROFILE),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + credential.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(15000),
        },
      );
      assert.equal(replay.status, 202, await replay.text());
    }
    assert.equal(h.modelCount(), after);
    assert.deepEqual(dispatches, ["POST", "POST"]);
    const history = await h.request(
      "owner",
      "api/identity/catalog/processes/versions?" +
        new URLSearchParams({
          ...h.target,
          profile: PROCESS_VERSION_PROFILE,
          processId: first.processId,
        }),
    );
    assert.equal(history.status, 200);
    const versions = ProcessVersionListSchema.parse(history.data);
    assert.equal(
      versions.versions.find((v) => v.version === 1)?.digest,
      first.artifactDigest,
    );
  } finally {
    session?.stop();
    await h.close();
  }
});
