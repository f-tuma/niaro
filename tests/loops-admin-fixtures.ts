import {
  LoopDetailSchema,
  LoopPageSchema,
  LoopActionDetailsSchema,
  LoopToolDetailsSchema,
  type LoopNode,
} from "../packages/protocol/loops";
import { AdminOverviewSchema } from "../packages/protocol/admin";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";

/** Browser QA uses these API responses; it never logs into a real workspace. */
export const loopsFixtureOverview = AdminOverviewSchema.parse({
  profile: "agent-server-admin/2",
  server: {
    name: "TEST assistant",
    workflowProfile: "agent-client/0.5-fixture",
    startedAt: "2026-10-01T08:00:00Z",
    sessionSeconds: 1800,
  },
  observedAt: "2026-10-01T08:00:00Z",
  services: [],
  tools: [],
  authentication: {
    current: "better-auth",
    identityEnabled: true,
    principalId: "test_user",
    oauth: "not_configured",
    backupKey: true,
    console: true,
    expiresAt: "2099-10-01T08:30:00Z",
  },
});
export const loopsFixtureIdentity = IdentityStateSchema.parse({
  profile: "agent-identity/1",
  enabled: true,
  needsSetup: false,
  user: { id: "test_user", name: "Demo user", email: "user@example.test" },
  organizations: [{ id: "test_org", name: "TEST organization", role: "owner" }],
});
export const loopsFixtureOrganization = OrganizationDetailSchema.parse({
  organizationId: "test_org",
  canManageMembers: true,
  canManageWorkspaces: true,
  members: [
    {
      id: "test_member",
      userId: "test_user",
      name: "Demo user",
      email: "user@example.test",
      role: "owner",
    },
  ],
  workspaces: [
    {
      id: "test_workspace",
      name: "TEST workspace",
      members: ["test_member"],
      connectionCount: 1,
      toolCount: 2,
    },
    {
      id: "other_workspace",
      name: "Second workspace",
      members: ["test_member"],
      connectionCount: 0,
      toolCount: 0,
    },
  ],
});
const run = {
  id: "a".repeat(64),
  workspaceId: "test_workspace",
  workspaceName: "TEST workspace",
  actorId: "test_user",
  actorName: "Demo user",
  request: "Najdi telefon a e-mail kontaktu v CRM",
  reply: "Našel jsem kontakt v CRM.",
  startedAt: "2026-10-01T08:05:00Z",
  finishedAt: "2026-10-01T08:05:04Z",
  status: "succeeded",
  modelCalls: 2,
  toolCalls: 2,
  inferenceCalls: 2,
  traceMode: "recorded",
};
export const loopsFixturePage = LoopPageSchema.parse({
  profile: "agent-loops/1",
  organizationId: "test_org",
  entries: [
    run,
    {
      ...run,
      id: "b".repeat(64),
      request: "Create a calendar proposal",
      status: "waiting",
      reply: null,
      finishedAt: null,
      startedAt: "2026-10-01T08:03:00Z",
      modelCalls: 1,
      toolCalls: 1,
      inferenceCalls: 1,
    },
    {
      ...run,
      id: "d".repeat(64),
      request: "Update a contact phone",
      reply: "The demo contact was updated.",
      modelCalls: 1,
      toolCalls: 1,
      inferenceCalls: 1,
    },
    {
      ...run,
      id: "c".repeat(64),
      request: "Check service availability",
      status: "failed",
      reply: null,
      startedAt: "2026-10-01T08:01:00Z",
      traceMode: "reconstructed",
      modelCalls: 1,
      toolCalls: 1,
      inferenceCalls: 1,
    },
  ],
  nextBefore: null,
});
const node = (
  id: string,
  kind: LoopNode["kind"],
  label: string,
  offset: number,
  details: LoopNode["details"] = [],
  action?: LoopNode["action"],
): LoopNode => ({
  id,
  kind,
  label,
  status: "succeeded",
  startedAt: `2026-10-01T08:05:0${offset}Z`,
  finishedAt: `2026-10-01T08:05:0${offset}Z`,
  details,
  ...(action ? { action } : {}),
});
const searchAction = LoopActionDetailsSchema.parse({
  operationId: "test_search",
  serviceName: "TEST CRM",
  actionName: "Search contacts",
  effect: "read",
  status: "succeeded",
  phase: "execution",
  input: [{ label: "Query", value: "Demo contact" }],
  output: [{ label: "Contacts returned", value: "2" }],
  inputTruncated: false,
  outputTruncated: false,
});
const readAction = LoopActionDetailsSchema.parse({
  ...searchAction,
  operationId: "test_read",
  actionName: "Read contact",
  input: [{ label: "Contact", value: "Demo contact" }],
  output: [
    { label: "Name", value: "Demo contact" },
    { label: "Phone", value: "+420 777 000 111" },
    { label: "Email", value: "demo@example.test" },
  ],
  outputTruncated: true,
});
const proposedAction = LoopActionDetailsSchema.parse({
  ...searchAction,
  operationId: "test_proposal",
  serviceName: "TEST calendar",
  actionName: "Create calendar event",
  effect: "write",
  status: "awaiting_approval",
  phase: "proposal",
  input: [
    { label: "Title", value: "Follow-up call" },
    { label: "Start", value: "2026-10-02 10:00" },
  ],
  output: [],
});
const writeAction = LoopActionDetailsSchema.parse({
  ...readAction,
  operationId: "test_write",
  actionName: "Update contact",
  effect: "write",
  outputTruncated: false,
  input: [
    { label: "Contact", value: "Demo contact" },
    { label: "Phone", value: "+420 777 000 222" },
  ],
  output: [
    { label: "Contact", value: "Demo contact" },
    { label: "Phone", value: "+420 777 000 222" },
  ],
});
const serviceTool = (name: string) =>
  LoopToolDetailsSchema.parse({
    name,
    outcome: "completed",
    input: [],
    output: [],
    inputRecorded: false,
    outputRecorded: false,
    inputTruncated: false,
    outputTruncated: false,
  });
const discovery = {
  ...node("discovery", "tool", "find_service", 0),
  tool: LoopToolDetailsSchema.parse({
    name: "find_service",
    outcome: "completed",
    input: [{ label: "Need", value: "TEST CRM contacts and tasks" }],
    output: [
      { label: "Returned services", value: "1" },
      { label: "Service", value: "TEST CRM" },
    ],
    inputRecorded: true,
    outputRecorded: true,
    inputTruncated: false,
    outputTruncated: false,
  }),
};
export const loopsFixtureDetail = LoopDetailSchema.parse({
  profile: "agent-loops/1",
  organizationId: "test_org",
  run,
  nodes: [
    node("request", "request", "User request", 0, [
      { label: "Message", value: run.request },
    ]),
    node("model_1", "model", "Mastra model", 0, [
      { label: "Model", value: "TEST model" },
    ]),
    discovery,
    {
      ...node(
        "tool_1",
        "tool",
        "crm.search_people",
        1,
        [{ label: "Query", value: "Demo contact" }],
        searchAction,
      ),
      tool: serviceTool("action_TEST_crm_search_people"),
    },
    {
      ...node(
        "result_1",
        "result",
        "Two matching contacts",
        1,
        [{ label: "Result", value: "2 contacts returned" }],
        searchAction,
      ),
      tool: serviceTool("action_TEST_crm_search_people"),
    },
    node("decision", "decision", "Validate selected contact", 2, [
      { label: "Outcome", value: "A fresh contact read is required" },
    ]),
    {
      ...node(
        "tool_2",
        "tool",
        "crm.get_person",
        2,
        [{ label: "Contact", value: "TEST contact" }],
        readAction,
      ),
      tool: serviceTool("action_TEST_crm_get_person"),
    },
    {
      ...node(
        "result_2",
        "result",
        "Contact verified",
        3,
        [
          {
            label: "Result",
            value: "Demo contact, +420 777 000 111, demo@example.test",
          },
        ],
        readAction,
      ),
      tool: serviceTool("action_TEST_crm_get_person"),
    },
    node("model_2", "model", "Mastra model", 3),
    node("reply", "reply", "Assistant reply", 4, [
      { label: "Message", value: run.reply },
    ]),
  ],
  edges: [
    { id: "e1", source: "request", target: "model_1", kind: "flow" },
    { id: "e2", source: "model_1", target: "discovery", kind: "flow" },
    { id: "e9", source: "discovery", target: "tool_1", kind: "flow" },
    { id: "e3", source: "tool_1", target: "result_1", kind: "result" },
    { id: "e4", source: "result_1", target: "decision", kind: "flow" },
    { id: "e5", source: "decision", target: "tool_2", kind: "retry" },
    { id: "e6", source: "tool_2", target: "result_2", kind: "result" },
    { id: "e7", source: "result_2", target: "model_2", kind: "flow" },
    { id: "e8", source: "model_2", target: "reply", kind: "flow" },
  ],
  truncated: false,
});

export type LoopsFixtureState = "ready" | "empty" | "denied" | "error";

/** Intercept /admin/api/** using pathname/search; unexpected paths fail closed. */
export function adminLoopsFixture(
  url: URL,
  state: LoopsFixtureState = "ready",
) {
  const path = url.pathname.replace(/^\/admin\/api\//, "");
  if (path === "overview") return { status: 200, body: loopsFixtureOverview };
  if (path === "auth-methods")
    return { status: 200, body: { identity: true, setup: false } };
  if (path === "identity") return { status: 200, body: loopsFixtureIdentity };
  if (path === "identity/organization")
    return {
      status: 200,
      body: {
        ...loopsFixtureOrganization,
        canManageWorkspaces: state !== "denied",
      },
    };
  if (path.startsWith("identity/loops")) {
    if (state === "error")
      return { status: 503, body: { error: "TEST_unavailable" } };
    if (state === "denied")
      return { status: 403, body: { error: "TEST_forbidden" } };
    if (path === "identity/loops") {
      const status = url.searchParams.get("status");
      const workspace = url.searchParams.get("workspaceId");
      return {
        status: 200,
        body: {
          ...loopsFixturePage,
          entries:
            state === "empty"
              ? []
              : loopsFixturePage.entries.filter(
                  (entry) =>
                    (!status || entry.status === status) &&
                    (!workspace || entry.workspaceId === workspace),
                ),
        },
      };
    }
    const runId = path.slice("identity/loops/".length);
    const selected = loopsFixturePage.entries.find(
      (entry) => entry.id === runId,
    );
    if (selected) {
      const waiting = selected.status === "waiting";
      const failed = selected.status === "failed";
      const write = selected.id === "d".repeat(64);
      const request = {
        ...loopsFixtureDetail.nodes[0]!,
        details: [{ label: "Message", value: selected.request }],
      };
      return {
        status: 200,
        body: {
          ...loopsFixtureDetail,
          run: selected,
          nodes: waiting
            ? [
                request,
                {
                  ...node(
                    "proposal",
                    "tool",
                    "Create calendar event",
                    1,
                    [],
                    proposedAction,
                  ),
                  status: "waiting",
                },
                {
                  ...loopsFixtureDetail.nodes[1],
                  id: "question",
                  kind: "question",
                  label: "Choose a calendar",
                  status: "waiting",
                },
              ]
            : failed
              ? [
                  request,
                  {
                    ...node(
                      "invalid-tool",
                      "tool",
                      "internal_datetime_resolve",
                      1,
                    ),
                    status: "failed",
                    tool: LoopToolDetailsSchema.parse({
                      name: "internal_datetime_resolve",
                      outcome: "invalid_arguments",
                      input: [],
                      output: [],
                      inputRecorded: false,
                      outputRecorded: false,
                      inputTruncated: false,
                      outputTruncated: false,
                      failure: {
                        code: "TEST_INVALID_TOOL_ARGUMENTS",
                        kind: "validation",
                        stage: "validation",
                        retry: "correct_input",
                        fields: [
                          {
                            path: "when",
                            issue: "TEST missing date interpretation",
                          },
                        ],
                      },
                    }),
                  },
                  {
                    ...loopsFixtureDetail.nodes[1],
                    id: "error",
                    kind: "error",
                    label: "Service unavailable",
                    status: "failed",
                    startedAt: null,
                    finishedAt: null,
                    action: {
                      ...readAction,
                      status: "unknown",
                      output: [],
                      outputTruncated: false,
                    },
                  },
                ]
              : write
                ? [
                    request,
                    node("write", "tool", "Update contact", 1, [], writeAction),
                    node("reply", "reply", "Reply", 4, [
                      { label: "Message", value: selected.reply! },
                    ]),
                  ]
                : loopsFixtureDetail.nodes,
          edges: waiting
            ? [
                {
                  id: "wait",
                  source: "request",
                  target: "proposal",
                  kind: "flow",
                },
                {
                  id: "approve",
                  source: "proposal",
                  target: "question",
                  kind: "flow",
                },
              ]
            : failed
              ? [
                  {
                    id: "fail",
                    source: "request",
                    target: "invalid-tool",
                    kind: "flow",
                  },
                  {
                    id: "fail-result",
                    source: "invalid-tool",
                    target: "error",
                    kind: "flow",
                  },
                ]
              : write
                ? [
                    {
                      id: "write",
                      source: "request",
                      target: "write",
                      kind: "flow",
                    },
                    {
                      id: "reply",
                      source: "write",
                      target: "reply",
                      kind: "flow",
                    },
                  ]
                : loopsFixtureDetail.edges,
        },
      };
    }
  }
  return { status: 404, body: { error: "TEST_fixture_missing" } };
}
