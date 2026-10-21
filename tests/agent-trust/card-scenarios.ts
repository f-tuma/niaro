import assert from "node:assert/strict";
import {
  CommandSchema,
  type Command,
  type Snapshot,
} from "../../packages/protocol";
import type { ServiceResult } from "../../packages/protocol/service-result";
import {
  createTrustHarness,
  type ModelRequest,
  type TrustHarness,
} from "./harness";
import type { TrustScenario } from "./types";

function serviceResult(
  snapshot: Snapshot,
  operationId?: string,
): ServiceResult {
  const results = snapshot.conversations
    .flatMap((conversation) => conversation.messages)
    .map((message) => message.result)
    .filter(
      (result): result is ServiceResult =>
        result?.type === "service.action" &&
        (!operationId || result.operationId === operationId),
    );
  assert(
    results.length,
    "Expected an authoritative service result in the conversation",
  );
  return results.at(-1)!;
}

function writes(h: TrustHarness) {
  return h.network.filter((request) => request.path.endsWith("/meetings"));
}

function resolve(operationId: string, id: string, approved = true): Command {
  return CommandSchema.parse({
    type: "service.resolve",
    commandId: id,
    idempotencyKey: id,
    conversationId: "conversation-1",
    operationId,
    approved,
    language: "en",
  });
}

/** Scripted language reflects the fixture receipt; this does not grade a live model. */
function lifecycleScript(h: TrustHarness, body: ModelRequest) {
  const outcome = [...(body.messages ?? [])]
    .reverse()
    .find(
      (message) =>
        message.role === "user" &&
        message.content?.startsWith("[Server] The person"),
    )?.content;
  if (outcome?.includes('"status":"unknown"'))
    return {
      content:
        "I cannot verify whether the meeting was created. Check the calendar before retrying.",
    };
  if (outcome?.includes('"status":"rejected"'))
    return { content: "The proposal was declined. No meeting was created." };
  if (outcome?.includes("TEST-created-meeting"))
    return { content: "The meeting was created." };
  return h.writeScript(body);
}

const request =
  "Create a meeting with jane@example.test from 2026-10-01T12:00:00Z to 2026-10-01T12:30:00Z.";
const expectedInput = {
  attendee: "jane@example.test",
  start: "2026-10-01T12:00:00Z",
  end: "2026-10-01T12:30:00Z",
};

function form() {
  return {
    title: "Find a contact",
    nodes: [
      {
        id: "name",
        type: "input",
        label: "Contact name",
        kind: "text",
        required: true,
      },
      { id: "button", type: "button", actionId: "find" },
    ],
    root: ["name", "button"],
    actions: [
      {
        id: "find",
        label: "Find contact",
        kind: "submit",
        variant: "primary",
        fields: ["name"],
      },
    ],
  };
}

async function prepareForm(h: TrustHarness, id: string) {
  let composed = false;
  h.onChat(() => {
    if (!composed) {
      composed = true;
      return h.call("compose_card", form());
    }
    return { content: "Enter the contact name." };
  });
  const first = await h.send("Prepare a contact lookup form.", { id });
  const message = first.snapshot.conversations[0]!.messages.at(-1)!;
  assert(message.result?.type === "card.document");
  const response = CommandSchema.parse({
    type: "card.respond",
    commandId: `${id}-response`,
    idempotencyKey: `${id}-response`,
    conversationId: "conversation-1",
    messageId: message.id,
    cardId: message.result.document.id,
    expectedCardRevision: message.result.document.revision,
    actionId: "find",
    language: "en",
    values: { name: "Jane Test" },
  });
  assert(response.type === "card.respond");
  return { first, message, response };
}

export const cardScenarios: TrustScenario[] = [
  {
    id: "action-lifecycle",
    title: "A proposal, a decision and a verified effect remain distinct",
    run: async (probe) => {
      for (const approved of [true, false]) {
        const h = createTrustHarness({ signal: probe.signal });
        probe.defer(() => h.close());
        const branch = approved ? "approved" : "declined";
        try {
          h.onChat((body) => lifecycleScript(h, body));
          const pending = await h.send(request, {
            id: `TEST-lifecycle-${branch}`,
          });
          const proposal = serviceResult(pending.snapshot);
          await probe.check(
            `${branch}.proposal`,
            "The displayed proposal has the exact requested effect and no write has run",
            () => {
              assert.equal(proposal.status, "awaiting_approval");
              assert.equal(proposal.effect, "write");
              assert.deepEqual(JSON.parse(proposal.inputJson), {
                body: expectedInput,
              });
              assert.equal(writes(h).length, 0);
              assert.equal(
                h.catalog.invocation(
                  proposal.operationId,
                  h.scope.workspaceId,
                  h.scope.userId,
                )?.status,
                "awaiting_approval",
              );
              assert.deepEqual(proposal.card?.actions, []);
              assert(
                !proposal.card?.nodes.some(
                  (node) => node.type === "button" || node.type === "input",
                ),
              );
            },
          );
          const command = resolve(
            proposal.operationId,
            `TEST-lifecycle-${branch}-decision`,
            approved,
          );
          const completed = await h.execute(command);
          const outcome = serviceResult(
            completed.snapshot,
            proposal.operationId,
          );
          await probe.check(
            `${branch}.effect`,
            "Only explicit approval produces one matching write; declining produces none",
            () => {
              assert.equal(completed.status, "accepted");
              assert.equal(outcome.status, approved ? "succeeded" : "rejected");
              assert.equal(writes(h).length, approved ? 1 : 0);
              if (approved) {
                assert.deepEqual(writes(h)[0]!.body, expectedInput);
                assert.equal(
                  h.catalog.invocation(
                    proposal.operationId,
                    h.scope.workspaceId,
                    h.scope.userId,
                  )?.status,
                  "succeeded",
                );
                assert.deepEqual(
                  h.catalog.invocation(
                    proposal.operationId,
                    h.scope.workspaceId,
                    h.scope.userId,
                  )?.result,
                  { id: "TEST-created-meeting", created: true },
                );
              }
            },
          );
          const calls = h.requests.length;
          await probe.check(
            `${branch}.replay`,
            "Decision replay and a file-backed restart reuse the receipt without inference or another write",
            async () => {
              assert.deepEqual(await h.execute(command), completed);
              await h.restart();
              assert.deepEqual(await h.execute(command), completed);
              assert.equal(h.requests.length, calls);
              assert.equal(writes(h).length, approved ? 1 : 0);
              assert.equal(
                serviceResult(
                  h.workflow.snapshot(h.scope),
                  proposal.operationId,
                ).status,
                outcome.status,
              );
            },
          );
          probe.observe(branch, {
            proposalStatus: proposal.status,
            operationStatus: outcome.status,
            commandStatus: completed.status,
            serviceWrites: writes(h).length,
            modelRequests: h.requests.length,
          });
        } finally {
          await h.close();
        }
      }
    },
  },
  {
    id: "unknown-write-result",
    title:
      "A lost response after dispatch remains unknown and is never repeated",
    run: async (probe) => {
      const h = createTrustHarness({ signal: probe.signal });
      probe.defer(() => h.close());
      try {
        h.writeResponse = "lost";
        h.onChat((body) => lifecycleScript(h, body));
        const pending = await h.send(request, { id: "TEST-unknown-proposal" });
        const proposal = serviceResult(pending.snapshot);
        const command = resolve(proposal.operationId, "TEST-unknown-decision");
        const completed = await h.execute(command);
        const outcome = serviceResult(completed.snapshot, proposal.operationId);
        await probe.check(
          "unknown.authoritative-state",
          "A dispatched write without a response is unknown, with no verified result or success badge",
          () => {
            assert.equal(writes(h).length, 1);
            assert.equal(outcome.status, "unknown");
            const receipt = h.catalog.invocation(
              proposal.operationId,
              h.scope.workspaceId,
              h.scope.userId,
            );
            assert.equal(receipt?.status, "unknown");
            assert.equal(receipt?.result, undefined);
            assert(
              !outcome.card?.nodes.some(
                (node) => node.type === "badge" && node.tone === "success",
              ),
            );
            assert(
              outcome.card?.nodes.some(
                (node) => node.type === "notice" && node.tone === "warning",
              ),
            );
            assert.match(
              completed.snapshot.conversations[0]!.messages.at(-1)!.text,
              /(?:cannot verify|could not be verified).*(?:before retrying|before repeating)/,
            );
          },
        );
        const calls = h.requests.length;
        await probe.check(
          "unknown.no-automatic-repeat",
          "Repeated decisions, a new confirmation command and restart cannot resend the unknown write",
          async () => {
            assert.deepEqual(await h.execute(command), completed);
            await h.execute(
              resolve(proposal.operationId, "TEST-unknown-second-decision"),
            );
            await h.restart();
            const replayed = await h.execute(command);
            assert.equal(replayed.commandId, completed.commandId);
            assert.equal(replayed.status, completed.status);
            assert.equal(replayed.code, completed.code);
            assert.equal(
              serviceResult(replayed.snapshot, proposal.operationId).status,
              "unknown",
            );
            assert.equal(writes(h).length, 1);
            assert.equal(h.requests.length, calls);
            assert.equal(
              h.catalog.invocation(
                proposal.operationId,
                h.scope.workspaceId,
                h.scope.userId,
              )?.status,
              "unknown",
            );
          },
        );
        probe.observe("outcome", {
          agentKnownStatus: outcome.status,
          syntheticDispatches: writes(h).length,
          hasVerifiedResult: false,
          finalReply:
            completed.snapshot.conversations[0]!.messages.at(-1)!.text,
          languageProvider:
            "scripted; quality of live inference is not measured",
        });
      } finally {
        await h.close();
      }
    },
  },
  {
    id: "card-visible-intent-and-staleness",
    title:
      "Visible form intent binds identity, revision and the current conversation",
    run: async (probe) => {
      const h = createTrustHarness({ signal: probe.signal });
      probe.defer(() => h.close());
      try {
        const { response } = await prepareForm(h, "TEST-visible-card");
        const calls = h.requests.length;
        await probe.check(
          "card.foreign-scopes",
          "Another authenticated principal or workspace cannot answer the stored card",
          async () => {
            for (const scope of [
              { ...h.scope, userId: "TEST-bob" },
              {
                ...h.scope,
                workspaceId: "22222222-2222-4222-8222-222222222222",
                connectionId: "account-22222222-2222-4222-8222-222222222222",
              },
            ]) {
              const denied = await h.executeAs(scope, response);
              assert.notEqual(denied.status, "accepted");
            }
            assert.equal(h.requests.length, calls);
            assert.equal(h.network.length, 0);
          },
        );
        await probe.check(
          "card.invalid-revision-and-hidden-data",
          "Old revisions and undeclared answer fields are rejected before inference",
          async () => {
            const stale = await h.execute({
              ...response,
              commandId: "TEST-visible-stale",
              idempotencyKey: "TEST-visible-stale",
              expectedCardRevision: response.expectedCardRevision + 1,
            });
            assert.equal(stale.code, "revision_conflict");
            const forged = await h.execute({
              ...response,
              commandId: "TEST-visible-forged",
              idempotencyKey: "TEST-visible-forged",
              values: { name: "Jane Test", approved: true },
            });
            assert.equal(forged.code, "invalid_answer");
            assert.equal(h.requests.length, calls);
            assert.equal(h.network.length, 0);
          },
        );
        h.onChat((body) => h.lookupScript(body));
        const completed = await h.execute(response);
        await probe.check(
          "card.visible-effect",
          "The form sends exactly its visible labels and values, then runs only the requested lookup",
          () => {
            assert.equal(completed.status, "accepted");
            const user = h.requests
              .slice(calls)
              .flatMap((body) => body.messages ?? [])
              .find(
                (message) =>
                  message.role === "user" &&
                  message.content === "Find contact\nContact name: Jane Test",
              );
            assert(user, "The model must receive only the visible form intent");
            assert.equal(h.network.length, 1);
            assert(h.network[0]!.path.endsWith("/contacts"));
            assert.equal(writes(h).length, 0);
            assert.equal(serviceResult(completed.snapshot).status, "succeeded");
            assert.equal(serviceResult(completed.snapshot).effect, "read");
          },
        );
        const after = h.requests.length;
        await probe.check(
          "card.replay-and-superseded-click",
          "A response replay is passive, while a new click on the superseded card is rejected",
          async () => {
            assert.deepEqual(await h.execute(response), completed);
            const stale = await h.execute({
              ...response,
              commandId: "TEST-visible-click-again",
              idempotencyKey: "TEST-visible-click-again",
            });
            assert.equal(stale.code, "revision_conflict");
            assert.equal(h.requests.length, after);
            assert.equal(h.network.length, 1);
          },
        );
        probe.observe("visibleIntent", {
          label: "Find contact",
          userText: "Find contact\nContact name: Jane Test",
          readEffects: h.network.length,
          writeEffects: writes(h).length,
          scopeBoundary:
            "Real ModelService over synthetic authenticated scopes; HTTP login itself is covered by separate regression tests",
        });
      } finally {
        await h.close();
      }

      const raced = createTrustHarness({ signal: probe.signal });
      probe.defer(() => raced.close());
      try {
        const { response } = await prepareForm(raced, "TEST-raced-card");
        raced.onChat((body) => raced.lookupScript(body));
        let changed = false;
        raced.onBeforeActionDispatch(() => {
          if (changed) return;
          changed = true;
          const current = raced.workflow.snapshot(raced.scope);
          raced.workflow.execute(
            raced.scope,
            CommandSchema.parse({
              type: "message.send",
              commandId: "TEST-concurrent-topic",
              idempotencyKey: "TEST-concurrent-topic",
              conversationId: "conversation-1",
              text: "New topic",
              language: "en",
            }),
            {
              expectedCursor: current.cursor,
              timeZone: "UTC",
              decision: {
                kind: "reply",
                reply: "The person moved to another topic.",
                title: null,
                contactId: null,
                localStart: null,
                durationMinutes: null,
              },
            },
          );
        });
        const denied = await raced.execute(response);
        await probe.check(
          "card.changed-before-dispatch",
          "A concurrent turn at the transport guard invalidates a previously valid click before service I/O",
          () => {
            assert(changed);
            assert.equal(denied.status, "conflict");
            assert.equal(denied.code, "revision_conflict");
            assert.equal(raced.network.length, 0);
          },
        );
      } finally {
        raced.close();
      }
    },
  },
  {
    id: "card-claims-checker-wiring",
    title:
      "A checker rejection removes unsupported display claims before repair",
    run: async (probe) => {
      const h = createTrustHarness({ signal: probe.signal });
      probe.defer(() => h.close());
      try {
        let calls = 0;
        h.onChat(() => {
          if (++calls === 1)
            return h.call("compose_card", {
              title: "Meeting created",
              nodes: [
                {
                  id: "status",
                  type: "badge",
                  label: "Created successfully",
                  tone: "success",
                },
              ],
              root: ["status"],
              actions: [],
            });
          return {
            content:
              calls === 2
                ? "The meeting was created."
                : "I cannot verify that a meeting was created.",
          };
        });
        h.onDecision((body) =>
          body.questions?.route.criteria.complete ? "incomplete" : undefined,
        );
        const result = await h.send("Tell me whether a meeting was created.", {
          id: "TEST-unsupported-card",
        });
        await probe.check(
          "claims.checker-input",
          "The checker receives the card's readable claim and its authoritative tool evidence",
          () => {
            const checker = h.requests.find(
              (body) => body.questions?.route.criteria.complete,
            );
            assert(checker);
            const card = checker.state?.composedCard as
              | { displayData?: string }
              | undefined;
            assert(card?.displayData);
            assert(card.displayData.includes("Meeting created"));
            assert(card.displayData.includes("Created successfully"));
            assert(Array.isArray(checker.state?.results));
          },
        );
        await probe.check(
          "claims.rejected-body-removed",
          "Rejected claims disappear from the final message and durable turn without an external effect",
          () => {
            const message = result.snapshot.conversations[0]!.messages.at(-1)!;
            assert.equal(
              message.text,
              "I cannot verify that a meeting was created.",
            );
            assert.equal(message.result, undefined);
            const saved = h.catalog.latestTurn(
              h.scope.workspaceId,
              h.scope.userId,
            )?.value as
              | { card?: unknown; answer?: { card?: unknown } }
              | undefined;
            assert.equal(saved?.card, undefined);
            assert.equal(saved?.answer?.card, undefined);
            assert.equal(h.network.length, 0);
          },
        );
        probe.observe("measurementBoundary", {
          checkerResponse: "scripted incomplete",
          demonstrates:
            "Card claims are forwarded to the checker and rejected content is removed",
          liveModelJudgmentAccuracy: "not measured",
          visibleFinalReply:
            result.snapshot.conversations[0]!.messages.at(-1)!.text,
        });
      } finally {
        await h.close();
      }
    },
  },
];
