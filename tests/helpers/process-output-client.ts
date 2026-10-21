import { FixtureEngine } from "../../apps/fixture-server/engine";
import { WorkItemSchema, type Snapshot } from "../../packages/protocol";
import {
  PROCESS_OUTPUT_PROFILE,
  PROCESS_OUTPUT_WORK_PROFILE,
  type ProcessOutputRequest,
  type ProcessOutputNode,
} from "../../packages/protocol/process-output";
import { snapshotWithoutProcessOutputs } from "../../packages/protocol/process-work";
import { ClientSession } from "../../packages/client-core/session";
import { processOutputCursor } from "../../packages/client-core/process-output-reader";
import { authInfo, credential } from "../auth-fixtures";

export const outputResponse = (value: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
export function outputWork(revision = 7) {
  const provenance = {
    runId: "TEST-output-run",
    processId: "TEST-output-process",
    version: 1,
    artifactDigest: "a".repeat(64),
    actorId: credential().scope.userId,
    conversationId: "conversation-1",
    commandId: "TEST-output-start",
    admissionId: "TEST-output-admission",
  };
  return WorkItemSchema.parse({
    id: "TEST-output-parent",
    revision,
    conversationId: "conversation-1",
    title: "TEST meeting process",
    context: "TEST complete",
    status: "succeeded",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    presentation: { type: "workflow.progress", version: 1, variant: "default" },
    native: {
      runId: "TEST-output-parent",
      revision,
      process: {
        kind: "service-process-1",
        provenance,
        status: "succeeded",
        journalStatus: "succeeded",
        detailsAvailable: true,
        receipts: [],
        outputSummary: {
          fieldCount: 20,
          shownFields: 8,
          clipped: true,
          redacted: true,
        },
        output: {
          profile: PROCESS_OUTPUT_PROFILE,
          scope: credential().scope,
          parentRunId: "TEST-output-parent",
          nativeRevision: revision,
          provenance,
          origin: {
            type: "command",
            conversationId: "conversation-1",
            requestId: "TEST-output-menu",
          },
          outputDigest: "b".repeat(64),
          redactionVersion: "process-output-redaction/1",
        },
      },
    },
  });
}
const nodes: ProcessOutputNode[] = [
  { kind: "string", value: "" },
  { kind: "null", value: null },
  { kind: "boolean", value: false },
  { kind: "number", value: 0 },
  { kind: "object", childCount: 0 },
  { kind: "array", childCount: 0 },
  { kind: "redacted" },
  ...Array.from(
    { length: 11 },
    (_, i): ProcessOutputNode => ({
      kind: "string",
      value: `TEST field ${i + 7}`,
    }),
  ),
  { kind: "string", value: "TEST-meeting-after-eight" },
  { kind: "boolean", value: true },
];
export function outputPage(request: ProcessOutputRequest) {
  const selected = request.path[0]?.index;
  const node: ProcessOutputNode =
    selected === undefined
      ? { kind: "object", childCount: nodes.length }
      : nodes[selected]!;
  const offset = request.cursor ? Number(request.cursor.split(".")[0]) : 0;
  const children =
    selected === undefined
      ? nodes.slice(offset, offset + 8).map((node, i) => ({
          index: offset + i,
          label:
            offset + i === 18
              ? "meetingId"
              : offset + i === 19
                ? "confirmed"
                : `field${offset + i}`,
          node,
        }))
      : [];
  return {
    profile: PROCESS_OUTPUT_PROFILE,
    ...request,
    offset,
    total: selected === undefined ? nodes.length : 0,
    node,
    children,
    nextCursor:
      selected === undefined && offset + children.length < nodes.length
        ? processOutputCursor(request, offset + children.length)
        : null,
  };
}
export function processOutputFixture() {
  const address = "https://fixture/v1/a";
  const cache = new Map<string, string>();
  const h = {
    address,
    cache,
    snapshot: {
      ...new FixtureEngine().snapshot(),
      workItems: [outputWork()],
    } as Snapshot,
    capability: "supported" as "supported" | "old" | "malformed" | "wrongScope",
    requests: [] as string[],
    writes: [] as string[],
    handlers: {
      output: async (request: ProcessOutputRequest) =>
        outputResponse(outputPage(request)),
    },
    request: (async (raw, init) => {
      const url = new URL(String(raw));
      h.requests.push(url.href);
      if (init?.method && init.method !== "GET") h.writes.push(url.href);
      if (url.pathname.endsWith("/session")) return outputResponse(authInfo());
      if (url.pathname.endsWith("/output/capabilities")) {
        if (h.capability === "old")
          return outputResponse({ error: "not_found" }, 404);
        if (h.capability === "malformed")
          return outputResponse({ available: true });
        return outputResponse({
          profile: PROCESS_OUTPUT_PROFILE,
          scope:
            h.capability === "wrongScope"
              ? credential("b").scope
              : credential().scope,
          available: true,
          readProfile: PROCESS_OUTPUT_PROFILE,
          workProfile: PROCESS_OUTPUT_WORK_PROFILE,
        });
      }
      if (url.pathname.endsWith("/snapshot"))
        return outputResponse(
          url.searchParams.get("tasks") === PROCESS_OUTPUT_WORK_PROFILE
            ? h.snapshot
            : snapshotWithoutProcessOutputs(h.snapshot),
        );
      if (url.pathname.endsWith("/processes/output"))
        return h.handlers.output(JSON.parse(url.searchParams.get("request")!));
      return outputResponse({ error: "not_found" }, 404);
    }) as typeof fetch,
    open: () =>
      new ClientSession(
        address,
        {
          getItem: async (key) => cache.get(key) ?? null,
          setItem: async (key, value) => {
            cache.set(key, value);
          },
        },
        credential(),
        h.request,
        undefined,
        undefined,
        false,
        { processOutputs: true },
      ),
  };
  return h;
}
