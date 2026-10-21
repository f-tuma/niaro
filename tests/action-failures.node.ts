import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionFailure,
  diagnosticText,
  mcpActionFailure,
  providerFailure,
  sanitizeActionFailure,
} from "../apps/server-integrations/failures";
import { invokeAction } from "../apps/server-integrations/discovery";
import { validateArguments } from "../apps/server-integrations/schema";
import {
  IntegrationError,
  jsonResponse,
  type IntegrationTransport,
} from "../apps/server-integrations/transport";
import type {
  Service,
  ServiceAction,
} from "../packages/protocol/service-catalog";
import { ActionFailureSchema } from "../packages/protocol/action-failure";
import { IdentityError } from "../apps/server-identity/error";
import { presentActionFailure } from "../apps/server-identity/failure-presentation";
import { INFERENCE_BUDGET_FAILURE_CODES } from "../apps/server-identity/inference-budget-failure";

const service = (protocol: "mcp" | "openapi" = "openapi"): Service => ({
  id: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  name: "TEST CRM",
  url: "https://test.invalid/api",
  protocol,
  icon: "users",
  iconSource: "custom",
  auth: { type: "bearer" },
  enabled: true,
  hasCredential: true,
  modelId: null,
  actions: [],
});
const action = (mcp = false): ServiceAction => ({
  id: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  sourceKey: null,
  name: "Create person",
  description: "TEST create person action",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
    additionalProperties: false,
  },
  binding: mcp
    ? { type: "mcp", name: "create_person" }
    : {
        type: "http",
        method: "POST",
        path: "/people",
        parameters: [],
        body: false,
      },
  effect: "write",
  approval: "always",
  enabled: true,
  policy: { roles: ["member"], users: [] },
});
const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => ({
  status,
  headers,
  text: JSON.stringify(value),
});
const options = {
  stage: "provider_response" as const,
  effect: "read" as const,
  dispatched: true,
};

test("provider budget-code collisions cannot become server pricing diagnoses, including historical receipts", () => {
  for (const code of INFERENCE_BUDGET_FAILURE_CODES) {
    const provider = providerFailure(
      { code, message: "TEST provider rejection" },
      { httpStatus: 503 },
    );
    assert.equal(provider.code, "integration_provider_failed");
    assert.equal(provider.stage, "provider_response");
    assert.equal(provider.kind, "provider");
    for (const language of ["en", "cs"] as const) {
      for (const failure of [provider, { ...provider, code }]) {
        const presented = presentActionFailure(failure, "failed", language);
        assert.equal(
          presented.fields[0]!.value,
          language === "en"
            ? "The service rejected the action."
            : "Služba akci odmítla.",
        );
        assert(presented.reply.includes("TEST provider rejection"));
      }
    }
  }
  const own = actionFailure(
    new IdentityError(409, "catalog_budget_price_required"),
    { stage: "dispatch", effect: "write", dispatched: false },
  );
  assert.equal(own.code, "catalog_budget_price_required");
  assert.equal(own.stage, "dispatch");
  assert.match(
    presentActionFailure(own, "failed", "en").reply,
    /pricing is missing/,
  );
  assert.match(
    presentActionFailure(own, "failed", "cs").reply,
    /chybí nastavená cena/,
  );
  for (const language of ["en", "cs"] as const) {
    const unknown = presentActionFailure(own, "unknown", language);
    assert.match(
      unknown.reply,
      language === "en" ? /may already have happened/ : /mohla už proběhnout/,
    );
  }
});

test("HTTP diagnostics preserve safe validation fields and redact exact credentials before clipping", () => {
  const key = "TEST-short-key";
  const cookie = "TEST-cookie-value";
  let caught: unknown;
  try {
    jsonResponse(
      json(
        {
          error: {
            code: "INVALID_DATA_INPUT",
            message:
              `Name is required; echoed ${key}, ${cookie}. ` + "x".repeat(1000),
            details: [
              {
                path: "/name/firstName",
                message: "Required field is missing.",
              },
            ],
            headers: { authorization: "Bearer TEST-header-value" },
            credential: { secret: "TEST-body-secret" },
          },
          request: { rawBody: "TEST PRIVATE INPUT" },
          stack: "TEST PRIVATE STACK",
        },
        422,
        { "set-cookie": `sid=${cookie}; HttpOnly` },
      ),
      [key],
    );
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof IntegrationError);
  assert.equal(caught.code, "integration_provider_failed");
  const failure = actionFailure(caught, options);
  assert.equal(failure.code, "INVALID_DATA_INPUT");
  assert.equal(failure.httpStatus, 422);
  assert.equal(failure.kind, "validation");
  assert.equal(failure.retry, "correct_input");
  assert.deepEqual(failure.fields, [
    { path: "/name/firstName", issue: "Required field is missing." },
  ]);
  assert.equal(failure.message?.length, 600);
  const serialized = JSON.stringify(failure);
  for (const privateValue of [
    key,
    cookie,
    "TEST-header-value",
    "TEST-body-secret",
    "TEST PRIVATE INPUT",
    "TEST PRIVATE STACK",
  ])
    assert(!serialized.includes(privateValue));
  assert(serialized.includes("[redacted]"));
});

test("HTTP authentication, permission, rate limit and outage have distinct next steps", () => {
  for (const [status, kind, retry] of [
    [401, "connection", "reconnect"],
    [403, "permission", "none"],
    [429, "rate_limit", "later"],
    [500, "provider", "later"],
  ]) {
    const failure = providerFailure(
      { message: "TEST provider reason" },
      { httpStatus: Number(status) },
    );
    assert.equal(failure.kind, kind);
    assert.equal(failure.retry, retry);
  }
});

test("provider validation message arrays remain useful without raw JSON or credentials", () => {
  const failure = providerFailure(
    {
      message: [
        "name.firstName must be a string",
        "Rejected TEST-validation-key",
      ],
      error: "Bad Request",
    },
    { httpStatus: 400, secretValues: ["TEST-validation-key"] },
  );
  assert.equal(
    failure.message,
    "name.firstName must be a string; Rejected [redacted]",
  );
  assert.equal(failure.retry, "correct_input");
});

test("malformed, HTML and huge provider bodies produce bounded metadata without inventing detail", () => {
  for (const value of [
    "not JSON TEST PRIVATE",
    "<html>TEST PRIVATE ERROR</html>",
    JSON.stringify({ message: "x".repeat(40000) }),
    null,
    [],
  ]) {
    const failure = providerFailure(value, { httpStatus: 503 });
    assert.deepEqual(failure, {
      code: "integration_provider_failed",
      kind: "provider",
      retry: "later",
      stage: "provider_response",
      httpStatus: 503,
      fields: [],
    });
  }
  assert.equal(diagnosticText("<html>TEST private</html>"), undefined);
  assert.equal(diagnosticText('{"raw":"TEST private"}'), undefined);
});

test("nested credential values never appear in error messages, issues or media", () => {
  const failure = providerFailure({
    message: "Cannot use TEST-OAuth-value and TEST-Api-value",
    access_token: "TEST-OAuth-value",
    credentials: { apiKey: "TEST-Api-value" },
    fieldErrors: {
      email: ["Use a valid email."],
      password: ["TEST-password-value"],
    },
    content: [
      { type: "image", data: "TEST-binary-value" },
      { type: "resource", resource: { text: "TEST-resource-value" } },
    ],
  });
  assert.equal(failure.message, "Cannot use [redacted] and [redacted]");
  assert.deepEqual(failure.fields, [
    { path: "email", issue: "Use a valid email." },
  ]);
  assert(!JSON.stringify(failure).includes("TEST-"));
});

test("late credential aliases are scanned before projection and exhausted scans discard diagnostic text", () => {
  const late = {
    message: "Rejected TEST-late-secret",
    ...Object.fromEntries(
      Array.from({ length: 90 }, (_, index) => [
        "unused" + index,
        "business field",
      ]),
    ),
    apiKey: "TEST-late-secret",
  };
  assert.equal(providerFailure(late).message, "Rejected [redacted]");
  const huge = {
    message: "Rejected TEST-deep-secret",
    irrelevant: Array.from({ length: 1500 }, (_, index) => ({
      business: index,
    })),
    nested: { token: "TEST-deep-secret" },
  };
  const incomplete = providerFailure(huge, { httpStatus: 400 });
  assert.equal(incomplete.message, undefined);
  assert.deepEqual(incomplete.fields, []);
  assert(!JSON.stringify(incomplete).includes("TEST-deep-secret"));
});

test("field and message projections are limited, URL and authorization contents are removed", () => {
  const failure = providerFailure({
    message:
      "Basic TEST-basic-value https://user:pass@test.invalid/path?token=TEST-url-value",
    issues: Array.from({ length: 40 }, (_, index) => ({
      path: "/field" + index + "x".repeat(300),
      message: "a".repeat(1000),
    })),
  });
  assert.equal(failure.fields.length, 8);
  assert(
    failure.fields.every(
      (field) => field.path.length <= 160 && field.issue.length <= 300,
    ),
  );
  assert(!JSON.stringify(failure).includes("TEST-basic-value"));
  assert(!JSON.stringify(failure).includes("TEST-url-value"));
  assert(ActionFailureSchema.safeParse(failure).success);
});

test("arbitrary exception messages and forged code objects cannot become diagnostic text", () => {
  for (const error of [
    new Error("TEST private exception and credential"),
    { code: "integration_input_invalid", message: "TEST private fake" },
  ])
    assert.deepEqual(actionFailure(error, options), {
      code: "action_failed",
      kind: "unknown",
      retry: "none",
      stage: "provider_response",
      fields: [],
    });
  const known = Object.assign(new Error("TEST private permission exception"), {
    code: "identity_forbidden",
  });
  assert.deepEqual(actionFailure(known, options), {
    code: "identity_forbidden",
    kind: "permission",
    retry: "none",
    stage: "provider_response",
    fields: [],
  });
  const staleMeeting = Object.assign(new Error("TEST resolved task"), {
    code: "process_origin_changed",
  });
  assert.deepEqual(
    actionFailure(staleMeeting, {
      ...options,
      effect: "write",
      stage: "dispatch",
      dispatched: false,
    }),
    {
      code: "process_origin_changed",
      kind: "validation",
      retry: "none",
      stage: "dispatch",
      fields: [],
    },
  );
});

test("an actual dispatched write always requires verification, including a provider refusal or cancellation", () => {
  const error = new IntegrationError(
    "integration_provider_failed",
    502,
    providerFailure(
      { error: { code: "INVALID_ARGUMENT", message: "Invalid field." } },
      { httpStatus: 400 },
    ),
  );
  const failure = actionFailure(error, { ...options, effect: "write" });
  assert.equal(failure.kind, "validation");
  assert.equal(failure.retry, "verify_first");
  assert.equal(
    actionFailure(error, { ...options, effect: "write", aborted: true }).retry,
    "verify_first",
  );
  assert.equal(
    actionFailure(error, { ...options, effect: "write", dispatched: false })
      .retry,
    "correct_input",
  );
});

test("saved diagnostics are reprojected without unknown fields, invalid enums or private payloads", () => {
  const safe = sanitizeActionFailure({
    code: "integration_provider_failed",
    kind: "provider",
    stage: "provider_response",
    retry: "later",
    message: "Rejected Authorization: Bearer TEST-private-value",
    fields: [
      { path: "email", issue: "Wrong format." },
      { path: "password", issue: "TEST private" },
    ],
    raw: "TEST private raw",
  });
  assert(safe);
  assert(!JSON.stringify(safe).includes("TEST"));
  assert.equal(safe.fields.length, 1);
  assert.equal(
    sanitizeActionFailure({ ...safe, retry: "auto_write" }),
    undefined,
  );
});

test("local schema validation identifies missing, mistyped and unsupported fields without dispatch", async () => {
  for (const [input, path, issue] of [
    [{}, "/name", "Required field is missing."],
    [{ name: 7 }, "/name", "Expected string."],
    [
      { name: "Jane Test", extra: "TEST private" },
      "/extra",
      "This field is not supported.",
    ],
  ] as const) {
    let dispatches = 0;
    await assert.rejects(
      invokeAction(
        async () => {
          dispatches++;
          return json({});
        },
        service(),
        action(),
        "TEST-key",
        input,
        new AbortController().signal,
        async (start) => start(),
        () => {
          dispatches++;
        },
      ),
      (error: unknown) => {
        assert(error instanceof IntegrationError);
        assert.equal(error.failure?.stage, "validation");
        assert.deepEqual(error.failure?.fields, [{ path, issue }]);
        assert(!JSON.stringify(error.failure).includes("TEST private"));
        return true;
      },
    );
    assert.equal(dispatches, 0);
  }
  assert.throws(
    () => validateArguments(action().inputSchema, { name: "x".repeat(65537) }),
    (error: unknown) =>
      error instanceof IntegrationError &&
      error.failure?.message === "Input exceeds the supported size.",
  );
});

function mcpTransport(
  reply: unknown,
  options: {
    handshakeStatus?: number;
    guardFails?: boolean;
    actionHeaders?: Record<string, string>;
    nativeCatalogTool?: string;
  } = {},
) {
  const methods: string[] = [];
  let actionDispatches = 0;
  const transport: IntegrationTransport = async (request) => {
    const body = request.body as {
      id?: number;
      method: string;
      params?: { name: string; arguments: { toolName?: string } };
    };
    await request.beforeDispatch?.(() => methods.push(body.method));
    if (body.method === "initialize")
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
          },
        },
        options.handshakeStatus ?? 200,
        { "mcp-session-id": "TEST-session-value" },
      );
    if (body.method === "notifications/initialized")
      return { status: 204, headers: {}, text: "" };
    if (options.nativeCatalogTool) {
      assert.equal(body.params?.name, "execute_tool");
      assert.equal(body.params?.arguments.toolName, options.nativeCatalogTool);
    }
    return json(
      { jsonrpc: "2.0", id: body.id, ...(reply as object) },
      200,
      options.actionHeaders,
    );
  };
  const run = () =>
    invokeAction(
      transport,
      service("mcp"),
      options.nativeCatalogTool
        ? {
            ...action(true),
            binding: {
              type: "mcp",
              name: "execute_tool",
              catalogTool: options.nativeCatalogTool,
            },
          }
        : action(true),
      "TEST-api-key",
      { name: "Jane Test" },
      new AbortController().signal,
      async (start) => {
        if (options.guardFails && methods.length >= 2)
          throw new IntegrationError("integration_dispatch_denied", 403);
        start();
      },
      () => {
        actionDispatches++;
      },
    );
  return {
    run,
    methods,
    get actionDispatches() {
      return actionDispatches;
    },
  };
}

test("MCP JSON-RPC errors preserve numeric code, reason and paths after real action dispatch", async () => {
  const h = mcpTransport({
    error: {
      code: -32602,
      message: "Missing firstName; echoed TEST-api-key TEST-session-value",
      data: {
        issues: [
          {
            path: ["name", "firstName"],
            message: "Required field is missing.",
          },
        ],
      },
    },
  });
  await assert.rejects(h.run, (error: unknown) => {
    assert(error instanceof IntegrationError);
    assert.equal(error.failure?.code, "-32602");
    assert.equal(error.failure?.kind, "validation");
    assert.deepEqual(error.failure?.fields, [
      { path: "/name/firstName", issue: "Required field is missing." },
    ]);
    assert(!JSON.stringify(error.failure).includes("TEST-api-key"));
    assert(!JSON.stringify(error.failure).includes("TEST-session-value"));
    return true;
  });
  assert.deepEqual(h.methods, [
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
  assert.equal(h.actionDispatches, 1);
});

test("Twenty native create_one_person keeps the specific error instead of its generic ToolOutput message", async () => {
  const result = {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          message: "Failed to create record in person",
          error:
            "TEST validation: emails.primaryEmail has invalid format; echoed TEST-api-key TEST-session-value",
        }),
      },
    ],
  };
  const h = mcpTransport(
    { result },
    { nativeCatalogTool: "create_one_person" },
  );
  await assert.rejects(h.run, (error: unknown) => {
    assert(error instanceof IntegrationError);
    assert.equal(
      error.failure?.message,
      "TEST validation: emails.primaryEmail has invalid format; echoed [redacted] [redacted]",
    );
    assert(!JSON.stringify(error.failure).includes("TEST-api-key"));
    assert(!JSON.stringify(error.failure).includes("TEST-session-value"));
    assert.equal(
      actionFailure(error, { ...options, effect: "write" }).retry,
      "verify_first",
    );
    return true;
  });
  assert.equal(h.actionDispatches, 1);
});

test("Twenty nested error details preserve code, message and field diagnostics inside native MCP output", async () => {
  const result = {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          message: "Failed to create record in person",
          error: {
            code: "INVALID_ARGS_DATA",
            message: "TEST record fields are invalid.",
            fieldErrors: {
              "emails.primaryEmail": ["Use a valid email."],
              name: { messages: ["First name is missing."] },
            },
            credentials: { apiKey: "TEST-private-cause-key" },
            request: { body: "TEST-private-input" },
          },
        }),
      },
    ],
  };
  const h = mcpTransport(
    { result },
    { nativeCatalogTool: "create_one_person" },
  );
  await assert.rejects(h.run, (error: unknown) => {
    assert(error instanceof IntegrationError);
    assert.equal(error.failure?.code, "INVALID_ARGS_DATA");
    assert.equal(error.failure?.kind, "validation");
    assert.equal(error.failure?.message, "TEST record fields are invalid.");
    assert.deepEqual(error.failure?.fields, [
      { path: "emails.primaryEmail", issue: "Use a valid email." },
      { path: "name", issue: "First name is missing." },
    ]);
    assert(!JSON.stringify(error.failure).includes("TEST-private"));
    return true;
  });
});

test("Twenty HTTP exception names cannot overshadow plural validation messages", () => {
  let caught: unknown;
  try {
    jsonResponse(
      json(
        {
          statusCode: 400,
          error: "BadRequestException",
          messages: [
            "TEST email field has invalid format.",
            "TEST first name is required; echoed TEST-http-key",
          ],
        },
        400,
      ),
      ["TEST-http-key"],
    );
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof IntegrationError);
  assert.equal(
    caught.failure?.message,
    "TEST email field has invalid format.; TEST first name is required; echoed [redacted]",
  );
  assert.equal(caught.failure?.kind, "validation");
  assert.equal(caught.failure?.httpStatus, 400);
  assert.equal(caught.failure?.retry, "correct_input");
});

test("explicit causes are bounded and sanitized while missing or unusable details preserve the generic fallback", () => {
  assert.equal(
    providerFailure({
      message: "Generic wrapper",
      error: {
        message: "Generic execution error",
        cause: { message: "TEST specific nested field issue." },
      },
    }).message,
    "TEST specific nested field issue.",
  );
  const cause = providerFailure(
    {
      message: "Failed to create record in person",
      cause: "TEST specific issue " + "TEST-secret-value" + "x".repeat(2000),
    },
    { secretValues: ["TEST-secret-value"] },
  );
  assert(cause.message?.startsWith("TEST specific issue [redacted]"));
  assert.equal(cause.message?.length, 600);
  assert(!cause.message.includes("TEST-secret-value"));
  for (const error of [
    undefined,
    "",
    null,
    "<html>TEST private page</html>",
    "x".repeat(40000),
  ]) {
    const failure = providerFailure({
      success: false,
      message: "Failed to create record in person",
      error,
    });
    assert.equal(failure.message, "Failed to create record in person");
    assert.deepEqual(failure.fields, []);
  }
  assert.equal(
    mcpActionFailure({
      structuredContent: {
        id: "TEST-business-record",
        status: "failed",
        cause: "Historical business cause",
      },
    }),
    undefined,
  );
});

test("HTTP 200 MCP error diagnostics redact fresh response cookies, authorization and tokens", async () => {
  const message =
    "Rejected TEST-response-cookie TEST-response-authorization TEST-response-token";
  for (const reply of [
    { error: { code: -32602, message } },
    { result: { isError: true, content: [{ type: "text", text: message }] } },
  ]) {
    const h = mcpTransport(reply, {
      actionHeaders: {
        "set-cookie": "sid=TEST-response-cookie; HttpOnly",
        authorization: "Bearer TEST-response-authorization",
        "x-access-token": "TEST-response-token",
      },
    });
    await assert.rejects(h.run, (error: unknown) => {
      assert(error instanceof IntegrationError);
      assert.equal(
        error.failure?.message,
        "Rejected [redacted] [redacted] [redacted]",
      );
      assert(!JSON.stringify(error.failure).includes("TEST-response"));
      return true;
    });
    assert.equal(h.actionDispatches, 1);
  }
});

test("MCP business false flags and failed job records without error evidence remain successful data", async () => {
  for (const structuredContent of [
    { ok: false },
    { success: false },
    { id: "TEST-job", status: "failed" },
    { success: false, fieldErrors: {} },
  ]) {
    const result = { isError: false, structuredContent };
    assert.equal(mcpActionFailure(result), undefined);
    const h = mcpTransport({ result });
    assert.deepEqual(await h.run(), result);
    assert.equal(h.actionDispatches, 1);
  }
});

test("MCP isError and explicit wrapped failures never become success because outer isError is false", async () => {
  for (const result of [
    { isError: true, content: [{ type: "text", text: "Name is required." }] },
    {
      isError: false,
      structuredContent: {
        status: "failed",
        error: { code: "INVALID_DATA", message: "Name is required." },
      },
    },
    {
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: { code: "INVALID_DATA", message: "Name is required." },
          }),
        },
      ],
    },
  ]) {
    const h = mcpTransport({ result });
    await assert.rejects(
      h.run,
      (error: unknown) =>
        error instanceof IntegrationError &&
        error.failure?.message === "Name is required.",
    );
    assert.equal(h.actionDispatches, 1);
  }
  assert.equal(
    mcpActionFailure({
      isError: false,
      structuredContent: { name: "Jane Test" },
      content: [{ type: "text", text: "Jane Test" }],
    }),
    undefined,
  );
  assert.equal(
    mcpActionFailure({
      isError: false,
      structuredContent: {
        records: [{ name: "Jane Test", error: "historical business property" }],
      },
    }),
    undefined,
  );
});

test("MCP authorization still guards handshake and action, while handshake failures do not mark action dispatched", async () => {
  const h = mcpTransport({ result: {} }, { handshakeStatus: 401 });
  await assert.rejects(
    h.run,
    (error: unknown) =>
      error instanceof IntegrationError &&
      error.failure?.stage === "connection" &&
      error.failure?.httpStatus === 401,
  );
  assert.deepEqual(h.methods, ["initialize"]);
  assert.equal(h.actionDispatches, 0);
  const refused = mcpTransport({ result: {} }, { guardFails: true });
  await assert.rejects(refused.run, /integration_dispatch_denied/);
  assert.deepEqual(refused.methods, [
    "initialize",
    "notifications/initialized",
  ]);
  assert.equal(refused.actionDispatches, 0);
});

test("REST callback marks only an authorized action dispatch and HTTP diagnostics include known API key redaction", async () => {
  let dispatched = 0;
  const transport: IntegrationTransport = async (request) => {
    await request.beforeDispatch?.(() => {});
    return json(
      {
        message: "Invalid name; echoed TEST-api-key",
        fieldErrors: { name: "Use a name." },
      },
      400,
    );
  };
  await assert.rejects(
    invokeAction(
      transport,
      service(),
      action(),
      "TEST-api-key",
      { name: "Jane Test" },
      new AbortController().signal,
      async (start) => start(),
      () => {
        dispatched++;
      },
    ),
    (error: unknown) => {
      assert(error instanceof IntegrationError);
      assert.equal(error.failure?.message, "Invalid name; echoed [redacted]");
      return true;
    },
  );
  assert.equal(dispatched, 1);
});
