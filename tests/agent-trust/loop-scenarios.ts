import assert from "node:assert/strict";
import type { Command, CommandResult } from "../../packages/protocol";
import { retryMessageCommand } from "../../packages/client-core/commands";
import {
  createTrustHarness,
  toolResults,
  type ModelRequest,
  type TrustHarness,
} from "./harness";
import type { TrustScenario } from "./types";

function latestTurn(h: TrustHarness) {
  return h.commandState();
}

function savedTurn(h: TrustHarness, commandId: string) {
  return h.commandState(commandId);
}

function reply(result: CommandResult) {
  const message = result.snapshot.conversations
    .flatMap((conversation) => conversation.messages)
    .find((entry) => entry.replyToCommandId === result.commandId);
  assert(message, "An accepted command must have its own visible reply");
  return message;
}

function assertPairedTools(requests: ModelRequest[]) {
  for (const request of requests)
    for (const message of request.messages ?? [])
      for (const call of message.tool_calls ?? [])
        assert.equal(
          request.messages!.filter(
            (entry) => entry.role === "tool" && entry.tool_call_id === call.id,
          ).length,
          1,
          "Every carried tool call needs exactly one result before inference",
        );
}

export const loopScenarios: TrustScenario[] = [
  {
    id: "loop.clarification-after-restart",
    title:
      "An answer after restart continues the paused goal and verified read",
    async run(probe) {
      const h = createTrustHarness({ signal: probe.signal });
      probe.defer(() => h.close());
      try {
        const goal =
          "Prepare a meeting with Jane Test; find her contact and ask which day.";
        h.onChat((body) =>
          toolResults(body).some((result) => result.data?.contacts)
            ? h.call("ask_user", {
                question: "Which day should the meeting be?",
              })
            : h.lookupScript(body),
        );
        const first = await h.send(goal, { id: "TEST-paused-goal" });
        const paused = latestTurn(h);
        await probe.check(
          "paused-working-state",
          "The goal, question and read provenance are persisted before waiting",
          () => {
            assert.equal(first.status, "accepted");
            assert.equal(paused.kind, "mastra-1");
            assert.equal(paused.pending?.kind, "question");
            assert.equal(paused.text, goal);
            assert.equal(paused.pending?.question, reply(first).text);
            assert.equal(paused.sources.length, 1);
            assert.equal(h.network.length, 1);
          },
        );
        await h.restart();
        await probe.check(
          "reopened-working-state",
          "Closing both databases and opening a fresh runtime preserves the paused turn",
          () => {
            assert.equal(latestTurn(h).commandId, "TEST-paused-goal");
            assert.equal(latestTurn(h).pending?.kind, "question");
            assert.equal(latestTurn(h).threadId, paused.threadId);
            assert.equal(latestTurn(h).runId, paused.runId);
          },
        );
        let received: ModelRequest | undefined;
        h.onChat((body) => {
          received = body;
          return {
            content: "Jane's contact is saved. The meeting should be tomorrow.",
          };
        });
        const next = await h.send("Tomorrow", { id: "TEST-goal-answer" });
        await probe.check(
          "continued-goal",
          "The follow-up sees the original goal, open question and authorized facts without redispatching the read",
          () => {
            assert.equal(next.status, "accepted");
            assert(received);
            assert(
              received.messages?.some(
                (message) =>
                  message.role === "user" && message.content === goal,
              ),
              "Native conversation memory must retain the original task",
            );
            assert(
              JSON.stringify(received.messages).includes(
                paused.pending!.question!,
              ),
              "Native context must retain the exact outstanding question",
            );
            assert(
              toolResults(received).some(
                (result) =>
                  result.data?.contacts?.[0]?.email === "jane@example.test",
              ),
            );
            assert.equal(latestTurn(h).threadId, paused.threadId);
            assert.equal(latestTurn(h).pending, undefined);
            assert.deepEqual(latestTurn(h).sources, paused.sources);
            assert.equal(h.network.length, 1);
            assertPairedTools(h.requests);
          },
        );
        probe.observe("continuation", {
          initialGoal: goal,
          threadId: latestTurn(h).threadId,
          providerDispatches: h.network.length,
          reply: reply(next).text,
        });
      } finally {
        await h.close();
      }
    },
  },
  {
    id: "loop.topic-detour",
    title:
      "A topic detour preserves suspended work; explicit return resumes its exact native run",
    async run(probe) {
      const h = createTrustHarness({ signal: probe.signal });
      probe.defer(() => h.close());
      try {
        const goal = "Prepare a meeting with Jane Test and ask which day.";
        h.onChat((body) =>
          toolResults(body).some((result) => result.data?.contacts)
            ? h.call("ask_user", { question: "Which day?" })
            : h.lookupScript(body),
        );
        const initial = await h.send(goal, { id: "TEST-before-detour" });
        const original = latestTurn(h);
        const task = initial.snapshot.workItems.find(
          (work) => work.id === original.runId,
        )!;
        assert(task?.native?.question);
        const dispatches = h.network.length;
        h.onDecision((body) =>
          "continue_work" in body.questions!.route.criteria
            ? "new_task"
            : undefined,
        );
        let detourRequest: ModelRequest | undefined;
        h.onChat((body) => {
          detourRequest = body;
          return { content: "Prague." };
        });
        const detour = "What is the capital of Czechia?";
        await h.send(detour, { id: "TEST-detour" });
        await probe.check(
          "detour-clears-active-work",
          "A separate request replaces the active goal and drops its carried service facts",
          () => {
            assert(detourRequest);
            assert.equal(latestTurn(h).text, detour);
            assert.equal(latestTurn(h).pending, undefined);
            assert.deepEqual(latestTurn(h).sources, []);
            assert(
              !toolResults(detourRequest).some(
                (result) => result.data?.contacts,
              ),
            );
            assert.equal(h.network.length, dispatches);
          },
        );
        const returnText = "Back to the earlier meeting: tomorrow, please.";
        h.onChat(() =>
          h.call("ask_user", { question: "Which meeting should I continue?" }),
        );
        await h.send(returnText, { id: "TEST-return-from-detour" });
        await probe.check(
          "detour-never-authorizes-write",
          "Neither the detour nor its return silently dispatches a meeting write",
          () => {
            assert.equal(h.network.length, dispatches);
            assert.equal(latestTurn(h).text, returnText);
          },
        );
        await h.restart();
        h.workflow.syncNativeWork(h.scope, await h.runtime().tasks!());
        const currentTask = h.workflow
          .snapshot(h.scope)
          .workItems.find((work) => work.id === task.id)!;
        const modelCalls = h.requests.length;
        const selected = await h.execute({
          type: "task.open",
          commandId: "TEST-select-original-goal",
          idempotencyKey: "TEST-select-original-goal",
          conversationId: task.conversationId,
          workItemId: task.id,
          expectedWorkRevision: currentTask.revision,
          language: "en",
        });
        assert.equal(selected.status, "accepted");
        assert.equal(h.requests.length, modelCalls);
        h.onChat(() => ({
          content: "The day is recorded for the original meeting.",
        }));
        const completed = await h.execute({
          type: "message.send",
          commandId: "TEST-resume-original-goal",
          idempotencyKey: "TEST-resume-original-goal",
          conversationId: task.conversationId,
          text: "Tomorrow, please.",
          language: "en",
          context: {
            runtime: "mastra",
            workItemId: task.id,
            inputRequestId: task.native!.question!.id,
            expectedInputRevision: task.native!.question!.revision,
          },
        });
        await probe.check(
          "explicit-durable-goal-return",
          "After detour and restart, selecting is passive and a bound answer resumes the original run without writing",
          () => {
            assert.equal(completed.status, "accepted");
            assert.equal(
              savedTurn(h, "TEST-resume-original-goal").runId,
              original.runId,
            );
            assert.equal(
              savedTurn(h, "TEST-resume-original-goal").threadId,
              original.threadId,
            );
            assert.equal(h.network.length, dispatches);
            assert.equal(
              completed.snapshot.workItems.find((work) => work.id === task.id)
                ?.status,
              "succeeded",
            );
          },
        );
      } finally {
        await h.close();
      }
    },
  },
  {
    id: "loop.explicit-new-session",
    title:
      "An explicit new session archives the prior conversation and starts fresh",
    async run(probe) {
      const h = createTrustHarness({ signal: probe.signal });
      probe.defer(() => h.close());
      try {
        const oldGoal = "TEST old goal: prepare a meeting with Jane Test.";
        h.onChat(() => h.call("ask_user", { question: "Which day?" }));
        await h.send(oldGoal, { id: "TEST-before-new-session" });
        const oldThread = latestTurn(h).threadId;
        let freshRequest: ModelRequest | undefined;
        h.onChat((body) => {
          freshRequest = body;
          return { content: "Prague." };
        });
        const freshGoal = "What is the capital of Czechia?";
        const fresh = await h.send(freshGoal, {
          id: "TEST-new-session",
          session: "new",
        });
        await probe.check(
          "new-session-isolated",
          "The new session receives no old task or paused question, while the old chat is archived",
          () => {
            assert.equal(fresh.status, "accepted");
            assert(freshRequest);
            assert.equal(latestTurn(h).text, freshGoal);
            assert.equal(latestTurn(h).pending, undefined);
            assert.notEqual(latestTurn(h).threadId, oldThread);
            assert(!JSON.stringify(freshRequest.messages).includes(oldGoal));
            assert.deepEqual(latestTurn(h).sources, []);
            assert.equal(h.workflow.sessions(h.scope).length, 1);
            assert.equal(h.network.length, 0);
          },
        );
        probe.observe("new-session", {
          archivedSessions: h.workflow.sessions(h.scope).length,
          activeRequest: latestTurn(h).text,
          providerDispatches: h.network.length,
        });
      } finally {
        await h.close();
      }
    },
  },
  ...(["before", "after"] as const).map(
    (phase): TrustScenario => ({
      id: `loop.cancellation-${phase}-receipt`,
      title: `Controlled cancellation ${phase} a read receipt permits an explicit retry without repeating a recorded read`,
      async run(probe) {
        const h = createTrustHarness({ signal: probe.signal });
        probe.defer(() => h.close());
        try {
          h.onChat(h.lookupScript);
          const abort = new AbortController();
          const command: Command = {
            type: "message.send",
            commandId: `TEST-cancellation-${phase}-public`,
            idempotencyKey: `TEST-cancellation-${phase}-key`,
            conversationId: "conversation-1",
            text: "Find Jane Test",
            language: "en",
            timeZone: "UTC",
          };
          const invoke = h.controller.invoke.bind(h.controller);
          let attemptedOperation: string | undefined;
          h.controller.invoke = async (...args) => {
            attemptedOperation = args[0].requestId;
            if (phase === "after") await invoke(...args);
            const interruption = Error(`TEST interrupted ${phase} receipt`);
            abort.abort(interruption);
            throw interruption;
          };
          await probe.check(
            "terminal-cancellation",
            "AbortController cancellation prevents the wire reply; a discarded proposal has no receipt and a committed read remains authoritative",
            async () => {
              await assert.rejects(
                h.execute(command, abort.signal),
                /TEST interrupted/,
              );
              const interrupted = savedTurn(h, command.idempotencyKey);
              assert(attemptedOperation);
              assert.deepEqual(
                interrupted.operations,
                phase === "after" ? [attemptedOperation] : [],
              );
              assert(interrupted.threadId);
              assert(interrupted.runId);
              const receipt = h.catalog.invocation(
                attemptedOperation,
                h.scope.workspaceId,
                h.scope.userId,
              );
              assert.equal(
                receipt?.status,
                phase === "after" ? "succeeded" : undefined,
              );
              assert.equal(interrupted.answer, undefined);
              assert.equal(interrupted.trace?.status, "cancelled");
              assert.equal(h.network.length, phase === "after" ? 1 : 0);
            },
          );
          const recordedOperation = savedTurn(h, command.idempotencyKey)
            .operations[0];
          await h.restart();
          const retry = retryMessageCommand(
            command as Extract<Command, { type: "message.send" }>,
            {
              commandId: `TEST-cancellation-${phase}-retry-public`,
              idempotencyKey: `TEST-cancellation-${phase}-retry-key`,
            },
          );
          const recovered = await h.execute(retry);
          await probe.check(
            "explicit-retry-preserves-effects",
            "A fresh explicit retry reads the committed result or executes the previously unexecuted read once; cancellation is not orphaned-run recovery",
            () => {
              assert.equal(recovered.status, "accepted");
              assert.equal(reply(recovered).text, "Contact found.");
              assert.equal(h.network.length, 1);
              assert.equal(latestTurn(h).pending, undefined);
              const completed = latestTurn(h);
              const parent = savedTurn(h, command.idempotencyKey);
              assert.notEqual(completed.runId, parent.runId);
              assert.notEqual(completed.threadId, parent.threadId);
              assert.equal(completed.operations.length, 1);
              if (phase === "after")
                assert.deepEqual(completed.operations, [recordedOperation]);
              const receipt = h.catalog.invocation(
                completed.operations[0]!,
                h.scope.workspaceId,
                h.scope.userId,
              );
              assert(receipt);
              assert.equal(receipt.status, "succeeded");
              assert.equal(receipt.organizationId, h.target.organizationId);
              const conversation = recovered.snapshot.conversations.find(
                (entry) => entry.id === command.conversationId,
              );
              assert.equal(
                conversation?.messages.filter(
                  (message) =>
                    message.role === "user" &&
                    message.logicalMessageId === command.commandId,
                ).length,
                1,
              );
              assert.equal(receipt.workspaceId, h.scope.workspaceId);
              assert.equal(receipt.userId, h.scope.userId);
              assert.deepEqual(receipt.input, { name: "Jane Test" });
              assert(completed.sources.every((id) => id === receipt.id));
              assertPairedTools(h.requests);
            },
          );
          const inference = h.requests.length;
          const replay = await h.execute(retry);
          await probe.check(
            "workflow-replay-passive",
            "Repeating the completed wire command reads its durable receipt without inference or provider calls",
            () => {
              assert.deepEqual(replay, recovered);
              assert.equal(h.requests.length, inference);
              assert.equal(h.network.length, 1);
            },
          );
          probe.observe("cancellationRetry", {
            phase,
            recordedBeforeRetry: phase === "after",
            operationIds: latestTurn(h).operations,
            providerDispatches: h.network.length,
            pending: latestTurn(h).pending ?? null,
            replayInference: h.requests.length - inference,
          });
        } finally {
          await h.close();
        }
      },
    }),
  ),
  {
    id: "loop.retry-rejects-interrupted-parent",
    title: "Explicit retry cannot start from an interrupted native parent",
    async run(probe) {
      const h = createTrustHarness({ signal: probe.signal });
      probe.defer(() => h.close());
      try {
        h.onChat(() => ({ content: "TEST original result" }));
        const original: Command = {
          type: "message.send",
          commandId: "TEST-interrupted-parent-public",
          idempotencyKey: "TEST-interrupted-parent-key",
          conversationId: "conversation-1",
          text: "TEST request with an interrupted parent",
          language: "en",
          timeZone: "UTC",
        };
        const accepted = await h.execute(original);
        assert.equal(accepted.status, "accepted");
        const parent = savedTurn(h, original.idempotencyKey);
        parent.trace!.status = "interrupted";
        h.catalog.saveTurn(
          parent.runId,
          h.scope.workspaceId,
          h.scope.userId,
          parent,
        );
        const retry = retryMessageCommand(
          original as Extract<Command, { type: "message.send" }>,
          {
            commandId: "TEST-interrupted-child-public",
            idempotencyKey: "TEST-interrupted-child-key",
          },
        );
        const providerCalls = h.requests.length;
        const rejected = await h.execute(retry);
        await probe.check(
          "interrupted-parent-rejected-before-inference",
          "An interrupted parent is not eligible for the explicit retry action and must be rejected before provider dispatch",
          () => {
            assert.equal(rejected.status, "conflict");
            assert(
              ["catalog_conflict", "revision_conflict"].includes(rejected.code),
            );
            assert.equal(h.requests.length, providerCalls);
            assert.equal(
              savedTurn(h, parent.commandId).trace?.status,
              "interrupted",
            );
          },
        );
      } finally {
        await h.close();
      }
    },
  },
  ...(["committed", "unknown"] as const).map(
    (outcome): TrustScenario => ({
      id: `loop.retry-${outcome}-write`,
      title: `An explicit retry cannot repeat a ${outcome} external write`,
      async run(probe) {
        const h = createTrustHarness({
          signal: probe.signal,
          writeApproval: "never",
        });
        probe.defer(() => h.close());
        try {
          if (outcome === "unknown") h.writeResponse = "lost";
          h.onChat(h.writeScript);
          const abort = new AbortController();
          const command: Command = {
            type: "message.send",
            commandId: `TEST-retry-${outcome}-write-public`,
            idempotencyKey: `TEST-retry-${outcome}-write-key`,
            conversationId: "conversation-1",
            text: "Create a meeting with Jane Test",
            language: "en",
            timeZone: "UTC",
          };
          if (outcome === "committed") {
            const invoke = h.controller.invoke.bind(h.controller);
            h.controller.invoke = async (...args) => {
              await invoke(...args);
              abort.abort(Error("TEST cancelled after committed write"));
              throw Error("TEST cancelled after committed write");
            };
            await assert.rejects(
              h.execute(command, abort.signal),
              /TEST cancelled after committed write/,
            );
          } else {
            const initial = await h.execute(command);
            assert.equal(initial.status, "accepted");
          }
          const parent = savedTurn(h, command.idempotencyKey);
          assert.equal(
            parent.trace?.status,
            outcome === "committed" ? "cancelled" : "unknown",
          );
          assert.equal(parent.operations.length, 1);
          const operationId = parent.operations[0]!;
          const receipt = h.catalog.invocation(
            operationId,
            h.scope.workspaceId,
            h.scope.userId,
          );
          assert.equal(
            receipt?.status,
            outcome === "committed" ? "succeeded" : "unknown",
          );
          const inferenceCalls = h.requests.length;
          const serviceCalls = h.network.filter((entry) =>
            entry.path.includes("/meetings"),
          ).length;
          const retry = retryMessageCommand(
            command as Extract<Command, { type: "message.send" }>,
            {
              commandId: `TEST-retry-${outcome}-write-child-public`,
              idempotencyKey: `TEST-retry-${outcome}-write-child-key`,
            },
          );
          let retryResult: CommandResult | undefined;
          let retryError: unknown;
          try {
            retryResult = await h.execute(retry);
          } catch (error) {
            retryError = error;
          }
          await probe.check(
            `${outcome}.write-blocked-before-inference`,
            "The parent write receipt remains authoritative and an explicit retry is rejected before model or service dispatch",
            () => {
              assert(retryError || retryResult?.status !== "accepted");
              assert.equal(h.requests.length, inferenceCalls);
              assert.equal(
                h.network.filter((entry) => entry.path.includes("/meetings"))
                  .length,
                serviceCalls,
              );
              assert.equal(
                h.catalog.invocation(
                  operationId,
                  h.scope.workspaceId,
                  h.scope.userId,
                )?.status,
                outcome === "committed" ? "succeeded" : "unknown",
              );
            },
          );
          probe.observe(`retry-${outcome}-write`, {
            parentOperation: receipt?.status,
            retry: "blocked",
            additionalInference: h.requests.length - inferenceCalls,
            additionalServiceDispatches:
              h.network.filter((entry) => entry.path.includes("/meetings"))
                .length - serviceCalls,
          });
        } finally {
          await h.close();
        }
      },
    }),
  ),
  ...(["unknown", "succeeded"] as const).map(
    (outcome): TrustScenario => ({
      id: `loop.retry-stale-ancestor-after-${outcome}-descendant`,
      title: `A retry from an old cancelled ancestor is blocked after a child write becomes ${outcome}`,
      async run(probe) {
        const h = createTrustHarness({
          signal: probe.signal,
          writeApproval: "never",
        });
        probe.defer(() => h.close());
        try {
          h.onChat(h.writeScript);
          const parentAbort = new AbortController();
          const parentCommand: Command = {
            type: "message.send",
            commandId: "TEST-retry-lineage-parent-public",
            idempotencyKey: "TEST-retry-lineage-parent-key",
            conversationId: "conversation-1",
            text: "Create a meeting with Jane Test",
            language: "en",
            timeZone: "UTC",
          };
          const invoke = h.controller.invoke.bind(h.controller);
          h.controller.invoke = async (...args) => {
            parentAbort.abort(Error("TEST cancel before parent write"));
            throw Error("TEST cancel before parent write");
          };
          await assert.rejects(
            h.execute(parentCommand, parentAbort.signal),
            /TEST cancel before parent write/,
          );
          const parent = savedTurn(h, parentCommand.idempotencyKey);
          assert.equal(parent.trace?.status, "cancelled");
          h.controller.invoke = invoke;
          if (outcome === "unknown") h.writeResponse = "lost";
          const child = retryMessageCommand(
            parentCommand as Extract<Command, { type: "message.send" }>,
            {
              commandId: "TEST-retry-lineage-child-public",
              idempotencyKey: "TEST-retry-lineage-child-key",
            },
          );
          const childResult = await h.execute(child);
          assert.equal(childResult.status, "accepted");
          const childState = savedTurn(h, child.idempotencyKey);
          assert.equal(childState.trace?.status, outcome);
          assert.equal(childState.retryParentRunId, parent.runId);
          const childReplayInference = h.requests.length;
          const childReplayWrites = h.network.filter((entry) =>
            entry.path.includes("/meetings"),
          ).length;
          assert.deepEqual(await h.execute(child), childResult);
          assert.equal(h.requests.length, childReplayInference);
          assert.equal(
            h.network.filter((entry) => entry.path.includes("/meetings"))
              .length,
            childReplayWrites,
          );
          const inferenceCalls = h.requests.length;
          const serviceCalls = h.network.filter((entry) =>
            entry.path.includes("/meetings"),
          ).length;
          const staleRetry = retryMessageCommand(
            parentCommand as Extract<Command, { type: "message.send" }>,
            {
              commandId: "TEST-retry-lineage-stale-public",
              idempotencyKey: "TEST-retry-lineage-stale-key",
            },
          );
          let staleResult: CommandResult | undefined;
          let retryError: unknown;
          try {
            staleResult = await h.execute(staleRetry);
          } catch (error) {
            retryError = error;
          }
          await probe.check(
            "unknown-descendant-blocks-stale-ancestor",
            "Once a retry descendant has an unknown write outcome, another retry from its cancelled ancestor is rejected before inference or service dispatch",
            () => {
              assert(retryError || staleResult?.status !== "accepted");
              assert.equal(h.requests.length, inferenceCalls);
              assert.equal(
                h.network.filter((entry) => entry.path.includes("/meetings"))
                  .length,
                serviceCalls,
              );
            },
          );
          probe.observe(`retry-lineage-${outcome}-child`, {
            parent: parent.trace?.status,
            child: childState.trace?.status,
            staleAncestorRetry: "blocked",
            additionalInference: h.requests.length - inferenceCalls,
            additionalServiceDispatches:
              h.network.filter((entry) => entry.path.includes("/meetings"))
                .length - serviceCalls,
          });
        } finally {
          await h.close();
        }
      },
    }),
  ),
  {
    id: "loop.retry-transitive-unknown-descendant",
    title:
      "A safe cancelled retry child is allowed, but an unknown grandchild blocks retries from the original ancestor",
    async run(probe) {
      const h = createTrustHarness({
        signal: probe.signal,
        writeApproval: "never",
      });
      probe.defer(() => h.close());
      try {
        h.onChat(h.writeScript);
        const original = h.controller.invoke.bind(h.controller);
        const parentCommand: Command = {
          type: "message.send",
          commandId: "TEST-retry-transitive-parent-public",
          idempotencyKey: "TEST-retry-transitive-parent-key",
          conversationId: "conversation-1",
          text: "Create a meeting with Jane Test",
          language: "en",
          timeZone: "UTC",
        };
        const parentAbort = new AbortController();
        h.controller.invoke = async () => {
          parentAbort.abort(Error("TEST cancel parent"));
          throw Error("TEST cancel parent");
        };
        await assert.rejects(
          h.execute(parentCommand, parentAbort.signal),
          /TEST cancel parent/,
        );
        const childCommand = retryMessageCommand(
          parentCommand as Extract<Command, { type: "message.send" }>,
          {
            commandId: "TEST-retry-transitive-child-public",
            idempotencyKey: "TEST-retry-transitive-child-key",
          },
        );
        const childAbort = new AbortController();
        h.controller.invoke = async () => {
          childAbort.abort(Error("TEST cancel safe child"));
          throw Error("TEST cancel safe child");
        };
        await assert.rejects(
          h.execute(childCommand, childAbort.signal),
          /TEST cancel safe child/,
        );
        const parent = savedTurn(h, parentCommand.idempotencyKey);
        const child = savedTurn(h, childCommand.idempotencyKey);
        assert.equal(child.trace?.status, "cancelled");
        assert.equal(child.operations.length, 0);
        const safeAncestorRetry = retryMessageCommand(
          parentCommand as Extract<Command, { type: "message.send" }>,
          {
            commandId: "TEST-retry-transitive-safe-ancestor-public",
            idempotencyKey: "TEST-retry-transitive-safe-ancestor-key",
          },
        );
        const safeRetryAbort = new AbortController();
        h.controller.invoke = async () => {
          safeRetryAbort.abort(Error("TEST cancel safe ancestor retry"));
          throw Error("TEST cancel safe ancestor retry");
        };
        await assert.rejects(
          h.execute(safeAncestorRetry, safeRetryAbort.signal),
          /TEST cancel safe ancestor retry/,
        );
        const safeRetry = savedTurn(h, safeAncestorRetry.idempotencyKey);
        assert.equal(safeRetry.trace?.status, "cancelled");
        assert.equal(safeRetry.retryParentRunId, parent.runId);
        h.controller.invoke = original;
        h.writeResponse = "lost";
        const grandchildCommand = retryMessageCommand(childCommand, {
          commandId: "TEST-retry-transitive-grandchild-public",
          idempotencyKey: "TEST-retry-transitive-grandchild-key",
        });
        const grandchildResult = await h.execute(grandchildCommand);
        assert.equal(grandchildResult.status, "accepted");
        const grandchild = savedTurn(h, grandchildCommand.idempotencyKey);
        assert.equal(grandchild.trace?.status, "unknown");
        assert.equal(grandchild.retryParentRunId, child.runId);
        assert.equal(child.retryParentRunId, parent.runId);
        const inferenceCalls = h.requests.length;
        const serviceCalls = h.network.filter((entry) =>
          entry.path.includes("/meetings"),
        ).length;
        const staleRetry = retryMessageCommand(
          parentCommand as Extract<Command, { type: "message.send" }>,
          {
            commandId: "TEST-retry-transitive-stale-public",
            idempotencyKey: "TEST-retry-transitive-stale-key",
          },
        );
        const result = await h.execute(staleRetry);
        await probe.check(
          "grandchild-unknown-blocks-root-retry",
          "A settled failed-only child permits a new retry, but an unknown write two attempts later blocks reuse of the original ancestor before inference or dispatch",
          () => {
            assert.notEqual(result.status, "accepted");
            assert.equal(h.requests.length, inferenceCalls);
            assert.equal(
              h.network.filter((entry) => entry.path.includes("/meetings"))
                .length,
              serviceCalls,
            );
          },
        );
      } finally {
        await h.close();
      }
    },
  },
  {
    id: "loop.busy-session-reset",
    title:
      "A busy new-session request cannot archive a running request's context",
    async run(probe) {
      const h = createTrustHarness({ signal: probe.signal });
      probe.defer(() => h.close());
      let release = () => {};
      let running: Promise<CommandResult> | undefined;
      try {
        h.onChat(() => ({
          content: "The current conversation is established.",
        }));
        await h.send("Keep this conversation", {
          id: "TEST-existing-conversation",
        });
        h.onChat(h.lookupScript);
        let reached = () => {};
        const atBoundary = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        h.onBeforeActionDispatch(async () => {
          reached();
          await gate;
        });
        running = h.send("Find Jane Test", { id: "TEST-running-request" });
        await Promise.race([
          atBoundary,
          running.then(() => {
            throw Error("The running request completed before its checkpoint");
          }),
        ]);
        const before = h.workflow.snapshot(h.scope);
        const sessions = h.workflow.sessions(h.scope);
        await probe.check(
          "busy-request-has-no-reset",
          "The server refuses concurrent inference before mutating the active conversation or archived sessions",
          async () => {
            await assert.rejects(
              h.send("Start another task", {
                id: "TEST-busy-new-session",
                session: "new",
              }),
              /model_busy/,
            );
            assert.deepEqual(h.workflow.snapshot(h.scope), before);
            assert.deepEqual(h.workflow.sessions(h.scope), sessions);
            assert.equal(h.network.length, 0);
          },
        );
        release();
        const completed = await running;
        await probe.check(
          "running-request-completes",
          "Releasing the provider boundary lets the original request finish in its original conversation exactly once",
          async () => {
            assert.equal(completed.status, "accepted");
            assert.equal(reply(completed).text, "Contact found.");
            assert.equal(h.network.length, 1);
            assert.equal(h.workflow.sessions(h.scope).length, sessions.length);
            assert(
              completed.snapshot.conversations[0]?.messages.some(
                (message) => message.text === "Keep this conversation",
              ),
            );
          },
        );
        probe.observe("busy-session", {
          providerDispatches: h.network.length,
          archivedSessions: h.workflow.sessions(h.scope).length,
          originalReply: reply(completed).text,
        });
      } finally {
        release();
        await running?.catch(() => {});
        await h.close();
      }
    },
  },
  {
    id: "loop.bounded-invalid-tools",
    title:
      "Repeated unsupported tools terminate at the server's inference budget",
    async run(probe) {
      const h = createTrustHarness({ signal: probe.signal });
      probe.defer(() => h.close());
      const unsupportedName = "TEST_PRIVATE_NONEXISTENT_TOOL";
      const privateArgument = "TEST_PRIVATE_UNAVAILABLE_ARGUMENT";
      let attemptedCalls: Awaited<ReturnType<typeof h.nativeInvocations>> = [];
      try {
        h.onChat(() =>
          h.call(unsupportedName, {
            command: "create anything",
            token: privateArgument,
          }),
        );
        await probe.check(
          "invalid-tools-bounded",
          "The runtime publishes a durable step-limit failure, preserves its budget and makes no external call",
          async () => {
            const result = await h.send("Try an unavailable tool", {
              id: "TEST-invalid-tools",
            });
            assert.equal(result.status, "accepted");
            assert.match(reply(result).text, /step limit/);
            assert.equal(
              h.requests.filter((request) => request.messages).length,
              12,
            );
            assert.equal(h.network.length, 0);
            assert.equal(latestTurn(h).modelCalls, 12);
            assert.equal(latestTurn(h).inference, 12);
            assert.equal(latestTurn(h).calls, 0);
            assert.deepEqual(latestTurn(h).operations, []);
            assert.deepEqual(latestTurn(h).receipts, []);
            assert.equal(latestTurn(h).pending, undefined);
            assert.equal(latestTurn(h).answer?.reply, reply(result).text);
            assert.equal(latestTurn(h).trace?.status, "failed");
            assertPairedTools(h.requests);
            const invocations = await h.nativeInvocations(
              latestTurn(h).threadId,
            );
            assert.equal(invocations.length, 12);
            attemptedCalls = invocations;
            assert(
              invocations.every(
                (call) =>
                  call.state === "output-error" &&
                  call.toolName === "niaro_unavailable_tool" &&
                  typeof call.errorText === "string" &&
                  /Tool "niaro_unavailable_tool" not found/.test(
                    call.errorText,
                  ),
              ),
              "Mastra must persist every attempted unsupported tool as an explicit tool error",
            );
            assert(
              invocations.every((call) => Object.keys(call.args).length === 0),
            );
            assert.equal(
              new Set(invocations.map((call) => call.toolCallId)).size,
              12,
            );
            const failures =
              latestTurn(h).trace?.steps.filter(
                (step) => step.kind === "tool",
              ) ?? [];
            assert.equal(
              failures.length,
              12,
              "Each unavailable attempt produces one completed observer pair",
            );
            assert(
              failures.every(
                (step) =>
                  step.status === "failed" &&
                  step.finishedAt &&
                  step.tool?.outcome === "unavailable" &&
                  step.tool.input.length === 0,
              ),
            );
            assert.deepEqual(
              new Set(failures.map((step) => step.callId)),
              new Set(invocations.map((call) => call.toolCallId)),
            );
            for (const value of [
              latestTurn(h),
              h.requests,
              await h.nativeMessages(latestTurn(h).threadId),
            ]) {
              const encoded = JSON.stringify(value);
              assert(!encoded.includes(unsupportedName));
              assert(!encoded.includes(privateArgument));
            }
          },
        );
        await h.restart();
        await probe.check(
          "exhausted-budget-after-restart",
          "Reopening the stores and retrying the same command cannot reset its inference budget",
          async () => {
            assert.equal(latestTurn(h).modelCalls, 12);
            assert.equal(latestTurn(h).inference, 12);
            const inferenceRequests = h.requests.length;
            const replay = await h.send("Try an unavailable tool", {
              id: "TEST-invalid-tools",
            });
            assert.equal(replay.status, "accepted");
            assert.match(reply(replay).text, /step limit/);
            assert.equal(h.requests.length, inferenceRequests);
            assert.equal(h.network.length, 0);
            assert.equal(latestTurn(h).modelCalls, 12);
            assert.equal(latestTurn(h).inference, 12);
            assert.equal(latestTurn(h).calls, 0);
            assert.deepEqual(latestTurn(h).operations, []);
            assert.deepEqual(latestTurn(h).receipts, []);
            assert.deepEqual(
              await h.nativeInvocations(latestTurn(h).threadId),
              attemptedCalls,
            );
          },
        );
        probe.observe("budget", {
          modelCalls: latestTurn(h).modelCalls,
          inference: latestTurn(h).inference,
          providerDispatches: h.network.length,
          rejection: "catalog_budget_exhausted",
        });
      } finally {
        await h.close();
      }
    },
  },
];
