import { ClientSession } from "../../packages/client-core/session";
import { processCommandDigest } from "../../packages/client-core/process-command-digest";
import { emptySnapshot } from "../../packages/test-fixtures";
import type {
  ProcessExecutionEntry,
  ProcessInputCard,
  ProcessInputRequest,
} from "../../packages/protocol/process-execution";
import type { ProcessStartCommand } from "../../packages/protocol/process-start";
import { credential, authInfo } from "../auth-fixtures";

export const launchResponse = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
export function launchGate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Synthetic injected transport only. No models, accounts or actual business effects. */
export function processLaunchFixture() {
  const address = "https://fixture.test/v1/a";
  const snapshot = emptySnapshot(credential().scope);
  const entries: ProcessExecutionEntry[] = ["A", "B"].map((suffix) => ({
    availability: "ready",
    processId: `TEST-process-${suffix}`,
    name: `TEST process ${suffix}`,
    description: `TEST purpose ${suffix}`,
    kind: "workflow",
    version: 1,
    artifactDigest: "a".repeat(64),
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
      additionalProperties: false,
    },
  }));
  entries.push({
    availability: "blocked",
    processId: "TEST-process-C",
    name: "TEST unavailable",
    description: "TEST blocked purpose",
    kind: "agent",
    version: 2,
    artifactDigest: "b".repeat(64),
    reason: "model_unavailable",
  });
  const cache = new Map<string, string>();
  const commands: string[] = [];
  const inputRequests: ProcessInputRequest[] = [];
  const inventoryRequests: string[] = [];
  let outcome: "accepted" | "rejected" | "unknown" = "accepted";
  let failClear = false;
  let offline = false;
  const cards = new Map<string, ProcessInputCard>();
  const cardFor = (request: ProcessInputRequest) => {
    const entry = entries.find((item) => item.processId === request.processId)!;
    if (entry.availability !== "ready") throw Error("TEST blocked");
    const form = {
      profile: "agent-process-input/1" as const,
      scope: credential().scope,
      language: request.language,
      processId: entry.processId,
      name: entry.name,
      description: entry.description,
      kind: entry.kind,
      version: entry.version,
      artifactDigest: entry.artifactDigest,
      inputSchema: entry.inputSchema,
      origin: request.origin,
    };
    const formDigest = processCommandDigest(form);
    const card = {
      form,
      formDigest,
      intent: {
        intentId: `TEST-intent-${request.origin.requestId}`,
        origin: request.origin,
        processId: form.processId,
        version: form.version,
        artifactDigest: form.artifactDigest,
        formDigest,
        inputSchema: form.inputSchema,
        fields: {},
        createdAt: "2026-10-06T00:00:00.000Z",
      },
    };
    cards.set(card.intent.intentId, card);
    return card;
  };
  const handlers = {
    inventory: async (_url: URL) =>
      launchResponse({
        profile: "agent-process-execution/1",
        scope: credential().scope,
        fingerprint: "c".repeat(64),
        processes: entries,
        nextAfter: null,
      }),
    input: async (request: ProcessInputRequest) =>
      launchResponse(cardFor(request)),
    command: async (command: ProcessStartCommand) => {
      if (outcome === "unknown") throw Error("TEST response lost");
      const card = cards.get(command.intentId)!;
      const base = {
        profile: "agent-process-start/1",
        receiptId: "TEST-receipt",
        intentId: command.intentId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandDigest: processCommandDigest(command),
        origin: card.form.origin,
        processId: card.form.processId,
        version: card.form.version,
        artifactDigest: card.form.artifactDigest,
        formDigest: card.formDigest,
        createdAt: "2026-10-06T00:00:00.000Z",
      };
      return launchResponse(
        {
          profile: "agent-process-execution/2",
          scope: credential().scope,
          commandId: command.commandId,
          ...(outcome === "rejected"
            ? {}
            : {
                process: {
                  parentRunId: "TEST-parent",
                  runId: "TEST-run",
                  processId: card.form.processId,
                  version: card.form.version,
                  revision: 1,
                  status: "running",
                },
              }),
          admission:
            outcome === "rejected"
              ? {
                  ...base,
                  status: "rejected",
                  reason: "process_active_version_changed",
                }
              : {
                  ...base,
                  status: "admitted",
                  input: command.input,
                  inputDigest: processCommandDigest(command.input),
                  compilerVersion: "niaro-native-workflow/3",
                  runId: "TEST-run",
                  parentRunId: "TEST-parent",
                },
        },
        outcome === "rejected" ? 422 : 202,
      );
    },
  };
  const storage = {
    getItem: async (key: string) => cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (
        failClear &&
        key.includes("agent-client.command.v2:") &&
        value === "null"
      )
        throw Error("TEST disk error");
      cache.set(key, value);
    },
  };
  const transport: typeof fetch = async (url, init) => {
    if (offline) throw Error("TEST offline");
    const path = new URL(String(url));
    if (path.pathname.endsWith("/auth/session"))
      return launchResponse(authInfo());
    if (path.pathname.endsWith("/processes/input")) {
      const request = JSON.parse(String(init?.body)) as ProcessInputRequest;
      inputRequests.push(request);
      return handlers.input(request);
    }
    if (path.pathname.endsWith("/processes/commands")) {
      commands.push(String(init?.body));
      return handlers.command(
        JSON.parse(String(init?.body)) as ProcessStartCommand,
      );
    }
    if (path.pathname.endsWith("/processes")) {
      inventoryRequests.push(path.href);
      return handlers.inventory(path);
    }
    if (path.pathname.endsWith("/snapshot")) return launchResponse(snapshot);
    if (path.pathname.endsWith("/events"))
      return launchResponse({ ...snapshot, events: [] }, 409);
    throw Error(`TEST unexpected request ${path.pathname}`);
  };
  return {
    entries,
    cache,
    commands,
    inputRequests,
    inventoryRequests,
    cards,
    cardFor,
    handlers,
    snapshot,
    outcome: (next: typeof outcome) => {
      outcome = next;
    },
    failClear: (next: boolean) => {
      failClear = next;
    },
    offline: (next: boolean) => {
      offline = next;
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
        { processQuestions: true },
      ),
  };
}
