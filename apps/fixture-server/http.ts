import { pipeline } from "node:stream";
import {
  meetingAudioRoute,
  meetingRoute,
  humanTaskRoute,
} from "../server-identity/meeting-http";
import { clientAddress } from "../server-identity/client-address";
import {
  PROCESS_OUTPUT_PROFILE,
  PROCESS_OUTPUT_WORK_PROFILE,
  PROCESS_OUTPUT_MAX_REQUEST_BYTES,
  ProcessOutputRequestSchema,
} from "../../packages/protocol/process-output";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  PairingRequestSchema,
  PROFILE,
  DEVICE_SESSION_PROFILE,
  CONVERSATION_HISTORY_PROFILE,
  ConversationListStateSchema,
  CONVERSATION_PROJECTION_PROFILE,
  sameScope,
  OPEN_WORK_PROFILE,
} from "../../packages/protocol";
import {
  SERVER_INFO_PROFILE,
  ServerInfoSchema,
} from "../../packages/protocol/server-info";
import { FixtureAuth, AuthError } from "./auth";
import {
  ChatSearchRateLimited,
  ChatSearchUnavailable,
  chatSearchRequest,
} from "./chat-search";
import { loggedPath, operatorLog, operatorLogEnabled } from "./operator-log";
import { processEventsForCurrentWindow } from "./process-event-visibility";
import {
  REPLY_CORRELATION_PROFILE,
  snapshotForClient,
  eventsForClient,
} from "../../packages/protocol/reply-correlation";
import { CARD_PROFILE } from "../../packages/protocol/card-document";
import {
  HUB_PROFILE,
  HUB_PROFILE_V2,
  HUB_PROFILE_V3,
} from "../../packages/protocol/hub";
import {
  ProcessRuntimeProfileSchema,
  ProcessRuntimeReadQuerySchema,
  ProcessRuntimeInterruptRequestSchema,
  ProcessRuntimeInterruptResponseSchema,
} from "../../packages/protocol/process-coordinator";
import {
  snapshotWithoutCards,
  eventsWithoutCards,
} from "../../packages/protocol/card-delivery";
import {
  messageDelivery,
  messageForClient,
  snapshotForMessageDelivery,
  eventsForMessageDelivery,
} from "../../packages/protocol/message-delivery";
import {
  QUESTION_OPTIONS_PROFILE,
  snapshotWithoutQuestionOptions,
  eventsWithoutQuestionOptions,
} from "../../packages/protocol/question-options";
import {
  PROCESS_WORK_PROFILE,
  PROCESS_QUESTION_WORK_PROFILE,
  PROCESS_APPROVAL_WORK_PROFILE,
  snapshotWithoutProcessOutputs,
  eventsWithoutProcessOutputs,
  snapshotWithoutProcessApprovals,
  eventsWithoutProcessApprovals,
  snapshotWithoutProcessWork,
  snapshotWithoutProcessQuestions,
  eventsWithoutProcessQuestions,
  eventsWithoutProcessWork,
} from "../../packages/protocol/process-work";
import { IdentityError } from "../server-identity/error";
import type { McpPrincipal } from "../server-identity/mcp-access";
import {
  BrowserLoginStart,
  BrowserLoginSecret,
} from "../../packages/protocol/browser-login";
import {
  SpeechError,
  type SpeechSynthesizer,
} from "../server-integrations/speech";
import {
  SPEECH_PROFILE,
  SPEECH_TEXT_LENGTH,
  SpeechCapabilitiesSchema,
  SpeechRequestSchema,
  SpeechResultSchema,
} from "../../packages/protocol/speech";
import { VoiceError, type Transcriber } from "./voice";
import { ModelError, type DecisionRouter } from "./decision";
import { ModelService } from "./model-service";
import { McpTasks } from "../server-mcp/tasks";
import { HubRunner } from "../server-identity/hub-runner";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../../packages/protocol/process-questions";
import {
  createMcpHttpHandler,
  McpAuthenticationError,
  McpTaskError,
} from "../server-mcp/transport";
import {
  REQUEST_INTERRUPTION_PROFILE,
  RequestInterruptionRequestSchema,
  RequestInterruptionResponseSchema,
} from "../../packages/protocol/request-interruption";
import {
  ACTIVITY_PROFILE,
  WORKFLOW_ACTIVITY_PROFILE,
  TOOL_ACTIVITY_PROFILE,
  LEGACY_ACTIVITY_PROFILE,
  legacyActivity,
  toolActivity,
  workflowActivity,
  ActivityCommandIdSchema,
  ActivityResponseSchema,
} from "../../packages/protocol/activity";
import type { AdminTool } from "../../packages/protocol/admin";
import type { ContactDirectory } from "../server-tools/contacts";
import type { IdentityService } from "../server-identity/service";
import {
  AccountWorkspaceId,
  isAccountScope,
} from "../../packages/protocol/mobile-access";
import {
  voiceCapabilities,
  VoiceRequestSchema,
  VoiceResultSchema,
  VoiceTranscriptSchema,
  VOICE_PROFILE,
  VOICE_BODY_BYTES,
  type VoiceContext,
} from "../../packages/protocol/voice";
import {
  CalDavCalendar,
  CalendarWorker,
  type CalendarConfig,
} from "./calendar";
import {
  FixtureStorage,
  acquireServerLock,
  type StorageCheckpoint,
} from "./storage";
async function body(req: IncomingMessage, limit = 65536) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RangeError("payload_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
/** Connector errors become short, public reasons the MCP client can act on. */
const connectorFailures: Record<string, string> = {
  mcp_tool_not_found: "This tool is no longer available. List the tools again.",
  mcp_call_not_found: "No call with this requestId exists for this access.",
  service_oauth_connection_required:
    "The person must first connect their own account to this service in Niaro.",
  catalog_action_denied: "This action is disabled or not permitted.",
  catalog_conflict:
    "The service configuration changed. List the tools again and retry.",
  catalog_pending_limit:
    "Too many calls are waiting for approval. Ask the person to review them in Niaro.",
  integration_schema_unsupported: "The input does not match the tool schema.",
  integration_input_invalid: "The input does not match the tool schema.",
};
function connectorHandlers(
  identity: NonNullable<FixtureServerOptions["identity"]>,
) {
  const { mcpConnectorTools, mcpConnectorCall, mcpConnectorStatus } = identity;
  if (!mcpConnectorTools || !mcpConnectorCall || !mcpConnectorStatus)
    return undefined;
  const publicError = async <T>(run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      const code =
        error instanceof IdentityError
          ? error.code
          : error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code)
            : "";
      // Field-level validation issues are schema paths, safe to return.
      const fields =
        error instanceof Error && "failure" in error
          ? ((
              error as {
                failure?: { fields?: { path: string; issue: string }[] };
              }
            ).failure?.fields ?? [])
          : [];
      throw new McpTaskError(
        code in connectorFailures ? code : "call_failed",
        [
          connectorFailures[code] ?? "The service call failed.",
          ...fields
            .slice(0, 10)
            .map((field) => `${field.path}: ${field.issue}`),
        ].join(" "),
      );
    }
  };
  return {
    modes: (principal: McpPrincipal) => ({
      tasks: principal.scopes.some((scope) => scope.startsWith("native.")),
      connector: principal.scopes.includes("services.call"),
    }),
    list: async (principal: McpPrincipal) =>
      (await mcpConnectorTools.call(identity, principal)).map(
        ({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        }),
      ),
    call: (
      principal: McpPrincipal,
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) =>
      publicError(() =>
        mcpConnectorCall.call(identity, principal, name, input, signal),
      ),
    status: (principal: McpPrincipal, requestId: string) =>
      publicError(() =>
        mcpConnectorStatus.call(identity, principal, requestId),
      ),
  };
}
export type FixtureServerOptions = {
  identity?: Pick<
    IdentityService,
    | "attachWorkflow"
    | "mobileAccess"
    | "mobileMeetingAccess"
    | "mobileProcessOutput"
    | "mobileProcessOutputCapabilities"
    | "mobileProcesses"
    | "mobileProcessInput"
    | "mobileProcessDesign"
    | "mobileProcessCoordinator"
    | "pairMobile"
    | "browserLogin"
    | "appLogin"
    | "mobileServiceConnection"
    | "revokeMobile"
    | "refreshMobile"
    | "calendarTarget"
    | "executeCalendar"
  > &
    Partial<
      Pick<
        IdentityService,
        | "mcpAuthenticate"
        | "mcpTaskDependencies"
        | "mcpPublicHttp"
        | "baseURL"
        | "mcpConnectorTools"
        | "mcpConnectorCall"
        | "mcpConnectorStatus"
        | "mobileHub"
        | "mobileHubUnattended"
        | "hubRecord"
        | "hubRelease"
        | "hubFill"
        | "attachHubRunner"
        | "hubOpen"
        | "mobileSkills"
        | "mobileMentions"
        | "mobileProcessProposal"
      >
    >;
  management?: (
    req: IncomingMessage,
    res: ServerResponse,
    tools: AdminTool[],
  ) => Promise<boolean>;
  now?: () => number;
  sessionTtlMs?: number;
  checkpoint?: StorageCheckpoint;
  calendar?: CalendarConfig;
  calendarTransport?: typeof fetch;
  transcriber?: Transcriber;
  synthesizer?: SpeechSynthesizer;
  model?: DecisionRouter;
  crm?: ContactDirectory;
  /** A function is read at every request: administration may rename the server. */
  serverName?: string | (() => string);
};
export function createFixtureServer(
  directory: string,
  origins = [
    "http://localhost:8081",
    "http://localhost:8082",
    "http://127.0.0.1:8081",
  ],
  options: FixtureServerOptions = {},
) {
  const serverName =
    typeof options.serverName === "string"
      ? ServerInfoSchema.shape.name.parse(options.serverName)
      : options.serverName;
  const release = acquireServerLock(directory);
  let auth: FixtureAuth;
  let storage: FixtureStorage;
  let worker: CalendarWorker;
  try {
    auth = new FixtureAuth(directory, options.now, options.sessionTtlMs);
    options.identity?.attachWorkflow(auth.serverId);
    const calendar = options.calendar
      ? new CalDavCalendar(options.calendar, options.calendarTransport)
      : undefined;
    if (calendar && calendar.config.scope.serverId !== auth.serverId)
      throw new Error("Calendar server identity mismatch");
    storage = new FixtureStorage(
      directory,
      auth.serverId,
      options.now,
      options.checkpoint,
      (scope) =>
        isAccountScope(scope)
          ? options.identity?.calendarTarget(scope)
          : calendar?.targetFor(scope),
    );
    worker = new CalendarWorker(
      storage,
      calendar,
      options.identity?.executeCalendar.bind(options.identity),
    );
  } catch (error) {
    release();
    throw error;
  }
  const models = options.model
    ? new ModelService(storage, options.model, options.now, options.crm)
    : undefined;
  // Account workspaces never inherit the instance CRM directory.
  const accountModels = options.identity
    ? new ModelService(storage, options.model, options.now)
    : undefined;
  const speechActive = new Set<string>();
  const browserAttempts = new Map<string, { count: number; until: number }>();
  const modelControllers = new Set<AbortController>();
  const mcpTasks =
    options.identity?.mcpTaskDependencies &&
    options.identity.baseURL &&
    accountModels
      ? new McpTasks(
          options.identity.mcpTaskDependencies(),
          storage,
          accountModels,
          (task) =>
            `${options.identity!.baseURL}/admin/mcp?taskId=${encodeURIComponent(task.id)}&workspaceId=${encodeURIComponent(task.scope.workspaceId)}`,
        )
      : undefined;
  // Hub refreshes run in the background through the ordinary start steps.
  const identity = options.identity;
  const hubRunner =
    identity?.mobileHub &&
    identity.mobileHubUnattended &&
    identity.hubRecord &&
    identity.hubRelease
      ? new HubRunner({
          inventory: (c, query) =>
            identity.mobileProcesses(
              c.header,
              c.workspaceId,
              c.serverId,
              query,
            ),
          unattended: (c, entry) =>
            identity.mobileHubUnattended!(
              c.header,
              c.workspaceId,
              c.serverId,
              entry,
            ),
          prepare: (c, request) =>
            identity.mobileProcessInput(
              c.header,
              c.workspaceId,
              c.serverId,
              request,
            ),
          coordinator: (c) =>
            identity.mobileProcessCoordinator(
              c.header,
              c.workspaceId,
              c.serverId,
              PROCESS_QUESTION_EXECUTION_PROFILE,
            ),
          createConversation: (scope, conversationId) => {
            const key = conversationId.slice("chat-".length);
            const created = storage.execute(scope, {
              type: "conversation.create",
              commandId: key,
              idempotencyKey: key,
              conversationId,
            });
            if (created.status !== "accepted")
              throw new IdentityError(409, "hub_conversation_unavailable");
          },
          conversationExists: (scope, conversationId) => {
            const snapshot = storage.snapshot(scope, conversationId);
            return (
              sameScope(snapshot.scope, scope) &&
              snapshot.conversations.some((c) => c.id === conversationId)
            );
          },
          record: (c, scope, itemId, outcome) =>
            identity.hubRecord!(c.actor, scope, itemId, outcome),
          fill: (c, itemId, language, signal) =>
            identity.hubFill
              ? identity.hubFill(
                  // The scheduler holds no bearer: the member is checked instead.
                  c.scheduled
                    ? {
                        member: {
                          organizationId: c.actor.organizationId,
                          userId: c.actor.userId,
                        },
                      }
                    : c.header,
                  c.workspaceId,
                  c.serverId,
                  itemId,
                  language,
                  signal,
                )
              : Promise.resolve({
                  type: "failed" as const,
                  error: "hub_fill_unavailable",
                }),
          release: (scope, itemId) => identity.hubRelease!(scope, itemId),
        })
      : undefined;
  // Scheduled fills share the runner's per-person lanes with the page's.
  if (hubRunner)
    identity?.attachHubRunner?.((...args) => hubRunner.launch(...args));
  const mcp =
    mcpTasks && options.identity?.mcpAuthenticate && options.identity.baseURL
      ? createMcpHttpHandler({
          tasks: mcpTasks,
          allowedOrigins: [
            ...new Set([...origins, new URL(options.identity.baseURL).origin]),
          ],
          allowedHosts: [new URL(options.identity.baseURL).host],
          connector: connectorHandlers(options.identity),
          resourceMetadataUrl: `${options.identity.baseURL}/.well-known/oauth-protected-resource/mcp`,
          authenticate: async (req) => {
            try {
              return await options.identity!.mcpAuthenticate!(
                req.headers.authorization,
                auth.serverId,
              );
            } catch (error) {
              if (error instanceof IdentityError || error instanceof AuthError)
                throw new McpAuthenticationError(
                  error.status === 403 ? 403 : 401,
                );
              throw error;
            }
          },
        })
      : undefined;
  const accessLog = operatorLogEnabled();
  const server = createServer(async (req, res) => {
    const path = req.url?.split("?", 1)[0];
    // Orchestration probes: unauthenticated and content-free, answered before
    // any host, origin or session check so a container health check can reach them.
    if (path === "/healthz" || path === "/readyz") {
      const read = req.method === "GET" || req.method === "HEAD";
      const ok = path === "/healthz" || (!closed && storage.ready());
      res.writeHead(read ? (ok ? 200 : 503) : 405, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(read ? {} : { Allow: "GET, HEAD" }),
      });
      return res.end(
        req.method === "HEAD"
          ? undefined
          : JSON.stringify(
              read
                ? { status: ok ? "ok" : "unavailable" }
                : { error: "method_not_allowed" },
            ),
      );
    }
    if (accessLog) {
      const started = performance.now();
      // A failed request logs its error code ("hub_conflict"), never a body.
      let error: string | undefined;
      const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
      res.end = ((...args: unknown[]) => {
        error ??= failureCode(res.statusCode, args[0]);
        return end(...args);
      }) as typeof res.end;
      res.once("close", () =>
        operatorLog("http_request", {
          method: req.method?.slice(0, 10) ?? "",
          path: loggedPath(req.url),
          status: res.statusCode,
          ms: Math.round(performance.now() - started),
          ...(error ? { error } : {}),
          ...(res.writableFinished ? {} : { aborted: true }),
        }),
      );
    }
    const origin = req.headers.origin;
    const respond = (status: number, data: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(status === 401
          ? { "WWW-Authenticate": 'Bearer realm="agent-client"' }
          : {}),
        ...(origin && origins.includes(origin)
          ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
          : {}),
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
      });
      res.end(status === 204 ? undefined : JSON.stringify(data));
    };
    try {
      if (await options.identity?.mcpPublicHttp?.(req, res)) return;
    } catch {
      return respond(503, { error: "mcp_oauth_unavailable" });
    }
    if (req.url?.split("?")[0] === "/mcp") {
      if (!mcp) return respond(404, { error: "mcp_unavailable" });
      return mcp(req, res);
    }
    if (options.management) {
      try {
        if (await options.management(req, res, models?.describeTools() ?? []))
          return;
      } catch {
        // Management failures must not leak configuration or escape the HTTP lifecycle.
        return respond(503, { error: "admin_unavailable" });
      }
    }
    if (origin && !origins.includes(origin))
      return respond(403, { error: "origin_denied" });
    const url = new URL(req.url ?? "/", "http://fixture.local");
    const correlated =
      url.searchParams.get("replies") === REPLY_CORRELATION_PROFILE;
    const conversationProjection =
      url.searchParams.get("chats") === CONVERSATION_PROJECTION_PROFILE;
    const cards = url.searchParams.get("cards") === CARD_PROFILE;
    // Why a chat could not be deleted reaches only clients that ask.
    const openWorkDelivery = url.searchParams.get("work") === OPEN_WORK_PROFILE;
    const questionOptions =
      url.searchParams.get("questions") === QUESTION_OPTIONS_PROFILE;
    // Message times and newer result types reach only clients that name them.
    const messages = messageDelivery(url.searchParams);
    const outputWork =
      url.searchParams.get("tasks") === PROCESS_OUTPUT_WORK_PROFILE;
    const approvalWork =
      outputWork ||
      url.searchParams.get("tasks") === PROCESS_APPROVAL_WORK_PROFILE;
    const questionWork =
      approvalWork ||
      url.searchParams.get("tasks") === PROCESS_QUESTION_WORK_PROFILE;
    const processWork =
      questionWork || url.searchParams.get("tasks") === PROCESS_WORK_PROFILE;
    const clientSnapshot = (
      snapshot: import("../../packages/protocol").Snapshot,
    ) => {
      if (!conversationProjection && snapshot.conversations.length > 50)
        throw new IdentityError(406, "conversation_profile_required");
      const delivered = outputWork
        ? snapshot
        : snapshotWithoutProcessOutputs(snapshot);
      const compatible = processWork
        ? approvalWork
          ? delivered
          : questionWork
            ? snapshotWithoutProcessApprovals(delivered)
            : snapshotWithoutProcessQuestions(
                snapshotWithoutProcessApprovals(delivered),
              )
        : snapshotWithoutProcessWork(delivered);
      const answerable = questionOptions
        ? compatible
        : snapshotWithoutQuestionOptions(compatible);
      return snapshotForMessageDelivery(
        cards ? answerable : snapshotWithoutCards(answerable),
        messages,
      );
    };
    const clientEvents = (
      events: import("../../packages/protocol").DomainEvent[],
    ) => {
      const delivered = outputWork
        ? events
        : eventsWithoutProcessOutputs(events);
      const compatible = processWork
        ? approvalWork
          ? delivered
          : questionWork
            ? eventsWithoutProcessApprovals(delivered)
            : eventsWithoutProcessQuestions(
                eventsWithoutProcessApprovals(delivered),
              )
        : eventsWithoutProcessWork(delivered);
      const answerable = questionOptions
        ? compatible
        : eventsWithoutQuestionOptions(compatible);
      return eventsForMessageDelivery(
        cards ? answerable : eventsWithoutCards(answerable),
        messages,
      );
    };
    const appAction = /^\/v1\/auth\/app\/(start|exchange)$/.exec(
      url.pathname,
    )?.[1] as "start" | "exchange" | undefined;
    if (appAction && options.identity) {
      if (req.method === "OPTIONS") return respond(204, null);
      if (req.method !== "POST")
        return respond(405, { error: "method_not_allowed" });
      try {
        auth.rateLimit(clientAddress(req));
        return respond(
          200,
          await options.identity.appLogin(
            appAction,
            await body(req, 2048),
            origin,
          ),
        );
      } catch (error) {
        if (error instanceof IdentityError || error instanceof AuthError)
          return respond(error.status, { error: error.code });
        return respond(400, { error: "invalid_payload" });
      }
    }
    const browserAction = /^\/v1\/auth\/browser\/(start|poll|cancel)$/.exec(
      url.pathname,
    )?.[1] as "start" | "poll" | "cancel" | undefined;
    if (browserAction && options.identity) {
      if (req.method === "OPTIONS") return respond(204, null);
      if (req.method !== "POST")
        return respond(405, { error: "method_not_allowed" });
      try {
        if (browserAction === "start") auth.rateLimit(clientAddress(req));
        else {
          const now = Date.now(),
            remote = clientAddress(req);
          for (const [key, value] of browserAttempts)
            if (value.until <= now) browserAttempts.delete(key);
          let attempts = browserAttempts.get(remote);
          if (!attempts) {
            if (browserAttempts.size >= 1024)
              throw new AuthError(429, "browser_login_slow_down");
            attempts = { count: 0, until: now + 60_000 };
            browserAttempts.set(remote, attempts);
          }
          if (++attempts.count > 120)
            throw new AuthError(429, "browser_login_slow_down");
        }
        const payload = await body(req, 2048);
        const value =
          browserAction === "start"
            ? BrowserLoginStart.parse(payload)
            : BrowserLoginSecret.parse(payload);
        return respond(
          200,
          await options.identity.browserLogin(
            browserAction,
            "deviceCode" in value ? String(value.deviceCode) : undefined,
            url.searchParams.get("session") === DEVICE_SESSION_PROFILE,
          ),
        );
      } catch (error) {
        if (error instanceof IdentityError || error instanceof AuthError)
          return respond(error.status, { error: error.code });
        return respond(400, { error: "invalid_payload" });
      }
    }
    const match =
      /^\/v1\/([A-Za-z0-9-]+)\/(server|snapshot|events|meetings(?:\/[A-Fa-f0-9-]{36}(?:\/(?:blocks|seal|process|record|audio))?)?|human-tasks(?:\/[A-Za-z0-9%:._-]{1,480})?|conversations(?:\/messages)?|commands(?:\/interrupt)?|activity|auth\/pair|auth\/session|auth\/refresh|services\/(?:start|status|cancel)|process-design(?:\/(?:capabilities|start|update|acknowledge|accept|turns(?:\/list)?|sessions\/list|drafts\/list))?|processes(?:\/(?:input|runs|output(?:\/capabilities)?|commands(?:\/interrupt)?))?|hub(?:\/open)?|skills|mentions|search|process-proposals|voice|voice\/transcriptions|voice\/speech)$/.exec(
        url.pathname,
      );
    if (!match) return respond(404, { error: "not_found" });
    if (req.method === "OPTIONS") return respond(204, null);
    const workspace = match[1]!,
      route = match[2]!;
    const accountWorkspace = AccountWorkspaceId.safeParse(workspace).success;
    if (
      !["a", "b"].includes(workspace) &&
      !(accountWorkspace && options.identity)
    )
      return respond(404, { error: "not_found" });
    try {
      if (route === "process-design" || route.startsWith("process-design/")) {
        if (!accountWorkspace || !options.identity?.mobileProcessDesign)
          return respond(404, { error: "not_found" });
        if (!["GET", "POST"].includes(req.method ?? ""))
          return respond(405, { error: "method_not_allowed" });
        const controller = new AbortController();
        const cancel = () => controller.abort();
        modelControllers.add(controller);
        res.once("close", cancel);
        if (res.destroyed || res.writableEnded) cancel();
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(120_000),
        ]);
        try {
          if (req.method === "POST") auth.rateLimit(clientAddress(req));
          const payload =
            req.method === "POST" ? await body(req, 131072) : undefined;
          signal.throwIfAborted();
          return respond(
            200,
            await options.identity.mobileProcessDesign(
              req.headers.authorization,
              workspace,
              auth.serverId,
              req.method ?? "GET",
              url,
              payload,
              signal,
            ),
          );
        } finally {
          res.off("close", cancel);
          modelControllers.delete(controller);
        }
      }
      if (route === "auth/pair" && req.method === "POST") {
        auth.rateLimit(clientAddress(req));
        const request = PairingRequestSchema.parse(await body(req));
        return respond(
          200,
          accountWorkspace
            ? await options.identity!.pairMobile(
                request.code,
                workspace,
                auth.serverId,
                url.searchParams.get("session") === DEVICE_SESSION_PROFILE,
              )
            : auth.pair(request.code, workspace),
        );
      }
      if (
        route === "auth/refresh" &&
        accountWorkspace &&
        ["POST", "DELETE"].includes(req.method ?? "")
      ) {
        const result = await options.identity!.refreshMobile(
          await body(req, 4096),
          workspace,
          auth.serverId,
          req.method === "DELETE",
        );
        return respond(req.method === "DELETE" ? 204 : 200, result);
      }
      if (
        route === "processes/output" ||
        route === "processes/output/capabilities"
      ) {
        if (!accountWorkspace || !options.identity)
          return respond(404, { error: "not_found" });
        if (req.method !== "GET")
          return respond(405, { error: "method_not_allowed" });
        const keys = [...url.searchParams.keys()];
        if (
          new Set(keys).size !== keys.length ||
          keys.some(
            (key) =>
              key !== "profile" &&
              !(route === "processes/output" && key === "request"),
          )
        )
          return respond(400, { error: "invalid_payload" });
        if (url.searchParams.get("profile") !== PROCESS_OUTPUT_PROFILE)
          return respond(406, { error: "process_profile_unsupported" });
        if (route === "processes/output/capabilities")
          return respond(
            200,
            await options.identity.mobileProcessOutputCapabilities(
              req.headers.authorization,
              workspace,
              auth.serverId,
            ),
          );
        const raw = url.searchParams.get("request");
        if (!raw || Buffer.byteLength(raw) > PROCESS_OUTPUT_MAX_REQUEST_BYTES)
          return respond(400, { error: "invalid_payload" });
        const request = ProcessOutputRequestSchema.parse(JSON.parse(raw));
        return respond(
          200,
          await options.identity.mobileProcessOutput(
            req.headers.authorization,
            workspace,
            auth.serverId,
            request,
          ),
        );
      }
      // One item of an AI widget in full, read now under this credential.
      if (route === "hub/open") {
        if (!accountWorkspace || !identity?.hubOpen)
          return respond(404, { error: "not_found" });
        const keys = [...url.searchParams.keys()];
        if (
          new Set(keys).size !== keys.length ||
          keys.some((key) => key !== "language")
        )
          return respond(400, { error: "invalid_payload" });
        if (req.method !== "POST")
          return respond(405, { error: "method_not_allowed" });
        const language =
          url.searchParams.get("language") === "cs" ? "cs" : "en";
        // Authenticated and one at a time per person: the pairing limit is not spent.
        const payload = await body(req, 2048);
        const gone = new AbortController();
        res.on("close", () => gone.abort());
        return respond(
          200,
          await identity.hubOpen(
            req.headers.authorization,
            workspace,
            auth.serverId,
            payload,
            language,
            gone.signal,
          ),
        );
      }
      // The person's hub; refreshes start in the background with this credential.
      if (route === "hub") {
        if (!accountWorkspace || !identity?.mobileHub || !hubRunner)
          return respond(404, { error: "not_found" });
        const keys = [...url.searchParams.keys()];
        const profile = url.searchParams.get("profile");
        if (
          new Set(keys).size !== keys.length ||
          keys.some((key) => key !== "language" && key !== "profile") ||
          (profile !== null &&
            profile !== HUB_PROFILE &&
            profile !== HUB_PROFILE_V2 &&
            profile !== HUB_PROFILE_V3)
        )
          return respond(400, { error: "invalid_payload" });
        if (req.method !== "GET" && req.method !== "POST")
          return respond(405, { error: "method_not_allowed" });
        const language =
          url.searchParams.get("language") === "cs" ? "cs" : "en";
        // Authenticated and bounded (one run per item at a time, a person's
        // runs in sequence), so the shared pairing rate limit is not spent here.
        const payload =
          req.method === "POST" ? await body(req, 4096) : undefined;
        const result = await identity.mobileHub(
          req.headers.authorization,
          workspace,
          auth.serverId,
          payload,
          language,
          // Reads answer in agent-hub/1 unless the dashboard is asked for.
          profile === HUB_PROFILE_V3 ? 3 : profile === HUB_PROFILE_V2 ? 2 : 1,
        );
        if (result.refresh.length)
          hubRunner.launch(
            {
              header: req.headers.authorization!,
              workspaceId: workspace,
              serverId: auth.serverId,
              actor: result.actor,
            },
            result.scope,
            result.refresh,
            language,
          );
        return respond(200, result.view);
      }
      // Skills the person can use, a chat proposal's state and saving it.
      if (route === "skills") {
        if (!accountWorkspace || !identity?.mobileSkills)
          return respond(404, { error: "not_found" });
        const keys = [...url.searchParams.keys()];
        if (
          new Set(keys).size !== keys.length ||
          keys.length > 1 ||
          keys.some((key) => key !== "id" && key !== "proposalId") ||
          (req.method === "POST" && keys.length)
        )
          return respond(400, { error: "invalid_payload" });
        if (req.method !== "GET" && req.method !== "POST")
          return respond(405, { error: "method_not_allowed" });
        // Authenticated and idempotent: the shared pairing limit is not spent here.
        const payload =
          req.method === "POST" ? await body(req, 4096) : undefined;
        return respond(
          200,
          await identity.mobileSkills(
            req.headers.authorization,
            workspace,
            auth.serverId,
            url.searchParams,
            payload,
          ),
        );
      }
      // A process proposed in chat: how saving it went, and saving it.
      if (route === "process-proposals") {
        if (!accountWorkspace || !identity?.mobileProcessProposal)
          return respond(404, { error: "not_found" });
        const keys = [...url.searchParams.keys()];
        if (
          new Set(keys).size !== keys.length ||
          keys.some(
            (key) =>
              key !== "language" &&
              (req.method !== "GET" || key !== "sessionId"),
          )
        )
          return respond(400, { error: "invalid_payload" });
        if (req.method !== "GET" && req.method !== "POST")
          return respond(405, { error: "method_not_allowed" });
        // Saving runs a native test, so presses share the pairing rate limit.
        if (req.method === "POST") auth.rateLimit(clientAddress(req));
        const payload =
          req.method === "POST" ? await body(req, 8192) : undefined;
        return respond(
          200,
          await identity.mobileProcessProposal(
            req.headers.authorization,
            workspace,
            auth.serverId,
            req.method,
            {
              sessionId: url.searchParams.get("sessionId") ?? undefined,
              language: url.searchParams.get("language") ?? undefined,
            },
            payload,
          ),
        );
      }
      // What the person can tag with "@" in a message.
      if (route === "mentions") {
        if (!accountWorkspace || !identity?.mobileMentions)
          return respond(404, { error: "not_found" });
        // for=hub: only the services overview widgets can read.
        const keys = [...url.searchParams.keys()];
        const purpose = url.searchParams.get("for");
        if (
          keys.some((key) => key !== "for") ||
          keys.length > 1 ||
          (purpose !== null && purpose !== "hub")
        )
          return respond(400, { error: "invalid_payload" });
        if (req.method !== "GET")
          return respond(405, { error: "method_not_allowed" });
        return respond(
          200,
          await identity.mobileMentions(
            req.headers.authorization,
            workspace,
            auth.serverId,
            purpose === "hub" ? "hub" : undefined,
          ),
        );
      }
      // Negotiate separately; reads/preparation must not construct the AI/service runtime.
      if (route === "processes" || route.startsWith("processes/")) {
        if (!accountWorkspace || !options.identity)
          return respond(404, { error: "not_found" });
        const keys = [...url.searchParams.keys()];
        if (
          new Set(keys).size !== keys.length ||
          (route !== "processes" &&
            route !== "processes/runs" &&
            keys.some((key) => key !== "profile"))
        )
          return respond(400, { error: "invalid_payload" });
        const requestedProfile = ProcessRuntimeProfileSchema.safeParse(
          url.searchParams.get("profile"),
        );
        if (!requestedProfile.success)
          return respond(406, { error: "process_profile_unsupported" });
        if (route === "processes" && req.method === "GET") {
          const query = Object.fromEntries(url.searchParams);
          delete query.profile;
          return respond(
            200,
            await options.identity.mobileProcesses(
              req.headers.authorization,
              workspace,
              auth.serverId,
              query,
            ),
          );
        }
        if (route === "processes/input" && req.method === "POST") {
          auth.rateLimit(clientAddress(req));
          return respond(
            200,
            await options.identity.mobileProcessInput(
              req.headers.authorization,
              workspace,
              auth.serverId,
              await body(req, 4096),
            ),
          );
        }
        if (
          (route === "processes/runs" && req.method === "GET") ||
          (["processes/commands", "processes/commands/interrupt"].includes(
            route,
          ) &&
            req.method === "POST")
        ) {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          modelControllers.add(controller);
          res.on("close", cancel);
          if (res.destroyed || res.writableEnded) cancel();
          try {
            if (req.method === "POST") auth.rateLimit(clientAddress(req));
            const payload =
              req.method === "POST" ? await body(req, 73728) : undefined;
            if (res.destroyed || res.writableEnded) cancel();
            controller.signal.throwIfAborted();
            const access = await options.identity.mobileProcessCoordinator(
              req.headers.authorization,
              workspace,
              auth.serverId,
              requestedProfile.data,
            );
            controller.signal.throwIfAborted();
            if (route === "processes/runs") {
              const query = Object.fromEntries(url.searchParams);
              delete query.profile;
              return respond(
                200,
                await access.coordinator.read(
                  ProcessRuntimeReadQuerySchema.parse(query).parentRunId,
                ),
              );
            }
            if (route === "processes/commands/interrupt") {
              const request =
                ProcessRuntimeInterruptRequestSchema.parse(payload);
              if (request.profile !== requestedProfile.data)
                return respond(400, { error: "invalid_payload" });
              return respond(
                200,
                ProcessRuntimeInterruptResponseSchema.parse(
                  await access.coordinator.interrupt(request.command),
                ),
              );
            }
            const result = await access.coordinator.execute(
              payload,
              controller.signal,
              (intent, command) => {
                if (res.destroyed || res.writableEnded) cancel();
                controller.signal.throwIfAborted();
                const snapshot = storage.snapshot(
                  access.scope,
                  command.conversationId,
                );
                if (
                  !sameScope(snapshot.scope, access.scope) ||
                  intent.origin.type === "card" ||
                  intent.origin.conversationId !== command.conversationId ||
                  !snapshot.conversations.some(
                    (c) => c.id === command.conversationId,
                  )
                )
                  throw new IdentityError(409, "process_origin_changed");
              },
            );
            return respond(
              result.admission.status === "rejected" ? 422 : 202,
              result,
            );
          } finally {
            res.off("close", cancel);
            modelControllers.delete(controller);
          }
        }
        return respond(405, { error: "method_not_allowed" });
      }
      if (
        route === "meetings" ||
        route.startsWith("meetings/") ||
        route === "human-tasks" ||
        route.startsWith("human-tasks/")
      ) {
        if (!accountWorkspace || !options.identity)
          return respond(404, { error: "meeting_unavailable" });
        const access = await options.identity.mobileMeetingAccess(
          req.headers.authorization,
          workspace,
          auth.serverId,
        );
        if (/^meetings\/[^/]+\/audio$/.test(route) && req.method !== "DELETE") {
          const audio = await meetingAudioRoute(req, route, url, access);
          if (!audio.body && audio.status === 405)
            return respond(405, { error: "method_not_allowed" });
          res.writeHead(audio.status, {
            ...audio.headers,
            ...(origin && origins.includes(origin)
              ? {
                  "Access-Control-Allow-Origin": origin,
                  "Access-Control-Expose-Headers":
                    "Content-Range, Content-Length, Accept-Ranges",
                  Vary: "Origin",
                }
              : {}),
          });
          if (!audio.body) return res.end();
          // Closes the file whichever side ends first, also when the client
          // left before the stream was opened (a player seeking fast).
          pipeline(audio.body, res, () => {});
          return;
        }
        const result = await (
          route.startsWith("human-tasks") ? humanTaskRoute : meetingRoute
        )(req, route, url, access);
        return respond(result.status, result.value);
      }
      const bridge = accountWorkspace
        ? await options.identity!.mobileAccess(
            req.headers.authorization,
            workspace,
            auth.serverId,
          )
        : undefined;
      const session =
        bridge?.session ??
        auth.authenticate(req.headers.authorization, workspace);
      const run = <T>(fn: () => T): Promise<T> =>
        bridge
          ? bridge.run(fn)
          : Promise.resolve().then(() => {
              auth.authenticate(req.headers.authorization, workspace);
              return fn();
            });
      const runtimeModels = bridge ? accountModels : models;
      if (route === "search") {
        if (req.method !== "GET")
          return respond(405, { error: "method_not_allowed" });
        const request = chatSearchRequest(url.searchParams);
        if (request === "unsupported")
          return respond(406, { error: "chat_search_profile_unsupported" });
        if (!request) return respond(400, { error: "invalid_payload" });
        try {
          return respond(
            200,
            await run(() =>
              storage.searchConversations(
                session.scope,
                request.query,
                request.options,
              ),
            ),
          );
        } catch (error) {
          if (error instanceof ChatSearchRateLimited)
            return respond(429, { error: "chat_search_rate_limited" });
          if (error instanceof ChatSearchUnavailable)
            return respond(404, { error: "not_found" });
          throw error;
        }
      }
      if (route === "conversations" || route === "conversations/messages") {
        if (req.method !== "GET")
          return respond(405, { error: "method_not_allowed" });
        const keys = [...url.searchParams.keys()];
        const allowed =
          route === "conversations"
            ? ["profile", "after", "state"]
            : [
                "profile",
                "after",
                "conversationId",
                "revision",
                // Delivery declarations (messageDeliveryPath): times, generated UI.
                "messages",
                "ui",
              ];
        if (
          new Set(keys).size !== keys.length ||
          keys.some((k) => !allowed.includes(k))
        )
          return respond(400, { error: "invalid_payload" });
        if (url.searchParams.get("profile") !== CONVERSATION_HISTORY_PROFILE)
          return respond(406, { error: "conversation_profile_unsupported" });
        const after = url.searchParams.get("after");
        if (
          after !== null &&
          (!/^[1-9][0-9]{0,15}$/.test(after) ||
            !Number.isSafeInteger(Number(after)))
        )
          return respond(400, { error: "invalid_payload" });
        if (route === "conversations") {
          const state = url.searchParams.get("state");
          const filter =
            state === null
              ? undefined
              : ConversationListStateSchema.safeParse(state);
          if (filter && !filter.success)
            return respond(400, { error: "invalid_payload" });
          return respond(
            200,
            await run(() =>
              storage.conversations(session.scope, after, filter?.data),
            ),
          );
        }
        const id = url.searchParams.get("conversationId");
        const revision = url.searchParams.get("revision");
        if (
          !id ||
          !/^[a-zA-Z0-9._:-]{1,160}$/.test(id) ||
          (revision !== null &&
            (!/^[1-9][0-9]{0,15}$/.test(revision) ||
              !Number.isSafeInteger(Number(revision))))
        )
          return respond(400, { error: "invalid_payload" });
        const page = await run(() =>
          storage.conversationMessages(
            session.scope,
            id,
            after,
            revision === null ? undefined : Number(revision),
          ),
        );
        return page === null
          ? respond(404, { error: "conversation_not_found" })
          : page === undefined
            ? respond(409, { error: "conversation_changed" })
            : respond(200, {
                ...page,
                messages: page.messages.map((message) =>
                  messageForClient(message, messages),
                ),
              });
      }
      if (route.startsWith("services/") && req.method === "POST") {
        if (!bridge) return respond(404, { error: "not_found" });
        if (!/^services\/(?:start|status|cancel)$/.test(route))
          return respond(404, { error: "not_found" });
        if (route === "services/start") auth.rateLimit(clientAddress(req));
        return respond(
          200,
          await options.identity!.mobileServiceConnection(
            req.headers.authorization,
            workspace,
            auth.serverId,
            route.slice(9) as "start" | "status" | "cancel",
            await body(req, 2048),
          ),
        );
      }
      const transcriber = bridge ? bridge.transcriber : options.transcriber;
      if (route === "server" && req.method === "GET") {
        if (!serverName) return respond(404, { error: "not_found" });
        return respond(
          200,
          await run(() =>
            ServerInfoSchema.parse({
              profile: SERVER_INFO_PROFILE,
              name:
                typeof serverName === "function" ? serverName() : serverName,
              scope: session.scope,
              workflowProfile: PROFILE,
              componentCatalog: {
                "workflow.progress": 1,
                "input.choice": 1,
                "action.approval": 1,
                "crm.contacts": 1,
                "service.action": 2,
                ...(cards ? { "card.document": 1 } : {}),
              },
              configuredServices: {
                interpretation: (bridge ? bridge.modelEnabled : !!runtimeModels)
                  ? "model"
                  : bridge
                    ? "disabled"
                    : "demo-phrases",
                voice: !!transcriber,
                contacts: (
                  bridge
                    ? bridge.tools.has("crm.contacts.list") ||
                      bridge.tools.has("crm.contacts.search")
                    : options.crm
                )
                  ? "test-read-only"
                  : "disabled",
                calendar: (
                  isAccountScope(session.scope)
                    ? options.identity?.calendarTarget(session.scope)
                    : options.calendar &&
                      sameScope(options.calendar.scope, session.scope)
                )
                  ? "caldav-test"
                  : "simulated",
              },
            }),
          ),
        );
      }
      if (route === "activity" && req.method === "GET") {
        const commandId = ActivityCommandIdSchema.parse(
          url.searchParams.get("commandId"),
        );
        const requestedProfile = url.searchParams.get("profile");
        const profile =
          requestedProfile === ACTIVITY_PROFILE ||
          requestedProfile === WORKFLOW_ACTIVITY_PROFILE ||
          requestedProfile === TOOL_ACTIVITY_PROFILE
            ? requestedProfile
            : LEGACY_ACTIVITY_PROFILE;
        return respond(
          200,
          await run(() => {
            const activity =
              runtimeModels?.activity(session.scope, commandId) ?? null;
            return ActivityResponseSchema.parse({
              profile,
              scope: session.scope,
              commandId,
              activity:
                profile === ACTIVITY_PROFILE
                  ? activity
                  : profile === WORKFLOW_ACTIVITY_PROFILE
                    ? workflowActivity(activity)
                    : profile === TOOL_ACTIVITY_PROFILE
                      ? toolActivity(activity)
                      : legacyActivity(activity),
            });
          }),
        );
      }
      const synthesizer = bridge ? bridge.synthesizer : options.synthesizer;
      if (route === "voice/speech" && req.method === "GET")
        return respond(
          200,
          await run(() =>
            SpeechCapabilitiesSchema.parse({
              profile: SPEECH_PROFILE,
              enabled: !!synthesizer,
              model: synthesizer?.model ?? null,
              processing: "cloud",
              maxTextLength: SPEECH_TEXT_LENGTH,
            }),
          ),
        );
      if (route === "voice/speech" && req.method === "POST") {
        if (!synthesizer) throw new SpeechError("speech_unavailable", 503);
        const request = SpeechRequestSchema.parse(await body(req, 4096));
        const readText = () => {
          const message = storage
            .snapshot(session.scope)
            .conversations.find((c) => c.id === request.conversationId)
            ?.messages.find((m) => m.id === request.messageId);
          if (!message || message.role !== "assistant")
            throw new SpeechError("speech_context_changed", 409);
          return message.text;
        };
        const text = await run(readText);
        if (!text.trim() || text.length > SPEECH_TEXT_LENGTH)
          throw new SpeechError("speech_too_long", 413);
        const validate = () => {
          if (readText() !== text)
            throw new SpeechError("speech_context_changed", 409);
        };
        const key = JSON.stringify(session.scope);
        if (speechActive.has(key) || speechActive.size >= 8)
          throw new SpeechError("speech_busy", 429);
        speechActive.add(key);
        const controller = new AbortController();
        modelControllers.add(controller);
        const cancel = () => controller.abort();
        res.on("close", cancel);
        const timeout = setTimeout(cancel, 65000);
        try {
          const audio = await synthesizer.synthesize(
            text,
            request.language,
            controller.signal,
            (start) =>
              run(() => {
                controller.signal.throwIfAborted();
                validate();
                start();
              }),
          );
          await run(validate);
          controller.signal.throwIfAborted();
          return respond(
            200,
            SpeechResultSchema.parse({
              ...request,
              scope: session.scope,
              audio,
            }),
          );
        } finally {
          clearTimeout(timeout);
          res.off("close", cancel);
          modelControllers.delete(controller);
          speechActive.delete(key);
        }
      }
      if (route === "voice" && req.method === "GET")
        return respond(
          200,
          await run(() =>
            voiceCapabilities(
              !!transcriber && (transcriber.available?.() ?? true),
              transcriber?.engine,
              transcriber?.model,
            ),
          ),
        );
      let validateTaskWindow: (() => boolean) | undefined;
      if (
        ["snapshot", "events", "commands", "voice/transcriptions"].includes(
          route,
        ) &&
        bridge?.integrations?.tasks
      ) {
        if (bridge.integrations.taskWindow) {
          let settled = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            const window = await bridge.integrations.taskWindow((id) =>
              storage.legacyQuestionProof(session.scope, id),
            );
            const published = await run(() => {
              if (!window.validate()) return false;
              storage.syncNativeWork(session.scope, window.items, true);
              validateTaskWindow = window.validate;
              return true;
            });
            if (published) {
              settled = true;
              break;
            }
          }
          if (!settled) throw new IdentityError(503, "task_projection_changed");
        } else {
          const tasks = await bridge.integrations.tasks();
          await run(() => storage.syncNativeWork(session.scope, tasks));
        }
      }
      if (route === "voice/transcriptions" && req.method === "POST") {
        if (!transcriber) throw new VoiceError("voice_unavailable", 503);
        const validateContext = (context: VoiceContext) =>
          run(() => {
            const current = session;
            const snapshot = storage.snapshot(
              current.scope,
              context.conversationId,
            );
            if (!("inputRequestId" in context)) {
              if (
                !snapshot.conversations.some(
                  (c) => c.id === context.conversationId,
                )
              )
                throw new VoiceError("voice_context_changed", 409);
              return current.scope;
            }
            const input =
              snapshot.inputRequests.find(
                (i) => i.id === context.inputRequestId,
              ) ??
              snapshot.workItems.find((w) => w.id === context.workItemId)
                ?.native?.question;
            const work = snapshot.workItems.find(
              (w) => w.id === context.workItemId,
            );
            if (
              !input ||
              input.id !== context.inputRequestId ||
              !work ||
              input.workItemId !== work.id ||
              input.conversationId !== context.conversationId ||
              input.revision !== context.expectedInputRevision ||
              input.status !== "open" ||
              work.status !== "waiting_input"
            )
              throw new VoiceError("voice_context_changed", 409);
            return current.scope;
          });
        const request = VoiceRequestSchema.parse(
          await body(req, VOICE_BODY_BYTES),
        );
        await validateContext(request.context);
        const controller = new AbortController();
        modelControllers.add(controller);
        const cancel = () => controller.abort();
        res.on("close", cancel);
        const timeout = setTimeout(cancel, 110_000);
        try {
          const raw = await transcriber.transcribe(request, controller.signal);
          controller.signal.throwIfAborted();
          const scope = await validateContext(request.context);
          controller.signal.throwIfAborted();
          // Providers without quality evidence can return text, but never auto-send it.
          const transcript = VoiceTranscriptSchema.parse(
            typeof raw === "string"
              ? { text: raw, reviewReasons: ["uncertain"] }
              : raw,
          );
          if (
            request.stopReason === "limit" &&
            !transcript.reviewReasons.includes("limit")
          )
            transcript.reviewReasons.push("limit");
          // Transcription is data only: no execute(), event, receipt, or workflow mutation.
          return respond(
            200,
            VoiceResultSchema.parse({
              profile: VOICE_PROFILE,
              requestId: request.requestId,
              language: request.language,
              context: request.context,
              scope,
              ...transcript,
            }),
          );
        } finally {
          clearTimeout(timeout);
          res.off("close", cancel);
          modelControllers.delete(controller);
        }
      }
      if (route === "auth/session") {
        if (req.method === "GET") return respond(200, await run(() => session));
        if (req.method === "DELETE") {
          if (bridge)
            await options.identity!.revokeMobile(req.headers.authorization!);
          else auth.revoke(req.headers.authorization!);
          return respond(204, null);
        }
      }
      if (route === "snapshot" && req.method === "GET")
        return respond(
          200,
          snapshotForClient(
            clientSnapshot(
              await run(() => {
                if (validateTaskWindow && !validateTaskWindow())
                  throw new IdentityError(503, "task_projection_changed");
                const selected = url.searchParams.get("conversationId");
                if (
                  selected !== null &&
                  !/^[a-zA-Z0-9._:-]{1,160}$/.test(selected)
                )
                  throw new SyntaxError("Invalid conversation");
                return storage.snapshot(session.scope, selected ?? undefined);
              }),
            ),
            correlated,
          ),
        );
      if (route === "events" && req.method === "GET") {
        const cursor = Number(url.searchParams.get("after"));
        if (!Number.isSafeInteger(cursor) || cursor < 0)
          return respond(400, { error: "invalid_cursor" });
        const events = await run(() => {
          if (
            !conversationProjection &&
            storage.snapshot(session.scope).conversations.length > 50
          )
            throw new IdentityError(406, "conversation_profile_required");
          if (validateTaskWindow && !validateTaskWindow())
            throw new IdentityError(503, "task_projection_changed");
          const saved = storage.events(session.scope, cursor);
          return saved
            ? {
                ...saved,
                events: processEventsForCurrentWindow(
                  saved.events,
                  storage.snapshot(session.scope).workItems,
                ),
              }
            : null;
        });
        return events
          ? respond(200, {
              ...events,
              events: eventsForClient(clientEvents(events.events), correlated),
            })
          : respond(409, { error: "snapshot_required" });
      }
      if (route === "commands/interrupt" && req.method === "POST") {
        const request = RequestInterruptionRequestSchema.parse(await body(req));
        const current = await run(() => session);
        const outcome = runtimeModels
          ? await runtimeModels.interrupt(
              current.scope,
              request.command,
              run,
              bridge?.nativeRequests,
            )
          : await run(() => {
              const known = storage.replay(current.scope, request.command);
              const base = {
                profile: REQUEST_INTERRUPTION_PROFILE,
                scope: current.scope,
                commandId: request.command.commandId,
              };
              return known
                ? { ...base, status: "settled" as const, result: known }
                : {
                    ...base,
                    status: "unknown" as const,
                    reason: "not_running" as const,
                  };
            });
        return respond(
          200,
          RequestInterruptionResponseSchema.parse(
            outcome.status === "settled"
              ? {
                  ...outcome,
                  result: {
                    ...outcome.result,
                    openWork: openWorkDelivery
                      ? outcome.result.openWork
                      : undefined,
                    snapshot: snapshotForClient(
                      clientSnapshot(outcome.result.snapshot),
                      correlated,
                    ),
                  },
                }
              : outcome,
          ),
        );
      }
      if (route === "commands" && req.method === "POST") {
        const command = await body(req);
        if (
          !conversationProjection &&
          command &&
          typeof command === "object" &&
          "type" in command &&
          command.type === "conversation.create"
        )
          return respond(406, { error: "conversation_profile_required" });
        // Reading a request body can span expiration or revocation.
        const current = await run(() => session);
        // A dropped connection does not cancel the command: the app retries
        // the exact command and joins this run or reads its receipt. Only an
        // explicit interrupt, shutdown or the overall deadline stop it.
        const controller = new AbortController();
        modelControllers.add(controller);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10 * 60_000),
        ]);
        let result;
        try {
          result = runtimeModels
            ? await runtimeModels.execute(
                current.scope,
                command,
                () => run(() => undefined),
                signal,
                bridge,
                bridge?.model,
              )
            : await run(() => {
                signal.throwIfAborted();
                return storage.execute(current.scope, command);
              });
        } finally {
          modelControllers.delete(controller);
        }
        const { openWork, ...delivered } = result;
        return respond(
          result.status === "conflict"
            ? 409
            : result.status === "rejected"
              ? 422
              : 202,
          {
            ...delivered,
            ...(openWork && openWorkDelivery ? { openWork } : {}),
            snapshot: snapshotForClient(
              clientSnapshot(result.snapshot),
              correlated,
            ),
          },
        );
      }
      return respond(405, { error: "method_not_allowed" });
    } catch (error) {
      if (error instanceof ModelError)
        return respond(503, { error: error.code });
      if (error instanceof SpeechError)
        return respond(error.status, { error: error.code });
      if (error instanceof VoiceError)
        return respond(error.status, { error: error.code });
      if (error instanceof AuthError || error instanceof IdentityError)
        return respond(error.status, { error: error.code });
      if (error instanceof RangeError)
        return respond(413, { error: "payload_too_large" });
      const invalid =
        error instanceof SyntaxError ||
        (error instanceof Error && error.name === "ZodError");
      // The class name only: messages can quote request or model content.
      if (!invalid)
        operatorLog(
          "http_error",
          {
            path: loggedPath(req.url),
            error:
              error instanceof Error
                ? error.constructor.name.slice(0, 60)
                : typeof error,
          },
          "error",
        );
      return respond(invalid ? 400 : 500, {
        error: invalid ? "invalid_payload" : "fixture_error",
      });
    }
  });
  const timer = setInterval(() => {
    try {
      storage.tick();
    } catch {
      console.error(
        "Fixture worker transaction failed; retrying from durable state.",
      );
    }
    void worker
      .tick()
      .catch(() =>
        console.error(
          "Calendar worker interrupted; durable claim retained for recovery.",
        ),
      );
  }, 250);
  timer.unref();
  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    mcpTasks?.stop();
    void hubRunner?.close();
    worker.stop();
    for (const controller of modelControllers) controller.abort();
    storage.close();
    release();
  };
  server.on("close", dispose);
  server.on("error", dispose);
  return server;
}

/** The `error` code of a small JSON failure response, when it is one. */
function failureCode(status: number, body: unknown) {
  if (status < 400 || body === undefined || body === null) return undefined;
  const text =
    typeof body === "string"
      ? body
      : Buffer.isBuffer(body)
        ? body.toString("utf8")
        : undefined;
  if (!text || text.length > 4096) return undefined;
  try {
    const code = (JSON.parse(text) as { error?: unknown }).error;
    return typeof code === "string" && /^[a-z0-9_.-]{1,80}$/.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}
