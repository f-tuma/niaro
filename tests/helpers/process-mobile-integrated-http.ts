import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Credential } from "../../packages/protocol";
import { ProcessDefinitionSchema } from "../../packages/protocol/service-processes";
import {
  ActionSettings,
  CatalogModelSettings,
  ServiceSettings,
} from "../../packages/protocol/service-catalog";
import { coordinatorHttpFixture } from "./process-coordinator-http";
import { processObject } from "./service-process";
import { MEETING_PROFILE } from "../../packages/protocol/meetings";
import type { MeetingSynthesis } from "../../packages/protocol/meeting-record";
import type { ProcessData } from "../../packages/protocol/service-processes";
import { emptyDesignBrief } from "../../packages/protocol/process-design";

export type MobileProcessScenario = {
  questions?: number;
  writes?: number;
  /** Frozen per-run budget; use exhaustion without mutating qualification policy. */
  maxModelCalls?: number;
  outcome?: "success" | "invalid_output" | "service_failed" | "service_unknown";
  memory?: "none" | "saved";
  parameterPadding?: string;
  inputSchema?: Extract<ProcessData, { type: "object" }>;
  writeApproval?: "always" | "never";
};
export type MobileHttpRequest = {
  method: string;
  path: string;
  body?: string;
  status?: number;
};
export type MobileFixtureHold = "model" | "before_service" | "after_service";

/** Real SQLite identity, native Mastra execution, pairing and loopback HTTP.
 * Only provider responses are scripted; no WorkItem, admission or loop is seeded.
 */
export async function mobileIntegratedHttpFixture(
  options: { testAllowedOrigins?: string[]; testSavedMemory?: boolean } = {},
) {
  const requests: MobileHttpRequest[] = [];
  const holds = new Map<
    MobileFixtureHold,
    { gate: Promise<void>; release: () => void; entered: boolean }
  >();
  const holdAt = async (stage: MobileFixtureHold) => {
    const held = holds.get(stage);
    if (!held) return;
    held.entered = true;
    await held.gate;
    holds.delete(stage);
  };
  const h = await coordinatorHttpFixture({
    allowOrdinaryRuntime: true,
    ...options,
    observeRequest: (req, res) => {
      const path = req.url ?? "/";
      // Credentials, login/password bodies and admin cookies never enter this log.
      if (!path.startsWith("/v1/") && !path.includes("/api/identity/loops"))
        return;
      const entry: MobileHttpRequest = { method: req.method ?? "GET", path };
      requests.push(entry);
      if (path.includes("/processes/commands")) {
        const chunks: Buffer[] = [];
        // Observe incoming chunks without adding a data listener: that would
        // start flowing before the real handler finishes its async auth gate.
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
  let scenario: Required<
    Omit<MobileProcessScenario, "inputSchema" | "writeApproval">
  > &
    Pick<MobileProcessScenario, "inputSchema" | "writeApproval"> = {
    questions: 2,
    writes: 2,
    maxModelCalls: 6,
    outcome: "success",
    memory: "none",
    parameterPadding: "",
    writeApproval: "always",
  };
  let modelStep = 0,
    serviceStep = 0,
    designerProposalEnabled = false,
    designerModelStep = 0;
  h.beforeModel(() => holdAt("model"));
  h.beforeDispatch(async () => {
    await holdAt("before_service");
    if (
      scenario.outcome === "service_failed" &&
      serviceStep + 1 === scenario.writes
    )
      throw Error("TEST service unavailable before dispatch");
  });
  h.afterDispatch(() => holdAt("after_service"));
  h.onModel((request) => {
    if (
      designerProposalEnabled &&
      request.tools?.some(
        (tool) => tool.function.name === "design_update_proposal",
      )
    ) {
      if (designerModelStep++ === 0)
        return {
          content: null,
          tool_calls: [
            {
              id: "TEST-mobile-design-update",
              type: "function",
              function: {
                name: "design_update_proposal",
                arguments: JSON.stringify({
                  revision: 1,
                  brief: {
                    ...emptyDesignBrief(),
                    purpose: "TEST mobile authenticated draft",
                  },
                  candidate: h.workflow(),
                }),
              },
            },
          ],
        };
      return { content: "TEST proposal is ready for review." };
    }
    const step = ++modelStep;
    const question = step <= scenario.questions;
    const write = step <= scenario.questions + scenario.writes;
    return question || write
      ? {
          content: null,
          tool_calls: [
            {
              id: `TEST-${question ? "question" : "write"}-${step}`,
              type: "function",
              function: {
                name: question ? "ask_user" : "action_process_0",
                arguments: JSON.stringify(
                  question
                    ? { question: `TEST question ${step}?` }
                    : {
                        name:
                          `TEST write ${step - scenario.questions}` +
                          (scenario.parameterPadding
                            ? `\n${scenario.parameterPadding}`
                            : ""),
                      },
                ),
              },
            },
          ],
        }
      : {
          content: JSON.stringify({
            result:
              scenario.outcome === "invalid_output"
                ? 42
                : "TEST integrated result",
          }),
        };
  });
  h.onService(async () => {
    const step = ++serviceStep;
    if (step === scenario.writes && scenario.outcome === "service_unknown")
      throw new DOMException(
        "TEST lost service reply after dispatch",
        "TimeoutError",
      );
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({ value: `TEST saved write ${step}` }),
    };
  });
  const budget = h.identity["catalog"].store.inferenceBudget;
  const policy = budget.policy(h.target.organizationId, h.target.workspaceId);
  budget.savePolicy(
    h.target.organizationId,
    h.target.workspaceId,
    policy.revision,
    {
      ...policy.settings,
      prices: policy.settings.prices.map((price) => ({
        ...price,
        maxInputTokens: 50_000,
        maxOutputTokens: 10_000,
      })),
    },
  );
  let credential: Credential | undefined;
  const configure = async (
    next: MobileProcessScenario = {},
    role: "owner" | "member" = "owner",
  ) => {
    scenario = {
      questions: 2,
      writes: 2,
      outcome: "success",
      memory: "none",
      parameterPadding: "",
      writeApproval: "always",
      ...next,
      maxModelCalls:
        next.maxModelCalls ?? (next.questions ?? 2) + (next.writes ?? 2) + 2,
    };
    assert(Number.isInteger(scenario.questions) && scenario.questions >= 0);
    assert(Number.isInteger(scenario.writes) && scenario.writes >= 0);
    assert(scenario.questions + scenario.writes <= 8);
    assert(
      Number.isInteger(scenario.maxModelCalls) && scenario.maxModelCalls > 0,
    );
    assert(scenario.parameterPadding.length <= 16_384);
    modelStep = serviceStep = 0;
    if (scenario.writes) {
      const service = h.identity["catalog"].store.service(
        h.target.workspaceId,
        h.serviceId,
      );
      const action = service.actions.find((item) => item.id === h.writeId)!;
      await h.catalog({
        type: "saveAction",
        id: action.id,
        serviceId: service.id,
        serviceRevision: service.revision,
        revision: action.revision,
        settings: {
          ...ActionSettings.strip().parse(action),
          approval: scenario.writeApproval,
        },
      });
    }
    const base = h.workflow();
    const artifact = h.activate(
      ProcessDefinitionSchema.parse({
        schemaVersion: 1,
        kind: "agent",
        name: "TEST integrated native mobile process",
        description:
          "Isolated synthetic provider responses over real paired HTTP",
        trigger: "manual",
        inputSchema: scenario.inputSchema ?? base.inputSchema,
        outputSchema: processObject({ result: { type: "string" } }),
        limits: {
          ...base.limits,
          maxModelCalls: scenario.maxModelCalls,
        },
        modelId: h.modelId,
        instructions:
          "TEST ask the scripted questions, confirm each write, return typed output",
        memory: scenario.memory,
        humanInput: "text",
        capabilities: scenario.writes
          ? [{ serviceId: h.serviceId, actionId: h.writeId }]
          : [],
      }),
    );
    credential ??= await h.pair(role);
    return {
      endpoint: h.origin + "/v1/" + h.target.workspaceId,
      credential,
      artifact,
      target: h.target,
      serviceId: h.serviceId,
    };
  };
  const seedMeeting = async () => {
    assert(credential, "TEST mobile fixture must be paired before seeding");
    const store = h.identity["meetings"];
    const scope = credential.scope;
    const id = randomUUID();
    const title = "TEST quarterly planning";
    const quote = "Anna will prepare the prototype before Friday.";
    const audio = new Uint8Array([1, 2, 3, 4]);
    store.create(scope, {
      profile: MEETING_PROFILE,
      id,
      title,
      recordedAt: new Date().toISOString(),
      language: "en",
      mimeType: "audio/wav",
      bytes: audio.byteLength,
    });
    store.append(scope, id, 0, audio);
    store.seal(scope, id, await store.hash(scope, id));
    store.update(scope, id, { durationSeconds: 60 });
    store.putSegment(scope, id, {
      index: 0,
      startSeconds: 0,
      endSeconds: 60,
      text: quote,
      reviewReasons: [],
      transcriber: "TEST/STT",
      analyzer: null,
      analysis: null,
    });
    const synthesis: MeetingSynthesis = {
      summary: "The team will prepare the prototype before Friday.",
      summarySources: [{ segment: 0, quote }],
      points: [],
      tasks: [
        {
          text: quote,
          assignee: "Anna",
          due: "Friday",
          sources: [{ segment: 0, quote }],
        },
      ],
      overflow: false,
    };
    const record = store.publishRecord(scope, id, synthesis, "TEST/Mastra");
    return {
      meetingId: id,
      title,
      recordDigest: record.recordDigest,
      taskId: record.humanTaskIds[0],
    };
  };
  /** Simulate owner/access drift after a mobile intent was prepared. */
  const moveMeetingOutsidePairedUserScope = (meetingId: string) => {
    assert(
      credential,
      "TEST mobile fixture must be paired before changing scope",
    );
    const scope = credential.scope;
    const changed = h.identity["db"]
      .prepare("UPDATE niaro_meeting SET owner=? WHERE id=?")
      .run(
        JSON.stringify([
          scope.connectionId,
          scope.serverId,
          scope.workspaceId,
          "TEST-foreign-user",
        ]),
        meetingId,
      );
    assert.equal(changed.changes, 1);
  };
  const inspect = () => ({
    modelCalls: h.modelCount(),
    serviceDispatches: [...h.dispatches],
    commandPosts: requests.filter(
      (r) =>
        r.method === "POST" &&
        r.path.split("?")[0]?.endsWith("/processes/commands"),
    ).length,
    ordinaryCommandPosts: requests.filter(
      (r) =>
        r.method === "POST" &&
        r.path.split("?")[0]?.endsWith("/commands") &&
        !r.path.includes("/processes/"),
    ).length,
    requests: structuredClone(requests),
    models: structuredClone(h.models()),
    held: [...holds].map(([stage, hold]) => ({ stage, entered: hold.entered })),
    budgetPolicy: h.identity["catalog"].store.inferenceBudget.policy(
      h.target.organizationId,
      h.target.workspaceId,
    ),
    canonicalReceipts: h.identity["db"]
      .prepare("SELECT data FROM agent_service_invocation ORDER BY id")
      .all()
      .map((row) => {
        const receipt = JSON.parse(String(row.data)) as {
          id: string;
          status: string;
          effect: string;
          input: Record<string, unknown>;
          result?: unknown;
          failure?: { code: string };
        };
        return {
          operationId: receipt.id,
          status: receipt.status,
          effect: receipt.effect,
          input: receipt.input,
          result: receipt.result,
          ...(receipt.failure ? { failureCode: receipt.failure.code } : {}),
        };
      }),
    processJournals: h.identity["db"]
      .prepare(
        "SELECT id,data FROM agent_service_turn WHERE json_extract(data,'$.processId') IS NOT NULL ORDER BY id",
      )
      .all()
      .map((row) => {
        const journal = JSON.parse(String(row.data)) as {
          processId: string;
          status: string;
          failure?: { code: string };
        };
        return {
          parentRunId: String(row.id),
          processId: journal.processId,
          status: journal.status,
          ...(journal.failure ? { failureCode: journal.failure.code } : {}),
        };
      }),
    processStarts: h.identity["db"]
      .prepare(
        "SELECT data FROM agent_process_start_command ORDER BY command_key",
      )
      .all()
      .map((row) => {
        const saved = JSON.parse(String(row.data)) as {
          receipt: { status: string; reason?: string; origin: unknown };
          command: { input?: unknown };
        };
        return {
          status: saved.receipt.status,
          ...(saved.receipt.reason ? { reason: saved.receipt.reason } : {}),
          origin: saved.receipt.origin,
          input: saved.command.input,
        };
      }),
  });
  const seedDesignerPages = async (serviceId: string, count = 102) => {
    assert(credential, "TEST designer fixture must be paired before seeding");
    assert(Number.isInteger(count) && count > 100 && count <= 150);
    const db = h.identity["db"];
    const scope = credential.scope;
    const sessionRow = db
      .prepare(
        `SELECT organization_id,workspace_id,user_id,data FROM agent_process_design
         WHERE organization_id=? AND workspace_id=? AND user_id=?
           AND json_extract(data,'$.serviceId')=? ORDER BY id LIMIT 1`,
      )
      .get(
        h.target.organizationId,
        h.target.workspaceId,
        scope.userId,
        h.serviceId,
      ) as
      | {
          organization_id: string;
          workspace_id: string;
          user_id: string;
          data: string;
        }
      | undefined;
    const processRow = db
      .prepare(
        `SELECT id,organization_id,workspace_id,service_id,draft,updated_at
         FROM agent_service_process WHERE organization_id=? AND workspace_id=?
           AND service_id=? AND owner_type='service' ORDER BY id LIMIT 1`,
      )
      .get(h.target.organizationId, h.target.workspaceId, h.serviceId) as
      | {
          id: string;
          organization_id: string;
          workspace_id: string;
          service_id: string;
          draft: string;
          updated_at: string;
        }
      | undefined;
    assert(sessionRow, "TEST seed one real service design session first");
    assert(processRow, "TEST save one real service draft before paging");
    const insertSession = db.prepare(
      "INSERT INTO agent_process_design (id,organization_id,workspace_id,user_id,data) VALUES (?,?,?,?,?)",
    );
    const insertProcess = db.prepare(
      `INSERT INTO agent_service_process
       (id,organization_id,workspace_id,service_id,revision,draft,active_version,updated_at,owner_type)
       VALUES (?,?,?,?,1,?,NULL,?,'service')`,
    );
    const pageSessionIds: string[] = [];
    const pageDraftIds: string[] = [];
    for (let index = 0; index < count; index++) {
      const suffix = String(index).padStart(3, "0");
      const id = `zz-page-session-${suffix}`;
      const state = JSON.parse(sessionRow.data) as Record<string, unknown>;
      insertSession.run(
        id,
        sessionRow.organization_id,
        sessionRow.workspace_id,
        sessionRow.user_id,
        JSON.stringify({
          ...state,
          id,
          acceptedProcessId: null,
          updatedAt: new Date(0).toISOString(),
        }),
      );
      pageSessionIds.push(id);
      const definition = JSON.parse(processRow.draft) as { name: string };
      const draftId = `zz-page-draft-${suffix}`;
      insertProcess.run(
        draftId,
        processRow.organization_id,
        processRow.workspace_id,
        h.serviceId,
        JSON.stringify({ ...definition, name: `TEST page draft ${suffix}` }),
        processRow.updated_at,
      );
      pageDraftIds.push(draftId);
    }
    const foreignServiceId = await h.catalog({
      type: "saveService",
      revision: 0,
      settings: {
        name: "TEST other designer service",
        url: "https://other-services.example.test/v1",
        protocol: "openapi",
        icon: "database",
        auth: { type: "none" },
        enabled: true,
      },
    });
    const foreignSessionId = "zz-foreign-service-session";
    const foreignState = JSON.parse(sessionRow.data) as Record<string, unknown>;
    insertSession.run(
      foreignSessionId,
      sessionRow.organization_id,
      sessionRow.workspace_id,
      sessionRow.user_id,
      JSON.stringify({
        ...foreignState,
        id: foreignSessionId,
        serviceId: foreignServiceId,
        acceptedProcessId: null,
      }),
    );
    insertProcess.run(
      "zz-foreign-service-draft",
      processRow.organization_id,
      processRow.workspace_id,
      foreignServiceId,
      processRow.draft,
      processRow.updated_at,
    );
    const foreignActorSessionId = "zz-foreign-actor-session";
    const foreignActorState = JSON.parse(sessionRow.data) as Record<
      string,
      unknown
    >;
    insertSession.run(
      foreignActorSessionId,
      sessionRow.organization_id,
      sessionRow.workspace_id,
      "TEST-foreign-user",
      JSON.stringify({
        ...foreignActorState,
        id: foreignActorSessionId,
        acceptedProcessId: null,
      }),
    );
    return {
      foreignServiceId,
      foreignSessionId,
      foreignActorSessionId,
      existingDraftId: processRow.id,
      pageSessionIds,
      pageDraftIds,
    };
  };
  const serviceDraftIds = (serviceId: string) => {
    assert(credential, "TEST designer fixture must be paired before reading");
    return (
      h.identity["db"]
        .prepare(
          `SELECT id FROM agent_service_process
           WHERE organization_id=? AND workspace_id=? AND service_id=?
             AND owner_type='service' ORDER BY id`,
        )
        .all(h.target.organizationId, h.target.workspaceId, serviceId) as {
        id: string;
      }[]
    ).map((row) => row.id);
  };

  return {
    ...h,
    get identity() {
      return h.identity;
    },
    configure,
    enableDesignerProposal: () => {
      designerProposalEnabled = true;
      designerModelStep = 0;
    },
    seedDesignerPages,
    serviceDraftIds,
    seedMeeting,
    moveMeetingOutsidePairedUserScope,
    inspect,
    issuePairing: async () => {
      const result = await h.request(
        "owner",
        "api/identity/mobile/pairing",
        h.target,
      );
      assert.equal(result.status, 200);
      const issued = h.record(result.data);
      return { address: String(issued.address), code: String(issued.code) };
    },
    hold: (stage: MobileFixtureHold) => {
      assert(!holds.has(stage), "TEST stage is already held");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(stage, { gate, release, entered: false });
    },
    release: (stage?: MobileFixtureHold) => {
      for (const [key, held] of holds)
        if (!stage || key === stage) held.release();
    },
    revokeDevice: (accessToken?: string) => {
      const token = accessToken ?? credential?.accessToken;
      assert(token);
      return h.identity.revokeMobile("Bearer " + token);
    },
    disableService: async () => {
      const service = h.identity["catalog"].store.service(
        h.target.workspaceId,
        h.serviceId,
      );
      await h.catalog({
        type: "saveService",
        id: service.id,
        revision: service.revision,
        settings: { ...ServiceSettings.strip().parse(service), enabled: false },
      });
    },
    disableAction: async () => {
      const service = h.identity["catalog"].store.service(
        h.target.workspaceId,
        h.serviceId,
      );
      const action = service.actions.find((a) => a.id === h.writeId)!;
      await h.catalog({
        type: "saveAction",
        id: action.id,
        revision: action.revision,
        serviceId: service.id,
        serviceRevision: service.revision,
        settings: { ...ActionSettings.strip().parse(action), enabled: false },
      });
    },
    disableModel: async () => {
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
    },
    disableMemory: async () => {
      const current = h.identity["plugins"].read(h.target.workspaceId);
      const result = await h.request("owner", "api/identity/plugins", {
        ...h.target,
        revision: current.revision,
        settings: {
          ...current.settings,
          enabled: current.settings.enabled.filter((id) => id !== "memory"),
        },
      });
      assert.equal(result.status, 200);
    },
    revokeMembership: async () => {
      assert(credential);
      const member = h.identity["db"]
        .prepare(
          'SELECT id FROM member WHERE "organizationId"=? AND "userId"=?',
        )
        .get(h.target.organizationId, credential.scope.userId);
      assert(member);
      const result = await h.request("owner", "api/identity/command", {
        ...h.target,
        type: "setWorkspaceMember",
        memberId: String(member.id),
        allowed: false,
      });
      assert.equal(result.status, 200);
    },
    exhaustBudget: () => {
      const current = h.identity["catalog"].store.inferenceBudget;
      const policy = current.policy(
        h.target.organizationId,
        h.target.workspaceId,
      );
      current.savePolicy(
        h.target.organizationId,
        h.target.workspaceId,
        policy.revision,
        { ...policy.settings, maxTokens: 1 },
      );
    },
    loops: (
      id?: string,
      role: "owner" | "admin" | "member" | "anonymous" = "owner",
    ) =>
      h.request(
        role,
        `api/identity/loops${id ? "/" + encodeURIComponent(id) : ""}?${h.query}`,
      ),
    close: async () => {
      for (const held of holds.values()) held.release();
      await h.close();
    },
  };
}
