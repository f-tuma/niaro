import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authRequest } from "../../packages/client-core/auth";
import { CredentialSchema } from "../../packages/protocol";
import {
  OwnedDesignReviewSchema,
  DESIGN_PROFILE,
  WORKSPACE_DESIGN_PROFILE,
  DesignTurnSchema,
  emptyDesignBrief,
} from "../../packages/protocol/process-design";
import {
  ProcessDefinitionSchema,
  WORKSPACE_PROCESS_PROFILE,
  WorkspaceProcessListSchema,
  OwnedProcessRecordSchema,
  ProcessListSchema,
  ProcessVersionSchema,
} from "../../packages/protocol/service-processes";
import {
  NativeTestJobSchema,
  NativeTestSuiteSchema,
  PROCESS_NATIVE_TEST_PROFILE,
} from "../../packages/protocol/process-native-testing";
import { PROCESS_VERSION_PROFILE } from "../../packages/protocol/process-versions";
import {
  PROCESS_ACTIVATION_PROFILE,
  ProcessActivationReceiptSchema,
  ProcessActivationReviewSchema,
} from "../../packages/protocol/process-activation";
import {
  ActionSettings,
  CatalogModelSettings,
  ServiceSettings,
} from "../../packages/protocol/service-catalog";
import { DEFAULT_PROCESS_LIMITS } from "../../apps/server-identity/process-validation";
import type { IntegrationTransport } from "../../apps/server-integrations/transport";
import type { StoredInvocation } from "../../apps/server-identity/service-catalog";
import { designHttpFixture, designHttpPath } from "./process-design-http";
import { processObject } from "./service-process";

const base = "api/identity/catalog/processes";
export const PIPELINE_INPUT = {
  contactId: "TEST-contact-ada",
  name: "Ada Test",
  email: "ada@example.test",
  calendarId: "TEST-calendar-prague",
  title: "TEST CRM consultation",
  start: "2026-10-12T10:00:00+02:00",
  end: "2026-10-12T10:30:00+02:00",
  timeZone: "Europe/Prague",
};
export const PIPELINE_QUESTION =
  "TEST CRM returned two matching contacts. Confirm contactId TEST-contact-ada and ada@example.test for this meeting.";
export const PIPELINE_ANSWER =
  "  TEST potvrzuji TEST-contact-ada, ada@example.test.\n";
export const PIPELINE_RESULT = {
  ...PIPELINE_INPUT,
  meetingId: "TEST-meeting-001",
  status: "confirmed",
};
export type PipelineScenario =
  | "success"
  | "failure"
  | "unknown"
  | "unavailable";
export type PipelineRequest = {
  method: string;
  path: string;
  body?: string;
  status?: number;
};

/** All lifecycle commands are ordinary authenticated HTTP. Only external
 * provider replies are scripted; there is no synthetic registry activation.
 */
export async function pipelineHttpFixture(
  options: {
    testAllowedOrigins?: string[];
    outputPadding?: boolean;
    workspaceOwned?: boolean;
  } = {},
) {
  const outputPadding = options.outputPadding
    ? Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          `audit${String(i).padStart(2, "0")}`,
          i === 0
            ? "TEST full value ".repeat(250).slice(0, 3991) + "TEST-END!"
            : `TEST audit value ${i}`,
        ]),
      )
    : {};
  const finalResult = {
    ...PIPELINE_RESULT,
    ...outputPadding,
    ...(options.outputPadding ? { confirmed: true } : {}),
  };
  // The same immutable schema accepts different service data. Keep the six-case
  // authoring suite within its existing total fixture bound; paired runtime
  // readback separately exercises the complete 4000-character value.
  const qualificationResult = {
    ...finalResult,
    ...(options.outputPadding
      ? { audit00: "TEST qualification readback value" }
      : {}),
  };
  const requests: PipelineRequest[] = [];
  const h = await designHttpFixture(undefined, {
    ...options,
    observeRequest: (req, res) => {
      const path = req.url ?? "/";
      if (
        !path.startsWith("/v1/") &&
        !path.includes("/catalog/processes") &&
        !path.includes("/api/identity/loops")
      )
        return;
      const entry: PipelineRequest = { method: req.method ?? "GET", path };
      requests.push(entry);
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        const push = req.push.bind(req);
        req.push = (chunk, encoding) => {
          if (chunk === null)
            entry.body = Buffer.concat(chunks).toString("utf8");
          else
            chunks.push(
              Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(String(chunk), encoding),
            );
          return push(chunk, encoding);
        };
      }
      res.once("finish", () => {
        entry.status = res.statusCode;
      });
    },
  });
  const fields = Object.fromEntries(
    Object.keys(PIPELINE_INPUT).map((key) => [
      key,
      { type: "string" as const },
    ]),
  );
  const meetingSchema = processObject(fields);
  const resultSchema = processObject({
    ...fields,
    meetingId: { type: "string" },
    status: { type: "string" },
  });
  const finalSchema = processObject({
    ...resultSchema.properties,
    ...Object.fromEntries(
      Object.keys(outputPadding).map((key) => [
        key,
        { type: "string" as const },
      ]),
    ),
    ...(options.outputPadding
      ? { confirmed: { type: "boolean" as const } }
      : {}),
  });
  const literalPadding = Object.fromEntries(
    Object.entries(outputPadding).map(([key, value]) => [
      key,
      { source: "literal" as const, value: key === "audit00" ? "" : value },
    ]),
  );
  const contact = {
    contactId: PIPELINE_INPUT.contactId,
    name: PIPELINE_INPUT.name,
    email: PIPELINE_INPUT.email,
    ambiguous: true,
  };
  const contactSchema = processObject({
    contactId: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    ambiguous: { type: "boolean" },
  });
  const lookupInput = { contactId: PIPELINE_INPUT.contactId };
  const availability = { available: true };
  const availabilitySchema = processObject({ available: { type: "boolean" } });
  const actionSettings = (name: string, inputSchema: object, path: string) => ({
    name,
    description: "TEST isolated concrete CRM / Calendar meeting capability",
    inputSchema,
    binding: {
      type: "http",
      method: "GET",
      path,
      parameters: Object.keys(
        (inputSchema as { properties: object }).properties,
      ).map((name) => ({ name, in: "query", required: true })),
      body: false,
    },
    effect: "read",
    approval: "never",
    enabled: true,
    policy: { roles: ["owner", "admin", "member"], users: [] },
  });
  const crm = h.identity["catalog"].store.service(
    h.target.workspaceId,
    h.serviceId,
  );
  await h.catalog({
    type: "saveService",
    id: crm.id,
    revision: crm.revision,
    settings: {
      ...ServiceSettings.strip().parse(crm),
      name: "TEST CRM contacts",
      url: "https://crm.example.test/v1",
    },
  });
  const crmCurrent = h.identity["catalog"].store.service(
    h.target.workspaceId,
    h.serviceId,
  );
  await h.catalog({
    type: "saveAction",
    id: h.actionId,
    serviceId: h.serviceId,
    serviceRevision: crmCurrent.revision,
    revision: crmCurrent.actions.find((a) => a.id === h.actionId)!.revision,
    settings: actionSettings(
      "TEST Lookup CRM contact",
      processObject({ contactId: { type: "string" } }),
      "/contacts",
    ),
  });
  const calendarId = await h.catalog({
    type: "saveService",
    revision: 0,
    settings: {
      name: "TEST Calendar meetings",
      url: "https://calendar.example.test/v1",
      protocol: "openapi",
      icon: "calendar",
      auth: { type: "none" },
      enabled: true,
    },
  });
  const calendarAction = async (settings: object) =>
    h.catalog({
      type: "saveAction",
      serviceId: calendarId,
      serviceRevision: h.identity["catalog"].store.service(
        h.target.workspaceId,
        calendarId,
      ).revision,
      revision: 0,
      settings,
    });
  const availabilityId = await calendarAction(
    actionSettings(
      "TEST Calendar availability",
      meetingSchema,
      "/availability",
    ),
  );
  const createId = await calendarAction({
    ...actionSettings(
      "TEST Create meeting",
      processObject({ body: meetingSchema }),
      "/meetings",
    ),
    binding: {
      type: "http",
      method: "POST",
      path: "/meetings",
      parameters: [],
      body: true,
    },
    effect: "write",
    approval: "always",
  });
  const readbackId = await calendarAction(
    actionSettings(
      "TEST Read meeting",
      processObject({
        calendarId: { type: "string" },
        meetingId: { type: "string" },
      }),
      "/meetings/readback",
    ),
  );
  h.budgetSettings.prices[0]!.maxInputTokens = options.outputPadding
    ? 80_000
    : 50_000;
  h.budgetSettings.prices[0]!.maxOutputTokens = options.outputPadding
    ? 10_000
    : 1_000;
  const budget = await h.request("owner", "api/identity/catalog/budget", {
    ...h.target,
    revision: h.identity["catalog"].store.inferenceBudget.policy(
      h.target.organizationId,
      h.target.workspaceId,
    ).revision,
    settings: h.budgetSettings,
  });
  assert.equal(budget.status, 200, JSON.stringify(budget.data));
  const from = (source: "input" | "step", key: string, stepId?: string) =>
    source === "input"
      ? { source, path: [key] }
      : { source, stepId, path: [key] };
  const mapped = (source: "input" | "step", stepId?: string) =>
    Object.fromEntries(
      Object.keys(fields).map((key) => [key, from(source, key, stepId)]),
    );
  const definition = ProcessDefinitionSchema.parse({
    schemaVersion: 1,
    kind: "workflow",
    name: "TEST qualified CRM meeting pipeline",
    description:
      "Native designer / qualified activation / paired Session acceptance",
    trigger: "manual",
    inputSchema: meetingSchema,
    outputSchema: finalSchema,
    limits: { ...DEFAULT_PROCESS_LIMITS, maxModelCalls: 32 },
    entry: "contact",
    steps: [
      {
        id: "contact",
        type: "action",
        serviceId: h.serviceId,
        actionId: h.actionId,
        input: { contactId: from("input", "contactId") },
        outputSchema: contactSchema,
        next: "plan",
      },
      {
        id: "plan",
        type: "agent",
        modelId: h.modelId,
        memory: "none",
        humanInput: "text",
        instructions:
          "TEST specialize in CRM meetings. If the CRM contact is ambiguous, ask for exact contactId and email confirmation. Return typed meeting parameters only after clarification.",
        capabilities: [],
        input: {
          ...mapped("input"),
          contactId: from("step", "contactId", "contact"),
          name: from("step", "name", "contact"),
          email: from("step", "email", "contact"),
          ambiguous: from("step", "ambiguous", "contact"),
        },
        inputSchema: processObject({
          ...fields,
          ambiguous: { type: "boolean" },
        }),
        outputSchema: meetingSchema,
        next: "availability",
      },
      {
        id: "availability",
        type: "action",
        serviceId: calendarId,
        actionId: availabilityId,
        input: mapped("step", "plan"),
        outputSchema: availabilitySchema,
        next: "available",
      },
      {
        id: "available",
        type: "branch",
        condition: {
          operator: "equals",
          left: from("step", "available", "availability"),
          right: true,
        },
        whenTrue: "create",
        whenFalse: "unavailable",
      },
      {
        id: "create",
        type: "action",
        serviceId: calendarId,
        actionId: createId,
        input: { body: { source: "step", stepId: "plan", path: [] } },
        outputSchema: resultSchema,
        next: "readback",
      },
      {
        id: "readback",
        type: "action",
        serviceId: calendarId,
        actionId: readbackId,
        input: {
          calendarId: from("step", "calendarId", "create"),
          meetingId: from("step", "meetingId", "create"),
        },
        outputSchema: finalSchema,
        next: "done",
      },
      {
        id: "done",
        type: "return",
        output: {
          ...Object.fromEntries(
            Object.keys(finalResult).map((key) => [
              key,
              from("step", key, "readback"),
            ]),
          ),
        },
      },
      {
        id: "unavailable",
        type: "return",
        output: {
          ...literalPadding,
          ...(options.outputPadding
            ? { confirmed: { source: "literal", value: false } }
            : {}),
          ...mapped("step", "plan"),
          meetingId: { source: "literal", value: "" },
          status: { source: "literal", value: "unavailable" },
        },
      },
    ],
  });
  const brief = {
    ...emptyDesignBrief(),
    purpose:
      "TEST Look up a CRM contact, clarify ambiguity, check Calendar availability, approve and create one meeting, verify it by readback.",
    inputs: Object.keys(PIPELINE_INPUT),
    outputs: [
      ...Object.keys(PIPELINE_RESULT),
      ...(options.outputPadding ? ["confirmed"] : []),
    ],
    rules: [
      "Every Calendar write requires separate human approval",
      "Unknown writes stop without retry or readback",
      "Only readback proves the final meeting result",
      "An unavailable Calendar slot returns unavailable without proposing a write",
    ],
    assumptions: [
      {
        id: "synthetic_scope",
        text: "TEST Scripted model, CRM and Calendar responses only; controlled native test acceptance is not live acceptance.",
      },
    ],
  };
  let designStep = 0,
    modelStep = 0;
  let scenario: PipelineScenario = "success";
  const toolReply = (name: string, input: object, id: string) => ({
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      },
    ],
  });
  h.onModel((request) => {
    if (
      request.tools?.some(
        (tool) => tool.function.name === "design_update_proposal",
      )
    )
      return ++designStep === 1
        ? toolReply(
            "design_update_proposal",
            { revision: 1, brief, candidate: definition },
            "TEST-pipeline-design-proposal",
          )
        : {
            content:
              "TEST Review the exact CRM/Calendar meeting proposal and acknowledge its isolated scope before accepting.",
          };
    return ++modelStep === 1
      ? toolReply(
          "ask_user",
          { question: PIPELINE_QUESTION },
          "TEST-pipeline-contact-question",
        )
      : { content: JSON.stringify(PIPELINE_INPUT) };
  });
  const serviceDispatches: {
    origin: string;
    method: string;
    path: string;
    body?: unknown;
  }[] = [];
  const transport: IntegrationTransport = async (request) => {
    const url = new URL(request.url);
    assert(
      [
        "https://models.example.test",
        "https://crm.example.test",
        "https://calendar.example.test",
      ].includes(url.origin),
      "TEST origin is not explicitly allowlisted",
    );
    if (url.origin === "https://models.example.test")
      return h.scriptedModelTransport(request);
    if (url.origin === "https://crm.example.test") {
      assert.equal(request.method, "GET");
      assert.equal(url.pathname, "/v1/contacts");
      assert.deepEqual(Object.fromEntries(url.searchParams), lookupInput);
    } else if (url.pathname === "/v1/availability") {
      assert.equal(request.method, "GET");
      assert.deepEqual(Object.fromEntries(url.searchParams), PIPELINE_INPUT);
    } else if (url.pathname === "/v1/meetings") {
      assert.equal(request.method, "POST");
      assert.deepEqual(request.body, PIPELINE_INPUT);
    } else {
      assert.equal(request.method, "GET");
      assert.equal(url.pathname, "/v1/meetings/readback");
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        calendarId: PIPELINE_INPUT.calendarId,
        meetingId: PIPELINE_RESULT.meetingId,
      });
    }
    assert(request.beforeDispatch);
    if (request.method === "POST" && scenario === "failure")
      throw Error("TEST Calendar unavailable before dispatch");
    await request.beforeDispatch(() => {
      serviceDispatches.push({
        origin: url.origin,
        method: request.method ?? "GET",
        path: url.pathname,
        ...(request.body === undefined
          ? {}
          : { body: structuredClone(request.body) }),
      });
    });
    if (url.origin === "https://crm.example.test")
      return { status: 200, headers: {}, text: JSON.stringify(contact) };
    if (url.pathname.endsWith("/availability"))
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({ available: scenario !== "unavailable" }),
      };
    if (request.method === "POST" && scenario === "unknown")
      throw new DOMException(
        "TEST Calendar lost reply after dispatch",
        "TimeoutError",
      );
    return {
      status: 200,
      headers: {},
      text: JSON.stringify(
        url.pathname.endsWith("/readback") ? finalResult : PIPELINE_RESULT,
      ),
    };
  };
  const install = () =>
    Object.defineProperty(h.identity["catalog"], "transport", {
      value: transport,
    });
  install();
  const issuePairing = async (role: "owner" | "member" = "owner") => {
    const response = await h.request(
      role,
      "api/identity/mobile/pairing",
      h.target,
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const issued = h.record(response.data);
    return { address: String(issued.address), code: String(issued.code) };
  };
  const credential = async (role: "owner" | "member" = "owner") => {
    const issued = await issuePairing(role);
    return CredentialSchema.parse(
      await authRequest(
        String(issued.address),
        "pair",
        fetch,
        undefined,
        String(issued.code),
        false,
        true,
      ),
    );
  };
  const qualificationSuite = () => {
    const catalog = h.identity["catalog"].store;
    const services = [
      catalog.service(h.target.workspaceId, h.serviceId),
      catalog.service(h.target.workspaceId, calendarId),
    ];
    const lookup = (id: string) =>
      services
        .flatMap((service) =>
          service.actions.map((action) => ({ service, action })),
        )
        .find((entry) => entry.action.id === id)!;
    const usage = { inputTokens: 10, outputTokens: 5 };
    const tool = (name: string, input: object, id: string) => ({
      modelId: h.modelId,
      requiredTools: [name],
      reply: { type: "tool", name, input, callId: "TEST-" + id },
      usage,
    });
    const text = (value: object) => ({
      modelId: h.modelId,
      requiredTools: [],
      reply: { type: "text", text: JSON.stringify(value) },
      usage,
    });
    const actionName = (id: string) => "action_" + id.replaceAll("-", "_");
    const readInput = {
      calendarId: PIPELINE_INPUT.calendarId,
      meetingId: PIPELINE_RESULT.meetingId,
    };
    const cases = [
      "success",
      "rejection",
      "missing_input",
      "failure",
      "unknown",
      "restart",
    ].map((scenario) => {
      const missing = scenario === "missing_input",
        failed = scenario === "failure",
        denied = scenario === "rejection",
        unknown = scenario === "unknown";
      const spec = missing
        ? []
        : [
            {
              id: h.actionId,
              input: lookupInput,
              output: contact,
              effect: "read",
              decision: "none",
              outcome: failed ? "failure" : "complete",
            },
            ...(!failed
              ? [
                  {
                    id: availabilityId,
                    input: PIPELINE_INPUT,
                    output: availability,
                    effect: "read",
                    decision: "none",
                    outcome: "complete",
                  },
                  {
                    id: createId,
                    input: { body: PIPELINE_INPUT },
                    output: PIPELINE_RESULT,
                    effect: "write",
                    decision: denied ? "reject" : "approve",
                    outcome: unknown ? "unknown" : "complete",
                  },
                  ...(!denied && !unknown
                    ? [
                        {
                          id: readbackId,
                          input: readInput,
                          output: qualificationResult,
                          effect: "read",
                          decision: "none",
                          outcome: "complete",
                        },
                      ]
                    : []),
                ]
              : []),
          ];
      const actions = spec.map((item) => ({
        serviceId: lookup(item.id).service.id,
        actionId: item.id,
        input: item.input,
        decision: item.decision,
        outcome: item.outcome,
        ...(item.outcome === "complete" ? { output: item.output } : {}),
      }));
      const receipts = spec.map((item) => ({
        serviceId: lookup(item.id).service.id,
        actionId: item.id,
        serviceRevision: lookup(item.id).service.revision,
        actionRevision: lookup(item.id).action.revision,
        input: item.input,
        effect: item.effect,
        status:
          item.decision === "reject"
            ? "rejected"
            : item.outcome === "failure"
              ? "failed"
              : item.outcome === "unknown"
                ? "unknown"
                : "succeeded",
        dispatches: item.decision === "reject" ? 0 : 1,
        ...(item.decision === "reject"
          ? {}
          : item.outcome === "failure"
            ? { code: "integration_provider_failed" }
            : item.outcome === "unknown"
              ? { code: "integration_unavailable" }
              : { output: item.output }),
      }));
      const configured =
        missing || failed
          ? []
          : [
              tool(
                "ask_user",
                { question: PIPELINE_QUESTION },
                "question-configured-" + scenario,
              ),
              text(PIPELINE_INPUT),
            ];
      const generic = missing
        ? []
        : [
            tool(
              "find_actions",
              { service: services[0]!.name, need: "TEST CRM contact lookup" },
              "find-crm-" + scenario,
            ),
            tool(actionName(h.actionId), lookupInput, "contact-" + scenario),
            ...(!failed
              ? [
                  tool(
                    "ask_user",
                    { question: PIPELINE_QUESTION },
                    "question-generic-" + scenario,
                  ),
                  tool(
                    "find_actions",
                    {
                      service: services[1]!.name,
                      need: "TEST Calendar meeting availability create readback",
                    },
                    "find-calendar-" + scenario,
                  ),
                  tool(
                    actionName(availabilityId),
                    PIPELINE_INPUT,
                    "availability-" + scenario,
                  ),
                  tool(
                    actionName(createId),
                    { body: PIPELINE_INPUT },
                    "create-" + scenario,
                  ),
                  ...(!denied && !unknown
                    ? [
                        tool(
                          actionName(readbackId),
                          readInput,
                          "readback-" + scenario,
                        ),
                      ]
                    : []),
                ]
              : []),
            text(unknown ? { status: "unknown" } : qualificationResult),
            ...(unknown ? [text({ status: "unknown" })] : []),
          ];
      const outcome = missing
        ? "input_invalid"
        : failed
          ? "failed"
          : denied
            ? "rejected"
            : unknown
              ? "unknown"
              : "succeeded";
      const code = missing
        ? "process_input_invalid"
        : failed
          ? "integration_provider_failed"
          : denied
            ? "process_action_rejected"
            : "integration_unavailable";
      return {
        id: scenario,
        scenario,
        input: missing ? {} : PIPELINE_INPUT,
        actions,
        models: { configured, generic },
        ...(missing || failed
          ? {}
          : {
              questions: {
                configured: [
                  { question: PIPELINE_QUESTION, answer: PIPELINE_ANSWER },
                ],
                generic: [
                  { question: PIPELINE_QUESTION, answer: PIPELINE_ANSWER },
                ],
              },
            }),
        expected: {
          outcome,
          ...(outcome === "succeeded"
            ? { output: qualificationResult }
            : { codes: { configured: code, generic: code } }),
          receipts,
        },
        ...(scenario === "restart" ? { reopenAt: "suspended" } : {}),
      };
    });
    return NativeTestSuiteSchema.parse({ genericModelId: h.modelId, cases });
  };
  const setupOnly = () => ({
    origin: h.origin,
    endpoint: h.origin + "/v1/" + h.target.workspaceId,
    admin: {
      email: "owner@example.test",
      password: "TEST-design-HTTP-password-only-2026",
    },
    target: h.target,
    serviceId: h.serviceId,
    calendarId,
    modelId: h.modelId,
    definition,
    brief,
    input: PIPELINE_INPUT,
    createInput: { body: PIPELINE_INPUT },
    question: PIPELINE_QUESTION,
    answer: PIPELINE_ANSWER,
    expectedResult: finalResult,
    unavailableResult: {
      ...PIPELINE_INPUT,
      meetingId: "",
      status: "unavailable",
      ...(options.outputPadding
        ? {
            ...Object.fromEntries(
              Object.keys(outputPadding).map((key) => [
                key,
                key === "audit00" ? "" : outputPadding[key],
              ]),
            ),
            confirmed: false,
          }
        : {}),
    },
    actionIds: {
      lookup: h.actionId,
      availability: availabilityId,
      create: createId,
      readback: readbackId,
    },
  });
  const designProfile = options.workspaceOwned
    ? "?profile=" + encodeURIComponent(WORKSPACE_DESIGN_PROFILE)
    : "";
  const registryQuery = new URLSearchParams({
    ...h.target,
    ...(options.workspaceOwned ? { profile: WORKSPACE_PROCESS_PROFILE } : {}),
  });
  const runPipeline = async (
    runOptions: {
      mobileDesigner?: boolean;
      mobileDesignOwner?: "service" | "workspace";
      activate?: boolean;
    } = {},
  ) => {
    const post = async (path: string, input: object) => {
      const response = await h.request("owner", path, input, {
        signal: AbortSignal.timeout(125_000),
      });
      assert.equal(
        response.status,
        200,
        path + ": " + JSON.stringify(response.data),
      );
      return h.record(response.data);
    };
    const mobile = runOptions.mobileDesigner ? await credential() : undefined;
    const mobileDesignOwner =
      runOptions.mobileDesignOwner ??
      (options.workspaceOwned ? "workspace" : "service");
    const mobileDesignProfile =
      mobileDesignOwner === "workspace"
        ? WORKSPACE_DESIGN_PROFILE
        : DESIGN_PROFILE;
    const mobileRequest = async (
      path: string,
      method: "GET" | "POST",
      input?: object,
    ) => {
      const url = new URL("/v1/" + h.target.workspaceId + "/" + path, h.origin);
      url.searchParams.set("profile", mobileDesignProfile);
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${mobile!.accessToken}`,
          "Content-Type": "application/json",
        },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      const value = h.record(await response.json());
      assert.equal(response.status, 200, path + ": " + JSON.stringify(value));
      return value;
    };
    const startedValue = runOptions.mobileDesigner
      ? await mobileRequest("process-design/start", "POST", {
          ...(mobileDesignOwner === "workspace"
            ? {
                profile: WORKSPACE_DESIGN_PROFILE,
                owner: { type: "workspace" },
              }
            : { serviceId: h.serviceId }),
          requestId: randomUUID(),
        })
      : await post(designHttpPath + "/start" + designProfile, {
          ...h.target,
          requestId: randomUUID(),
          ...(options.workspaceOwned
            ? {
                profile: WORKSPACE_DESIGN_PROFILE,
                owner: { type: "workspace" },
              }
            : { serviceId: h.serviceId }),
          confirmation: "every_write",
        });
    const started = OwnedDesignReviewSchema.parse(startedValue.review);
    const turnValue = runOptions.mobileDesigner
      ? await mobileRequest("process-design/turns", "POST", {
          sessionId: started.id,
          requestId: randomUUID(),
          revision: started.revision,
          modelId: h.modelId,
          text: brief.purpose,
          language: "en",
        })
      : await post(designHttpPath + "/turns" + designProfile, {
          ...h.target,
          sessionId: started.id,
          requestId: randomUUID(),
          revision: started.revision,
          modelId: h.modelId,
          text: brief.purpose,
          language: "en",
        });
    const turn = DesignTurnSchema.parse(turnValue.turn);
    assert.equal(turn.status, "completed", JSON.stringify(turn));
    assert.equal(
      turn.toolReceipts[0]?.name,
      "design_update_proposal",
      JSON.stringify(turn),
    );
    const preparedValue = runOptions.mobileDesigner
      ? await mobileRequest(
          "process-design?sessionId=" + encodeURIComponent(started.id),
          "GET",
        )
      : h.record(
          (
            await h.request(
              "owner",
              designHttpPath +
                "?" +
                new URLSearchParams({
                  ...h.target,
                  sessionId: started.id,
                  ...(options.workspaceOwned
                    ? { profile: WORKSPACE_DESIGN_PROFILE }
                    : {}),
                }),
            )
          ).data,
        );
    const prepared = OwnedDesignReviewSchema.parse(preparedValue.review);
    assert(prepared.blockers.includes("assumptions_unacknowledged"));
    const reviewValue = runOptions.mobileDesigner
      ? await mobileRequest("process-design/acknowledge", "POST", {
          sessionId: started.id,
          requestId: randomUUID(),
          revision: prepared.revision,
          assumptions: prepared.assumptions.map(({ id, digest }) => ({
            id,
            digest,
          })),
        })
      : await post(designHttpPath + "/acknowledge" + designProfile, {
          ...h.target,
          sessionId: started.id,
          requestId: randomUUID(),
          revision: prepared.revision,
          assumptions: prepared.assumptions.map(({ id, digest }) => ({
            id,
            digest,
          })),
          confirmation: "every_write",
        });
    const review = OwnedDesignReviewSchema.parse(reviewValue.review);
    assert.deepEqual(review.blockers, []);
    const accepted = runOptions.mobileDesigner
      ? await mobileRequest("process-design/accept", "POST", {
          sessionId: started.id,
          requestId: randomUUID(),
          revision: review.revision,
          reviewDigest: review.reviewDigest,
        })
      : await post(designHttpPath + "/accept" + designProfile, {
          ...h.target,
          sessionId: started.id,
          requestId: randomUUID(),
          revision: review.revision,
          reviewDigest: review.reviewDigest,
        });
    const receipt = h.record(accepted.receipt);
    const acceptedReview = OwnedDesignReviewSchema.parse(accepted.review);
    const processes = (
      options.workspaceOwned ? WorkspaceProcessListSchema : ProcessListSchema
    ).parse((await h.request("owner", base + "?" + registryQuery)).data);
    const draft = processes.processes.find((p) => p.id === receipt.processId)!;
    assert(draft);
    assert.equal(draft.activeVersion, null);
    let artifact, process;
    if (options.workspaceOwned) {
      const frozen = await post(base + "/versions/freeze", {
        ...h.target,
        profile: PROCESS_VERSION_PROFILE,
        requestId: randomUUID(),
        processId: draft.id,
        revision: draft.revision,
      });
      const receipt = h.record(frozen.receipt);
      artifact = ProcessVersionSchema.parse(
        h.record(
          (
            await h.request(
              "owner",
              base +
                "?" +
                registryQuery +
                "&id=" +
                draft.id +
                "&version=" +
                receipt.version,
            )
          ).data,
        ).version,
      );
      process = OwnedProcessRecordSchema.parse(
        h.record(
          (
            await h.request(
              "owner",
              base + "?" + registryQuery + "&id=" + draft.id,
            )
          ).data,
        ).process,
      );
    } else {
      const frozen = await post(base + "/command", {
        ...h.target,
        type: "freezeDraft",
        id: draft.id,
        revision: draft.revision,
      });
      artifact = ProcessVersionSchema.parse(frozen.version);
      process = OwnedProcessRecordSchema.parse(frozen.process);
    }
    const job = NativeTestJobSchema.parse(
      (
        await post(base + "/tests/native", {
          ...h.target,
          profile: PROCESS_NATIVE_TEST_PROFILE,
          requestId: randomUUID(),
          processId: artifact.processId,
          revision: process.revision,
          version: artifact.version,
          artifactDigest: artifact.digest,
          suite: qualificationSuite(),
        })
      ).job,
    );
    assert.equal(
      job.qualification?.status,
      "qualified",
      JSON.stringify(job.report?.observations),
    );
    if (runOptions.activate === false) {
      const current = (
        options.workspaceOwned ? WorkspaceProcessListSchema : ProcessListSchema
      )
        .parse((await h.request("owner", base + "?" + registryQuery)).data)
        .processes.find((p) => p.id === artifact.processId)!;
      assert.equal(current.activeVersion, null);
      assert.equal((await inspect()).serviceDispatches.length, 0);
      return {
        ...setupOnly(),
        artifact,
        design: { review: acceptedReview, turn, receipt },
        job,
        activation: undefined,
        credential: await credential(),
      };
    }
    const activationQuery = new URLSearchParams({
      ...h.target,
      profile: PROCESS_ACTIVATION_PROFILE,
      processId: artifact.processId,
      version: String(artifact.version),
      testId: job.testId,
    });
    const activationReview = ProcessActivationReviewSchema.parse(
      h.record(
        (
          await h.request(
            "owner",
            base + "/activation/review?" + activationQuery,
          )
        ).data,
      ).review,
    );
    assert.equal(activationReview.canActivate, true);
    const activation = ProcessActivationReceiptSchema.parse(
      (
        await post(base + "/activation", {
          ...h.target,
          profile: PROCESS_ACTIVATION_PROFILE,
          requestId: randomUUID(),
          type: "activate",
          processId: artifact.processId,
          revision: activationReview.revision,
          expectedActiveVersion: null,
          version: artifact.version,
          artifactDigest: artifact.digest,
          testId: job.testId,
          qualificationDigest: job.qualification!.qualificationDigest,
          acknowledgement: "controlled_native_test_only",
        })
      ).receipt,
    );
    return {
      ...setupOnly(),
      artifact,
      design: { review: acceptedReview, turn, receipt },
      job,
      activation,
      credential: await credential(),
    };
  };
  const completePipeline = async () => {
    const result = await runPipeline();
    assert(result.activation);
    return { ...result, activation: result.activation };
  };
  const qualifyMobileDraft = () =>
    runPipeline({ mobileDesigner: true, activate: false });
  const qualifyMobileServiceDraft = () =>
    runPipeline({
      mobileDesigner: true,
      mobileDesignOwner: "service",
      activate: false,
    });
  const inspect = async () => ({
    modelCalls: h.modelCount(),
    serviceDispatches: structuredClone(serviceDispatches),
    requests: structuredClone(requests),
    models: structuredClone(h.models()),
    processes: (options.workspaceOwned
      ? WorkspaceProcessListSchema
      : ProcessListSchema
    ).parse((await h.request("owner", base + "?" + registryQuery)).data)
      .processes,
    receipts: h.identity["db"]
      .prepare("SELECT data FROM agent_service_invocation ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.data)) as StoredInvocation),
  });
  return {
    ...h,
    get identity() {
      return h.identity;
    },
    setupOnly,
    completePipeline,
    qualifyMobileDraft,
    qualifyMobileServiceDraft,
    qualificationSuite,
    credential,
    issuePairing,
    inspect,
    runtimeScenario: (next: PipelineScenario) => {
      scenario = next;
      modelStep = 0;
    },
    loops: async (id?: string) =>
      h.request(
        "owner",
        "api/identity/loops" +
          (id ? "/" + encodeURIComponent(id) : "") +
          "?" +
          h.query,
      ),
    drift: async (kind: "service" | "model" | "permission") => {
      if (kind === "service") {
        const service = h.identity["catalog"].store.service(
          h.target.workspaceId,
          calendarId,
        );
        await h.catalog({
          type: "saveService",
          id: service.id,
          revision: service.revision,
          settings: {
            ...ServiceSettings.strip().parse(service),
            enabled: false,
          },
        });
      } else if (kind === "model") {
        const selected = h.identity["catalog"].store.model(
          h.target.organizationId,
          h.modelId,
          "tools",
        );
        await h.catalog({
          type: "saveModel",
          id: selected.model.id,
          revision: selected.model.revision,
          settings: {
            ...CatalogModelSettings.strip().parse(selected.model),
            enabled: false,
          },
        });
      } else {
        const service = h.identity["catalog"].store.service(
          h.target.workspaceId,
          calendarId,
        );
        const action = service.actions.find((a) => a.id === createId)!;
        await h.catalog({
          type: "saveAction",
          id: action.id,
          serviceId: service.id,
          serviceRevision: service.revision,
          revision: action.revision,
          settings: {
            ...ActionSettings.strip().parse(action),
            policy: { roles: [], users: [] },
          },
        });
      }
    },
    restart: async () => {
      await h.restart();
      install();
    },
  };
}
