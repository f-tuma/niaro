import assert from "node:assert/strict";
import {
  CommandSchema,
  type Command,
  type Snapshot,
} from "../../packages/protocol";
import type { ServiceResult } from "../../packages/protocol/service-result";
import {
  createTrustHarness,
  toolResults,
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

export const answerScenarios: TrustScenario[] = [
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
    id: "ui-program-admission",
    title:
      "An answer's UI program is admitted by the shared library before it is stored",
    run: async (probe) => {
      const h = createTrustHarness({ signal: probe.signal });
      probe.defer(() => h.close());
      try {
        let calls = 0;
        h.onChat(() =>
          ++calls === 1
            ? {
                content:
                  'Here is the contact form.\n\n```openui-lang\nroot = Stack([Text(q.name)])\nq = Query("crm", {}, {name: ""})\n```',
              }
            : {
                content:
                  'Here is the contact form.\n\n```openui-lang\nroot = Stack([form, links])\nform = Form("find", [TextField("name", "Contact name", null, null, true)], Button("Find contact", @ToAssistant("Find contact")))\nlinks = Buttons([Button("Open", @OpenUrl("javascript:alert(1)")), Button("Docs", @OpenUrl("https://example.test/help"))])\n```',
              },
        );
        const result = await h.send("Prepare a contact lookup form.", {
          id: "TEST-ui-admission",
        });
        const message = result.snapshot.conversations[0]!.messages.at(-1)!;
        await probe.check(
          "ui.data-fetching-refused",
          "A program that fetches data is refused once and the model answers again",
          () => {
            assert.equal(calls, 2);
            assert(
              JSON.stringify(h.requests).includes(
                "Query and Mutation are not supported",
              ),
            );
          },
        );
        await probe.check(
          "ui.normalized-and-passive",
          "The stored program keeps the visible form and the checked link, drops the script link, and runs nothing",
          () => {
            assert.equal(message.text, "Here is the contact form.");
            const program = message.ui?.program ?? "";
            assert(program.includes('@ToAssistant("Find contact")'));
            assert(program.includes("https://example.test/help"));
            assert(!program.includes("javascript:"));
            assert.equal(message.result, undefined);
            assert.equal(h.network.length, 0);
            assert.equal(writes(h).length, 0);
          },
        );
        probe.observe("uiAdmission", {
          program: message.ui?.program,
          boundary:
            "A follow-up button only fills the person's message box on the client; the server sees it as an ordinary message",
        });
      } finally {
        await h.close();
      }
    },
  },
  {
    id: "ui-claims-checker-wiring",
    title: "A checker rejection removes unsupported UI claims before repair",
    run: async (probe) => {
      // The turn writes (approval not required here), so the checker still
      // judges it; a read-only answer no longer goes through the checker.
      const h = createTrustHarness({
        signal: probe.signal,
        writeApproval: "never",
      });
      probe.defer(() => h.close());
      try {
        let answers = 0;
        h.onChat((body) => {
          const results = toolResults(body);
          if (!results.some((result) => result.status === "succeeded"))
            return h.call(h.tool("Create meeting"), {
              body: {
                attendee: "jane@example.test",
                start: "2026-10-01T12:00:00Z",
                end: "2026-10-01T12:30:00Z",
              },
            });
          return ++answers === 1
            ? {
                content:
                  'The meeting was created.\n\n```openui-lang\nroot = Stack([Heading("Meeting created"), Badge("Created successfully", "success")])\n```',
              }
            : { content: "I cannot verify that a meeting was created." };
        });
        h.onDecision((body) =>
          body.questions?.route.criteria.complete ? "incomplete" : undefined,
        );
        const result = await h.send("Create the meeting with Jane.", {
          id: "TEST-unsupported-ui",
        });
        await probe.check(
          "claims.checker-input",
          "The checker receives the UI's readable claims and its authoritative tool evidence",
          () => {
            const checker = h.requests.find(
              (body) => body.questions?.route.criteria.complete,
            );
            assert(checker);
            const ui = checker.state?.generatedUi as
              | { displayData?: string }
              | undefined;
            assert(ui?.displayData);
            assert(ui.displayData.includes("Meeting created"));
            assert(ui.displayData.includes("Created successfully"));
            assert(Array.isArray(checker.state?.results));
          },
        );
        await probe.check(
          "claims.rejected-body-removed",
          "Rejected claims disappear from the final message and durable turn; the repair adds no external effect",
          () => {
            const message = result.snapshot.conversations[0]!.messages.at(-1)!;
            assert.equal(
              message.text,
              "I cannot verify that a meeting was created.",
            );
            assert.equal(message.ui, undefined);
            const saved = h.catalog.latestTurn(
              h.scope.workspaceId,
              h.scope.userId,
            )?.value as { answer?: { ui?: unknown } } | undefined;
            assert.equal(saved?.answer?.ui, undefined);
            // The one write the turn made; the repair added no call.
            assert.equal(h.network.length, 1);
          },
        );
        probe.observe("measurementBoundary", {
          checkerResponse: "scripted incomplete",
          demonstrates:
            "UI claims are forwarded to the checker and rejected content is removed",
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
