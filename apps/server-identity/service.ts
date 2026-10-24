import { budgetedInferenceTransport } from "./inference-budget";
import { clientAddress } from "./client-address";
import { MeetingStore } from "./meeting-store";
import { meetingAgentAccess } from "./meeting-agent";
import {
  McpAccessStore,
  MCP_ACCESS_SCOPES,
  type McpPrincipal,
  type McpAccessScope,
} from "./mcp-access";
import { McpAdmissionStore, mcpScope } from "../server-mcp/admission";
import { connectorResult, connectorTools } from "./mcp-connector";
import type { McpTasks } from "../server-mcp/tasks";
import { createMcpOAuth, MCP_OAUTH_TOKEN_PREFIX } from "../server-mcp/oauth";
import {
  MEETING_SETTINGS_DEFAULTS,
  MeetingProcessor,
  type MeetingChunkTranscriber,
  type MeetingSettings,
} from "./meeting-processing";
import { consolidateMeeting, nameMeeting } from "@niaro/server-agent";
import {
  createNiaroMastraModel,
  MODEL_CALL_LIMITS,
  type ModelCallLimits,
} from "../server-integrations/mastra-model";
import { createProcessReadWindow } from "./process-read-window";
import { readProcessOutput } from "./process-output";
import {
  PROCESS_OUTPUT_PROFILE,
  PROCESS_OUTPUT_WORK_PROFILE,
  ProcessOutputCapabilitiesSchema,
  ProcessOutputRequestSchema,
} from "../../packages/protocol/process-output";
import { AppLogin } from "./app-login";
import { prepareProcessInput } from "./process-input";
import { assertMeetingProcessOrigin } from "./meeting-process-origin";
import { ProcessResolveStore } from "./process-resolve-store";
import { ProcessQuestionStore } from "./process-question-store";
import type { ProcessRuntimeProfile } from "../../packages/protocol/process-coordinator";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../../packages/protocol/process-questions";
import { NativeCommandRequests } from "./native-command-requests";
import { createProcessCoordinator } from "./process-coordinator";
import { createProcessTaskProjection } from "./process-work-items";
import { Invitations, type MailSettings } from "./invitations";
import { AccountSecurity } from "./account-security";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createKyselyAdapter } from "@better-auth/kysely-adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";
import { z } from "zod";
import { acquireServerLock } from "../fixture-server/storage";
import {
  BootstrapIdentitySchema,
  IdentityCommandSchema,
  IdentityId,
  IdentityStateSchema,
  OrganizationDetailSchema,
  OrganizationRole,
} from "../../packages/protocol/identity";
import type { ServerConfig } from "../reference-server/config";
import { IdentityError } from "./error";
import { WorkspaceConnectionStore } from "./connections";
import { AuditStore } from "./audit";
import { WorkspaceAIStore, type AIProfiles } from "./workspace-ai";
import { UpdateWorkspaceAISchema } from "../../packages/protocol/workspace-ai";
import { CalendarCommand } from "../../packages/protocol/workspace-calendar";
import { WorkspaceCalendarStore } from "./workspace-calendar";
import { CalDavCalendar } from "../fixture-server/calendar";
import {
  AUTH_PROFILE,
  PROFILE,
  type AuthSession,
  type Scope,
  type Operation,
} from "../../packages/protocol";
import type { CalendarOutcome } from "../fixture-server/engine";
import { AuditQuery, type AuditRecord } from "../../packages/protocol/audit";
import { LoopId, LoopQuery } from "../../packages/protocol/loops";
import { LoopsStore } from "./loops";
import { AuthError } from "../fixture-server/auth";
import {
  BrowserLoginInspect,
  BrowserLoginConsent,
} from "../../packages/protocol/browser-login";
import {
  ConnectionCommandSchema,
  ConnectionInvokeSchema,
  ConnectionToolId,
  WorkspaceTarget,
} from "../../packages/protocol/connections";
import { ToolError } from "../server-tools/registry";
import { MobileSessionStore, type MobileRuntime } from "./mobile";
import {
  MobilePairingTarget,
  MobileWorkspaceStatus,
} from "../../packages/protocol/mobile-access";
import { createCatalogRuntime } from "./catalog-runtime";
import { closeNativeCatalogRuntime } from "./mastra-runtime";
import {
  MemoryStore,
  assertNativeMemoryFormat,
  type MemoryActor,
} from "./memory";
import { createMemoryRuntime } from "./memory-runtime";
import {
  MemoryCommandSchema,
  MemorySettingsSchema,
  MemoryViewSchema,
  type MemorySource,
} from "../../packages/protocol/memory";
import {
  ProfilePluginSettingsSchema,
  type PluginSettings,
} from "../server-plugins/registry";
import { WorkspacePluginStore } from "./workspace-plugins";
import { loadPlugins } from "../server-plugins/catalog";
import { PluginFiles, PluginFilesError } from "../server-plugins/files";
import {
  ChangePluginFilesSchema,
  PLUGIN_FILES_PROFILE,
  PluginFilesQuerySchema,
  PluginFilesResultSchema,
  PluginFilesSchema,
  UpdateWorkspacePluginsSchema,
  PreviewWorkspacePluginSchema,
} from "../../packages/protocol/workspace-plugins";
import { ServiceCatalogStore } from "./service-catalog";
import { ServiceOAuthStore } from "./service-oauth";
import { ServiceMobileFlows } from "./service-mobile-flows";
import {
  HostedError,
  HostedServers,
  type HostedOptions,
} from "../server-hosting/manager";
import { HUB_DETAIL_TTL_MS, HubStore } from "./hub-store";
import { SkillStore, type SkillActor } from "./skill-store";
import {
  SKILL_LIMITS,
  SkillProposalAcceptSchema,
} from "../../packages/protocol/skills";
import {
  MENTIONS_PROFILE,
  MentionDirectorySchema,
  type MentionDirectory,
} from "../../packages/protocol/mentions";
import { createHub, type Hub, type HubRunOutcome } from "./hub";
import type { HubFillCredential, HubLaunch } from "./hub-runner";
import {
  HUB_SCHEDULE_DEFAULTS,
  HubScheduler,
  type HubScheduleSettings,
} from "./hub-scheduler";
import type { HubOwner, HubScheduledItem } from "./hub-store";
import { operatorLog } from "../fixture-server/operator-log";
import {
  HUB_FILL_CAPS,
  HUB_OPEN_CAPS,
  createHubFillAccess,
  hubReadableServices,
  runHubFill,
  runHubOpen,
  runHubPrefetch,
} from "./hub-fill";
import {
  HubOpenRequestSchema,
  type HubOpenResult,
} from "../../packages/protocol/hub";
import {
  HostedCommand,
  HostedLogRequest,
  HostedResolveRequest,
  HostedServersSchema,
} from "../../packages/protocol/hosted";
import { linkedSubject } from "./service-oauth-controller";
import {
  ServiceConnectionPoll,
  ServiceConnectionRequest,
  ServiceConnectionStart,
  ServiceConnectionStatus,
  ServiceOAuthFinishInput,
} from "../../packages/protocol/service-oauth";
import { exchangeOAuthCode } from "../server-integrations/service-oauth";

import { AuthProviderStore } from "./auth-providers";
import { ServerSettingsStore, serverSettingsDefaults } from "./server-settings";
import {
  ImportServerSettingsSchema,
  SERVER_SETTINGS_PROFILE,
  ServerSettingsViewSchema,
  UpdateServerSettingsSchema,
  serverSettingsFile,
  serverSettingsOfFile,
  type ServerSettings,
} from "../../packages/protocol/server-settings";
import {
  createAuthProviderBridge,
  providerCallbackOutcome,
} from "./auth-provider-bridge";
import {
  SaveAuthProviderSchema,
  DeleteAuthProviderSchema,
  AuthProviderStartSchema,
  AuthProvidersSchema,
} from "../../packages/protocol/auth-providers";
import { CatalogController, type CatalogContext } from "./catalog-controller";
import { ServiceProcessStore, type ProcessActor } from "./service-processes";
import { ProcessStartStore } from "./process-start-store";
import { handleServiceProcesses } from "./process-controller";
import { ProcessActivationStore } from "./process-activation-store";
import { ProcessVersionsStore } from "./process-versions-store";
import {
  handleProcessVersions,
  isProcessVersionsPath,
} from "./process-versions-http";
import {
  handleProcessActivation,
  isProcessActivationPath,
} from "./process-activation-http";
import { ProcessTestingStore } from "./process-testing-store";
import { createProcessTesting } from "./process-testing";
import { createProcessNativeTesting } from "./process-native-testing-controller";
import {
  handleProcessNativeTest,
  isProcessNativeTestPath,
} from "./process-native-test-http";
import { ProcessDesignStore } from "./process-design-store";
import { ProcessDesignConversation } from "./process-design-conversation";
import {
  ProcessProposalStore,
  createProcessProposals,
  type ProcessProposals,
} from "./process-proposal";
import {
  handleProcessDesign,
  isProcessDesignPath,
  PROCESS_DESIGN_PATH,
} from "./process-design-controller";
import {
  DESIGN_PROFILE,
  WORKSPACE_DESIGN_PROFILE,
} from "../../packages/protocol/process-design";
import {
  createTransport,
  IntegrationError,
  type IntegrationTransport,
} from "../server-integrations/transport";
import { SpeechProcessor } from "../fixture-server/voice-openrouter";
import { VoiceError, type Transcriber } from "../fixture-server/voice";
import {
  SpeechError,
  synthesizeSpeech,
  type SpeechSynthesizer,
} from "../server-integrations/speech";
import {
  transcribeAudio,
  transcribeMeetingChunk,
} from "../server-integrations/transcription";
import { ModelError } from "../fixture-server/decision";
async function body(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  const timeout = setTimeout(() => req.destroy(), 10_000);
  timeout.unref();
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (
        size >
        (req.url?.split("?")[0] === "/admin/api/identity/catalog/discover" ||
        req.url?.split("?")[0] === "/admin/api/identity/plugin-files"
          ? 1_048_576
          : req.url?.startsWith("/admin/api/identity/catalog/")
            ? 131072
            : req.url?.split("?")[0] === "/admin/api/identity/skills/command"
              ? 524288
              : req.url?.split("?")[0] === "/admin/auth/sign-in/email" ||
                  req.url?.startsWith("/admin/api/identity/server-settings")
                ? 65536
                : 8192)
      )
        throw new IdentityError(413, "identity_invalid_input");
      chunks.push(Buffer.from(chunk));
    }
    return size === 0
      ? {}
      : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  } finally {
    clearTimeout(timeout);
  }
}
function mcpConsentRedirect(value: unknown, baseURL: string) {
  if (typeof value !== "string") return undefined;
  try {
    const redirect = new URL(value, baseURL);
    if (
      redirect.origin !== new URL(baseURL).origin ||
      redirect.pathname !== "/admin/mcp/consent" ||
      redirect.username ||
      redirect.password ||
      redirect.hash
    )
      return undefined;
    return redirect.href;
  } catch {
    return undefined;
  }
}
function privateFile(file: string) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.())
    throw Error("Identity files must be private and owned by this user");
}
export async function openIdentity(
  config: ServerConfig,
  options: {
    connectionTransport?: typeof fetch;
    calendarTransport?: typeof fetch;
    integrationTransport?: IntegrationTransport;
    speechProcessor?: Pick<SpeechProcessor, "process">;
    hosting?: HostedOptions & { autostart?: boolean };
  } = {},
) {
  const settings = config.administration?.identity;
  if (!settings) throw Error("Identity is not configured");
  mkdirSync(settings.directory, { recursive: true, mode: 0o700 });
  const directory = lstatSync(settings.directory);
  if (
    !directory.isDirectory() ||
    directory.mode & 0o077 ||
    directory.uid !== process.getuid?.()
  )
    throw Error("Identity directory must be private");
  const release = acquireServerLock(settings.directory);
  let db: DatabaseSync | undefined;
  try {
    // Built-in plugins, and the operator's from <identity directory>/plugins.
    // An invalid plugin is logged and skipped; the server starts regardless.
    const pluginsDirectory = join(settings.directory, "plugins");
    await loadPlugins({ dataDirectory: pluginsDirectory });
    const secretFile = join(settings.directory, "secret");
    const file = join(settings.directory, "identity.sqlite");
    if (existsSync(file) && !existsSync(secretFile))
      throw Error("Existing identity database requires its original secret");
    if (!existsSync(secretFile))
      writeFileSync(secretFile, randomBytes(48).toString("base64url"), {
        mode: 0o600,
        flag: "wx",
      });
    privateFile(secretFile);
    const secret = readFileSync(secretFile, "utf8");
    if (!/^[A-Za-z0-9_-]{64}$/.test(secret))
      throw Error("Invalid identity secret");
    if (existsSync(file)) privateFile(file);
    if (existsSync(file)) {
      const preflight = new DatabaseSync(file, { readOnly: true });
      try {
        assertNativeMemoryFormat(preflight);
      } finally {
        preflight.close();
      }
    }
    db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;",
    );
    const authProviders = new AuthProviderStore(db, secret, settings.baseURL);
    const bridge = createAuthProviderBridge(authProviders);
    let service: IdentityService | undefined;
    const oauthGrants = new McpAccessStore(db, {
      checkServer: (id) => service?.mcpServerId() === id,
    });
    const mcpOAuth = createMcpOAuth({
      db,
      baseURL: settings.baseURL,
      allowInsecureDevelopment: new URL(settings.baseURL).protocol === "http:",
      getServerId: () => service?.mcpServerId(),
      issueGrant: (input) => oauthGrants.issue(input),
      revalidateGrant: (id, target) =>
        oauthGrants.authenticateGrant(id, target),
      revokeGrant: (input) => oauthGrants.revoke(input),
    });
    const auth = await createIdentityAuth(
      db,
      secret,
      settings.baseURL,
      settings.accountSessionDays * 24 * 60 * 60,
      bridge,
      mcpOAuth,
    );
    await auth.$context;
    mcpOAuth.upgradeResourceScopes();
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workspace (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
        name TEXT NOT NULL, UNIQUE(organization_id, name)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_workspace_member (
        workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
        PRIMARY KEY(workspace_id, member_id)
      ) STRICT;
    `);
    const connections = new WorkspaceConnectionStore(
      db,
      secret,
      settings.connectionOrigins,
      options.connectionTransport,
    );
    const workspaceAI = new WorkspaceAIStore(db);
    let speechProcessor = options.speechProcessor;
    if (!speechProcessor && settings.voiceAssetsDirectory)
      speechProcessor = new SpeechProcessor(settings.voiceAssetsDirectory);
    if (!speechProcessor && "assetsDirectory" in config.adapters.voice) {
      try {
        speechProcessor = new SpeechProcessor(
          config.adapters.voice.assetsDirectory,
        );
      } catch {
        /* Legacy local Whisper does not require the standalone cloud VAD binary. */
      }
    }
    // Administration may change some profile values; the saved ones win.
    const serverSettings = new ServerSettingsStore(
      db,
      serverSettingsDefaults(config),
    );
    const current = serverSettings.read().settings;
    // One list for catalog validation and the transport: hosted servers add their
    // loopback origin while they exist and remove it when deleted.
    const trusted = [...current.integrationOrigins];
    const hosted = new HostedServers(
      db,
      join(settings.directory, "hosted"),
      trusted,
      secret,
      {
        allowCustom: settings.hosting.allowCustom,
        runtime: settings.hosting.runtime,
        ...options.hosting,
      },
    );
    service = new IdentityService(
      db,
      auth,
      settings.baseURL,
      release,
      connections,
      new MobileSessionStore(
        db,
        settings.baseURL,
        config.sessionSeconds * 1000,
        settings.mobile.sessionIdleDays * 24 * 60 * 60 * 1000,
      ),
      new AuditStore(db),
      workspaceAI,
      new WorkspaceCalendarStore(db, secret, settings.calendarCollections),
      new CatalogController(
        new ServiceCatalogStore(
          db,
          secret,
          trusted,
          new ServiceOAuthStore(db, secret, settings.baseURL),
          authProviders,
        ),
        options.integrationTransport ?? createTransport(trusted),
        !!speechProcessor,
        (workspace) =>
          !!workspaceAI.resolve(workspaceAI.read(workspace).selection)
            .transcriber,
      ),
      options.calendarTransport,
      speechProcessor,
      {
        ...ProfilePluginSettingsSchema.parse(config.plugins ?? {}),
        timeZone: current.timeZone,
      },
      {
        store: authProviders,
        bridge,
        rebuild: async () => {
          const nextBridge = createAuthProviderBridge(authProviders);
          const nextAuth = await createIdentityAuth(
            db!,
            secret,
            settings.baseURL,
            settings.accountSessionDays * 24 * 60 * 60,
            nextBridge,
            mcpOAuth,
          );
          await nextAuth.$context;
          return { auth: nextAuth, bridge: nextBridge };
        },
      },
      settings.mail,
      secret,
      mcpOAuth,
      { scheduler: current.hubScheduler },
      current.meetings,
      serverSettings,
    );
    await service.initializeMemory();
    service.attachHosting(hosted);
    service.attachPluginFiles(
      new PluginFiles(pluginsDirectory),
      settings.pluginEditing !== false,
    );
    if (options.hosting?.autostart !== false) hosted.startAll();
    return service;
  } catch (error) {
    db?.close();
    release();
    throw error;
  }
}
async function createIdentityAuth(
  db: DatabaseSync,
  secret: string,
  baseURL: string,
  sessionSeconds: number,
  bridge: ReturnType<typeof createAuthProviderBridge>,
  mcpOAuth?: ReturnType<typeof createMcpOAuth>,
) {
  const { kysely } = await createKyselyAdapter({ database: db });
  if (!kysely) throw Error("SQLite adapter unavailable");
  const authOptions = {
    ...bridge.options,
    appName: "Agent Server",
    baseURL: baseURL,
    basePath: "/admin/auth",
    secret,
    database: { db: kysely, type: "sqlite", transaction: false },
    // Provisioning is exposed only through our authorized, transactional endpoints.
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    // The browser remembers the account; using it at most once a day
    // extends the session again (sliding expiry). Revocation, password
    // change and sign-out still end it at once.
    session: {
      expiresIn: sessionSeconds,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    advanced: {
      ...bridge.options.advanced,
      cookiePrefix: "agent_identity",
      useSecureCookies: baseURL.startsWith("https:"),
      defaultCookieAttributes: {
        path: "/admin",
        httpOnly: true,
        sameSite: "strict",
      },
      ipAddress: { ipAddressHeaders: ["x-agent-client-ip"] },
    },
    trustedOrigins: [baseURL],
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      customRules: { "/sign-in/email": { window: 60, max: 10 } },
    },
    plugins: [
      bridge.plugin,
      ...(mcpOAuth?.plugins ?? []),
      organization({
        allowUserToCreateOrganization: false,
        membershipLimit: 100,
      }),
    ],
    logger: { disabled: true },
  } satisfies BetterAuthOptions;
  // Plugins may seed configuration during init. Install their schema first so
  // a fresh boot and a restored boot run the same canonical initialization.
  await (await getMigrations(authOptions)).runMigrations();
  return betterAuth(authOptions);
}
type Auth = Awaited<ReturnType<typeof createIdentityAuth>>;
// Identity reads and mutations share one queue. Async Better Auth writes inside a
// SQLite transaction cannot be observed by another request before commit/rollback.
/** The operator's clue when voice fails: which step and its error code, never content. */
function logFailure(step: string, error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : error instanceof Error
        ? error.name
        : "unexpected";
  // A provider's own words (already redacted), so a failure says why.
  const failure = error instanceof IntegrationError ? error.failure : undefined;
  const detail = failure
    ? ` (${[failure.httpStatus, failure.message].filter(Boolean).join(" ")})`
    : "";
  console.warn(`${step} failed: ${code}${detail}`);
}
export class IdentityService {
  private mcpGrants: McpAccessStore;
  private mcpAdmissions: McpAdmissionStore;
  private mcpTaskRunner?: McpTasks;
  private loops: LoopsStore;
  private serviceFlows: ServiceMobileFlows;
  private plugins: WorkspacePluginStore;
  private memory: MemoryStore;
  private processes: ServiceProcessStore;
  private processStarts?: ProcessStartStore;
  private processResolves?: ProcessResolveStore;
  private processQuestions?: ProcessQuestionStore;
  private nativeRequests = new NativeCommandRequests();
  private processDesigns: ProcessDesignStore;
  private processDesignConversation?: ProcessDesignConversation;
  private processTests?: ProcessTestingStore;
  private processContractTesting?: ReturnType<typeof createProcessTesting>;
  private processNativeTesting?: ReturnType<typeof createProcessNativeTesting>;
  private processActivation?: ProcessActivationStore;
  private processVersions?: ProcessVersionsStore;
  /** Personal processes drafted in chat and saved from their card. */
  private processProposals?: ProcessProposals;
  private memoryMaintenance: ReturnType<typeof setInterval>;
  private workflowServerId?: string;
  private pending: Promise<unknown> = Promise.resolve();
  private invitations: Invitations;
  private appLogins: AppLogin;
  private accountSecurity: AccountSecurity;
  private executions = new Set<AbortController>();
  /** Owner setup attempts per client address, for one minute. */
  private bootstrapAttempts = new Map<
    string,
    { count: number; until: number }
  >();
  private catalogRequests = new Set<Promise<void>>();
  /** Hub opens in flight per person: one at a time, a few may wait. */
  private hubOpens = new Map<
    string,
    { queue: Promise<void>; waiting: number }
  >();
  /** Background prefetches into the index: one chain per person, one per item. */
  private hubPrefetchLanes = new Map<string, Promise<void>>();
  private hubPrefetching = new Set<string>();
  private executingUsers = new Set<string>();
  private closing = false;
  private meetings: MeetingStore;
  private meetingProcessor: MeetingProcessor;
  private meetingSweep?: ReturnType<typeof setInterval>;
  private meetingRetentionDays: number;
  private hub: Hub;
  /** Keeps hourly and daily widgets fresh in the background; ticks are no-ops until a runner is attached. */
  private hubScheduler: HubScheduler;
  private hubLaunch?: HubLaunch;
  private skills: SkillStore;
  private hosted?: HostedServers;
  private pluginFiles?: PluginFiles;
  private pluginEditing = false;
  constructor(
    private db: DatabaseSync,
    private auth: Auth,
    readonly baseURL: string,
    private release: () => void,
    private connections: WorkspaceConnectionStore,
    private mobile: MobileSessionStore,
    private audit: AuditStore,
    private ai: WorkspaceAIStore,
    private calendars: WorkspaceCalendarStore,
    private catalog: CatalogController,
    private calendarTransport: typeof fetch = fetch,
    private speechProcessor?: Pick<SpeechProcessor, "process">,
    pluginSettings?: PluginSettings,
    private providerRegistry?: {
      store: AuthProviderStore;
      bridge: ReturnType<typeof createAuthProviderBridge>;
      rebuild: () => Promise<{
        auth: Auth;
        bridge: ReturnType<typeof createAuthProviderBridge>;
      }>;
    },
    mail?: z.infer<typeof MailSettings>,
    memorySecret?: string,
    private mcpOAuth?: ReturnType<typeof createMcpOAuth>,
    hubSettings?: { scheduler: HubScheduleSettings },
    meetingSettings?: Partial<MeetingSettings>,
    private serverSettingsStore?: ServerSettingsStore,
  ) {
    this.mcpGrants = new McpAccessStore(db, {
      checkServer: (id) => !this.closing && id === this.workflowServerId,
    });
    this.mcpAdmissions = new McpAdmissionStore(db);
    this.meetings = new MeetingStore(db);
    const meetingOptions = { ...MEETING_SETTINGS_DEFAULTS, ...meetingSettings };
    this.meetingRetentionDays = meetingOptions.audioRetentionDays;
    this.meetingProcessor = new MeetingProcessor(this.meetings, {
      // One queue with chat voice, which always goes first.
      queue:
        speechProcessor && "queue" in speechProcessor
          ? (speechProcessor as SpeechProcessor).queue
          : undefined,
      glossary: meetingOptions.glossary,
      chunkSeconds: meetingOptions.chunkSeconds,
    });
    this.scheduleMeetingSweep();
    this.loops = new LoopsStore(db, catalog.store);
    this.plugins = new WorkspacePluginStore(db, pluginSettings);
    this.skills = new SkillStore(db, (record) => this.audit.append(record));
    this.hub = createHub({
      store: new HubStore(db),
      processes: {
        executionInventory: (...args) =>
          this.processes.executionInventory(...args),
        unattendedEffect: (...args) => this.processes.unattendedEffect(...args),
        activeOutputSchema: (...args) =>
          this.processes.activeOutputSchema(...args),
      },
      starts: () => this.processStarts,
      journal: (id, workspaceId, userId) =>
        catalog.store.turn(id, workspaceId, userId),
      humanTasks: {
        open: (scope, limit) => this.meetings.humanTasks.open(scope, limit),
        openCount: (scope) => this.meetings.humanTasks.openCount(scope),
      },
      timeZone: (workspaceId) =>
        this.plugins.read(workspaceId).settings.timeZone,
      meetings: (scope, limit) => this.meetings.recent(scope, limit),
      services: (actor) =>
        hubReadableServices(
          catalog.store,
          actor.organizationId,
          actor.workspaceId,
          { userId: actor.userId, role: actor.role },
        ).map((service) => ({ id: service.id, name: service.name })),
    });
    this.hubScheduler = new HubScheduler(
      {
        scheduled: () => this.hub.scheduled(),
        launch: (entry) => this.hubScheduleStart(entry),
        // Opened items past their time in the index are not kept for anyone.
        sweep: () =>
          db
            .prepare("DELETE FROM agent_hub_item_detail WHERE fetched_at <= ?")
            .run(new Date(Date.now() - HUB_DETAIL_TTL_MS).toISOString()),
        log: (fields) => operatorLog("hub_schedule", fields),
      },
      hubSettings?.scheduler ?? HUB_SCHEDULE_DEFAULTS,
    );
    this.hubScheduler.start();
    this.memory = new MemoryStore(db, {
      secret: memorySecret,
      run: (fn) => this.serial(async () => fn()),
      nativeStorageUrl: catalog.store.nativeStorageUrl,
      onMutation: (actor, action, source) =>
        this.audit.append({
          organizationId: actor.organizationId,
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
          source,
          action:
            action === "preference"
              ? "memory.preference_changed"
              : "memory.changed",
          targetId: null,
          outcome: "succeeded",
          details: {},
        }),
    });
    this.processes = new ServiceProcessStore(
      db,
      catalog.store,
      this.plugins,
      (record) => this.audit.append(record),
    );
    this.processDesigns = new ProcessDesignStore(
      db,
      this.processes,
      catalog.store,
      this.plugins,
    );
    this.serviceFlows = new ServiceMobileFlows(db, catalog.store, mobile);
    this.invitations = new Invitations(db, mail);
    this.appLogins = new AppLogin(db, baseURL);
    this.accountSecurity = new AccountSecurity(db, {
      password: async () => (await this.auth.$context).password,
      audit,
      mobile,
      mcp: this.mcpGrants,
      mail,
    });
    this.memoryMaintenance = setInterval(
      () => {
        void this.serial(async () => !this.closing)
          .then((active) =>
            active ? this.memory.purgeExpiredAll() : undefined,
          )
          .catch((error) => logFailure("Memory retention", error));
      },
      60 * 60 * 1000,
    );
    this.memoryMaintenance.unref();
  }
  async initializeMemory() {
    await this.memory.purgeExpiredAll();
  }
  attachHosting(hosted: HostedServers) {
    this.hosted = hosted;
  }
  /** Plugin files in the console; editing is the operator's switch. */
  attachPluginFiles(files: PluginFiles, editing: boolean) {
    this.pluginFiles = files;
    this.pluginEditing = editing;
  }
  attachAI(profiles: AIProfiles) {
    this.ai.attach(profiles);
  }
  private memorySourceAccess(
    source: MemorySource,
    actor: MemoryActor,
    role: "owner" | "admin" | "member",
  ) {
    if (source.type !== "verified_operation") return true;
    try {
      const receipt = this.catalog.store.contactSource(
        source.operationId,
        actor.organizationId,
        actor.workspaceId,
        { userId: actor.userId, role },
        30 * 60 * 1000,
      );
      return receipt.serviceId === source.serviceId;
    } catch {
      return false;
    }
  }
  calendarTarget(scope: Scope) {
    if (this.closing || scope.serverId !== this.workflowServerId) return;
    return this.calendars.access(scope)?.target;
  }
  async executeCalendar(
    scope: Scope,
    operation: Operation,
    signal: AbortSignal,
    complete: (outcome: CalendarOutcome) => void,
  ) {
    const changed: CalendarOutcome = {
      status: "result_unknown",
      error: "configuration_changed",
      retry: false,
    };
    const started = Date.now();
    const initial = await this.serial(async () => {
      if (signal.aborted || this.closing) return;
      const target = this.calendarTarget(scope);
      if (
        !target ||
        JSON.stringify(target) !== JSON.stringify(operation.parameters.calendar)
      ) {
        complete(changed);
        return;
      }
      const access = this.calendars.config(scope)!;
      const auditId = this.audit.append({
        organizationId: access.organizationId,
        workspaceId: scope.workspaceId,
        actorId: scope.userId,
        source: "chat",
        action: "calendar.executed",
        targetId: access.row.id,
        outcome: "running",
        details: { revision: access.row.revision },
      });
      return { ...access, auditId };
    });
    if (!initial) return;
    const check = () => {
      signal.throwIfAborted();
      if (
        JSON.stringify(this.calendarTarget(scope)) !==
        JSON.stringify(initial.target)
      )
        throw new IdentityError(403, "calendar_access_changed");
    };
    // The approved operation is durable; current membership/grants, not the old
    // browser session lifetime, authorize each request. Never hold the queue across I/O.
    const transport: typeof fetch = async (input, init) => {
      const dispatched = await this.serial(async () => {
        check();
        return { response: this.calendarTransport(input, init) };
      });
      const response = await dispatched.response;
      try {
        await this.serial(async () => check());
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      return response;
    };
    let outcome = await new CalDavCalendar(initial.config, transport).execute(
      scope,
      operation,
      signal,
    );
    await this.serial(async () => {
      if (this.closing || signal.aborted) return; // Lease reconciles after restart.
      let accessChanged = false;
      try {
        check();
      } catch {
        outcome = changed;
        accessChanged = true;
      }
      this.audit.finish(
        initial.auditId,
        outcome.status === "succeeded" ? "succeeded" : "unknown",
        {
          revision: initial.row.revision,
          durationMs: Math.max(0, Date.now() - started),
          ...(outcome.status === "succeeded"
            ? {}
            : {
                reason: accessChanged
                  ? ("access_changed" as const)
                  : ("provider_failed" as const),
              }),
        },
      );
      complete(outcome);
    });
  }
  private async auditedTool(
    event: Omit<AuditRecord, "outcome">,
    signal: AbortSignal,
    execute: () => Promise<unknown>,
    validateInQueue: () => void | Promise<void>,
  ) {
    const started = Date.now();
    const id = await this.serial(async () => {
      if (this.closing) throw new IdentityError(503, "identity_unavailable");
      return this.audit.append({ ...event, outcome: "running" });
    });
    try {
      const result = await execute();
      await this.serial(async () => {
        if (this.closing) throw new IdentityError(503, "identity_unavailable");
        await validateInQueue();
        signal.throwIfAborted();
        this.audit.finish(id, "succeeded", {
          ...event.details,
          durationMs: Math.max(0, Date.now() - started),
        });
      });
      return result;
    } catch (error) {
      const denied =
        error instanceof AuthError ||
        error instanceof ModelError ||
        (error instanceof IdentityError &&
          [401, 403, 404, 409].includes(error.status)) ||
        (error instanceof ToolError && error.code === "tool_forbidden");
      await this.serial(async () => {
        // Shutdown marks unresolved attempts interrupted before closing the DB.
        if (this.closing) return;
        this.audit.finish(
          id,
          signal.aborted ? "cancelled" : denied ? "denied" : "failed",
          {
            ...event.details,
            durationMs: Math.max(0, Date.now() - started),
            reason: signal.aborted
              ? "cancelled"
              : denied
                ? "access_changed"
                : error instanceof ToolError &&
                    error.code === "tool_invalid_input"
                  ? "invalid_input"
                  : "provider_failed",
          },
        );
      });
      throw error;
    }
  }
  attachWorkflow(serverId: string) {
    if (this.workflowServerId && this.workflowServerId !== serverId)
      throw Error("Identity workflow server mismatch");
    this.workflowServerId = serverId;
    // Internal foundation only. NIAR-92 must validate the current device/account
    // credential in the request queue before EVERY store call, including replay.
    // This durable store separately checks current membership and private scope.
    this.processStarts ??= new ProcessStartStore(
      this.db,
      serverId,
      this.processes,
      {
        authorize: (original) => {
          const member = this.db
            .prepare(
              `SELECT m.role FROM member m
          JOIN agent_workspace w ON w.organization_id=m."organizationId"
          WHERE m."organizationId"=? AND m."userId"=? AND w.id=?
          AND (m.role IN ('owner','admin') OR EXISTS (
            SELECT 1 FROM agent_workspace_member wm WHERE wm.workspace_id=w.id AND wm.member_id=m.id))`,
            )
            .get(
              original.organizationId,
              original.userId,
              original.workspaceId,
            );
          if (!member) throw new IdentityError(403, "identity_forbidden");
          return { ...original, role: OrganizationRole.parse(member.role) };
        },
        read: (actor, id) => this.processes.assertExecutionScope(actor, id),
      },
    );
    this.processResolves ??= new ProcessResolveStore(
      this.db,
      this.processStarts,
    );
    this.processQuestions ??= new ProcessQuestionStore(
      this.db,
      this.processStarts,
    );
    this.processVersions ??= new ProcessVersionsStore(
      this.db,
      serverId,
      this.processes,
    );
    // This constructor passively retires orphan reservations. Never recreate it
    // during an attachment: a live request owns its reservation until drained.
    this.processTests ??= new ProcessTestingStore(
      this.db,
      serverId,
      this.processes,
      (record) => this.audit.append(record),
    );
    this.processContractTesting ??= createProcessTesting(
      this.processes,
      this.processTests,
    );
    this.processNativeTesting ??= createProcessNativeTesting(
      this.processes,
      this.catalog.store,
      this.processTests,
    );
    this.processActivation ??= new ProcessActivationStore(
      this.db,
      serverId,
      this.processes,
      this.catalog.store,
      this.processTests,
      (record) => this.audit.append(record),
      {
        epoch: (org) => this.connections.policyVersion(org),
        // Current role of the qualifying person, if they still belong to the
        // workspace. Whether that role may manage the exact process (owner/admin
        // for workspace processes, the owner for a personal one) is decided by
        // the registry in ProcessActivationStore.
        creatorActor: (original) => {
          const row = this.db
            .prepare(
              `SELECT m.role FROM member m
            JOIN agent_workspace w ON w.organization_id=m."organizationId"
            WHERE m."organizationId"=? AND m."userId"=? AND w.id=?
              AND (m.role IN ('owner','admin') OR EXISTS (
                SELECT 1 FROM agent_workspace_member wm WHERE wm.workspace_id=w.id AND wm.member_id=m.id))`,
            )
            .get(
              original.organizationId,
              original.userId,
              original.workspaceId,
            );
          const role = OrganizationRole.safeParse(row?.role);
          if (!role.success)
            throw new IdentityError(
              409,
              "process_qualification_authority_changed",
            );
          return { ...original, role: role.data };
        },
      },
    );
    this.processDesignConversation ??= new ProcessDesignConversation(
      this.db,
      this.processDesigns,
      this.processes,
      this.catalog,
      this.plugins,
      { serverId },
    );
    // Its constructor marks saves this server no longer runs as interrupted.
    this.processProposals ??= createProcessProposals({
      store: new ProcessProposalStore(this.db, serverId),
      proposals: this.processDesigns,
      conversation: this.processDesignConversation,
      registry: this.processes,
      catalog: this.catalog.store,
      plugins: this.plugins,
      versions: this.processVersions,
      testing: this.processNativeTesting,
      activation: this.processActivation,
      hub: this.hub,
    });
  }
  private catalogEnabled(org: string, workspace: string, voice = false) {
    try {
      return voice
        ? !!this.speechProcessor &&
            !!this.catalog.store.resolveVoice(org, workspace)
        : !!this.catalog.store.resolveModel(org, workspace);
    } catch {
      return false;
    }
  }
  pairMobile(
    code: string,
    workspaceId: string,
    serverId: string,
    persistent = false,
  ) {
    return this.serial(() =>
      this.transaction(async () =>
        this.mobile.pair(code, workspaceId, serverId, persistent),
      ),
    );
  }
  appLogin(action: "start" | "exchange", input: unknown, webOrigin?: string) {
    return this.serial(() =>
      this.transaction(async () =>
        action === "start"
          ? this.appLogins.start(input, webOrigin ?? "agentclient://auth")
          : this.appLogins.exchange(input, (grant) =>
              this.mobile.issueApp(grant),
            ),
      ),
    );
  }
  browserLogin(
    action: "start" | "poll" | "cancel",
    deviceCode?: string,
    persistent = false,
  ) {
    return this.serial(() =>
      this.transaction(async () => {
        if (!this.workflowServerId)
          throw new IdentityError(503, "identity_unavailable");
        if (action === "start")
          return this.mobile.startBrowser(this.workflowServerId, persistent);
        if (action === "poll")
          return this.mobile.pollBrowser(deviceCode!, this.workflowServerId);
        this.mobile.cancelBrowser(deviceCode!);
        return { ok: true };
      }),
    );
  }
  revokeMobile(header: string) {
    return this.serial(async () => this.mobile.revoke(header));
  }
  refreshMobile(
    raw: unknown,
    workspaceId: string,
    serverId: string,
    revoke = false,
  ) {
    return this.serial(() =>
      this.transaction(async () =>
        this.mobile.refresh(raw, workspaceId, serverId, revoke),
      ),
    );
  }
  mobileServiceConnection(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    action: "start" | "status" | "cancel",
    payload: unknown,
  ) {
    return this.serial(async () =>
      this.transaction(async () => {
        if (this.closing) throw new IdentityError(503, "identity_unavailable");
        const input =
          action === "start"
            ? ServiceConnectionRequest.parse(payload)
            : ServiceConnectionPoll.parse(payload);
        const account = this.mobile.authenticate(header, workspaceId, serverId);
        const actor = {
          userId: account.grant.user_id,
          sessionId: `mobile:${account.credentialId}`,
        };
        const target = this.catalog.store.oauthTarget(
          workspaceId,
          input.serviceId,
        );
        const status = this.catalog.store.oauth!.status(target, actor.userId);
        if (action === "start")
          return ServiceConnectionStart.parse(
            this.serviceFlows.start(target, actor),
          );
        const attemptId =
          "attemptId" in input ? String(input.attemptId ?? "") : "";
        let flow: "pending" | "connected" | "cancelled" | undefined;
        if (attemptId) {
          const original = this.serviceFlows.read(attemptId, actor);
          if (
            original.target.serviceId !== input.serviceId ||
            original.target.workspaceId !== workspaceId
          )
            throw new IdentityError(403, "identity_forbidden");
          const current =
            action === "cancel"
              ? this.serviceFlows.cancel(attemptId, actor)
              : original;
          flow = current.status;
          if (flow === "pending") {
            try {
              this.serviceFlows.validate(attemptId, serverId, actor.userId);
            } catch {
              flow = "cancelled";
            }
          }
          if (
            current.configRevision !== status.config.revision ||
            current.target.serviceUrl !== target.serviceUrl ||
            (flow === "connected" &&
              current.connectionRevision !== status.connection.revision)
          )
            flow = "cancelled";
        } else if (action === "cancel")
          throw new IdentityError(400, "identity_invalid_input");
        let ready = !!status.config.discovery && status.config.hasClientId,
          connected = status.connection.status;
        if (status.config.settings.authProviderId) {
          try {
            const linked = this.providerRegistry!.store.linkedStatus(
              account.grant.organization_id,
              actor.userId,
              status.config.settings.authProviderId,
            );
            if (!linked.linked) connected = "disconnected";
          } catch {
            ready = false;
            connected = "disconnected";
          }
        }
        return ServiceConnectionStatus.parse({
          serviceId: input.serviceId,
          status: connected,
          ready,
          ...(flow ? { flow } : {}),
        });
      }),
    );
  }
  private async completeMobileServiceConnection(
    req: IncomingMessage,
    payload: unknown,
    signal: AbortSignal,
  ) {
    const input = ServiceOAuthFinishInput.parse(payload);
    const validate = async () => {
      if (this.closing || !this.workflowServerId)
        throw new IdentityError(503, "identity_unavailable");
      const browser = await this.getSession(req);
      if (!browser) throw new IdentityError(401, "identity_unauthorized");
      // The callback is standalone, but it still proves the receiving user's identity.
      // A forwarded authorization URL cannot connect someone else's CRM to its sender.
      return this.serviceFlows.validate(
        input.state,
        this.workflowServerId,
        browser.user.id,
        true,
      );
    };
    const prepared = await this.serial(async () => {
      const { flow, account } = await validate();
      const claim = this.catalog.store.oauth!.claimFromState(flow.actor, input);
      return {
        claim,
        org: account.grant.organization_id,
        epoch: this.connections.policyVersion(account.grant.organization_id),
      };
    });
    const guard = async () => {
      const value = await validate();
      if (this.connections.policyVersion(prepared.org) !== prepared.epoch)
        throw new IdentityError(409, "service_oauth_conflict");
      this.catalog.store.oauth!.assertClaim(
        prepared.claim,
        value.flow.actor,
        value.current,
      );
      signal.throwIfAborted();
      return value;
    };
    try {
      const tokens = await exchangeOAuthCode(
        this.catalog.transport,
        prepared.claim,
        {
          signal,
          beforeDispatch: (start) =>
            this.serial(async () => {
              await guard();
              start();
            }),
        },
      );
      return await this.serial(async () =>
        this.transaction(async () => {
          const { flow, current } = await guard();
          const result = this.catalog.store.oauth!.commitConnection(
            prepared.claim,
            tokens,
            flow.actor,
            current,
            linkedSubject(
              this.catalog.store,
              prepared.org,
              flow.actor.userId,
              current,
            ),
          );
          this.serviceFlows.finish(input.state, result.connection.revision);
          this.audit.append({
            organizationId: prepared.org,
            workspaceId: current.workspaceId,
            actorId: flow.actor.userId,
            source: "chat",
            action: "catalog.service_changed",
            targetId: current.serviceId,
            outcome: "succeeded",
            details: {},
          });
          // The page hands a native app back through its deep link; web polls instead.
          return { ok: true, app: flow.actor.sessionId.startsWith("mobile:") };
        }),
      );
    } catch (error) {
      // The operator's only clue when a consent fails; a code, never a token.
      console.warn(
        `service connection failed: ${
          error instanceof IdentityError || error instanceof IntegrationError
            ? error.code
            : "unexpected"
        }`,
      );
      await this.serial(async () => {
        try {
          this.serviceFlows.cancel(input.state, prepared.claim.actor);
        } catch {
          /* Expiry or a newer terminal state already invalidates this attempt. */
        }
      });
      throw error;
    }
  }

  private setAuthCookies(res: ServerResponse, response: Response) {
    const cookies = response.headers.getSetCookie();
    if (cookies.length)
      res.setHeader("Set-Cookie", [
        ...[res.getHeader("Set-Cookie")]
          .flat()
          .filter((v): v is string => typeof v === "string"),
        ...cookies,
      ]);
  }
  private async startProvider(
    req: IncomingMessage,
    res: ServerResponse,
    input: Parameters<AuthProviderStore["begin"]>[0],
  ) {
    const registry = this.providerRegistry!;
    const flow = registry.store.begin(input);
    const returnUrl = new URL(flow.returnPath, this.baseURL);
    const oauthQuery =
      returnUrl.pathname === "/admin/mcp/consent"
        ? returnUrl.search.slice(1)
        : undefined;
    const route = input.mode === "link" ? "link-social" : "sign-in/social";
    const response = await registry.bridge.runStart(flow, () =>
      this.auth.handler(
        new Request(`${this.baseURL}/admin/auth/${route}`, {
          method: "POST",
          headers: this.headers(req),
          body: JSON.stringify({
            provider: flow.providerId,
            ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
          }),
        }),
      ),
    );
    this.setAuthCookies(res, response);
    if (!response.ok) {
      registry.store.fail(flow.id);
      throw new IdentityError(403, "auth_provider_flow_invalid");
    }
    const value = z.object({ url: z.url() }).parse(await response.json());
    const target = new URL(value.url);
    if (target.protocol !== "https:" || target.username || target.password)
      throw new IdentityError(403, "auth_provider_flow_invalid");
    return { authorizationUrl: target.href };
  }
  private async inspectMobileService(
    req: IncomingMessage,
    res: ServerResponse,
    raw: unknown,
  ) {
    const input = z
      .strictObject({
        attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        action: z.enum(["inspect", "provider", "authorize"]),
      })
      .parse(raw);
    if (this.closing || !this.workflowServerId)
      throw new IdentityError(503, "identity_unavailable");
    const browser = await this.getSession(req);
    if (!browser) throw new IdentityError(401, "identity_unauthorized");
    const { account, current } = this.serviceFlows.validate(
      input.attemptId,
      this.workflowServerId,
      browser.user.id,
    );
    const providerId =
      this.catalog.store.oauth!.config(current).settings.authProviderId;
    const provider = providerId
      ? this.providerRegistry!.store.linkedStatus(
          account.grant.organization_id,
          browser.user.id,
          providerId,
        )
      : null;
    if (input.action === "provider") {
      if (!providerId) throw new IdentityError(400, "identity_invalid_input");
      return this.startProvider(req, res, {
        organizationId: account.grant.organization_id,
        providerId,
        mode: "link",
        actor: { userId: browser.user.id, sessionId: browser.session.id },
        returnPath: `/admin/service-connect#${input.attemptId}`,
      });
    }
    if (input.action === "authorize")
      return {
        authorizationUrl: this.serviceFlows.authorize(
          input.attemptId,
          this.workflowServerId,
          browser.user.id,
        ),
      };
    return {
      service: this.catalog.store.service(
        current.workspaceId,
        current.serviceId,
      ).name,
      provider,
      user: { name: browser.user.name, email: browser.user.email },
    };
  }
  /** Passive routes authenticate inside the identity queue, before runtime credential resolution. */
  mobileProcesses(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    query: unknown,
  ) {
    return this.serial(async () => {
      if (this.closing || this.workflowServerId !== serverId)
        throw new IdentityError(503, "identity_unavailable");
      const account = this.mobile.authenticate(header, workspaceId, serverId);
      return this.processes.executionInventory(
        {
          organizationId: account.grant.organization_id,
          workspaceId,
          userId: account.session.scope.userId,
          role: account.role,
        },
        account.session.scope,
        query,
      );
    });
  }
  mobileProcessInput(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    request: unknown,
  ) {
    return this.serial(async () => {
      if (
        this.closing ||
        this.workflowServerId !== serverId ||
        !this.processStarts
      )
        throw new IdentityError(503, "identity_unavailable");
      const account = this.mobile.authenticate(header, workspaceId, serverId);
      return prepareProcessInput(
        this.processes,
        this.processStarts,
        {
          organizationId: account.grant.organization_id,
          workspaceId,
          userId: account.session.scope.userId,
          role: account.role,
        },
        account.session.scope,
        request,
        (scope, meetingId) => this.meetings.record(scope, meetingId),
        (scope, taskId) => this.meetings.humanTasks.get(scope, taskId),
      );
    });
  }
  /** The person's hub over the app API. The caller starts the returned refreshes. */
  mobileHub(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    payload: unknown,
    language: "en" | "cs",
    /** A read answers in agent-hub/1 unless the dashboard (agent-hub/2 or /3) is asked for. */
    profile: 1 | 2 | 3 = 1,
  ) {
    return this.serial(async () => {
      if (this.closing || this.workflowServerId !== serverId)
        throw new IdentityError(503, "identity_unavailable");
      const account = this.mobile.authenticate(header, workspaceId, serverId);
      const actor = {
        organizationId: account.grant.organization_id,
        workspaceId,
        userId: account.session.scope.userId,
        role: account.role,
      };
      const scope = account.session.scope;
      // The person is here: the scheduler keeps their widgets fresh for a while.
      this.hub.opened(actor, language);
      const result =
        payload === undefined
          ? {
              view:
                profile === 3
                  ? this.hub.cards(actor, scope, language)
                  : profile === 2
                    ? this.hub.dashboard(actor, scope, language)
                    : this.hub.view(actor, scope, language),
              refresh: [] as string[],
            }
          : this.hub.command(actor, scope, language, payload);
      // Every started item, also those an older profile doesn't show.
      const started = result.refresh.length
        ? this.hub.cards(actor, scope, language).items
        : [];
      return {
        scope,
        actor,
        view: result.view,
        refresh: started.flatMap((item) =>
          result.refresh.includes(item.id)
            ? [
                item.processId
                  ? { id: item.id, processId: item.processId }
                  : { id: item.id },
              ]
            : [],
        ),
      };
    });
  }
  /**
   * A process proposal from chat: GET reads how saving it went; POST is the
   * person's "Save and turn on", which runs in the background under their
   * credential (the card polls the status). Only their own proposals.
   */
  async mobileProcessProposal(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    method: string,
    query: { sessionId?: string; language?: string },
    payload: unknown,
  ) {
    const proposals = this.processProposals;
    if (!proposals) throw new IdentityError(503, "identity_unavailable");
    const access = await this.serial(async () =>
      this.processReadAccess(header, workspaceId, serverId),
    );
    const target = { organizationId: access.organizationId, workspaceId };
    if (method === "GET") {
      const sessionId = IdentityId.parse(query.sessionId);
      return this.serial(async () => {
        access.context.validateRequest?.();
        const current = await access.context.actor(target);
        return proposals.status(
          { ...target, userId: current.userId, role: current.role },
          sessionId,
        );
      });
    }
    const begun = await proposals.accept(access.context, target, payload);
    if (begun.start) {
      const controller = new AbortController();
      this.executions.add(controller);
      const signal = AbortSignal.any([
        controller.signal,
        // The test has its own two-minute bound; this covers the whole save.
        AbortSignal.timeout(10 * 60_000),
      ]);
      const running: Promise<void> = proposals
        .run(
          access.context,
          begun.owner,
          access.scope,
          begun.request,
          query.language === "en" ? "en" : "cs",
          signal,
        )
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          this.executions.delete(controller);
          this.catalogRequests.delete(running);
        });
      this.catalogRequests.add(running);
    }
    return begun.status;
  }
  /** Whether a hub refresh may run this version unattended (checked again
   * just before the runner starts it; the policy may have changed). */
  mobileHubUnattended(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    entry: { processId: string; version: number; artifactDigest: string },
  ) {
    return this.serial(async () => {
      if (this.closing || this.workflowServerId !== serverId)
        throw new IdentityError(503, "identity_unavailable");
      const account = this.mobile.authenticate(header, workspaceId, serverId);
      return (
        this.processes.unattendedEffect(
          {
            organizationId: account.grant.organization_id,
            workspaceId,
            userId: account.session.scope.userId,
            role: account.role,
          },
          entry.processId,
          { version: entry.version, artifactDigest: entry.artifactDigest },
        ) !== "write"
      );
    });
  }
  /** A background hub refresh's outcome, under the same live credential. */
  /**
   * A background refresh's outcome for the person who started it. It needs no
   * live credential (the page may have been reloaded meanwhile): the run's
   * admission is re-authorized for the person's current membership, and only
   * their own hub item changes.
   */
  hubRecord(
    actor: ProcessActor,
    scope: Scope,
    itemId: string,
    outcome: HubRunOutcome,
  ) {
    return this.serial(async () => {
      if (this.closing || this.workflowServerId !== scope.serverId)
        throw new IdentityError(503, "identity_unavailable");
      this.hub.record(actor, scope, itemId, outcome);
    });
  }
  hubRelease(scope: Scope, itemId: string) {
    this.hub.release(scope, itemId);
  }
  /** The runner that fills widgets (per-person lanes); scheduled fills go through it too. */
  attachHubRunner(launch: HubLaunch) {
    this.hubLaunch = launch;
  }
  /** One scheduler pass now (tests and operators); the timer runs it otherwise. */
  hubScheduleTick() {
    return this.hubScheduler.tick();
  }
  /** The person's current role in the workspace, or `identity_forbidden`. */
  private hubMember(owner: HubOwner): ProcessActor {
    const row = this.db
      .prepare(
        `SELECT m.role FROM member m
          JOIN agent_workspace w ON w.organization_id=m."organizationId"
          WHERE m."organizationId"=? AND m."userId"=? AND w.id=?
          AND (m.role IN ('owner','admin') OR EXISTS (
            SELECT 1 FROM agent_workspace_member wm WHERE wm.workspace_id=w.id AND wm.member_id=m.id))`,
      )
      .get(owner.organizationId, owner.userId, owner.workspaceId);
    const role = OrganizationRole.safeParse(row?.role);
    if (!role.success) throw new IdentityError(403, "identity_forbidden");
    return { ...owner, role: role.data };
  }
  /**
   * A scheduled fill of one widget: the owner's membership is checked now
   * (and again at every step of the fill), the item is marked as filling
   * with source `schedule` and the runner fills it in the person's lane. A
   * fill already running is reused, so a refresh the person starts meanwhile
   * is never duplicated.
   */
  private hubScheduleStart(entry: HubScheduledItem) {
    return this.serial(async () => {
      const serverId = this.workflowServerId;
      const launch = this.hubLaunch;
      if (this.closing || !serverId || !launch) return false;
      const actor = this.hubMember(entry.owner);
      // Signed out everywhere (or a password reset): nothing runs as them.
      if (!this.mobile.signedIn(entry.owner.userId, entry.owner.workspaceId))
        return false;
      const scope: Scope = {
        connectionId: `account-${entry.owner.workspaceId}`,
        serverId,
        userId: entry.owner.userId,
        workspaceId: entry.owner.workspaceId,
      };
      if (!this.hub.schedule(actor, scope, entry.item.id)) return false;
      launch(
        {
          scheduled: true,
          workspaceId: entry.owner.workspaceId,
          serverId,
          actor,
        },
        scope,
        [{ id: entry.item.id }],
        "cs",
      );
      return true;
    }).catch(() => false);
  }
  /**
   * The person's authority for a hub agent run (a fill or an open): the
   * live credential re-checked on every step, the workspace's chat model and
   * a catalog context whose reads leave durable receipts.
   */
  private hubAgentAccess(
    credential: HubFillCredential,
    workspaceId: string,
    serverId: string,
  ) {
    if (this.closing || this.workflowServerId !== serverId)
      throw new IdentityError(503, "identity_unavailable");
    let organizationId: string;
    let userId: string;
    let check: () => { role: ProcessActor["role"] };
    if (credential && typeof credential === "object") {
      // A scheduled fill: no bearer, the person's current membership and a
      // live sign-in somewhere instead.
      ({ organizationId, userId } = credential.member);
      const member = () => {
        if (this.closing) throw new IdentityError(503, "identity_unavailable");
        const current = this.hubMember({ organizationId, workspaceId, userId });
        if (!this.mobile.signedIn(userId, workspaceId))
          throw new IdentityError(403, "identity_forbidden");
        return current;
      };
      member();
      check = () => ({ role: member().role });
    } else {
      const initial = this.mobile.authenticate(
        credential,
        workspaceId,
        serverId,
      );
      organizationId = initial.grant.organization_id;
      userId = initial.session.scope.userId;
      check = () => {
        if (this.closing) throw new IdentityError(503, "identity_unavailable");
        const current = this.mobile.authenticateDigest(
          initial.credentialId,
          workspaceId,
          serverId,
        );
        if (
          current.grant.organization_id !== organizationId ||
          current.session.scope.userId !== userId
        )
          throw new IdentityError(403, "identity_forbidden");
        return { role: current.role };
      };
    }
    const actor = () => ({
      organizationId,
      workspaceId,
      userId,
      role: check().role,
    });
    const selected = this.catalog.store.resolveModel(
      organizationId,
      workspaceId,
    );
    if (!selected) throw new IdentityError(409, "catalog_model_required");
    const context: CatalogContext = {
      serial: (fn) => this.serial(fn),
      actor: async (requested) => {
        const current = check();
        if (
          requested.organizationId !== organizationId ||
          requested.workspaceId !== workspaceId
        )
          throw new IdentityError(403, "identity_forbidden");
        return { userId, role: current.role };
      },
      validateRequest: () => {
        check();
      },
      epoch: (org) => this.connections.policyVersion(org),
      change: (org) => this.connections.changePolicy(org),
      audit: (record) => this.audit.append(record),
      finish: (id, outcome, details) => this.audit.finish(id, outcome, details),
      transaction: (fn) => this.transaction(fn),
    };
    return { organizationId, userId, check, actor, selected, context };
  }
  /**
   * Whether the person may still read what a widget's items are opened
   * from: its learned open read (before one, any read of the services it
   * names or was filled from) among their unattended reads now, under their
   * own account where the service asks for one. Local only, no network: what
   * the index serves rests on it.
   */
  private hubSourceReadable(
    actor: ProcessActor,
    request: {
      sources: { id: string }[];
      recipe?: { calls: { serviceId: string }[] } | null;
      open: { serviceId: string; actionId: string } | null;
    },
  ) {
    const who = { userId: actor.userId, role: actor.role };
    const readable = hubReadableServices(
      this.catalog.store,
      actor.organizationId,
      actor.workspaceId,
      who,
    );
    const named = request.open
      ? [request.open.serviceId]
      : [
          ...request.sources.map((source) => source.id),
          ...(request.recipe?.calls ?? []).map((call) => call.serviceId),
        ];
    return readable.some(
      (service) =>
        (!named.length || named.includes(service.id)) &&
        service.actions.some((action) => {
          if (request.open && action.id !== request.open.actionId) return false;
          try {
            this.catalog.store.authorize(
              actor.workspaceId,
              service.id,
              service.revision,
              action.id,
              action.revision,
              who,
              true,
            );
            return true;
          } catch {
            return false;
          }
        }),
    );
  }
  /**
   * Fills one AI widget in the background under the person's live
   * credential: a closed agent reads (never writes) through their own read
   * actions, under the inference ledger with the fill's own caps, and the
   * validated data is stored for the widget. Failures keep the last good data.
   */
  async hubFill(
    credential: HubFillCredential,
    workspaceId: string,
    serverId: string,
    itemId: string,
    language: "en" | "cs",
    signal: AbortSignal,
  ): Promise<HubRunOutcome> {
    try {
      const prepared = await this.serial(async () => {
        const access = this.hubAgentAccess(credential, workspaceId, serverId);
        return {
          ...access,
          request: this.hub.fillRequest(access.actor(), itemId),
        };
      });
      const runId = `hub-fill/${itemId}/${randomUUID()}`;
      const result = await runHubFill(
        createHubFillAccess({
          controller: this.catalog,
          context: prepared.context,
          target: { organizationId: prepared.organizationId, workspaceId },
          selected: prepared.selected,
          userId: prepared.userId,
          runId,
          check: () => {
            signal.throwIfAborted();
            prepared.check();
          },
        }),
        {
          ...prepared.request,
          language,
          now: Date.now(),
          runKey: runId,
        },
        signal,
      );
      await this.serial(async () => {
        this.hub.fillDone(prepared.actor(), itemId, prepared.request, result);
      });
      // The rows' bodies follow into the index, after this answer.
      this.hubPrefetch(prepared, workspaceId, itemId, language);
      return { type: "filled" };
    } catch (error) {
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
          ? error.code
          : "hub_fill_failed";
      return { type: "failed", error: code };
    }
  }
  /**
   * Opens one item of an AI widget in full for the signed-in person: from
   * the index when it is fresh there, else by replaying the widget's learned
   * open read, else by the same closed read-only agent as a fill (two reads
   * at most, under `HUB_OPEN_CAPS` in the ledger). The content is extracted
   * on the server, never rewritten by the model; the detail goes into the
   * index, the read the agent used becomes the widget's open recipe and the
   * other rows follow in the background. One open at a time per person.
   */
  async hubOpen(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    payload: unknown,
    language: "en" | "cs",
    signal: AbortSignal,
  ): Promise<HubOpenResult> {
    const parsed = HubOpenRequestSchema.safeParse(payload);
    if (!parsed.success) throw new IdentityError(400, "invalid_payload");
    const { itemId, ref } = parsed.data;
    const prepared = await this.serial(async () => {
      const access = this.hubAgentAccess(header, workspaceId, serverId);
      const actor = access.actor();
      const request = this.hub.openRequest(actor, itemId, ref);
      return {
        ...access,
        request,
        // The index answers only while the person may still read its source.
        cached: this.hubSourceReadable(actor, request)
          ? this.hub.openCached(actor, itemId, ref)
          : null,
      };
    });
    if (prepared.cached) return { ...prepared.cached, cached: true };
    const key = JSON.stringify([workspaceId, prepared.userId]);
    const lane = this.hubOpens.get(key) ?? {
      queue: Promise.resolve(),
      waiting: 0,
    };
    if (lane.waiting >= 2) throw new IdentityError(429, "hub_open_busy");
    lane.waiting++;
    this.hubOpens.set(key, lane);
    const controller = new AbortController();
    this.executions.add(controller);
    const run = lane.queue.then(async () => {
      const runId = `hub-open/${itemId}/${randomUUID()}`;
      const combined = AbortSignal.any([
        signal,
        controller.signal,
        AbortSignal.timeout(90_000),
      ]);
      combined.throwIfAborted();
      const result = await runHubOpen(
        createHubFillAccess({
          controller: this.catalog,
          context: prepared.context,
          target: { organizationId: prepared.organizationId, workspaceId },
          selected: prepared.selected,
          userId: prepared.userId,
          runId,
          caps: HUB_OPEN_CAPS,
          check: () => {
            combined.throwIfAborted();
            prepared.check();
          },
        }),
        { ...prepared.request, language, now: Date.now(), runKey: runId },
        combined,
      );
      await this.serial(async () => {
        this.hub.openDone(
          prepared.actor(),
          itemId,
          ref,
          result.detail,
          result.open,
        );
      });
      if (result.open)
        this.hubPrefetch(prepared, workspaceId, itemId, language);
      return result.detail;
    });
    lane.queue = run.then(
      () => {},
      () => {},
    );
    try {
      return { ...(await run), cached: false };
    } finally {
      this.executions.delete(controller);
      lane.waiting--;
      if (!lane.waiting && this.hubOpens.get(key) === lane)
        this.hubOpens.delete(key);
    }
  }
  /**
   * Opens the widget's rows into the index in the background, under the
   * same credential: the learned open read replayed for each row not fresh
   * there (never the agent, no model call), at most twelve, one after the
   * other, one chain per person and one run per item at a time. It never
   * delays the fill or open that started it; failures are silent.
   */
  private hubPrefetch(
    prepared: ReturnType<IdentityService["hubAgentAccess"]>,
    workspaceId: string,
    itemId: string,
    language: "en" | "cs",
  ) {
    if (this.closing) return;
    const laneKey = JSON.stringify([workspaceId, prepared.userId]);
    const itemKey = JSON.stringify([workspaceId, prepared.userId, itemId]);
    if (this.hubPrefetching.has(itemKey)) return;
    this.hubPrefetching.add(itemKey);
    const controller = new AbortController();
    this.executions.add(controller);
    const previous = this.hubPrefetchLanes.get(laneKey) ?? Promise.resolve();
    const run: Promise<void> = previous
      .then(async () => {
        if (this.closing) return;
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(5 * 60_000),
        ]);
        const request = await this.serial(async () =>
          this.hub.prefetchRequest(prepared.actor(), itemId),
        );
        if (!request.refs.length) return;
        const runId = `hub-prefetch/${itemId}/${randomUUID()}`;
        await runHubPrefetch(
          createHubFillAccess({
            controller: this.catalog,
            context: prepared.context,
            target: { organizationId: prepared.organizationId, workspaceId },
            selected: prepared.selected,
            userId: prepared.userId,
            runId,
            caps: HUB_FILL_CAPS,
            check: () => {
              signal.throwIfAborted();
              prepared.check();
            },
          }),
          { ...request, language, now: Date.now(), runKey: runId },
          signal,
          async (ref, detail) => {
            await this.serial(async () => {
              this.hub.openDone(prepared.actor(), itemId, ref, detail);
            });
          },
        );
      })
      .catch(() => {})
      .finally(() => {
        this.executions.delete(controller);
        this.hubPrefetching.delete(itemKey);
        this.catalogRequests.delete(run);
        if (this.hubPrefetchLanes.get(laneKey) === run)
          this.hubPrefetchLanes.delete(laneKey);
      });
    this.hubPrefetchLanes.set(laneKey, run);
    this.catalogRequests.add(run);
  }
  /** Authenticated app-API actor for skills and mentions (reads, no runtime). */
  private appActor(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
  ) {
    if (this.closing || this.workflowServerId !== serverId)
      throw new IdentityError(503, "identity_unavailable");
    const account = this.mobile.authenticate(header, workspaceId, serverId);
    return {
      scope: account.session.scope,
      actor: {
        organizationId: account.grant.organization_id,
        workspaceId,
        userId: account.session.scope.userId,
        role: account.role,
      } satisfies SkillActor,
    };
  }
  /**
   * Skills over the app API: `GET` lists the person's usable skills, `GET
   * ?id=` reads one, `GET ?proposalId=` reads a chat proposal's state and
   * `POST {type: "accept"}` saves a proposal (idempotent).
   */
  mobileSkills(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    query: URLSearchParams,
    payload: unknown,
  ) {
    return this.serial(async () => {
      const { actor } = this.appActor(header, workspaceId, serverId);
      if (payload !== undefined) {
        const command = SkillProposalAcceptSchema.parse(payload);
        return this.skills.accept(actor, command.proposalId, command.target);
      }
      const id = query.get("id");
      if (id) return this.skills.get(actor, id);
      const proposalId = query.get("proposalId");
      if (proposalId) return this.skills.proposalStatus(actor, proposalId);
      const list = this.skills.list(actor);
      // Members see only what they can use; disabled company skills stay in the console.
      return {
        ...list,
        workspace: list.workspace.filter((skill) => skill.enabled),
      };
    });
  }
  /** What this person can tag with "@" right now: usable services, ready
   * processes and skills. For the hub: only the services overview widgets can
   * read (enabled reads that run without approval). */
  mobileMentions(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    purpose?: "hub",
  ): Promise<MentionDirectory> {
    return this.serial(async () => {
      const { actor, scope } = this.appActor(header, workspaceId, serverId);
      if (purpose === "hub")
        return MentionDirectorySchema.parse({
          profile: MENTIONS_PROFILE,
          items: hubReadableServices(
            this.catalog.store,
            actor.organizationId,
            actor.workspaceId,
            { userId: actor.userId, role: actor.role },
          )
            .slice(0, 300)
            .map((service) => ({
              kind: "service" as const,
              id: service.id,
              name: service.name.slice(0, 120),
              ...(service.description
                ? { description: service.description.slice(0, 300) }
                : {}),
            })),
        });
      return this.mentionDirectory(actor, scope);
    });
  }
  private mentionDirectory(actor: SkillActor, scope: Scope): MentionDirectory {
    const store = this.catalog.store;
    const catalogActor = { userId: actor.userId, role: actor.role };
    const services = store
      .inventory(actor.organizationId, actor.workspaceId, {
        ...catalogActor,
        role: "owner",
      })
      .services.filter(
        (service) =>
          service.enabled &&
          service.actions.some(
            (action) => action.enabled && store.allowed(action, catalogActor),
          ),
      )
      .map((service) => ({
        kind: "service" as const,
        id: service.id,
        name: service.name.slice(0, 120),
        ...(service.description
          ? { description: service.description.slice(0, 300) }
          : {}),
      }));
    const processes = this.processes
      .executionInventory(actor, scope)
      .processes.flatMap((entry) =>
        entry.availability === "ready"
          ? [
              {
                kind: "process" as const,
                id: entry.processId,
                name: entry.name.slice(0, 120),
                ...(entry.description
                  ? { description: entry.description.slice(0, 300) }
                  : {}),
                ...(entry.personal ? { personal: true } : {}),
              },
            ]
          : [],
      );
    const skills = this.skills
      .usable(actor)
      .slice(0, SKILL_LIMITS.personalPerPerson)
      .map((skill) => ({
        kind: "skill" as const,
        id: skill.id,
        name: skill.name,
        description: skill.description,
        ...(skill.owner.type === "user" ? { personal: true } : {}),
      }));
    return MentionDirectorySchema.parse({
      profile: MENTIONS_PROFILE,
      items: [...services, ...processes, ...skills].slice(0, 300),
    });
  }
  /** Workspace process design over a pinned native app session. */
  async mobileProcessDesign(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    method: string,
    url: URL,
    payload: unknown,
    signal: AbortSignal,
  ) {
    if (
      ![DESIGN_PROFILE, WORKSPACE_DESIGN_PROFILE].includes(
        url.searchParams.get("profile") as
          | typeof DESIGN_PROFILE
          | typeof WORKSPACE_DESIGN_PROFILE,
      )
    )
      throw new IdentityError(406, "process_design_profile_unsupported");
    const access = await this.serial(async () =>
      this.processReadAccess(header, workspaceId, serverId),
    );
    const designUrl = new URL(url);
    // Scope comes from the bearer grant, never from mobile query/body values.
    designUrl.searchParams.set("organizationId", access.organizationId);
    designUrl.searchParams.set("workspaceId", workspaceId);
    designUrl.pathname =
      PROCESS_DESIGN_PATH +
      url.pathname.slice(`/v1/${workspaceId}/process-design`.length);
    const scopedPayload =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? {
            ...payload,
            organizationId: access.organizationId,
            workspaceId,
          }
        : payload;
    return handleProcessDesign(
      method,
      designUrl,
      scopedPayload,
      {
        proposals: this.processDesigns,
        conversation: this.processDesignConversation,
        registry: this.processes,
        catalog: this.catalog.store,
        plugins: this.plugins,
      },
      access.context,
      signal,
    );
  }
  /** Shared authenticated passive process dependencies; constructs no native runtime. */
  private processReadAccess(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
  ) {
    if (
      this.closing ||
      this.workflowServerId !== serverId ||
      !this.processStarts
    )
      throw new IdentityError(503, "identity_unavailable");
    const initial = this.mobile.authenticate(header, workspaceId, serverId);
    const organizationId = initial.grant.organization_id;
    const settings = this.plugins.read(workspaceId);
    const check = () => {
      if (this.closing) throw new IdentityError(503, "identity_unavailable");
      const current = this.mobile.authenticateDigest(
        initial.credentialId,
        workspaceId,
        serverId,
      );
      if (
        current.grant.organization_id !== organizationId ||
        current.session.scope.userId !== initial.session.scope.userId
      )
        throw new IdentityError(403, "identity_forbidden");
      return current;
    };
    const context: CatalogContext = {
      serial: (fn) => this.serial(fn),
      actor: async (requested) => {
        const current = check();
        if (
          requested.organizationId !== organizationId ||
          requested.workspaceId !== workspaceId
        )
          throw new IdentityError(403, "identity_forbidden");
        return { userId: current.session.scope.userId, role: current.role };
      },
      validateRequest: () => {
        check();
      },
      epoch: (org) => this.connections.policyVersion(org),
      change: (org) => this.connections.changePolicy(org),
      audit: (record) => this.audit.append(record),
      finish: (id, outcome, details) => this.audit.finish(id, outcome, details),
      transaction: (fn) => this.transaction(fn),
    };
    const memoryActor: MemoryActor = {
      organizationId,
      workspaceId,
      userId: initial.session.scope.userId,
      canManageShared: initial.role !== "member",
    };
    const memory = settings.settings.enabled.includes("memory")
      ? createMemoryRuntime(
          this.memory,
          memoryActor,
          MemorySettingsSchema.parse(settings.settings.memory ?? {}),
          {
            read: (fn) =>
              this.serial(async () => {
                check();
              }).then(fn),
            transaction: (fn) => this.serial(async () => fn()),
            check: () => {
              check();
              if (this.plugins.read(workspaceId).revision !== settings.revision)
                throw new IdentityError(409, "process_memory_changed");
            },
            sourceAccess: (source, actor) =>
              this.memorySourceAccess(source, actor, check().role),
            mutate: () =>
              Promise.reject(
                new IdentityError(403, "process_memory_read_only"),
              ),
          },
        )
      : undefined;
    return {
      scope: initial.session.scope,
      organizationId,
      context,
      memory,
      memoryObservation: () => [
        this.memory.version(memoryActor),
        this.plugins.read(workspaceId).revision,
      ],
    };
  }
  mobileProcessOutputCapabilities(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
  ) {
    return this.serial(async () => {
      if (this.closing || this.workflowServerId !== serverId)
        throw new IdentityError(503, "identity_unavailable");
      const current = this.mobile.authenticate(header, workspaceId, serverId);
      return ProcessOutputCapabilitiesSchema.parse({
        profile: PROCESS_OUTPUT_PROFILE,
        scope: current.session.scope,
        available: true,
        readProfile: PROCESS_OUTPUT_PROFILE,
        workProfile: PROCESS_OUTPUT_WORK_PROFILE,
      });
    });
  }
  async mobileProcessOutput(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    raw: unknown,
  ) {
    const request = ProcessOutputRequestSchema.parse(raw);
    const access = await this.serial(async () =>
      this.processReadAccess(header, workspaceId, serverId),
    );
    const windows = createProcessReadWindow(
      this.catalog,
      this.processes,
      this.processStarts!,
      access.context,
      access.scope,
      access.organizationId,
      access.memory,
      access.memoryObservation,
      this.processQuestions,
    );
    return readProcessOutput(
      await windows.read(request.reference.parentRunId),
      request,
      access.scope,
    );
  }
  /** Process requests share identity, Memory, native owner and in-flight ownership with chat. */
  mobileProcessCoordinator(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
    executionProfile?: ProcessRuntimeProfile,
  ) {
    return this.serial(async () => {
      if (
        this.closing ||
        this.workflowServerId !== serverId ||
        !this.processStarts ||
        !this.processResolves ||
        !this.processQuestions
      )
        throw new IdentityError(503, "identity_unavailable");
      const access = this.processReadAccess(header, workspaceId, serverId);
      const { scope, organizationId, context, memory } = access;
      return {
        scope: scope,
        coordinator: createProcessCoordinator(
          this.catalog,
          this.processes,
          this.processStarts,
          this.processResolves,
          context,
          scope,
          organizationId,
          this.nativeRequests,
          {
            memory,
            memoryObservation: access.memoryObservation,
            questions: this.processQuestions,
            executionProfile,
            validateMeetingOrigin: (origin, inputSchema) => {
              if (origin.type !== "meeting")
                throw new IdentityError(409, "process_origin_changed");
              assertMeetingProcessOrigin(
                (meetingScope, meetingId) =>
                  this.meetings.record(meetingScope, meetingId),
                scope,
                origin,
                inputSchema,
                (taskScope, taskId) =>
                  this.meetings.humanTasks.get(taskScope, taskId),
              );
            },
          },
        ),
      };
    });
  }
  async mobileMeetingAccess(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
  ) {
    const runtime = await this.mobileAccess(header, workspaceId, serverId);
    return {
      store: this.meetings,
      processor: this.meetingProcessor,
      runtime,
      failure: <T>(fn: () => T) => this.serial(async () => fn()),
    };
  }
  mobileAccess(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
  ): Promise<MobileRuntime> {
    return this.accountRuntimeAccess(
      workspaceId,
      serverId,
      (credentialId) =>
        credentialId
          ? this.mobile.authenticateDigest(credentialId, workspaceId, serverId)
          : this.mobile.authenticate(header, workspaceId, serverId),
      async (parentRunId) => {
        const access = await this.mobileProcessCoordinator(
          header,
          workspaceId,
          serverId,
        );
        return access.coordinator.retired(parentRunId);
      },
      // The app reviews and starts offered processes; other clients cannot.
      true,
      async (parentRunId, expectedRevision) => {
        const access = await this.mobileProcessCoordinator(
          header,
          workspaceId,
          serverId,
          PROCESS_QUESTION_EXECUTION_PROFILE,
        );
        await access.coordinator.cancelRun(parentRunId, expectedRevision);
      },
    );
  }
  mcpAuthenticate(header: string | undefined, serverId: string) {
    return this.serial(async () => {
      if (
        /^Bearer /i.test(header ?? "") &&
        header?.slice(7).startsWith(MCP_OAUTH_TOKEN_PREFIX)
      ) {
        if (!this.mcpOAuth) throw new IdentityError(401, "mcp_unauthorized");
        return this.mcpOAuth.authenticate(this.auth, header, { serverId });
      }
      return this.mcpGrants.authenticate(header, { serverId });
    });
  }
  /** Connector mode: the grant re-authenticates (with its membership) on every
   * read and inside the catalog's dispatch guard; nothing is cached per client. */
  private connectorPrincipal(grantId: string, serverId: string) {
    if (this.closing) throw new IdentityError(503, "identity_unavailable");
    const scopes: McpAccessScope[] = ["services.call"];
    const principal = this.mcpGrants.authenticateGrant(grantId, {
      serverId,
      requiredScopes: scopes,
    });
    this.mcpActor(principal, scopes);
    return principal;
  }
  private connectorContext(grantId: string, serverId: string): CatalogContext {
    return {
      serial: (fn) => this.serial(fn),
      actor: async (requested) => {
        const current = this.connectorPrincipal(grantId, serverId);
        if (
          requested.organizationId !== current.organizationId ||
          requested.workspaceId !== current.workspaceId
        )
          throw new IdentityError(403, "identity_forbidden");
        return { userId: current.userId, role: current.role };
      },
      validateRequest: () => {
        this.connectorPrincipal(grantId, serverId);
      },
      epoch: (org) => this.connections.policyVersion(org),
      change: (org) => this.connections.changePolicy(org),
      audit: (record) => this.audit.append(record),
      finish: (id, outcome, details) => this.audit.finish(id, outcome, details),
      transaction: (fn) => this.transaction(fn),
    };
  }
  private connectorApprovalUrl(workspaceId: string, requestId: string) {
    return `${this.baseURL}/admin/mcp?${new URLSearchParams({ approval: requestId, workspaceId })}`;
  }
  mcpConnectorTools(principal: McpPrincipal) {
    return this.serial(async () => {
      const current = this.connectorPrincipal(
        principal.grantId,
        principal.serverId,
      );
      const actor = { userId: current.userId, role: current.role };
      const catalog = this.catalog.store.inventory(
        current.organizationId,
        current.workspaceId,
        actor,
      );
      // Approval notes follow the person's own choices on personal services.
      return connectorTools(
        this.catalog.store.servicesFor(
          current.workspaceId,
          catalog.services,
          actor.userId,
        ),
        (action) => this.catalog.store.allowed(action, actor),
      );
    });
  }
  async mcpConnectorCall(
    principal: McpPrincipal,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const tool = (await this.mcpConnectorTools(principal)).find(
      (item) => item.name === name,
    );
    if (!tool) throw new IdentityError(404, "mcp_tool_not_found");
    const receipt = await this.catalog.invoke(
      {
        organizationId: principal.organizationId,
        workspaceId: principal.workspaceId,
        serviceId: tool.service.id,
        serviceRevision: tool.service.revision,
        actionId: tool.action.id,
        revision: tool.action.revision,
        input,
        requestId: randomUUID(),
        // Approval stays with a person in the console, never with the client.
        approve: false,
      },
      this.connectorContext(principal.grantId, principal.serverId),
      signal,
      "mcp",
    );
    return connectorResult(
      receipt,
      this.connectorApprovalUrl(principal.workspaceId, receipt.id),
    );
  }
  mcpConnectorStatus(principal: McpPrincipal, requestId: string) {
    return this.serial(async () => {
      const current = this.connectorPrincipal(
        principal.grantId,
        principal.serverId,
      );
      const receipt = this.catalog.store.invocation(
        IdentityId.parse(requestId),
        current.workspaceId,
        current.userId,
      );
      if (!receipt) throw new IdentityError(404, "mcp_call_not_found");
      return connectorResult(
        receipt,
        this.connectorApprovalUrl(current.workspaceId, receipt.id),
      );
    });
  }
  mcpTaskDependencies() {
    return {
      attach: (runner: McpTasks) => {
        this.mcpTaskRunner = runner;
      },
      store: this.mcpAdmissions,
      run: <T>(fn: () => T) =>
        this.serial(async () => {
          if (this.closing)
            throw new IdentityError(503, "identity_unavailable");
          return fn();
        }),
      access: (
        grantId: string,
        serverId: string,
        requiredScopes: McpAccessScope[],
        workspaceId?: string,
        credentialKind?: "mcp" | "browser",
        memberId?: string,
      ) =>
        credentialKind === "browser" && workspaceId
          ? this.browserRuntimeAccess(grantId, workspaceId, serverId, memberId)
          : this.mcpRuntimeAccess(grantId, serverId, requiredScopes),
    };
  }
  private mcpActor(
    principal: McpPrincipal,
    requiredScopes: McpAccessScope[] = principal.scopes,
  ) {
    this.mcpOAuth?.assertActiveGrant(principal.grantId, requiredScopes);
    return {
      grant: { organization_id: principal.organizationId },
      role: principal.role,
      credentialId: principal.grantId,
      session: {
        authProfile: AUTH_PROFILE,
        profile: PROFILE,
        expiresAt: principal.expiresAt,
        scope: mcpScope(principal),
        permissions: ["workflow.read", "workflow.write"],
      } satisfies AuthSession,
    };
  }
  mcpServerId() {
    return this.closing ? undefined : this.workflowServerId;
  }
  async mcpPublicHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (!this.mcpOAuth) return false;
    const url = new URL(req.url ?? "/", this.baseURL);
    const resourceMetadata =
      url.pathname === "/.well-known/oauth-protected-resource/mcp";
    const serverMetadata =
      url.pathname === "/.well-known/oauth-authorization-server/admin/auth";
    const publicAuth = [
      "/admin/auth/oauth2/authorize",
      "/admin/auth/oauth2/token",
      "/admin/auth/oauth2/revoke",
    ].includes(url.pathname);
    const consent = [
      "/admin/auth/mcp/oauth/consent-info",
      "/admin/auth/mcp/oauth/consent",
    ].includes(url.pathname);
    if (!resourceMetadata && !serverMetadata && !publicAuth && !consent)
      return false;
    const fail = (status: number, error: string) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify({ error }));
      return true;
    };
    if (
      req.headers.host !== new URL(this.baseURL).host ||
      (req.headers.origin !== undefined &&
        req.headers.origin !== new URL(this.baseURL).origin)
    )
      return fail(403, "mcp_oauth_origin_denied");
    if (resourceMetadata || serverMetadata) {
      if (req.method !== "GET" || url.search)
        return fail(405, "method_not_allowed");
    } else if (url.pathname.endsWith("/authorize")) {
      if (req.method !== "GET") return fail(405, "method_not_allowed");
    } else {
      if (req.method !== "POST") return fail(405, "method_not_allowed");
      if (
        consent &&
        (req.headers.origin !== new URL(this.baseURL).origin ||
          req.headers["x-agent-admin"] !== "1" ||
          req.headers["content-type"] !== "application/json")
      )
        return fail(403, "mcp_oauth_origin_denied");
    }
    if (resourceMetadata) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(this.mcpOAuth.protectedResourceMetadata()));
      return true;
    }
    let payload: Buffer | undefined;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const timeout = setTimeout(() => req.destroy(), 10_000);
      timeout.unref();
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 32_768) return fail(413, "invalid_request");
          chunks.push(Buffer.from(chunk));
        }
        payload = Buffer.concat(chunks);
      } catch {
        return fail(400, "invalid_request");
      } finally {
        clearTimeout(timeout);
      }
    }
    const headers = new Headers({
      "x-agent-client-ip": clientAddress(req),
    });
    for (const name of [
      "cookie",
      "origin",
      "authorization",
      "content-type",
      "accept",
    ])
      if (typeof req.headers[name] === "string")
        headers.set(name, req.headers[name]);
    const path = serverMetadata
      ? "/admin/auth/.well-known/oauth-authorization-server"
      : url.pathname;
    try {
      const response = await this.serial(async () => {
        if (this.closing) throw new IdentityError(503, "identity_unavailable");
        return this.auth.handler(
          new Request(`${this.baseURL}${path}${url.search}`, {
            method: req.method,
            headers,
            ...(payload ? { body: new Uint8Array(payload) } : {}),
          }),
        );
      });
      res.statusCode = response.status;
      for (const [name, value] of response.headers)
        if (name !== "set-cookie") res.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("Set-Cookie", cookies);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.end(Buffer.from(await response.arrayBuffer()));
      return true;
    } catch {
      return fail(503, "temporarily_unavailable");
    }
  }
  async mcpRuntimeAccess(
    grantId: string,
    serverId: string,
    requiredScopes: McpAccessScope[],
  ) {
    const principal = await this.serial(async () =>
      this.mcpGrants.authenticateGrant(grantId, { serverId, requiredScopes }),
    );
    return this.accountRuntimeAccess(principal.workspaceId, serverId, () =>
      this.mcpActor(
        this.mcpGrants.authenticateGrant(grantId, { serverId, requiredScopes }),
        requiredScopes,
      ),
    );
  }
  private browserRuntimeActor(
    sessionId: string,
    workspaceId: string,
    serverId: string,
  ) {
    if (this.closing || this.workflowServerId !== serverId)
      throw new IdentityError(503, "identity_unavailable");
    const row = this.db
      .prepare(
        `SELECT s."userId" AS user_id,s."expiresAt" AS expires_at,
      m.id AS member_id,m.role,w.organization_id
      FROM session s JOIN member m ON m."userId"=s."userId"
      JOIN agent_workspace w ON w.organization_id=m."organizationId"
      WHERE s.id=? AND w.id=?`,
      )
      .get(sessionId, workspaceId);
    const expiresAt =
      row &&
      (typeof row.expires_at === "number"
        ? row.expires_at
        : new Date(String(row.expires_at)).getTime());
    if (
      !row ||
      !expiresAt ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    )
      throw new IdentityError(401, "identity_unauthorized");
    const role = OrganizationRole.parse(row.role);
    if (
      role === "member" &&
      !this.db
        .prepare(
          "SELECT 1 FROM agent_workspace_member WHERE workspace_id=? AND member_id=?",
        )
        .get(workspaceId, String(row.member_id))
    )
      throw new IdentityError(403, "identity_forbidden");
    const principal = {
      grantId: sessionId,
      userId: String(row.user_id),
      memberId: String(row.member_id),
      organizationId: String(row.organization_id),
      workspaceId,
      serverId,
      role,
      scopes: ["native.view", "native.run"] as McpAccessScope[],
      expiresAt: new Date(expiresAt).toISOString(),
    };
    return { principal, runtime: this.mcpActor(principal) };
  }
  private async browserRuntimeAccess(
    sessionId: string,
    workspaceId: string,
    serverId: string,
    memberId?: string,
  ) {
    const initial = await this.serial(async () =>
      this.browserRuntimeActor(sessionId, workspaceId, serverId),
    );
    if (memberId && initial.principal.memberId !== memberId)
      throw new IdentityError(403, "identity_forbidden");
    return this.accountRuntimeAccess(workspaceId, serverId, () => {
      const current = this.browserRuntimeActor(
        sessionId,
        workspaceId,
        serverId,
      );
      if (
        current.principal.memberId !== initial.principal.memberId ||
        current.principal.userId !== initial.principal.userId
      )
        throw new IdentityError(403, "identity_forbidden");
      return current.runtime;
    });
  }
  private accountRuntimeAccess(
    workspaceId: string,
    serverId: string,
    authenticate: (credentialId?: string) => {
      grant: { organization_id: string };
      session: AuthSession;
      credentialId: string;
      role: z.infer<typeof OrganizationRole>;
    },
    retireProcessRequest?: MobileRuntime["retireProcessRequest"],
    offersProcesses = false,
    cancelProcessRun?: MobileRuntime["cancelProcessRun"],
  ): Promise<MobileRuntime> {
    return this.serial(async () => {
      if (this.closing) throw new IdentityError(503, "identity_unavailable");
      const initial = authenticate();
      const orgId = initial.grant.organization_id;
      const policyVersion = this.connections.policyVersion(orgId);
      const ai = this.ai.read(workspaceId);
      const plugins = this.plugins.read(workspaceId);
      const calendarRevision = this.calendars.row(workspaceId);
      const services = this.ai.resolve(ai.selection);
      let dynamicModel: ReturnType<ServiceCatalogStore["resolveModel"]>;
      try {
        dynamicModel = this.catalog.store.resolveModel(orgId, workspaceId);
      } catch {
        /* Disabled catalog selection must not break authenticated snapshot reads. */
      }
      const binding = this.connections.binding(workspaceId);
      const inventory = this.connections.list(orgId, workspaceId, initial.role);
      const selected = inventory.connections.find(
        (c) => c.id === binding.connectionId,
      );
      const row = selected
        ? this.connections.row(workspaceId, selected.id)
        : undefined;
      const check = () => {
        if (this.closing) throw new ModelError("model_unavailable");
        const actor = authenticate(initial.credentialId);
        const currentBinding = this.connections.binding(workspaceId);
        if (
          this.connections.policyVersion(orgId) !== policyVersion ||
          this.ai.read(workspaceId).revision !== ai.revision ||
          this.plugins.read(workspaceId).revision !== plugins.revision ||
          this.calendars.row(workspaceId)?.id !== calendarRevision?.id ||
          this.calendars.row(workspaceId)?.revision !==
            calendarRevision?.revision ||
          currentBinding.revision !== binding.revision ||
          currentBinding.connectionId !== binding.connectionId
        )
          throw new ModelError("model_unavailable");
        if (
          row &&
          this.connections.row(workspaceId, row.id).revision !== row.revision
        )
          throw new ModelError("model_unavailable");
        return actor;
      };
      const run = <T>(fn: () => T | Promise<T>) =>
        this.serial(async () => {
          check();
          return fn();
        });
      const memoryActor: MemoryActor = {
        organizationId: orgId,
        workspaceId,
        userId: initial.session.scope.userId,
        canManageShared: initial.role !== "member",
      };
      const memoryRuntime = plugins.settings.enabled.includes("memory")
        ? createMemoryRuntime(
            this.memory,
            memoryActor,
            MemorySettingsSchema.parse(plugins.settings.memory ?? {}),
            {
              read: (fn) =>
                this.serial(async () => {
                  check();
                }).then(fn),
              transaction: (fn) => this.serial(async () => fn()),
              check: () => {
                check();
              },
              sourceAccess: (source, actor) =>
                this.memorySourceAccess(source, actor, check().role),
              mutate: (fn) =>
                this.serial(async () => {
                  check();
                }).then(fn),
            },
          )
        : undefined;
      const validateAI = (kind: "model" | "transcriber") =>
        run(() => {
          if (
            !services[kind] ||
            this.ai.resolve(ai.selection)[kind] !== services[kind]
          )
            throw new ModelError("model_unavailable");
        });
      let catalogTranscriber: Transcriber | undefined;
      try {
        const voice = this.catalog.store.resolveVoice(orgId, workspaceId);
        if (voice && this.speechProcessor) {
          catalogTranscriber = {
            engine: "openrouter",
            model: voice.model.model,
            transcribe: async (input, signal, options) => {
              try {
                await run(() => {});
                const result = await this.speechProcessor!.process(
                  input,
                  signal,
                  {
                    transcribe: (wav, language, audioSignal) =>
                      transcribeAudio(
                        this.catalog.transport,
                        voice,
                        wav,
                        language,
                        audioSignal,
                        async (start) =>
                          run(() => {
                            audioSignal.throwIfAborted();
                            const currentVoice =
                              this.catalog.store.resolveVoice(
                                orgId,
                                workspaceId,
                              );
                            if (
                              !currentVoice ||
                              currentVoice.model.id !== voice.model.id ||
                              currentVoice.model.revision !==
                                voice.model.revision ||
                              currentVoice.method !== voice.method ||
                              currentVoice.provider.id !== voice.provider.id ||
                              currentVoice.provider.revision !==
                                voice.provider.revision
                            )
                              throw new IdentityError(
                                409,
                                "meeting_model_changed",
                              );
                            this.catalog.store.useProvider(
                              orgId,
                              voice.provider.id,
                              voice.provider.revision,
                            );
                            start();
                          }),
                      ),
                  },
                  options?.priority,
                );
                await run(() => {});
                signal.throwIfAborted();
                return result;
              } catch (error) {
                if (signal.aborted)
                  throw new VoiceError("voice_cancelled", 503);
                logFailure("transcription", error);
                if (error instanceof VoiceError) throw error;
                throw new VoiceError(
                  error instanceof IdentityError &&
                  (error.code === "catalog_budget_exhausted" ||
                    error.code === "catalog_provider_limit")
                    ? "voice_model_limit"
                    : "voice_processing_failed",
                  503,
                );
              }
            },
          };
        }
      } catch {
        // An unavailable selection must not break authenticated snapshot reads.
      }
      let meetingTranscriber: MeetingChunkTranscriber | undefined;
      try {
        // The workspace's voice model when it is a speech-to-text model, else
        // the separate meeting transcription model; otherwise meetings fall
        // back to minute-by-minute recognition through the voice transcriber.
        const resolveStt = () => {
          const voice = this.catalog.store.resolveVoice(orgId, workspaceId);
          return voice?.method === "transcription"
            ? voice
            : this.catalog.store.resolveMeetingTranscription(
                orgId,
                workspaceId,
              );
        };
        const stt = resolveStt();
        if (stt)
          meetingTranscriber = {
            model: stt.model.model,
            transcribe: async (input, signal) => {
              try {
                await run(() => {});
                const result = await transcribeMeetingChunk(
                  this.catalog.transport,
                  stt,
                  { data: input.audio, format: input.format },
                  input.prompt,
                  signal,
                  async (start) =>
                    run(() => {
                      signal.throwIfAborted();
                      const current = resolveStt();
                      if (
                        !current ||
                        current.model.id !== stt.model.id ||
                        current.model.revision !== stt.model.revision ||
                        current.provider.id !== stt.provider.id ||
                        current.provider.revision !== stt.provider.revision
                      )
                        throw new IdentityError(409, "meeting_model_changed");
                      this.catalog.store.useProvider(
                        orgId,
                        stt.provider.id,
                        stt.provider.revision,
                      );
                      start();
                    }),
                );
                await run(() => {});
                signal.throwIfAborted();
                return result;
              } catch (error) {
                if (signal.aborted)
                  throw new VoiceError("voice_cancelled", 503);
                logFailure("meeting transcription", error);
                if (
                  error instanceof IdentityError &&
                  (error.code === "catalog_budget_exhausted" ||
                    error.code === "catalog_provider_limit")
                )
                  throw new VoiceError("voice_model_limit", 503);
                throw error;
              }
            },
          };
      } catch {
        // An unavailable selection must not break authenticated snapshot reads.
      }
      let synthesizer: SpeechSynthesizer | undefined;
      try {
        const speech = this.catalog.store.resolveSpeech(orgId, workspaceId);
        if (speech)
          synthesizer = {
            model: speech.model.model,
            synthesize: async (text, language, signal, beforeDispatch) => {
              try {
                await run(() => {});
                const result = await synthesizeSpeech(
                  this.catalog.transport,
                  speech,
                  text,
                  language,
                  signal,
                  (start) =>
                    beforeDispatch(() => {
                      signal.throwIfAborted();
                      // The HTTP guard runs in this same identity queue and checks the current message.
                      check();
                      this.catalog.store.useProvider(
                        orgId,
                        speech.provider.id,
                        speech.provider.revision,
                      );
                      start();
                    }),
                );
                await run(() => {});
                signal.throwIfAborted();
                return result;
              } catch (error) {
                logFailure("spoken reply", error);
                if (error instanceof SpeechError) throw error;
                throw new SpeechError(
                  error instanceof IdentityError &&
                  (error.code === "catalog_budget_exhausted" ||
                    error.code === "catalog_provider_limit")
                    ? "speech_model_limit"
                    : "speech_unavailable",
                  503,
                );
              }
            },
          };
      } catch {
        /* Missing/disabled speech must not break chat reads. */
      }
      const meetingModel = (
        signal: AbortSignal,
        runId: string,
        limits: ModelCallLimits = MODEL_CALL_LIMITS.chat,
      ) => {
        let dispatched = false;
        const model = createNiaroMastraModel(
          dynamicModel!,
          budgetedInferenceTransport(
            this.catalog.transport,
            this.catalog.store.inferenceBudget,
            runId,
            {
              organizationId: orgId,
              workspaceId,
              userId: initial.session.scope.userId,
            },
            dynamicModel!,
            "model",
            (fn) => this.serial(fn),
            async () => {
              check();
            },
            () => 0,
            {
              maxTokens: 1000000,
              maxCostMicros: 10000000,
              maxModelCalls: 128,
            },
          ),
          async (start) =>
            run(() => {
              signal.throwIfAborted();
              const current = this.catalog.store.resolveModel(
                orgId,
                workspaceId,
              );
              if (
                dispatched ||
                !current ||
                current.model.id !== dynamicModel!.model.id ||
                current.model.revision !== dynamicModel!.model.revision ||
                current.provider.id !== dynamicModel!.provider.id ||
                current.provider.revision !== dynamicModel!.provider.revision
              )
                throw new IdentityError(409, "meeting_model_changed");
              this.catalog.store.useProvider(
                orgId,
                dynamicModel!.provider.id,
                dynamicModel!.provider.revision,
              );
              dispatched = true;
              start();
            }),
          limits,
        );
        return model;
      };
      return {
        nativeRequests: this.nativeRequests,
        retireProcessRequest,
        cancelProcessRun,
        synthesizer,
        meetingTranscriber,
        timeZone: plugins.settings.timeZone,
        meetingAnalyzer: dynamicModel
          ? {
              model: dynamicModel.model.model,
              fingerprint: JSON.stringify([
                dynamicModel.model.id,
                dynamicModel.model.revision,
                dynamicModel.provider.id,
                dynamicModel.provider.revision,
              ]),
              consolidate: async (input, language, signal, runId) => {
                // One call writes the whole record; long meetings take minutes.
                const result = await consolidateMeeting(
                  meetingModel(signal, runId, MODEL_CALL_LIMITS.meeting),
                  input,
                  language,
                  signal,
                );
                await run(() => {});
                signal.throwIfAborted();
                return result;
              },
              name: async (summary, language, signal, runId) => {
                const title = await nameMeeting(
                  meetingModel(signal, runId),
                  summary,
                  language,
                  signal,
                );
                await run(() => {});
                signal.throwIfAborted();
                return title;
              },
            }
          : undefined,
        session: initial.session,
        integrations: createCatalogRuntime(
          this.catalog,
          this.catalog.transport,
          {
            humanTasks: {
              get: (id) =>
                this.meetings.humanTasks.get(initial.session.scope, id),
              open: (limit) =>
                this.meetings.humanTasks.open(initial.session.scope, limit),
              openCount: () =>
                this.meetings.humanTasks.openCount(initial.session.scope),
              findOpenDuplicate: (content) =>
                this.meetings.humanTasks.findOpenDuplicate(
                  initial.session.scope,
                  content,
                ),
              create: (id, content, origin) =>
                this.meetings.humanTasks.create(
                  initial.session.scope,
                  id,
                  content,
                  origin,
                ),
              close: (id, reason) =>
                this.meetings.humanTasks.close(
                  initial.session.scope,
                  id,
                  reason,
                ),
            },
            serial: (fn) => this.serial(fn),
            actor: async () => {
              const actor = check();
              return { userId: actor.session.scope.userId, role: actor.role };
            },
            ...(offersProcesses
              ? {
                  processOffers: () => {
                    const actor = check();
                    return this.processes
                      .executionInventory(
                        {
                          organizationId: orgId,
                          workspaceId,
                          userId: actor.session.scope.userId,
                          role: actor.role,
                        },
                        actor.session.scope,
                      )
                      .processes.flatMap((entry) =>
                        entry.availability === "ready" ? [entry] : [],
                      );
                  },
                  hub: (language: "en" | "cs") => {
                    const actor = check();
                    return this.hub.agent(
                      {
                        organizationId: orgId,
                        workspaceId,
                        userId: actor.session.scope.userId,
                        role: actor.role,
                      },
                      actor.session.scope,
                      language,
                    );
                  },
                  ...(this.processProposals
                    ? {
                        processProposals: {
                          propose: (context, input, signal) =>
                            this.processProposals!.propose(
                              context,
                              { organizationId: orgId, workspaceId },
                              input,
                              signal,
                            ),
                        },
                      }
                    : {}),
                }
              : {}),
            // The person's own meetings, read-only; the scope is re-checked per call.
            meetings: (() => {
              const access = () => {
                check();
                return meetingAgentAccess(
                  this.meetings,
                  initial.session.scope,
                  // Search days are the workspace's days.
                  this.plugins.read(workspaceId).settings.timeZone,
                );
              };
              return {
                describe: (id: string) => access().describe(id),
                search: (args: unknown) => access().search(args),
                read: (args: unknown) => access().read(args),
              };
            })(),
            skills: (() => {
              const skillActor = (): SkillActor => {
                const actor = check();
                return {
                  organizationId: orgId,
                  workspaceId,
                  userId: actor.session.scope.userId,
                  role: actor.role,
                };
              };
              return {
                list: () => this.skills.usable(skillActor()),
                load: (id: string) => this.skills.usableSkill(skillActor(), id),
                propose: (id, content) =>
                  this.skills.propose(skillActor(), id, content),
                workspaceAllowed: () => skillActor().role !== "member",
              };
            })(),
            epoch: (org) => this.connections.policyVersion(org),
            change: (org) => this.connections.changePolicy(org),
            audit: (record) => this.audit.append(record),
            finish: (id, outcome, details) =>
              this.audit.finish(id, outcome, details),
            transaction: (fn) => this.transaction(fn),
          },
          initial.session.scope,
          orgId,
          !!dynamicModel,
          !!services.model,
          plugins.settings,
          memoryRuntime,
          undefined,
          this.processStarts
            ? createProcessTaskProjection(
                this.catalog,
                this.processes,
                this.processStarts,
                {
                  serial: (fn) => this.serial(fn),
                  actor: async () => {
                    const current = check();
                    return {
                      userId: current.session.scope.userId,
                      role: current.role,
                    };
                  },
                  validateRequest: () => {
                    check();
                  },
                  epoch: (org) => this.connections.policyVersion(org),
                  change: (org) => this.connections.changePolicy(org),
                  audit: (record) => this.audit.append(record),
                  finish: (id, outcome, details) =>
                    this.audit.finish(id, outcome, details),
                  transaction: (fn) => this.transaction(fn),
                },
                initial.session.scope,
                orgId,
                memoryRuntime,
                () => this.memory.version(memoryActor),
                this.processQuestions,
              )
            : undefined,
        ),
        modelEnabled: !!services.model || !!dynamicModel,
        voiceEnabled:
          !!catalogTranscriber ||
          (this.catalog.store.routing(workspaceId).voiceMode === "legacy" &&
            !!services.transcriber),
        model: services.model
          ? {
              timeZone: services.model.timeZone,
              decide: async (input, signal) => {
                await validateAI("model");
                signal.throwIfAborted();
                const result = await services.model!.decide(input, signal);
                await validateAI("model");
                signal.throwIfAborted();
                return result;
              },
            }
          : dynamicModel
            ? {
                timeZone: "UTC",
                decide: async () => {
                  throw new ModelError("model_unavailable");
                },
              }
            : undefined,
        transcriber:
          catalogTranscriber ??
          (this.catalog.store.routing(workspaceId).voiceMode === "legacy" &&
          services.transcriber
            ? {
                engine: services.transcriber.engine,
                model: services.transcriber.model,
                available: () => !!this.ai.resolve(ai.selection).transcriber,
                transcribe: async (input, signal, options) => {
                  await validateAI("transcriber");
                  signal.throwIfAborted();
                  const result = await services.transcriber!.transcribe(
                    input,
                    signal,
                    options,
                  );
                  await validateAI("transcriber");
                  signal.throwIfAborted();
                  return result;
                },
              }
            : undefined),
        run,
        runModel: <T>(fn: () => T) =>
          run(() => {
            if (
              !dynamicModel &&
              (!services.model ||
                this.ai.resolve(ai.selection).model !== services.model)
            )
              throw new ModelError("model_unavailable");
            return fn();
          }),
        tools: {
          has: (name) =>
            !!row &&
            !!selected?.tools.some(
              (tool) => tool.id === name && tool.canInvoke,
            ),
          invoke: async (name, input, context) => {
            const toolId = ConnectionToolId.parse(name);
            const signal = AbortSignal.any([
              context.signal,
              AbortSignal.timeout(8000),
            ]);
            const validateInQueue = () => {
              const actor = check();
              if (
                !row ||
                !selected?.tools.some(
                  (tool) => tool.id === name && tool.canInvoke,
                )
              )
                throw new ToolError("tool_forbidden");
              this.connections.authorize(
                workspaceId,
                row.id,
                row.revision,
                name,
                actor.role,
              );
            };
            return this.auditedTool(
              {
                organizationId: orgId,
                workspaceId,
                actorId: initial.session.scope.userId,
                source: "chat",
                action: "tool.invoked",
                targetId: binding.connectionId,
                details: { toolId, ...(row ? { revision: row.revision } : {}) },
              },
              signal,
              async () => {
                const registry = await this.serial(async () => {
                  validateInQueue();
                  return this.connections.registry(row!);
                });
                return registry.invoke(name, input, {
                  ...context,
                  signal,
                  validateSession: async () => {
                    await context.validateSession();
                    await this.serial(async () => validateInQueue());
                  },
                });
              },
              validateInQueue,
            );
          },
        },
      };
    });
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.pending.then(fn);
    this.pending = result.catch(() => undefined);
    return result;
  }
  async close() {
    this.closing = true;
    await this.hubScheduler.stop();
    await this.mcpTaskRunner?.close();
    clearInterval(this.memoryMaintenance);
    clearInterval(this.meetingSweep);
    await this.meetingProcessor.close();
    await this.hosted?.close();
    for (const controller of this.executions) controller.abort();
    this.nativeRequests.abortAll();
    await Promise.allSettled(this.catalogRequests);
    await Promise.allSettled(
      Array.from(this.nativeRequests.values(), (entry) => entry.promise),
    );
    await this.pending;
    await closeNativeCatalogRuntime(this.catalog);
    await this.memory.close();
    this.audit.interrupt();
    this.db.close();
    this.release();
  }
  private async transaction<T>(fn: () => Promise<T>) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private headers(req: IncomingMessage) {
    // Never trust forwarded client IP/host headers on this direct loopback listener.
    return new Headers({
      cookie: req.headers.cookie ?? "",
      origin: this.baseURL,
      "content-type": "application/json",
      "x-agent-client-ip": clientAddress(req),
      // Lets the person tell their browser sessions apart in their account.
      "user-agent": String(req.headers["user-agent"] ?? "").slice(0, 300),
    });
  }
  private getSession(req: IncomingMessage) {
    return this.auth.api.getSession({
      headers: this.headers(req),
      query: { disableCookieCache: true },
    });
  }
  revokeSession(req: IncomingMessage) {
    return this.serial(async () => {
      const response = await this.auth.api.signOut({
        headers: this.headers(req),
        returnHeaders: true,
      });
      return response.headers.getSetCookie();
    });
  }
  canManageConsole(userId: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM member WHERE \"userId\"=? AND role IN ('owner','admin')",
      )
      .get(userId);
  }
  session(req: IncomingMessage) {
    return this.serial(() => this.getSession(req));
  }
  /** Sound of processed meetings is kept for a while, then swept daily. */
  private scheduleMeetingSweep() {
    if (this.meetingSweep) clearInterval(this.meetingSweep);
    this.meetingSweep = undefined;
    if (!(this.meetingRetentionDays > 0) || this.closing) return;
    const sweep = () =>
      this.serial(async () => {
        if (this.closing || !(this.meetingRetentionDays > 0)) return;
        const deleted = this.meetings.sweepAudio(this.meetingRetentionDays);
        if (deleted) operatorLog("meeting_audio_retention", { deleted });
      }).catch(() => {});
    this.meetingSweep = setInterval(sweep, 24 * 60 * 60 * 1000);
    this.meetingSweep.unref();
    setImmediate(sweep);
  }
  /** The server settings in force: saved in administration, else the profile's. */
  serverSettings(): ServerSettings | undefined {
    return this.serverSettingsStore?.read().settings;
  }
  /** Settings read at use take effect at once; origins wait for a restart. */
  private applyServerSettings(next: ServerSettings, previous: ServerSettings) {
    this.plugins.setDefaultTimeZone(next.timeZone);
    this.meetingProcessor.configure(next.meetings);
    if (next.meetings.audioRetentionDays !== this.meetingRetentionDays) {
      this.meetingRetentionDays = next.meetings.audioRetentionDays;
      this.scheduleMeetingSweep();
    }
    if (
      JSON.stringify(next.hubScheduler) !==
      JSON.stringify(previous.hubScheduler)
    )
      this.hubScheduler.configure(next.hubScheduler);
  }
  private serverSettingsView(organizationId: string) {
    const store = this.serverSettingsStore!;
    const current = store.read();
    return ServerSettingsViewSchema.parse({
      profile: SERVER_SETTINGS_PROFILE,
      organizationId,
      revision: current.revision,
      settings: current.settings,
      defaults: store.defaults,
      restartPending: store.restartPending(),
    });
  }
  private needsSetup() {
    return !this.db.prepare('SELECT id FROM "user" LIMIT 1').get();
  }
  /** No account exists yet: the owner is still to be created. */
  setupPending() {
    return this.needsSetup();
  }
  private async actor(req: IncomingMessage, orgId: string) {
    const session = await this.getSession(req);
    if (!session) throw new IdentityError(401, "identity_unauthorized");
    const member = this.db
      .prepare(
        'SELECT id, role FROM member WHERE "organizationId"=? AND "userId"=?',
      )
      .get(orgId, session.user.id);
    if (!member) throw new IdentityError(403, "identity_forbidden");
    return {
      id: String(member.id),
      role: OrganizationRole.parse(member.role),
      userId: session.user.id,
    };
  }
  private async state(
    req: IncomingMessage,
    operator: boolean,
    res?: ServerResponse,
  ) {
    // Reading who is signed in also extends a session older than a day; the
    // renewed cookie goes back so the browser keeps remembering the account.
    const current = operator
      ? null
      : await this.auth.api.getSession({
          headers: this.headers(req),
          query: { disableCookieCache: true },
          returnHeaders: true,
        });
    const session = current?.response ?? null;
    const cookies = current?.headers.getSetCookie() ?? [];
    if (res && session && cookies.length)
      res.setHeader("Set-Cookie", [
        ...[res.getHeader("Set-Cookie")]
          .flat()
          .filter((v): v is string => typeof v === "string"),
        ...cookies,
      ]);
    if (!operator && !session)
      throw new IdentityError(401, "identity_unauthorized");
    return IdentityStateSchema.parse({
      profile: "agent-identity/1",
      enabled: true,
      needsSetup: this.needsSetup(),
      user: session
        ? {
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
          }
        : null,
      organizations: session
        ? this.db
            .prepare(
              'SELECT o.id, o.name, m.role FROM organization o JOIN member m ON m."organizationId"=o.id WHERE m."userId"=? ORDER BY o.name',
            )
            .all(session.user.id)
        : [],
    });
  }
  private async detail(req: IncomingMessage, orgId: string) {
    const actor = await this.actor(req, orgId);
    const manager = actor.role === "owner" || actor.role === "admin";
    const members = this.db
      .prepare(
        'SELECT m.id, m."userId", u.name, u.email, m.role FROM member m JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=? ORDER BY u.name',
      )
      .all(orgId);
    const workspaces = this.db
      .prepare(
        `SELECT id, name FROM agent_workspace WHERE organization_id=? ${manager ? "" : "AND id IN (SELECT workspace_id FROM agent_workspace_member WHERE member_id=?)"} ORDER BY name`,
      )
      .all(...(manager ? [orgId] : [orgId, actor.id]));
    return OrganizationDetailSchema.parse({
      organizationId: orgId,
      canManageMembers: actor.role === "owner",
      canManageWorkspaces: manager,
      members: manager ? members : members.filter((m) => m.id === actor.id),
      workspaces: workspaces.map((w) => {
        const inventory = this.connections.list(
          orgId,
          String(w.id),
          actor.role,
        );
        return {
          ...w,
          roles: manager
            ? this.catalog.store.workspaceRoles.list(String(w.id))
            : [],
          connectionCount:
            inventory.connections.length +
            Number(
              !!this.calendars.list(orgId, String(w.id), actor.role).calendar,
            ),
          toolCount:
            Number(
              !!this.calendars.list(orgId, String(w.id), actor.role).calendar
                ?.canCreate,
            ) +
            inventory.connections.reduce(
              (count, connection) => count + connection.tools.length,
              0,
            ),
          members: manager
            ? this.db
                .prepare(
                  "SELECT member_id FROM agent_workspace_member WHERE workspace_id=? ORDER BY member_id",
                )
                .all(w.id!)
                .map((m) => m.member_id)
            : [actor.id],
        };
      }),
    });
  }
  /**
   * Creates the owner while no account exists: the first person to sign up
   * (or the recovery console) becomes the owner, with the organization and
   * a first workspace, and is signed in like any other account.
   */
  private async bootstrap(
    req: IncomingMessage,
    res: ServerResponse,
    input: unknown,
    operator: boolean,
  ) {
    const client = clientAddress(req);
    const now = Date.now();
    for (const [id, item] of this.bootstrapAttempts)
      if (item.until <= now) this.bootstrapAttempts.delete(id);
    const attempt = this.bootstrapAttempts.get(client) ?? {
      count: 0,
      until: now + 60_000,
    };
    this.bootstrapAttempts.set(client, attempt);
    if (++attempt.count > 10 || this.bootstrapAttempts.size > 1000) {
      res.setHeader("Retry-After", "60");
      throw new IdentityError(429, "identity_rate_limited");
    }
    const value = BootstrapIdentitySchema.parse(input);
    if (!this.needsSetup())
      throw new IdentityError(409, "identity_already_initialized");
    const source = operator ? "recovery" : "console";
    await this.transaction(async () => {
      const created = await this.auth.api.signUpEmail({
        body: {
          name: value.name,
          email: value.email,
          password: value.password,
        },
      });
      const org = await this.auth.api.createOrganization({
        body: {
          name: value.organizationName,
          slug: `org-${randomUUID()}`,
          userId: created.user.id,
        },
      });
      if (!org) throw new IdentityError(503, "identity_unavailable");
      const actorId = operator ? null : created.user.id;
      this.audit.append({
        organizationId: org.id,
        workspaceId: null,
        actorId,
        source,
        action: "organization.created",
        targetId: org.id,
        outcome: "succeeded",
        details: {},
      });
      // A first workspace, named like the organization, so the owner can use
      // the app at once (owners reach every workspace of their organization).
      const workspaceId = randomUUID();
      this.db
        .prepare("INSERT INTO agent_workspace VALUES (?, ?, ?)")
        .run(workspaceId, org.id, value.organizationName);
      this.audit.append({
        organizationId: org.id,
        workspaceId,
        actorId,
        source,
        action: "workspace.created",
        targetId: workspaceId,
        outcome: "succeeded",
        details: {},
      });
    });
    // The new owner lands signed in, through Better Auth like every sign-in.
    const signedIn = await this.auth.api.signInEmail({
      body: { email: value.email, password: value.password },
      headers: this.headers(req),
      returnHeaders: true,
    });
    const cookies = signedIn.headers.getSetCookie();
    if (cookies.length)
      res.setHeader("Set-Cookie", [
        ...[res.getHeader("Set-Cookie")]
          .flat()
          .filter((v): v is string => typeof v === "string"),
        ...cookies,
      ]);
    return { ok: true };
  }
  private async command(req: IncomingMessage, input: unknown) {
    const value = IdentityCommandSchema.parse(input);
    const actor = await this.actor(req, value.organizationId);
    const workspaceAction =
      value.type === "createWorkspace" ||
      value.type === "setWorkspaceMember" ||
      value.type === "saveWorkspaceRole" ||
      value.type === "removeWorkspaceRole";
    if (
      workspaceAction
        ? !["owner", "admin"].includes(actor.role)
        : actor.role !== "owner"
    )
      throw new IdentityError(403, "identity_forbidden");
    if (
      value.type === "createAccount" ||
      (value.type === "setWorkspaceMember" && value.allowed)
    )
      throw new IdentityError(410, "invitation_required");
    await this.transaction(async () => {
      const event: AuditRecord = {
        organizationId: value.organizationId,
        workspaceId: "workspaceId" in value ? value.workspaceId : null,
        actorId: actor.userId,
        source: "console",
        action: "account.created",
        targetId: null,
        outcome: "succeeded",
        details: {},
      };
      if (value.type === "createWorkspace") {
        const count = this.db
          .prepare(
            "SELECT count(*) AS count FROM agent_workspace WHERE organization_id=?",
          )
          .get(value.organizationId)!;
        if (Number(count.count) >= 100)
          throw new IdentityError(409, "identity_limit");
        if (
          this.db
            .prepare(
              "SELECT id FROM agent_workspace WHERE organization_id=? AND name=?",
            )
            .get(value.organizationId, value.name)
        )
          throw new IdentityError(409, "identity_workspace_exists");
        const workspaceId = randomUUID();
        this.db
          .prepare("INSERT INTO agent_workspace VALUES (?, ?, ?)")
          .run(workspaceId, value.organizationId, value.name);
        event.action = "workspace.created";
        event.targetId = event.workspaceId = workspaceId;
      } else if (
        value.type === "saveWorkspaceRole" ||
        value.type === "removeWorkspaceRole"
      ) {
        await this.workspaceActor(req, value);
        if (value.type === "saveWorkspaceRole")
          event.targetId = this.catalog.store.workspaceRoles.save(
            value.workspaceId,
            value,
          );
        else {
          this.catalog.store.workspaceRoles.remove(
            value.workspaceId,
            value.id,
            value.revision,
          );
          event.targetId = value.id;
        }
        event.action = "workspace.role_changed";
      } else {
        const target = this.db
          .prepare(
            'SELECT id, role FROM member WHERE id=? AND "organizationId"=?',
          )
          .get(value.memberId, value.organizationId);
        if (!target) throw new IdentityError(404, "identity_not_found");
        event.targetId = value.memberId;
        if (value.type === "setWorkspaceMember") {
          event.action = "workspace.member_changed";
          event.details = { allowed: value.allowed };
          if (
            !this.db
              .prepare(
                "SELECT id FROM agent_workspace WHERE id=? AND organization_id=?",
              )
              .get(value.workspaceId, value.organizationId)
          )
            throw new IdentityError(404, "identity_not_found");
          if (value.allowed)
            this.db
              .prepare(
                "INSERT OR IGNORE INTO agent_workspace_member VALUES (?, ?)",
              )
              .run(value.workspaceId, value.memberId);
          else
            this.db
              .prepare(
                "DELETE FROM agent_workspace_member WHERE workspace_id=? AND member_id=?",
              )
              .run(value.workspaceId, value.memberId);
          if (!value.allowed) {
            this.catalog.store.workspaceRoles.revokeMember(
              value.workspaceId,
              value.memberId,
            );
            this.mobile.revokeMember(value.memberId, value.workspaceId);
          }
        } else {
          event.action =
            value.type === "changeRole"
              ? "member.role_changed"
              : "member.removed";
          event.details = {
            previousRole: OrganizationRole.parse(target.role),
            ...(value.type === "changeRole" ? { role: value.role } : {}),
          };
          if (
            target.role === "owner" &&
            (value.type === "removeMember" || value.role !== "owner")
          ) {
            const owners = this.db
              .prepare(
                "SELECT count(*) AS count FROM member WHERE \"organizationId\"=? AND role='owner'",
              )
              .get(value.organizationId)!;
            if (Number(owners.count) <= 1)
              throw new IdentityError(409, "identity_last_owner");
          }
          const headers = this.headers(req);
          if (value.type === "changeRole")
            await this.auth.api.updateMemberRole({
              headers,
              body: {
                organizationId: value.organizationId,
                memberId: value.memberId,
                role: value.role,
              },
            });
          else
            await this.auth.api.removeMember({
              headers,
              body: {
                organizationId: value.organizationId,
                memberIdOrEmail: value.memberId,
              },
            });
          this.mobile.revokeMember(value.memberId);
        }
      }
      // A new workspace removes nobody's authority. Role changes (roles are not
      // ranked: an action may be granted to one role only), removals and
      // workspace role edits can, so they still retire running work.
      if (value.type !== "createWorkspace")
        this.connections.changePolicy(value.organizationId);
      this.audit.append(event);
    });
    return { ok: true };
  }
  private async workspaceActor(
    req: IncomingMessage,
    target: z.infer<typeof WorkspaceTarget>,
  ) {
    const actor = await this.actor(req, target.organizationId);
    const workspace = this.db
      .prepare(
        "SELECT id FROM agent_workspace WHERE id=? AND organization_id=?",
      )
      .get(target.workspaceId, target.organizationId);
    if (!workspace) throw new IdentityError(404, "identity_not_found");
    if (
      actor.role === "member" &&
      !this.db
        .prepare(
          "SELECT 1 FROM agent_workspace_member WHERE workspace_id=? AND member_id=?",
        )
        .get(target.workspaceId, actor.id)
    )
      throw new IdentityError(403, "identity_forbidden");
    return actor;
  }
  private async invoke(
    req: IncomingMessage,
    res: ServerResponse,
    raw: unknown,
  ) {
    const input = ConnectionInvokeSchema.parse(raw);
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.once("close", onClose);
    let userId: string | undefined;
    try {
      const prepared = await this.serial(async () => {
        if (this.closing) throw new IdentityError(503, "identity_unavailable");
        const actor = await this.workspaceActor(req, input);
        // Only known records in an accessible workspace can create a scoped audit attempt.
        const row = this.connections.row(input.workspaceId, input.connectionId);
        if (this.executions.size >= 8 || this.executingUsers.has(actor.userId))
          throw new IdentityError(429, "connection_busy");
        userId = actor.userId;
        this.executingUsers.add(userId);
        this.executions.add(controller);
        return {
          actor,
          row,
          version: this.connections.policyVersion(input.organizationId),
        };
      });
      const validateInQueue = async () => {
        if (this.closing) throw new IdentityError(503, "identity_unavailable");
        const actor = await this.workspaceActor(req, input);
        if (
          actor.userId !== prepared.actor.userId ||
          prepared.version !==
            this.connections.policyVersion(input.organizationId)
        )
          throw new IdentityError(403, "identity_forbidden");
        return this.connections.authorize(
          input.workspaceId,
          input.connectionId,
          input.revision,
          input.toolId,
          actor.role,
        );
      };
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(8000),
      ]);
      // Provider I/O stays outside the queue; the durable start precedes dispatch.
      return await this.auditedTool(
        {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          actorId: prepared.actor.userId,
          source: "console",
          action: "tool.invoked",
          targetId: input.connectionId,
          details: { toolId: input.toolId, revision: input.revision },
        },
        signal,
        async () => {
          const registry = await this.serial(async () => {
            const authorized = await validateInQueue();
            return this.connections.registry(authorized);
          });
          return registry.invoke(input.toolId, input.input, {
            scope: {
              connectionId: input.connectionId,
              serverId: "identity",
              userId: prepared.actor.userId,
              workspaceId: input.workspaceId,
            },
            permissions: new Set(["contacts.read.test"]),
            signal,
            validateSession: () =>
              this.serial(async () => {
                await validateInQueue();
              }),
          });
        },
        async () => {
          await validateInQueue();
        },
      );
    } finally {
      res.off("close", onClose);
      this.executions.delete(controller);
      if (userId) this.executingUsers.delete(userId);
    }
  }
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    isOperator: () => boolean,
    /** Ends the recovery-key session once the owner is signed in instead. */
    endRecovery?: () => void,
  ): Promise<boolean> {
    const url = new URL(req.url!, this.baseURL);
    const respond = (status: number, data: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
      return true;
    };
    let payload: unknown;
    try {
      payload = req.method === "POST" ? await body(req) : undefined;
    } catch (error) {
      return respond(error instanceof IdentityError ? error.status : 400, {
        error: "identity_invalid_input",
      });
    }
    if (url.pathname.startsWith("/admin/api/identity/mcp/task/")) {
      try {
        if (req.method !== "POST")
          return respond(405, { error: "method_not_allowed" });
        if (isOperator())
          throw new IdentityError(403, "identity_account_required");
        if (!this.mcpTaskRunner || !this.workflowServerId)
          throw new IdentityError(503, "mcp_unavailable");
        const input = z
          .strictObject({
            workspaceId: IdentityId,
            taskId: IdentityId,
            requestId: IdentityId.optional(),
            input: z
              .strictObject({
                operationId: IdentityId,
                expectedRevision: z
                  .number()
                  .int()
                  .positive()
                  .max(Number.MAX_SAFE_INTEGER),
              })
              .optional(),
            approved: z.boolean().optional(),
          })
          .parse(payload);
        const principal = await this.serial(async () => {
          const session = await this.getSession(req);
          if (!session) throw new IdentityError(401, "identity_unauthorized");
          return this.browserRuntimeActor(
            session.session.id,
            input.workspaceId,
            this.workflowServerId!,
          ).principal;
        });
        const access = await this.browserRuntimeAccess(
          principal.grantId,
          input.workspaceId,
          principal.serverId,
          principal.memberId,
        );
        const action = url.pathname.split("/").at(-1);
        if (
          action === "get" &&
          input.requestId === undefined &&
          input.input === undefined &&
          input.approved === undefined
        )
          return respond(
            200,
            await this.mcpTaskRunner.humanGet(principal, access, input.taskId),
          );
        if (
          action === "decide" &&
          input.requestId &&
          input.input &&
          input.approved !== undefined
        )
          return respond(
            202,
            await this.mcpTaskRunner.humanDecide(principal, access, {
              taskId: input.taskId,
              requestId: input.requestId,
              input: input.input,
              approved: input.approved,
            }),
          );
        throw new IdentityError(400, "identity_invalid_input");
      } catch (error) {
        if (error instanceof IdentityError)
          return respond(error.status, { error: error.code });
        if (error instanceof ModelError)
          return respond(503, { error: error.code });
        return respond(400, { error: "identity_invalid_input" });
      }
    }
    if (url.pathname.startsWith("/admin/api/identity/catalog")) {
      if (this.closing) return respond(503, { error: "identity_unavailable" });
      const controller = new AbortController();
      this.executions.add(controller);
      let completed!: () => void;
      const completion = new Promise<void>((resolve) => {
        completed = resolve;
      });
      this.catalogRequests.add(completion);
      const close = () => controller.abort();
      res.once("close", close);
      if (res.destroyed || res.writableEnded) close();
      const design = isProcessDesignPath(url.pathname);
      const nativeTest = isProcessNativeTestPath(url.pathname);
      const activation = isProcessActivationPath(url.pathname);
      const versions = isProcessVersionsPath(url.pathname);
      const pinnedAccount = design || nativeTest || activation || versions;
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(
          // A designer turn with a reasoning model can take several calls of
          // a minute or more; ending it early leaves a call of unknown cost.
          design
            ? 300_000
            : pinnedAccount ||
                url.pathname === "/admin/api/identity/catalog/discover"
              ? 120000
              : 45000,
        ),
      ]);
      try {
        if (isOperator())
          throw new IdentityError(403, "identity_account_required");
        // Keep the original request/account binding private and immutable during
        // inference. Reauthentication may revoke it, never select another creator.
        const fingerprint = () =>
          JSON.stringify({
            method: req.method,
            url: req.url,
            cookie: req.headers.cookie,
            authorization: req.headers.authorization,
            host: req.headers.host,
            origin: req.headers.origin,
            marker: req.headers["x-agent-admin"],
            fetchSite: req.headers["sec-fetch-site"],
            contentType: req.headers["content-type"],
          });
        const original = fingerprint();
        const initial = pinnedAccount
          ? await this.serial(async () => {
              const session = await this.getSession(req);
              if (!session)
                throw new IdentityError(401, "identity_unauthorized");
              return { userId: session.user.id, sessionId: session.session.id };
            })
          : undefined;
        const validatePinnedRequest = () => {
          if (this.closing)
            throw new IdentityError(503, "identity_unavailable");
          signal.throwIfAborted();
          if (fingerprint() !== original || isOperator())
            throw new IdentityError(403, "identity_forbidden");
        };
        const context: CatalogContext = {
          serial: (run) => this.serial(run),
          actor: async (target) => {
            if (initial) {
              validatePinnedRequest();
              const session = await this.getSession(req);
              if (
                !session ||
                session.user.id !== initial.userId ||
                session.session.id !== initial.sessionId
              )
                throw new IdentityError(401, "identity_unauthorized");
            }
            const actor = await this.workspaceActor(req, target);
            if (initial) validatePinnedRequest();
            return actor;
          },
          ...(pinnedAccount ? { validateRequest: validatePinnedRequest } : {}),
          session: async () => {
            const session = await this.getSession(req);
            if (!session) throw new IdentityError(401, "identity_unauthorized");
            return { userId: session.user.id, sessionId: session.session.id };
          },
          epoch: (org) => this.connections.policyVersion(org),
          change: (org) => this.connections.changePolicy(org),
          audit: (record) => this.audit.append(record),
          finish: (id, outcome, details) =>
            this.audit.finish(id, outcome, details),
          transaction: (run) => this.transaction(run),
        };
        const result = design
          ? await handleProcessDesign(
              req.method ?? "GET",
              url,
              payload,
              {
                proposals: this.processDesigns,
                conversation: this.processDesignConversation,
                registry: this.processes,
                catalog: this.catalog.store,
                plugins: this.plugins,
              },
              context,
              signal,
            )
          : nativeTest
            ? await handleProcessNativeTest(
                req.method ?? "GET",
                url,
                payload,
                this.processNativeTesting,
                context,
                signal,
              )
            : activation
              ? await handleProcessActivation(
                  req.method ?? "GET",
                  url,
                  payload,
                  this.processActivation,
                  context,
                )
              : versions
                ? await handleProcessVersions(
                    req.method ?? "GET",
                    url,
                    payload,
                    this.processVersions,
                    context,
                  )
                : url.pathname.startsWith(
                      "/admin/api/identity/catalog/processes",
                    )
                  ? await handleServiceProcesses(
                      req.method ?? "GET",
                      url,
                      payload,
                      this.processes,
                      context,
                    )
                  : await this.catalog.handle(
                      req.method ?? "GET",
                      url,
                      payload,
                      context,
                      signal,
                    );
        if (res.destroyed || res.writableEnded) return true;
        return respond(200, result);
      } catch (error) {
        if (res.destroyed || res.writableEnded) return true;
        if (nativeTest && signal.aborted && !this.closing)
          return respond(signal.reason?.name === "TimeoutError" ? 504 : 409, {
            error:
              signal.reason?.name === "TimeoutError"
                ? "process_test_timeout"
                : "process_test_aborted",
          });
        if (error instanceof IdentityError || error instanceof IntegrationError)
          return respond(error.status, { error: error.code });
        if (error instanceof z.ZodError)
          return respond(400, { error: "identity_invalid_input" });
        return respond(502, { error: "integration_unavailable" });
      } finally {
        res.off("close", close);
        this.executions.delete(controller);
        this.catalogRequests.delete(completion);
        completed();
      }
    }
    if (
      url.pathname === "/admin/api/service-connect" &&
      req.method === "POST"
    ) {
      if (this.closing) return respond(503, { error: "identity_unavailable" });
      const controller = new AbortController(),
        close = () => controller.abort();
      let completed!: () => void;
      const completion = new Promise<void>((resolve) => {
        completed = resolve;
      });
      this.catalogRequests.add(completion);
      res.once("close", close);
      this.executions.add(controller);
      try {
        return respond(
          200,
          payload && typeof payload === "object" && "action" in payload
            ? await this.serial(() =>
                this.inspectMobileService(req, res, payload),
              )
            : await this.completeMobileServiceConnection(
                req,
                payload,
                AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(30000),
                ]),
              ),
        );
      } catch (error) {
        return respond(
          error instanceof IdentityError || error instanceof IntegrationError
            ? error.status
            : 400,
          {
            error:
              error instanceof IdentityError ||
              error instanceof IntegrationError
                ? error.code
                : "identity_invalid_input",
          },
        );
      } finally {
        res.off("close", close);
        this.executions.delete(controller);
        this.catalogRequests.delete(completion);
        completed();
      }
    }
    // Dispatch is intentionally outside serial(): neither uploads nor a remote CRM
    // may prevent another request from revoking a session or changing a role.
    if (
      req.method === "POST" &&
      url.pathname === "/admin/api/identity/connections/invoke"
    ) {
      try {
        if (isOperator())
          throw new IdentityError(403, "identity_account_required");
        return respond(200, await this.invoke(req, res, payload));
      } catch (error) {
        if (error instanceof IdentityError)
          return respond(error.status, { error: error.code });
        if (error instanceof z.ZodError)
          return respond(400, { error: "identity_invalid_input" });
        if (error instanceof ToolError)
          return respond(error.code === "tool_invalid_input" ? 400 : 502, {
            error: error.code,
          });
        return respond(502, { error: "tool_failed" });
      }
    }
    // Skills for the editors: the person's own and, for administrators, the company's.
    if (url.pathname.startsWith("/admin/api/identity/skills/")) {
      try {
        if (req.method !== "POST")
          return respond(405, { error: "method_not_allowed" });
        if (isOperator())
          throw new IdentityError(403, "identity_account_required");
        const route = url.pathname.slice("/admin/api/identity/skills/".length);
        if (!["list", "get", "command"].includes(route))
          return respond(404, { error: "not_found" });
        const input = z
          .looseObject({
            organizationId: IdentityId,
            workspaceId: IdentityId,
          })
          .parse(payload);
        return await this.serial(async () => {
          if (this.closing)
            throw new IdentityError(503, "identity_unavailable");
          const member = await this.workspaceActor(req, input);
          const actor: SkillActor = {
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            userId: member.userId,
            role: member.role,
          };
          if (route === "list") return respond(200, this.skills.list(actor));
          if (route === "get")
            return respond(
              200,
              this.skills.get(
                actor,
                z.strictObject({ id: IdentityId }).parse({ id: input.id }).id,
              ),
            );
          const {
            organizationId: _organization,
            workspaceId: _workspace,
            ...command
          } = input;
          return respond(200, this.skills.command(actor, command));
        });
      } catch (error) {
        if (error instanceof IdentityError)
          return respond(error.status, { error: error.code });
        if (error instanceof z.ZodError)
          return respond(400, { error: "identity_invalid_input" });
        return respond(500, { error: "skill_unavailable" });
      }
    }
    // Native payload I/O must allow independent identity revocation to run.
    try {
      if (url.pathname === "/admin/api/identity/memory" && isOperator())
        throw new IdentityError(403, "identity_account_required");
      if (url.pathname === "/admin/api/identity/memory") {
        if (req.method !== "GET" && req.method !== "POST")
          return respond(405, { error: "method_not_allowed" });
        const command =
          req.method === "POST" ? MemoryCommandSchema.parse(payload) : null;
        const target =
          command ??
          WorkspaceTarget.parse(Object.fromEntries(url.searchParams));
        const prepared = await this.serial(async () => ({
          actor: await this.workspaceActor(req, target),
          revision: this.plugins.read(target.workspaceId).revision,
          policy: this.connections.policyVersion(target.organizationId),
        }));
        const actor = prepared.actor;
        const check = () => {
          if (
            this.closing ||
            this.plugins.read(target.workspaceId).revision !==
              prepared.revision ||
            this.connections.policyVersion(target.organizationId) !==
              prepared.policy
          )
            throw new IdentityError(409, "memory_context_changed");
          const member = this.db
            .prepare(
              'SELECT role FROM member WHERE id=? AND "userId"=? AND "organizationId"=?',
            )
            .get(actor.id, actor.userId, target.organizationId);
          if (
            !member ||
            member.role !== actor.role ||
            (actor.role === "member" &&
              !this.db
                .prepare(
                  "SELECT 1 FROM agent_workspace_member WHERE workspace_id=? AND member_id=?",
                )
                .get(target.workspaceId, actor.id))
          )
            throw new IdentityError(403, "identity_forbidden");
        };
        const commit = {
          check,
          run: <T>(fn: () => T) =>
            this.serial(async () => {
              check();
              return fn();
            }),
        };
        const memoryActor: MemoryActor = {
          organizationId: target.organizationId,
          workspaceId: target.workspaceId,
          userId: actor.userId,
          canManageShared: actor.role !== "member",
        };
        const config = this.plugins.read(target.workspaceId).settings;
        const enabled = config.enabled.includes("memory");
        const settings = MemorySettingsSchema.parse(config.memory ?? {});
        if (command) {
          if (
            !enabled &&
            (command.type === "remember" || command.type === "revise")
          )
            throw new IdentityError(403, "plugin_unavailable");
          {
            const source = { type: "user_note" as const };
            if (command.type === "remember")
              await this.memory.remember(
                memoryActor,
                {
                  requestId: command.requestId,
                  content: command.content,
                  kind: command.kind,
                  scope: command.scope,
                  source,
                  explicitIntent: true,
                  settings,
                },
                commit,
              );
            else if (command.type === "revise")
              await this.memory.revise(
                memoryActor,
                {
                  requestId: command.requestId,
                  id: command.id,
                  revision: command.revision,
                  content: command.content,
                  source,
                  explicitIntent: true,
                  settings,
                },
                undefined,
                undefined,
                commit,
              );
            else if (command.type === "forget")
              await this.memory.forget(
                memoryActor,
                {
                  requestId: command.requestId,
                  id: command.id,
                  revision: command.revision,
                },
                commit,
              );
            else
              await commit.run(() =>
                this.memory.setOptOut(memoryActor, {
                  requestId: command.requestId,
                  optOut: command.optOut,
                }),
              );
          }
        }
        const viewVersion = await commit.run(() =>
          this.memory.version(memoryActor),
        );
        const items = await this.memory.list(memoryActor, {
          run: commit.run,
          settings,
          sourceAccess: (source, a) =>
            this.memorySourceAccess(source, a, actor.role),
        });
        return commit.run(() => {
          if (this.memory.version(memoryActor) !== viewVersion)
            throw new IdentityError(409, "memory_context_changed");
          return respond(
            200,
            MemoryViewSchema.parse({
              profile: "agent-memory/1",
              organizationId: target.organizationId,
              workspaceId: target.workspaceId,
              version: this.memory.version(memoryActor),
              enabled,
              canManageShared: memoryActor.canManageShared,
              ...this.memory.readPreferences(memoryActor),
              items,
            }),
          );
        });
      }
    } catch (error) {
      if (error instanceof IdentityError)
        return respond(error.status, { error: error.code });
      if (error instanceof z.ZodError)
        return respond(400, { error: "identity_invalid_input" });
      return respond(500, { error: "memory_unavailable" });
    }
    return this.serial(async () => {
      const operator = isOperator();
      try {
        // The person's own password and sign-ins, and admin-issued reset links.
        if (
          req.method === "POST" &&
          url.pathname === "/admin/api/identity/account/reset"
        ) {
          const input = z
            .strictObject({
              token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
              password: z.string().min(12).max(128).optional(),
            })
            .parse(payload);
          const client = clientAddress(req);
          if (!input.password)
            return respond(
              200,
              this.accountSecurity.inspectReset(input.token, client),
            );
          return respond(
            200,
            await this.transaction(() =>
              this.accountSecurity.useReset(
                input.token,
                input.password!,
                client,
              ),
            ),
          );
        }
        if (
          req.method === "POST" &&
          url.pathname === "/admin/api/identity/password-reset"
        ) {
          const input = z
            .strictObject({ organizationId: IdentityId, memberId: IdentityId })
            .parse(payload);
          const actor = await this.actor(req, input.organizationId);
          return respond(
            200,
            await this.accountSecurity.issueReset(
              actor.userId,
              input.organizationId,
              input.memberId,
              this.baseURL,
            ),
          );
        }
        if (
          req.method === "POST" &&
          url.pathname.startsWith("/admin/api/identity/account/")
        ) {
          const session = await this.getSession(req);
          if (!session) throw new IdentityError(401, "identity_unauthorized");
          const userId = session.user.id,
            sessionId = session.session.id;
          if (url.pathname === "/admin/api/identity/account/password") {
            const input = z
              .strictObject({
                currentPassword: z.string().min(1).max(128),
                newPassword: z.string().min(12).max(128),
              })
              .parse(payload);
            await this.transaction(() =>
              this.accountSecurity.changePassword(
                userId,
                sessionId,
                input.currentPassword,
                input.newPassword,
              ),
            );
            return respond(200, { ok: true });
          }
          if (url.pathname === "/admin/api/identity/account/access") {
            const input = z
              .discriminatedUnion("action", [
                z.strictObject({ action: z.literal("list") }),
                z.strictObject({
                  action: z.literal("revoke"),
                  id: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
                }),
                z.strictObject({ action: z.literal("revokeAll") }),
                z.strictObject({ action: z.literal("revokeOthers") }),
              ])
              .parse(payload);
            if (input.action === "revoke")
              this.accountSecurity.revoke(userId, input.id);
            if (input.action === "revokeOthers")
              this.accountSecurity.revokeOtherBrowsers(userId, sessionId);
            if (input.action === "revokeAll") {
              const signedOut = await this.auth.api.signOut({
                headers: this.headers(req),
                returnHeaders: true,
              });
              res.setHeader("Set-Cookie", signedOut.headers.getSetCookie());
              this.accountSecurity.revokeEverything(userId);
              return respond(200, { ok: true });
            }
            return respond(200, this.accountSecurity.access(userId, sessionId));
          }
          return respond(404, { error: "not_found" });
        }
        // The web app signs in to chat with the browser session it already has.
        if (
          req.method === "POST" &&
          url.pathname === "/admin/api/identity/app/session"
        ) {
          const input = WorkspaceTarget.parse(payload);
          const session = await this.getSession(req);
          if (!session || !this.workflowServerId)
            throw new IdentityError(401, "identity_unauthorized");
          const actor = await this.workspaceActor(req, input);
          const credential = this.mobile.issueWebSession(
            {
              session_id: session.session.id,
              member_id: actor.id,
              organization_id: input.organizationId,
              workspace_id: input.workspaceId,
              user_id: actor.userId,
              server_id: this.workflowServerId,
            },
            session.session.expiresAt,
          );
          return respond(200, {
            address: `${this.baseURL}/v1/${input.workspaceId}`,
            credential,
          });
        }
        if (
          req.method === "POST" &&
          url.pathname === "/admin/api/identity/app/consent"
        ) {
          const input = z
            .strictObject({
              id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
              organizationId: IdentityId,
              workspaceId: IdentityId,
            })
            .parse(payload);
          const session = await this.getSession(req);
          if (!session || !this.workflowServerId)
            throw new IdentityError(401, "identity_unauthorized");
          const actor = await this.workspaceActor(req, input);
          // Say so here, in the browser, where the person can remove a device.
          if (!this.mobile.availableSlots(actor.userId))
            throw new IdentityError(409, "mobile_device_limit");
          return respond(
            200,
            this.appLogins.consent(
              input.id,
              {
                member_id: actor.id,
                user_id: actor.userId,
                organization_id: input.organizationId,
                workspace_id: input.workspaceId,
                server_id: this.workflowServerId,
              },
              session.session.id,
            ),
          );
        }
        if (
          req.method === "POST" &&
          url.pathname === "/admin/api/identity/invitation"
        ) {
          const input = z
            .strictObject({
              token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
              accept: z.boolean().optional(),
              name: z.string().trim().min(1).max(100).optional(),
              password: z.string().min(12).max(128).optional(),
            })
            .parse(payload);
          const invite = this.invitations.inspect(input.token);
          const existing = this.db
            .prepare('SELECT id FROM "user" WHERE email=?')
            .get(invite.email);
          const session = await this.getSession(req);
          // A copied link may pass through other hands, and nobody proved
          // they read that mailbox: it neither says whether the address has
          // an account here (unless that account is signed in) nor verifies it.
          const emailed = (invite.delivery ?? "email") === "email";
          const matching = session?.user.email.toLowerCase() === invite.email;
          if (!input.accept)
            return respond(200, {
              email: invite.email,
              workspace: invite.name,
              ...(emailed || matching ? { existing: !!existing } : {}),
              organizationId: invite.organization_id,
              matching,
            });
          await this.transaction(async () => {
            let userId: string;
            if (existing) {
              if (!session)
                throw new IdentityError(403, "invitation_sign_in_required");
              if (session.user.id !== existing.id)
                throw new IdentityError(403, "invitation_account_mismatch");
              userId = session.user.id;
            } else {
              if (!input.name || !input.password)
                throw new IdentityError(400, "identity_invalid_input");
              const created = await this.auth.api.signUpEmail({
                body: {
                  email: invite.email,
                  name: input.name,
                  password: input.password,
                },
              });
              userId = created.user.id;
              // Only a link that went to the mailbox proves the address.
              if (emailed)
                this.db
                  .prepare('UPDATE "user" SET "emailVerified"=1 WHERE id=?')
                  .run(userId);
            }
            let member = this.db
              .prepare(
                'SELECT id FROM member WHERE "userId"=? AND "organizationId"=?',
              )
              .get(userId, invite.organization_id);
            if (!member) {
              await this.auth.api.addMember({
                body: {
                  userId,
                  organizationId: invite.organization_id,
                  role: "member",
                },
              });
              member = this.db
                .prepare(
                  'SELECT id FROM member WHERE "userId"=? AND "organizationId"=?',
                )
                .get(userId, invite.organization_id)!;
            }
            this.db
              .prepare(
                "INSERT OR IGNORE INTO agent_workspace_member(workspace_id,member_id) VALUES (?,?)",
              )
              .run(invite.workspace_id, member.id!);
            this.invitations.accept(invite.id);
            // Joining only adds a member (role "member") or workspace access; it
            // takes nobody's authority away, so running work keeps its epoch.
            this.audit.append({
              organizationId: invite.organization_id,
              workspaceId: invite.workspace_id,
              actorId: userId,
              source: "console",
              action: "workspace.member_changed",
              targetId: userId,
              outcome: "succeeded",
              details: {},
            });
          });
          return respond(200, { ok: true });
        }
        if (
          req.method === "POST" &&
          url.pathname === "/admin/api/identity/invitations"
        ) {
          const input = z
            .strictObject({
              organizationId: IdentityId,
              workspaceId: IdentityId,
              action: z.enum(["list", "send", "revoke"]),
              email: z
                .email()
                .max(254)
                .transform((v) => v.toLowerCase())
                .optional(),
              id: IdentityId.optional(),
            })
            .parse(payload);
          const actor = await this.workspaceActor(req, input);
          if (actor.role === "member")
            throw new IdentityError(403, "identity_forbidden");
          if (input.action === "list")
            return respond(200, {
              invitations: this.invitations.list(input.workspaceId),
              mail: this.invitations.mailConfigured,
            });
          const record = (action: AuditRecord["action"], targetId: string) =>
            this.audit.append({
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              actorId: actor.userId,
              source: "console",
              action,
              targetId,
              outcome: "succeeded",
              details: {},
            });
          if (input.action === "revoke" && input.id) {
            if (this.invitations.revoke(input.workspaceId, input.id))
              record("invitation.revoked", input.id);
            return respond(200, { ok: true });
          }
          if (input.action !== "send" || !input.email)
            throw new IdentityError(400, "identity_invalid_input");
          const sent = await this.invitations.send(
            input.workspaceId,
            input.email,
            actor.userId,
            this.baseURL,
          );
          record("invitation.created", sent.id);
          return respond(200, sent);
        }
        if (
          url.pathname === "/admin/api/identity/auth-providers/choices" &&
          req.method === "GET"
        )
          return respond(200, {
            providers: this.providerRegistry?.store.publicChoices() ?? [],
          });
        if (
          url.pathname === "/admin/api/identity/auth-providers/sign-in" &&
          req.method === "POST"
        ) {
          if (!this.providerRegistry)
            throw new IdentityError(404, "identity_not_found");
          const input = AuthProviderStartSchema.extend({
            invitationToken: z
              .string()
              .regex(/^[A-Za-z0-9_-]{43}$/)
              .optional(),
            returnPath: z
              .string()
              .max(2048)
              .regex(
                /^(?:\/admin\/(?:device|settings|service-connect|mcp(?:\/consent)?)?|\/account\/(?:login|invite)|\/(?:chat(?:\/[A-Za-z0-9_-]+)?|tasks|meetings(?:\/[A-Za-z0-9_-]+)?|processes(?:\/[A-Za-z0-9_-]+)?|skills(?:\/[A-Za-z0-9_-]+)?|connections(?:\/[A-Za-z0-9_-]+)?|search|me)?)(?:[?#].*)?$/,
              )
              .optional(),
          }).parse(payload);
          const provider = this.providerRegistry.store
            .publicChoices()
            .find((p) => p.id === input.providerId);
          if (!provider)
            throw new IdentityError(403, "auth_provider_unavailable");
          return respond(
            200,
            await this.startProvider(req, res, {
              organizationId: provider.organizationId,
              providerId: provider.id,
              mode: "sign-in",
              returnPath: input.returnPath ?? "/admin/",
              invitationToken: input.invitationToken,
            }),
          );
        }
        if (url.pathname.startsWith("/admin/auth/")) {
          if (req.headers.host !== new URL(this.baseURL).host)
            throw new IdentityError(403, "identity_origin_denied");
          const route = url.pathname.slice("/admin/auth/".length);
          if (
            /^callback\/ap_[a-f0-9]{32}$/.test(route) &&
            req.method === "GET"
          ) {
            const outcome: { reason?: string } = {};
            const response = await providerCallbackOutcome.run(outcome, () =>
              this.auth.handler(
                new Request(`${this.baseURL}${url.pathname}${url.search}`, {
                  headers: this.headers(req),
                }),
              ),
            );
            this.setAuthCookies(res, response);
            const result: unknown = await response
              .clone()
              .json()
              .catch(() => null);
            // The OAuth provider's fresh-session hook can return the newly
            // signed MCP resume in JSON while the SSO callback retains an older
            // Location header. Keep the provider's normalized query intact.
            const canonicalMcpResume =
              result &&
              typeof result === "object" &&
              "redirect" in result &&
              result.redirect === true &&
              "url" in result
                ? mcpConsentRedirect(result.url, this.baseURL)
                : undefined;
            let location =
              canonicalMcpResume ?? response.headers.get("location");
            if (
              location &&
              new URL(location, this.baseURL).origin === this.baseURL
            ) {
              // A rejection the person can fix names its reason on the page.
              if (outcome.reason) {
                const target = new URL(location, this.baseURL);
                if (target.searchParams.has("error")) {
                  target.searchParams.set("error", outcome.reason);
                  location = target.href;
                }
              }
              res.writeHead(302, {
                Location: location,
                "Cache-Control": "no-store",
              });
              res.end();
              return true;
            }
            res.writeHead(302, {
              Location: "/admin/settings?error=auth_provider_failed",
              "Cache-Control": "no-store",
            });
            res.end();
            return true;
          }
          if (
            req.method !== "POST" ||
            !["sign-in/email", "sign-out"].includes(route)
          )
            return respond(404, { error: "not_found" });
          const input =
            route === "sign-in/email"
              ? z
                  .strictObject({
                    email: z.email().max(254),
                    password: z.string().max(128),
                    oauth_query: z.string().min(1).max(16384).optional(),
                  })
                  .parse(payload)
              : {};
          const response = await this.auth.handler(
            new Request(`${this.baseURL}${url.pathname}`, {
              method: "POST",
              headers: this.headers(req),
              body: JSON.stringify(input),
            }),
          );
          const cookies = response.headers.getSetCookie();
          if (cookies.length)
            res.setHeader("Set-Cookie", [
              ...[res.getHeader("Set-Cookie")]
                .flat()
                .filter((v): v is string => typeof v === "string"),
              ...cookies,
            ]);
          if (response.status === 429) res.setHeader("Retry-After", "60");
          let oauthRedirect: string | undefined;
          if (response.ok && "oauth_query" in input && input.oauth_query) {
            const result: unknown = await response
              .clone()
              .json()
              .catch(() => null);
            if (
              result &&
              typeof result === "object" &&
              "url" in result &&
              typeof result.url === "string"
            ) {
              oauthRedirect = mcpConsentRedirect(result.url, this.baseURL);
              if (!oauthRedirect)
                throw new IdentityError(400, "mcp_oauth_redirect_invalid");
            }
          }
          // Session tokens and internal account data never enter our browser DTO.
          return respond(
            response.status,
            response.ok
              ? {
                  ok: true,
                  ...(oauthRedirect ? { redirect: oauthRedirect } : {}),
                }
              : {
                  error:
                    response.status === 429
                      ? "identity_rate_limited"
                      : "identity_unauthorized",
                },
          );
        }
        if (req.method === "GET" && url.pathname === "/admin/api/identity")
          return respond(200, await this.state(req, operator, res));
        if (
          req.method === "POST" &&
          url.pathname === "/admin/api/identity/bootstrap"
        ) {
          const result = await this.bootstrap(req, res, payload, operator);
          // The console now runs as the owner, not on the recovery key.
          if (operator) endRecovery?.();
          return respond(200, result);
        }
        // Recovery access deliberately does not impersonate an organization member.
        if (operator) throw new IdentityError(403, "identity_account_required");
        if (url.pathname === "/admin/api/identity/mcp/oauth/client/register") {
          if (req.method !== "POST")
            return respond(405, { error: "method_not_allowed" });
          if (!this.mcpOAuth || !this.workflowServerId)
            throw new IdentityError(503, "mcp_oauth_unavailable");
          const session = await this.getSession(req);
          if (
            !session ||
            !this.db
              .prepare('SELECT 1 FROM member WHERE "userId"=?')
              .get(session.user.id)
          )
            throw new IdentityError(403, "identity_account_required");
          return respond(
            201,
            await this.mcpOAuth.registerClient(
              this.auth,
              payload,
              this.headers(req),
            ),
          );
        }
        if (url.pathname.startsWith("/admin/api/identity/mcp/access/")) {
          if (req.method !== "POST")
            return respond(405, { error: "method_not_allowed" });
          const session = await this.getSession(req);
          if (!session) throw new IdentityError(401, "identity_unauthorized");
          const action = url.pathname.split("/").at(-1);
          const scope = {
            sessionId: session.session.id,
            serverId: this.workflowServerId,
          };
          if (action === "issue") {
            const input = z
              .strictObject({
                workspaceId: IdentityId,
                label: z.string().trim().min(1).max(120),
                scopes: z.array(z.enum(MCP_ACCESS_SCOPES)).min(1).max(3),
                expiresAt: z.number().int().positive(),
              })
              .parse(payload);
            const issued = this.mcpGrants.issue({ ...scope, ...input });
            this.audit.append({
              organizationId: issued.grant.organizationId,
              workspaceId: issued.grant.workspaceId,
              actorId: session.user.id,
              source: "console",
              action: "mcp.access_issued",
              targetId: issued.grant.id,
              outcome: "succeeded",
              details: {},
            });
            return respond(201, issued);
          }
          if (action === "list") {
            const input = z
              .strictObject({ workspaceId: IdentityId })
              .parse(payload);
            return respond(200, {
              grants: this.mcpGrants.list({ ...scope, ...input }),
              endpoint: `${this.baseURL}/mcp`,
            });
          }
          if (action === "revoke") {
            const input = z
              .strictObject({ workspaceId: IdentityId, grantId: IdentityId })
              .parse(payload);
            return respond(200, this.mcpGrants.revoke({ ...scope, ...input }));
          }
          // A connector call waiting for approval belongs to the person whose
          // MCP access made it; only that signed-in person can see or decline it.
          // Approval itself goes through the console's catalog invoke endpoint.
          if (action === "connector-call" || action === "connector-reject") {
            const input = z
              .strictObject({ workspaceId: IdentityId, requestId: IdentityId })
              .parse(payload);
            const receipt = this.catalog.store.invocation(
              input.requestId,
              input.workspaceId,
              session.user.id,
            );
            if (!receipt) throw new IdentityError(404, "identity_not_found");
            await this.workspaceActor(req, {
              organizationId: receipt.organizationId,
              workspaceId: receipt.workspaceId,
            });
            if (action === "connector-reject") {
              if (receipt.status !== "awaiting_approval")
                throw new IdentityError(409, "catalog_conflict");
              receipt.status = "rejected";
              this.catalog.store.saveInvocation(receipt);
              this.audit.append({
                organizationId: receipt.organizationId,
                workspaceId: receipt.workspaceId,
                actorId: session.user.id,
                source: "console",
                action: "catalog.action_invoked",
                targetId: receipt.actionId,
                outcome: "denied",
                details: {},
              });
            }
            return respond(200, {
              call: {
                requestId: receipt.id,
                organizationId: receipt.organizationId,
                workspaceId: receipt.workspaceId,
                serviceId: receipt.serviceId,
                actionId: receipt.actionId,
                serviceRevision: receipt.serviceRevision,
                actionRevision: receipt.actionRevision,
                title: receipt.title,
                serviceName: receipt.serviceName,
                effect: receipt.effect,
                input: receipt.input,
                status: receipt.status,
                ...(receipt.result !== undefined
                  ? { result: receipt.result }
                  : {}),
                ...(receipt.failure ? { failure: receipt.failure } : {}),
              },
            });
          }
          return respond(404, { error: "identity_not_found" });
        }
        if (
          url.pathname.startsWith("/admin/api/identity/hosted/") &&
          req.method === "POST"
        ) {
          const hosted = this.hosted;
          if (!hosted) throw new IdentityError(404, "identity_not_found");
          const action = url.pathname.split("/").at(-1);
          try {
            if (action === "list") {
              const { organizationId } = z
                .strictObject({ organizationId: IdentityId })
                .parse(payload);
              const actor = await this.actor(req, organizationId);
              const canManage = actor.role !== "member";
              return respond(
                200,
                HostedServersSchema.parse({
                  organizationId,
                  canManage,
                  allowCustom: hosted.allowCustom,
                  sandbox: (await hosted.sandboxKind()) ?? "unavailable",
                  builtins: hosted.builtins(),
                  servers: canManage ? hosted.list(organizationId) : [],
                }),
              );
            }
            if (action === "resolve") {
              const input = HostedResolveRequest.parse(payload);
              const actor = await this.actor(req, input.organizationId);
              if (actor.role === "member")
                throw new IdentityError(403, "identity_forbidden");
              return respond(
                200,
                await hosted.resolve(input.package, input.version),
              );
            }
            if (action === "logs") {
              const input = HostedLogRequest.parse(payload);
              const actor = await this.actor(req, input.organizationId);
              if (actor.role === "member")
                throw new IdentityError(403, "identity_forbidden");
              return respond(200, {
                lines: hosted.logs(input.organizationId, input.id),
              });
            }
            if (action !== "command")
              throw new IdentityError(404, "identity_not_found");
            const input = HostedCommand.parse(payload);
            const actor = await this.actor(req, input.organizationId);
            if (actor.role === "member")
              throw new IdentityError(403, "identity_forbidden");
            const server =
              input.type === "create"
                ? await hosted.create(
                    input.organizationId,
                    input.builtin,
                    input.secrets,
                  )
                : input.type === "createCustom"
                  ? await hosted.createCustom(
                      input.organizationId,
                      input.definition,
                      input.secrets,
                    )
                  : input.type === "secrets"
                    ? hosted.setSecrets(
                        input.organizationId,
                        input.id,
                        input.revision,
                        input.secrets,
                      )
                    : hosted.command(
                        input.organizationId,
                        input.id,
                        input.revision,
                        input.type,
                      );
            this.audit.append({
              organizationId: input.organizationId,
              workspaceId: null,
              actorId: actor.userId,
              source: "console",
              action: "hosted.server_changed",
              targetId: server?.id ?? ("id" in input ? input.id : null),
              outcome: "succeeded",
              details: {},
            });
            return respond(200, { ok: true, ...(server ? { server } : {}) });
          } catch (error) {
            if (error instanceof HostedError)
              throw new IdentityError(error.status, error.code);
            throw error;
          }
        }
        if (
          url.pathname.startsWith("/admin/api/identity/auth-providers/") &&
          req.method === "POST"
        ) {
          const registry = this.providerRegistry;
          if (!registry) throw new IdentityError(404, "identity_not_found");
          const action = url.pathname.split("/").at(-1);
          if (action === "account" || action === "link") {
            const input = z
              .strictObject({
                organizationId: IdentityId,
                providerId: IdentityId.optional(),
                returnPath: z
                  .string()
                  .max(2048)
                  .regex(/^\/account\/(?:login|invite)(?:#[A-Za-z0-9_-]{43})?$/)
                  .optional(),
              })
              .parse(payload);
            const actor = await this.actor(req, input.organizationId);
            const session = await this.getSession(req);
            if (!session) throw new IdentityError(401, "identity_unauthorized");
            if (action === "link") {
              if (!input.providerId)
                throw new IdentityError(400, "identity_invalid_input");
              return respond(
                200,
                await this.startProvider(req, res, {
                  organizationId: input.organizationId,
                  providerId: input.providerId,
                  mode: "link",
                  actor: {
                    userId: actor.userId,
                    sessionId: session.session.id,
                  },
                  returnPath: input.returnPath ?? "/admin/settings",
                }),
              );
            }
            return respond(200, {
              providers: registry.store
                .list(input.organizationId)
                .filter((provider) => provider.enabled)
                .map((provider) =>
                  registry.store.linkedStatus(
                    input.organizationId,
                    actor.userId,
                    provider.id,
                  ),
                ),
            });
          }
          if (action === "list" || action === "draft") {
            const { organizationId } = z
              .strictObject({ organizationId: IdentityId })
              .parse(payload);
            const actor = await this.actor(req, organizationId);
            if (action === "draft") {
              if (actor.role === "member")
                throw new IdentityError(403, "identity_forbidden");
              return respond(200, registry.store.draft(organizationId));
            }
            return respond(
              200,
              AuthProvidersSchema.parse({
                organizationId,
                canManage: actor.role !== "member",
                providers: registry.store.list(organizationId),
              }),
            );
          }
          if (action !== "save" && action !== "delete")
            throw new IdentityError(404, "identity_not_found");
          const input =
            action === "save"
              ? SaveAuthProviderSchema.parse(payload)
              : DeleteAuthProviderSchema.parse(payload);
          const actor = await this.actor(req, input.organizationId);
          if (actor.role === "member")
            throw new IdentityError(403, "identity_forbidden");
          let next: Awaited<ReturnType<typeof registry.rebuild>> | undefined;
          await this.transaction(async () => {
            let id = input.providerId;
            if ("input" in input)
              id = registry.store.save(
                input.organizationId,
                id,
                input.revision,
                input.input,
                input.creationId,
              ).id;
            else {
              registry.store.delete(input.organizationId, id!, input.revision);
            }
            next = await registry.rebuild();
            this.connections.changePolicy(input.organizationId);
            this.audit.append({
              organizationId: input.organizationId,
              workspaceId: null,
              actorId: actor.userId,
              source: "console",
              action: "auth.provider_changed",
              targetId: id,
              outcome: "succeeded",
              details: {},
            });
          });
          this.auth = next!.auth;
          registry.bridge = next!.bridge;
          return respond(200, { ok: true });
        }
        if (
          req.method === "POST" &&
          [
            "/admin/api/identity/device/inspect",
            "/admin/api/identity/device/release",
            "/admin/api/identity/device/consent",
          ].includes(url.pathname)
        ) {
          const session = await this.getSession(req);
          if (!session) throw new IdentityError(401, "identity_unauthorized");
          if (url.pathname.endsWith("/release")) {
            const { userCode } = BrowserLoginInspect.parse(payload);
            this.mobile.releaseBrowser(userCode, session.session.id);
            return respond(200, { ok: true });
          }
          if (url.pathname.endsWith("/inspect")) {
            const { userCode } = BrowserLoginInspect.parse(payload);
            return respond(
              200,
              this.mobile.inspectBrowser(userCode, session.session.id),
            );
          }
          const value = BrowserLoginConsent.parse(payload);
          if (!value.approve) {
            this.mobile.denyBrowser(value.userCode, session.session.id);
            return respond(200, { ok: true });
          }
          const actor = await this.workspaceActor(req, value);
          if (!this.workflowServerId)
            throw new IdentityError(503, "identity_unavailable");
          this.mobile.consentBrowser(
            value.userCode,
            value.approve,
            {
              session_id: session.session.id,
              member_id: actor.id,
              organization_id: value.organizationId,
              workspace_id: value.workspaceId,
              user_id: actor.userId,
              server_id: this.workflowServerId,
            },
            session.session.expiresAt,
          );
          return respond(200, { ok: true });
        }

        if (url.pathname.startsWith("/admin/api/identity/server-settings")) {
          // Server-wide settings: owners and administrators, from an account.
          const store = this.serverSettingsStore;
          const action = url.pathname.slice(
            "/admin/api/identity/server-settings".length,
          );
          const methods = (
            {
              "": ["GET", "POST"],
              "/export": ["GET"],
              "/import": ["POST"],
            } as Record<string, string[] | undefined>
          )[action];
          if (!store || !methods) return respond(404, { error: "not_found" });
          if (!methods.includes(req.method ?? ""))
            return respond(405, { error: "method_not_allowed" });
          const { organizationId } =
            req.method === "GET"
              ? z
                  .strictObject({ organizationId: IdentityId })
                  .parse(Object.fromEntries(url.searchParams))
              : z.object({ organizationId: IdentityId }).parse(payload);
          const actor = await this.actor(req, organizationId);
          if (actor.role === "member")
            throw new IdentityError(403, "identity_forbidden");
          if (action === "/export")
            return respond(200, serverSettingsFile(store.read().settings));
          if (req.method === "POST") {
            const change =
              action === "/import"
                ? ImportServerSettingsSchema.parse(payload)
                : UpdateServerSettingsSchema.parse(payload);
            const settings =
              "file" in change
                ? serverSettingsOfFile(change.file)
                : change.settings;
            let previous;
            try {
              previous = await this.transaction(async () => {
                const previous = store.update(change.revision, settings);
                this.audit.append({
                  organizationId,
                  workspaceId: null,
                  actorId: actor.userId,
                  source: "console",
                  action:
                    action === "/import"
                      ? "server.settings_imported"
                      : "server.settings_changed",
                  targetId: null,
                  outcome: "succeeded",
                  details: {
                    previousRevision: previous.revision,
                    revision: previous.revision + 1,
                  },
                });
                return previous;
              });
            } catch (error) {
              store.forget();
              throw error;
            }
            this.applyServerSettings(store.read().settings, previous.settings);
          }
          return respond(200, this.serverSettingsView(organizationId));
        }
        if (url.pathname === "/admin/api/identity/plugins/preview") {
          if (req.method !== "POST")
            return respond(405, { error: "method_not_allowed" });
          const command = PreviewWorkspacePluginSchema.parse(payload);
          await this.workspaceActor(req, command);
          return respond(200, this.plugins.preview(command));
        }
        if (url.pathname === "/admin/api/identity/plugins") {
          if (req.method !== "GET" && req.method !== "POST")
            return respond(405, { error: "method_not_allowed" });
          const value =
            req.method === "GET"
              ? WorkspaceTarget.parse(Object.fromEntries(url.searchParams))
              : UpdateWorkspacePluginsSchema.parse(payload);
          const actor = await this.workspaceActor(req, value);
          if (req.method === "POST") {
            if (actor.role === "member")
              throw new IdentityError(403, "identity_forbidden");
            const change = UpdateWorkspacePluginsSchema.parse(payload);
            await this.transaction(async () => {
              const previous = this.plugins.update(
                value.workspaceId,
                change.revision,
                change.settings,
              );
              this.audit.append({
                organizationId: value.organizationId,
                workspaceId: value.workspaceId,
                actorId: actor.userId,
                source: "console",
                action: "workspace.plugins_changed",
                targetId: value.workspaceId,
                outcome: "succeeded",
                details: {
                  previousRevision: previous.revision,
                  revision: previous.revision + 1,
                },
              });
            });
          }
          return respond(
            200,
            this.plugins.inventory(
              value.organizationId,
              value.workspaceId,
              actor.role !== "member",
              {
                allowed: actor.role === "owner" && !!this.pluginFiles,
                disabled: !this.pluginEditing,
              },
            ),
          );
        }
        if (url.pathname === "/admin/api/identity/plugin-files") {
          // A plugin's code runs in this process: owners only, audited, and
          // the operator can make it read-only (NIARO_PLUGIN_EDITING=0).
          if (req.method !== "GET" && req.method !== "POST")
            return respond(405, { error: "method_not_allowed" });
          const files = this.pluginFiles;
          if (!files) return respond(404, { error: "not_found" });
          const value =
            req.method === "GET"
              ? PluginFilesQuerySchema.parse(
                  Object.fromEntries(url.searchParams),
                )
              : ChangePluginFilesSchema.parse(payload);
          const actor = await this.actor(req, value.organizationId);
          if (actor.role !== "owner")
            throw new IdentityError(403, "identity_forbidden");
          const id = value.pluginId;
          const view = () => {
            try {
              return PluginFilesSchema.parse({
                profile: PLUGIN_FILES_PROFILE,
                organizationId: value.organizationId,
                pluginId: id,
                readOnly: !this.pluginEditing,
                ...files.read(id),
              });
            } catch (error) {
              if (error instanceof PluginFilesError)
                throw new IdentityError(error.status, error.code);
              throw error;
            }
          };
          if (req.method === "GET") return respond(200, view());
          const change = ChangePluginFilesSchema.parse(payload);
          const audit = (
            pluginEvent: "saved" | "reset" | "deleted" | "created" | "refused",
            outcome: "succeeded" | "failed" | "denied" = "succeeded",
          ) =>
            this.transaction(async () =>
              this.audit.append({
                organizationId: value.organizationId,
                workspaceId: null,
                actorId: actor.userId,
                source: "console",
                action: "server.plugin_changed",
                targetId: id,
                outcome,
                details: {
                  pluginEvent,
                  ...(outcome === "failed"
                    ? { reason: "invalid_input" as const }
                    : {}),
                },
              }),
            );
          if (!this.pluginEditing) {
            if (change.action !== "check") await audit("refused", "denied");
            throw new IdentityError(403, "plugin_editing_disabled");
          }
          const result = await files
            .run(async () => {
              switch (change.action) {
                case "check": {
                  const rejected = await files.check(id, change.files);
                  return {
                    outcome: rejected ? "invalid" : "valid",
                    rejected,
                    current: view(),
                  } as const;
                }
                case "save": {
                  const rejected = await files.save(id, change.files);
                  await audit(
                    rejected ? "refused" : "saved",
                    rejected ? "failed" : "succeeded",
                  );
                  return {
                    outcome: rejected ? "invalid" : "saved",
                    rejected,
                    current: view(),
                  } as const;
                }
                case "reset": {
                  const builtIn = files.read(id).builtIn;
                  files.reset(id);
                  await audit(builtIn ? "reset" : "deleted");
                  return {
                    outcome: builtIn ? "reset" : "deleted",
                    rejected: null,
                    current: builtIn ? view() : null,
                  } as const;
                }
                case "create":
                  await files.create(id);
                  await audit("created");
                  return {
                    outcome: "created",
                    rejected: null,
                    current: view(),
                  } as const;
              }
            })
            .catch((error: unknown) => {
              if (error instanceof PluginFilesError)
                throw new IdentityError(error.status, error.code);
              throw error;
            });
          return respond(
            200,
            PluginFilesResultSchema.parse({
              profile: PLUGIN_FILES_PROFILE,
              ...result,
            }),
          );
        }
        if (url.pathname === "/admin/api/identity/calendar") {
          if (req.method !== "GET" && req.method !== "POST")
            return respond(405, { error: "method_not_allowed" });
          const value =
            req.method === "GET"
              ? WorkspaceTarget.parse(Object.fromEntries(url.searchParams))
              : CalendarCommand.parse(payload);
          const actor = await this.workspaceActor(req, value);
          if (req.method === "POST") {
            if (actor.role === "member")
              throw new IdentityError(403, "identity_forbidden");
            const change = CalendarCommand.parse(payload);
            await this.transaction(async () => {
              const id = this.calendars.update(change);
              const action = {
                create: "calendar.created",
                configure: "calendar.configured",
                rotate: "calendar.key_rotated",
                remove: "calendar.removed",
              } as const;
              this.audit.append({
                organizationId: value.organizationId,
                workspaceId: value.workspaceId,
                actorId: actor.userId,
                source: "console",
                action: action[change.type],
                targetId: id,
                outcome: "succeeded",
                details: {
                  revision:
                    this.calendars.row(value.workspaceId)?.revision ??
                    (change.type === "create" ? 1 : change.revision),
                  ...(change.type === "configure"
                    ? { enabled: change.enabled, calendarRoles: change.roles }
                    : {}),
                },
              });
            });
          }
          return respond(
            200,
            this.calendars.list(
              value.organizationId,
              value.workspaceId,
              actor.role,
            ),
          );
        }
        if (url.pathname === "/admin/api/identity/ai") {
          if (req.method !== "GET" && req.method !== "POST")
            return respond(405, { error: "method_not_allowed" });
          const value =
            req.method === "GET"
              ? WorkspaceTarget.parse(Object.fromEntries(url.searchParams))
              : UpdateWorkspaceAISchema.parse(payload);
          const actor = await this.workspaceActor(req, value);
          if (actor.role === "member")
            throw new IdentityError(403, "identity_forbidden");
          if (req.method === "POST")
            await this.transaction(async () => {
              const change = UpdateWorkspaceAISchema.parse(payload);
              const previous = this.ai.update(
                value.workspaceId,
                change.revision,
                change.selection,
              );
              this.audit.append({
                organizationId: value.organizationId,
                workspaceId: value.workspaceId,
                actorId: actor.userId,
                source: "console",
                action: "workspace.ai_changed",
                targetId: value.workspaceId,
                outcome: "succeeded",
                details: {
                  previousRevision: previous.revision,
                  revision: previous.revision + 1,
                  previousModelId: previous.selection.modelId,
                  modelId: change.selection.modelId,
                  previousVoiceId: previous.selection.voiceId,
                  voiceId: change.selection.voiceId,
                },
              });
            });
          return respond(
            200,
            this.ai.inventory(value.organizationId, value.workspaceId),
          );
        }
        if (
          req.method === "GET" &&
          url.pathname === "/admin/api/identity/audit"
        ) {
          const query = AuditQuery.parse(Object.fromEntries(url.searchParams));
          const actor = await this.actor(req, query.organizationId);
          if (actor.role === "member")
            throw new IdentityError(403, "identity_forbidden");
          if (query.workspaceId)
            await this.workspaceActor(req, {
              organizationId: query.organizationId,
              workspaceId: query.workspaceId,
            });
          return respond(200, this.audit.page(query));
        }
        if (
          req.method === "GET" &&
          (url.pathname === "/admin/api/identity/loops" ||
            url.pathname.startsWith("/admin/api/identity/loops/"))
        ) {
          const query = LoopQuery.parse(Object.fromEntries(url.searchParams));
          const actor = await this.actor(req, query.organizationId);
          if (actor.role === "member")
            throw new IdentityError(403, "identity_forbidden");
          if (query.workspaceId)
            await this.workspaceActor(req, {
              organizationId: query.organizationId,
              workspaceId: query.workspaceId,
            });
          if (url.pathname === "/admin/api/identity/loops")
            return respond(200, this.loops.page(query));
          const id = LoopId.parse(
            url.pathname.slice("/admin/api/identity/loops/".length),
          );
          const detail = this.loops.detail(query.organizationId, id);
          if (
            !detail ||
            (query.workspaceId && detail.run.workspaceId !== query.workspaceId)
          )
            throw new IdentityError(404, "identity_not_found");
          return respond(200, detail);
        }
        if (url.pathname.startsWith("/admin/api/identity/mobile")) {
          const value = MobilePairingTarget.parse(
            req.method === "GET"
              ? Object.fromEntries(url.searchParams)
              : payload,
          );
          const actor = await this.workspaceActor(req, value);
          if (
            req.method === "GET" &&
            url.pathname === "/admin/api/identity/mobile"
          )
            return respond(
              200,
              MobileWorkspaceStatus.parse({
                ...value,
                activeDevices: this.mobile.count(
                  actor.userId,
                  value.workspaceId,
                ),
                availableDeviceSlots: this.mobile.availableSlots(actor.userId),
                modelEnabled:
                  this.catalogEnabled(
                    value.organizationId,
                    value.workspaceId,
                  ) ||
                  !!this.ai.resolve(this.ai.read(value.workspaceId).selection)
                    .model,
                voiceEnabled:
                  this.catalogEnabled(
                    value.organizationId,
                    value.workspaceId,
                    true,
                  ) ||
                  (this.catalog.store.routing(value.workspaceId).voiceMode ===
                    "legacy" &&
                    !!this.ai.resolve(this.ai.read(value.workspaceId).selection)
                      .transcriber),
              }),
            );
          if (
            req.method === "POST" &&
            url.pathname === "/admin/api/identity/mobile/revoke"
          ) {
            this.mobile.revokeOwn(actor.userId, value.workspaceId);
            return respond(200, { ok: true });
          }
          if (
            req.method === "POST" &&
            url.pathname === "/admin/api/identity/mobile/pairing"
          ) {
            if (!this.workflowServerId)
              throw new IdentityError(503, "identity_unavailable");
            const session = await this.getSession(req);
            if (!session) throw new IdentityError(401, "identity_unauthorized");
            return respond(
              200,
              this.mobile.issue(
                {
                  session_id: session.session.id,
                  member_id: actor.id,
                  organization_id: value.organizationId,
                  workspace_id: value.workspaceId,
                  user_id: actor.userId,
                  server_id: this.workflowServerId,
                },
                session.session.expiresAt,
              ),
            );
          }
          return respond(404, { error: "not_found" });
        }
        if (
          req.method === "GET" &&
          url.pathname === "/admin/api/identity/connections"
        ) {
          const target = WorkspaceTarget.parse(
            Object.fromEntries(url.searchParams),
          );
          const actor = await this.workspaceActor(req, target);
          return respond(
            200,
            this.connections.list(
              target.organizationId,
              target.workspaceId,
              actor.role,
            ),
          );
        }
        if (
          req.method === "POST" &&
          url.pathname === "/admin/api/identity/connections/command"
        ) {
          const value = ConnectionCommandSchema.parse(payload);
          const actor = await this.workspaceActor(req, value);
          if (actor.role === "member")
            throw new IdentityError(403, "identity_forbidden");
          await this.transaction(async () => {
            const targetId = this.connections.command(value);
            const actions = {
              create: "connection.created",
              configure: "connection.configured",
              rotate: "connection.key_rotated",
              remove: "connection.removed",
              selectAgentConnection: "connection.chat_selected",
            } as const;
            this.audit.append({
              organizationId: value.organizationId,
              workspaceId: value.workspaceId,
              actorId: actor.userId,
              source: "console",
              action: actions[value.type],
              targetId,
              outcome: "succeeded",
              details:
                value.type === "configure"
                  ? {
                      previousRevision: value.revision,
                      revision: value.revision + 1,
                      enabled: value.enabled,
                      grants: value.grants,
                    }
                  : value.type === "rotate"
                    ? {
                        previousRevision: value.revision,
                        revision: value.revision + 1,
                        expiresAt: value.expiresAt,
                      }
                    : value.type === "remove"
                      ? { revision: value.revision }
                      : value.type === "selectAgentConnection"
                        ? {
                            previousRevision: value.bindingRevision,
                            revision: value.bindingRevision + 1,
                          }
                        : { revision: 1, expiresAt: value.expiresAt },
            });
          });
          return respond(200, { ok: true });
        }
        if (
          req.method === "GET" &&
          url.pathname === "/admin/api/identity/organization"
        )
          return respond(
            200,
            await this.detail(
              req,
              IdentityId.parse(url.searchParams.get("id")),
            ),
          );
        if (
          req.method === "POST" &&
          url.pathname === "/admin/api/identity/command"
        )
          return respond(200, await this.command(req, payload));
        return respond(404, { error: "not_found" });
      } catch (error) {
        if (error instanceof IdentityError)
          return respond(error.status, { error: error.code });
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          return respond(400, { error: "identity_invalid_input" });
        return respond(503, { error: "identity_unavailable" });
      }
    });
  }
}
