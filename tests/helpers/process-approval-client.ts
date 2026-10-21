import { ClientSession } from "../../packages/client-core/session";
import { processCommandDigest } from "../../packages/client-core/process-command-digest";
import { WorkItemSchema } from "../../packages/protocol";
import type { ProcessResolveCommand } from "../../packages/protocol/process-coordinator";
import { emptySnapshot } from "../../packages/test-fixtures";
import { credential, authInfo } from "../auth-fixtures";

export const approvalResponse = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;

export function processApprovalWork(suffix = "A", revision = 7) {
  const result = {
    type: "service.action" as const,
    version: 1 as const,
    operationId: `TEST-operation-${suffix}`,
    title: `TEST approval ${suffix}`,
    service: "TEST CRM",
    status: "awaiting_approval" as const,
    effect: "write" as const,
    fields: [{ label: "name", value: `TEST ${suffix}` }],
    inputJson: JSON.stringify(
      {
        name: `  TEST ${suffix}\n`,
        enabled: false,
        amount: 0,
        empty: null,
        values: ["second", "first"],
      },
      null,
      2,
    ),
    reviewTruncated: false,
    summary: "TEST full approval",
  };
  return WorkItemSchema.parse({
    id: "TEST-parent",
    revision: revision + 100,
    conversationId: "conversation-1",
    title: "TEST process",
    context: "TEST pending confirmation",
    status: "waiting_approval",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    presentation: { type: "workflow.progress", version: 1, variant: "default" },
    native: {
      runId: "TEST-parent",
      revision,
      process: {
        kind: "service-process-1",
        status: "waiting",
        journalStatus: "waiting",
        detailsAvailable: true,
        provenance: {
          runId: "TEST-run",
          processId: "TEST-process",
          version: 1,
          artifactDigest: "a".repeat(64),
          actorId: credential().scope.userId,
          conversationId: "conversation-1",
          commandId: "TEST-start",
          admissionId: "TEST-admission",
        },
        approval: {
          nodeId: `TEST-node-${suffix}`,
          serviceId: "TEST-service",
          serviceRevision: 2,
          actionId: "TEST-action",
          actionRevision: 3,
          result,
        },
        receipts: [
          {
            operationId: "TEST-prior",
            title: "TEST prior write",
            service: "TEST CRM",
            effect: "write",
            status: "succeeded",
            summary: "",
          },
          {
            operationId: result.operationId,
            title: result.title,
            service: result.service,
            effect: result.effect,
            status: result.status,
            summary: "",
          },
        ],
      },
    },
  });
}

/** Real ClientSession with only a synthetic injected transport and test credentials. */
export function processApprovalFixture() {
  const address = "https://fixture.test/v1/a";
  const snapshot = {
    ...emptySnapshot(credential().scope),
    workItems: [processApprovalWork()],
  };
  const cache = new Map<string, string>();
  const commands: string[] = [];
  const requests: string[] = [];
  let offline = false;
  const runtime = (command: ProcessResolveCommand) => {
    const input = {};
    return {
      profile: "agent-process-execution/2",
      scope: credential().scope,
      commandId: command.commandId,
      admission: {
        profile: "agent-process-start/1",
        status: "admitted",
        receiptId: "TEST-admission",
        intentId: "TEST-intent",
        commandId: "TEST-start",
        idempotencyKey: "TEST-start-key",
        commandDigest: "b".repeat(64),
        origin: {
          type: "command",
          conversationId: "conversation-1",
          requestId: "TEST-request",
        },
        processId: "TEST-process",
        version: 1,
        artifactDigest: "a".repeat(64),
        formDigest: "c".repeat(64),
        input,
        inputDigest: processCommandDigest(input),
        compilerVersion: "niaro-native-workflow/3",
        runId: "TEST-run",
        parentRunId: "TEST-parent",
        createdAt: "2026-10-06T00:00:00.000Z",
      },
      process: {
        parentRunId: "TEST-parent",
        runId: "TEST-run",
        processId: "TEST-process",
        version: 1,
        revision: 8,
        status: "waiting",
        approval: { nodeId: "TEST-node-B", operationId: "TEST-operation-B" },
      },
    };
  };
  const handlers = {
    command: async (command: ProcessResolveCommand): Promise<Response> =>
      approvalResponse(runtime(command), 202),
  };
  const storage = {
    getItem: async (key: string) => cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      cache.set(key, value);
    },
  };
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url));
    requests.push(path.href);
    if (offline) throw new TypeError("Network request failed");
    if (path.pathname.endsWith("/auth/session"))
      return approvalResponse(authInfo());
    if (path.pathname.endsWith("/processes/commands")) {
      commands.push(String(init?.body));
      return handlers.command(JSON.parse(String(init?.body)));
    }
    if (path.pathname.endsWith("/snapshot")) return approvalResponse(snapshot);
    if (path.pathname.endsWith("/events"))
      return approvalResponse({ ...snapshot, events: [] }, 409);
    throw Error(`TEST unexpected request ${path.pathname}`);
  };
  return {
    address,
    cache,
    storage,
    commands,
    requests,
    snapshot,
    handlers,
    runtime,
    offline: (value: boolean) => {
      offline = value;
    },
    open: () =>
      new ClientSession(
        address,
        storage,
        credential(),
        transport,
        undefined,
        undefined,
        false,
        { processApprovals: true },
      ),
  };
}
