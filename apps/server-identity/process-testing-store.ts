import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { IdentityId, OrganizationRole } from "../../packages/protocol/identity";
import {
  PROCESS_NATIVE_TEST_PROFILE,
  NativeTestJobSchema,
  NativeTestReportSchema,
  NativeTestRequestSchema,
  NativeTestStampSchema,
  NativeTestExecutionSettingsSchema,
  NativeTestListQuerySchema,
  NativeTestListSchema,
  NativeTestSummarySchema,
  NativeTestDetailQuerySchema,
  NativeTestDetailSchema,
  type NativeTestJob,
  type NativeTestReport,
  type NativeTestRequest,
  type NativeTestListQuery,
  type NativeTestList,
  type NativeTestDetailQuery,
  PROCESS_NATIVE_TEST_DETAIL_PROFILE,
  NativeTestDetailV2QuerySchema,
  NativeTestDetailV2Schema,
  NativeTestDiagnosticSchema,
  type NativeTestDetailV2Query,
  type NativeTestDiagnostic,
} from "../../packages/protocol/process-native-testing";
import { ProcessTestCatalogSchema } from "./process-test-catalog";
import {
  PROCESS_TEST_PROFILE,
  ProcessTestJobSchema,
  ProcessTestReportSchema,
  ProcessTestRequestSchema,
  ProcessTestStampSchema,
  TestJsonSchema,
  type ProcessTestJob,
  type ProcessTestReport,
  type ProcessTestRequest,
} from "../../packages/protocol/process-testing";
import type { ServiceProcessStore, ProcessActor } from "./service-processes";
import type { AuditRecord } from "../../packages/protocol/audit";
import { processDigest } from "./process-validation";
import { IdentityError } from "./error";
import { assertDesignContent } from "./process-design-store";
import {
  nativeObservableAssertions,
  nativePassedBudget,
} from "./process-native-verdict";
import { NativeQualificationSummarySchema } from "../../packages/protocol/process-native-qualification";
import {
  deriveNativeQualification,
  nativeQualificationDigest,
} from "./process-native-qualification";

type Stamp = ProcessTestJob["stamp"];
const NativeEnvironmentSchema = z.strictObject({
  catalog: ProcessTestCatalogSchema,
  executionSettings: NativeTestExecutionSettingsSchema,
  authorityEpoch: z.number().int().nonnegative(),
});
export type NativeEnvironment = z.infer<typeof NativeEnvironmentSchema>;
const NativeCreatorSchema = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId,
  userId: IdentityId,
  role: OrganizationRole,
});
export type NativeEvidence = {
  creator: ProcessActor;
  request: NativeTestRequest;
  job: NativeTestJob;
  environment: NativeEnvironment;
};
type Job = ProcessTestJob | NativeTestJob;
type Request = ProcessTestRequest | NativeTestRequest;
type Stored = {
  creator: ProcessActor;
  request: Request;
  job: Job;
  environment?: NativeEnvironment;
  nativeDiagnostic?: NativeTestDiagnostic;
};
const commandKey = (
  serverId: unknown,
  organizationId: unknown,
  workspaceId: unknown,
  userId: unknown,
  requestId: unknown,
) =>
  processDigest([
    "process-contract-test/1",
    serverId,
    organizationId,
    workspaceId,
    userId,
    requestId,
  ]);

/** Construct once under the identity owner lock; every operation holds its queue. */
export class ProcessTestingStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly serverId: string,
    private readonly registry: ServiceProcessStore,
    private readonly audit: (record: AuditRecord) => void,
    private readonly now: () => number = Date.now,
  ) {
    // Explicit arguments keep stores sharing this connection independent of
    // which server most recently registered the deterministic SQL function.
    db.function(
      "niaro_process_test_command_key",
      { deterministic: true },
      commandKey,
    );
    db.exec(`CREATE TABLE IF NOT EXISTS agent_process_contract_test (
      command_key TEXT PRIMARY KEY, test_id TEXT UNIQUE NOT NULL,
      process_id TEXT NOT NULL REFERENCES agent_service_process(id) ON DELETE CASCADE,
      data TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS agent_process_contract_test_terminal
      BEFORE UPDATE ON agent_process_contract_test
      WHEN json_extract(OLD.data,'$.job.status') <> 'running'
      BEGIN SELECT RAISE(ABORT,'process_contract_test_immutable'); END;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_process_test_running
      ON agent_process_contract_test(process_id) WHERE json_extract(data,'$.job.status')='running';`);
    // A separate INTEGER PRIMARY KEY preserves reservation order through VACUUM.
    // Historical jobs have no trustworthy admission ordinal and are not backfilled.
    db.exec(`CREATE TABLE IF NOT EXISTS agent_process_native_test_admission (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id TEXT UNIQUE NOT NULL REFERENCES agent_process_contract_test(test_id) ON DELETE CASCADE,
      server_id TEXT NOT NULL, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      process_id TEXT NOT NULL, version INTEGER NOT NULL,
      FOREIGN KEY(process_id,version) REFERENCES agent_service_process_version(process_id,version) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_process_native_test_admission_scope
      ON agent_process_native_test_admission(server_id,organization_id,workspace_id,process_id,version,seq);
    CREATE TRIGGER IF NOT EXISTS agent_process_native_test_admission_immutable
      BEFORE UPDATE ON agent_process_native_test_admission
      BEGIN SELECT RAISE(ABORT,'process_native_test_admission_immutable'); END;`);
    this.atomic(() => {
      const rows = db
        .prepare(
          "SELECT data FROM agent_process_contract_test WHERE json_extract(data,'$.job.status')='running'",
        )
        .all();
      for (const row of rows) {
        const stored = this.parse(row.data);
        stored.job.status = "interrupted";
        stored.job.failure = "test_server_restarted";
        stored.job.updatedAt = this.time();
        this.save(stored);
        this.event(
          stored,
          stored.job.profile === PROCESS_NATIVE_TEST_PROFILE
            ? "native_test_interrupted"
            : "contract_test_interrupted",
          "interrupted",
          "recovery",
        );
      }
    });
  }
  private time() {
    return new Date(this.now()).toISOString();
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT process_contract_test_mutation");
    try {
      const value = fn();
      this.db.exec("RELEASE process_contract_test_mutation");
      return value;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO process_contract_test_mutation; RELEASE process_contract_test_mutation",
      );
      throw error;
    }
  }
  private key(actor: ProcessActor, requestId: string) {
    return commandKey(
      this.serverId,
      actor.organizationId,
      actor.workspaceId,
      actor.userId,
      requestId,
    );
  }
  private parse(value: unknown): Stored {
    const raw: Stored = JSON.parse(String(value));
    const native = raw.job.profile === PROCESS_NATIVE_TEST_PROFILE;
    const diagnostic =
      native && raw.nativeDiagnostic !== undefined
        ? NativeTestDiagnosticSchema.safeParse(raw.nativeDiagnostic)
        : undefined;
    if (diagnostic && !diagnostic.success)
      throw new IdentityError(409, "process_test_conflict");
    const stored: Stored = {
      creator: raw.creator,
      request: native
        ? NativeTestRequestSchema.parse(raw.request)
        : ProcessTestRequestSchema.parse(raw.request),
      job: native
        ? NativeTestJobSchema.parse(raw.job)
        : ProcessTestJobSchema.parse(raw.job),
      ...(native
        ? { environment: NativeEnvironmentSchema.parse(raw.environment) }
        : {}),
      ...(diagnostic?.success ? { nativeDiagnostic: diagnostic.data } : {}),
    };
    if (stored.nativeDiagnostic) {
      if (
        stored.job.status !== "interrupted" ||
        stored.job.failure !== "test_runner_failed" ||
        stored.job.report ||
        (stored.job as NativeTestJob).qualification
      )
        throw new IdentityError(409, "process_test_conflict");
      this.assertDiagnostic(stored, stored.nativeDiagnostic);
    }
    if (
      stored.job.profile === PROCESS_NATIVE_TEST_PROFILE &&
      stored.job.qualification
    ) {
      const { qualificationDigest, ...qualification } =
        stored.job.qualification;
      if (
        qualification.creatorUserId !== stored.creator.userId ||
        qualification.organizationId !== stored.creator.organizationId ||
        qualification.workspaceId !== stored.creator.workspaceId ||
        qualification.reportDigest !== processDigest(stored.job.report) ||
        qualification.environmentDigest !== processDigest(stored.environment) ||
        qualificationDigest !== nativeQualificationDigest(qualification)
      )
        throw new IdentityError(409, "process_test_conflict");
    }
    return stored;
  }
  private assertDiagnostic(stored: Stored, diagnostic: NativeTestDiagnostic) {
    if (
      stored.job.profile !== PROCESS_NATIVE_TEST_PROFILE ||
      !("profile" in stored.request) ||
      !stored.environment
    )
      throw new IdentityError(409, "process_test_conflict");
    const facts = diagnostic.evidence;
    if (!facts) return;
    const item = stored.request.suite.cases.find((c) => c.id === facts.caseId);
    if (
      !item ||
      item.scenario !== facts.scenario ||
      (facts.modelCalls !== undefined &&
        facts.modelCalls > item.models[facts.strategy].length) ||
      (facts.approvals !== undefined &&
        facts.approvals >
          item.actions.filter((a) => a.decision !== "none").length) ||
      facts.receipts?.some(
        (r) =>
          !stored.environment!.catalog.services.some(
            (s) =>
              s.id === r.serviceId &&
              s.revision === r.serviceRevision &&
              s.actions.some(
                (a) =>
                  a.id === r.actionId &&
                  a.revision === r.actionRevision &&
                  a.effect === r.effect,
              ),
          ),
      )
    )
      throw new IdentityError(409, "process_test_conflict");
  }
  private own(actor: ProcessActor, stored: Stored) {
    // Creator-private. A member's tests exist only for a personal process they
    // still own; anything else is not theirs (404, as for another admin).
    if (
      (actor.role === "member" &&
        !this.registry.canManage(actor, stored.job.processId)) ||
      actor.organizationId !== stored.creator.organizationId ||
      actor.workspaceId !== stored.creator.workspaceId ||
      actor.userId !== stored.creator.userId
    )
      throw new IdentityError(404, "process_test_not_found");
  }
  private lookup(actor: ProcessActor, testId: string): Stored {
    const row = this.db
      .prepare(
        "SELECT command_key,test_id,process_id,data FROM agent_process_contract_test WHERE test_id=?",
      )
      .get(testId);
    if (!row) throw new IdentityError(404, "process_test_not_found");
    const stored = this.parse(row.data);
    this.own(actor, stored);
    if (
      row.command_key !== this.key(actor, stored.request.requestId) ||
      row.test_id !== stored.job.testId ||
      row.process_id !== stored.job.processId ||
      (stored.job.profile === PROCESS_NATIVE_TEST_PROFILE &&
        stored.job.qualification &&
        stored.job.qualification.serverId !== this.serverId)
    )
      throw new IdentityError(404, "process_test_not_found");
    return stored;
  }
  private save(stored: Stored) {
    if (stored.job.profile === PROCESS_NATIVE_TEST_PROFILE)
      NativeTestJobSchema.parse(stored.job);
    else ProcessTestJobSchema.parse(stored.job);
    this.db
      .prepare("UPDATE agent_process_contract_test SET data=? WHERE test_id=?")
      .run(JSON.stringify(stored), stored.job.testId);
  }
  private event(
    stored: Stored,
    processEvent: NonNullable<AuditRecord["details"]["processEvent"]>,
    outcome: AuditRecord["outcome"],
    source: AuditRecord["source"] = "console",
  ) {
    this.audit({
      organizationId: stored.creator.organizationId,
      workspaceId: stored.creator.workspaceId,
      actorId: stored.creator.userId,
      source,
      action: "catalog.process_changed",
      targetId: stored.job.testId,
      outcome,
      details: { processEvent, processVersion: stored.job.version },
    });
  }
  private admit(actor: ProcessActor, raw: Request) {
    TestJsonSchema.parse(raw);
    assertDesignContent(raw);
    const request =
      raw && typeof raw === "object" && "profile" in raw
        ? NativeTestRequestSchema.parse(raw)
        : ProcessTestRequestSchema.parse(raw);
    if (
      request.organizationId !== actor.organizationId ||
      request.workspaceId !== actor.workspaceId
    )
      throw new IdentityError(403, "identity_forbidden");
    // A member may test only a personal process they own. Owners/admins keep
    // their original path; the registry still refuses someone else's personal one.
    if (actor.role === "member")
      this.registry.assertAccess(actor, request.processId, "manage");
    return request;
  }
  private replayValue(actor: ProcessActor, request: Request): Job | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM agent_process_contract_test WHERE command_key=?",
      )
      .get(this.key(actor, request.requestId));
    if (!row) return;
    const previous = this.parse(row.data);
    this.own(actor, previous);
    if (
      previous.job.profile === PROCESS_NATIVE_TEST_PROFILE &&
      previous.job.qualification &&
      previous.job.qualification.serverId !== this.serverId
    )
      throw new IdentityError(404, "process_test_not_found");
    if (processDigest(previous.request) !== processDigest(request))
      throw new IdentityError(409, "process_test_conflict");
    this.registry.version(actor, previous.job.processId, previous.job.version);
    return structuredClone(previous.job);
  }
  replay(actor: ProcessActor, request: ProcessTestRequest) {
    const job = this.replayValue(actor, this.admit(actor, request));
    return job ? ProcessTestJobSchema.parse(job) : undefined;
  }
  replayNative(actor: ProcessActor, request: NativeTestRequest) {
    const job = this.replayValue(actor, this.admit(actor, request));
    return job ? NativeTestJobSchema.parse(job) : undefined;
  }
  reserve(
    actor: ProcessActor,
    request: ProcessTestRequest,
    stamp: Stamp,
  ): { created: boolean; job: ProcessTestJob } {
    const result = this.reserveValue(actor, request, stamp);
    return {
      created: result.created,
      job: ProcessTestJobSchema.parse(result.job),
    };
  }
  reserveNative(
    actor: ProcessActor,
    request: NativeTestRequest,
    stamp: NativeTestJob["stamp"],
    environment: NativeEnvironment,
  ): { created: boolean; job: NativeTestJob } {
    const result = this.reserveValue(actor, request, stamp, environment);
    return {
      created: result.created,
      job: NativeTestJobSchema.parse(result.job),
    };
  }
  private reserveValue(
    actor: ProcessActor,
    raw: Request,
    rawStamp: Stamp | NativeTestJob["stamp"],
    rawEnvironment?: NativeEnvironment,
  ) {
    const request = this.admit(actor, raw);
    const replay = this.replayValue(actor, request);
    if (replay) return { created: false, job: replay };
    const native = "profile" in request;
    const stamp = native
      ? NativeTestStampSchema.parse(rawStamp)
      : ProcessTestStampSchema.parse(rawStamp);
    const environment = native
      ? NativeEnvironmentSchema.parse(rawEnvironment)
      : undefined;
    if (environment) {
      TestJsonSchema.parse(environment.catalog);
      assertDesignContent(environment.catalog);
      if (
        environment.catalog.organizationId !== actor.organizationId ||
        environment.catalog.workspaceId !== actor.workspaceId ||
        environment.catalog.userId !== actor.userId ||
        environment.catalog.role !== actor.role ||
        environment.catalog.budget.mode !== "enforce" ||
        processDigest(environment.catalog) !==
          (stamp as NativeTestJob["stamp"]).catalogDigest
      )
        throw new IdentityError(409, "process_test_conflict");
    }
    const artifact = this.registry.testArtifact(
      actor,
      request.processId,
      request.version,
    );
    if (
      artifact.digest !== request.artifactDigest ||
      stamp.artifactDigest !== artifact.digest ||
      stamp.sourcesDigest !== processDigest(artifact.sources) ||
      stamp.suiteDigest !== processDigest(request.suite)
    )
      throw new IdentityError(409, "process_test_conflict");
    return this.atomic(() => {
      const again = this.replayValue(actor, request);
      if (again) return { created: false, job: again };
      const process = this.registry.getOwned(actor, request.processId);
      if (
        native &&
        process.activeVersion === request.version &&
        request.retestActive !== true
      )
        throw new IdentityError(409, "process_test_active_version");
      if (process.revision !== request.revision)
        throw new IdentityError(409, "process_conflict");
      if (
        this.db
          .prepare(
            "SELECT 1 FROM agent_process_contract_test WHERE process_id=? AND json_extract(data,'$.job.status')='running'",
          )
          .get(request.processId)
      )
        throw new IdentityError(429, "process_test_busy");
      const stored: Stored = {
        creator: { ...actor },
        request,
        ...(environment ? { environment } : {}),
        job: {
          profile: native ? PROCESS_NATIVE_TEST_PROFILE : PROCESS_TEST_PROFILE,
          organizationId: actor.organizationId,
          workspaceId: actor.workspaceId,
          testId: randomUUID(),
          requestId: request.requestId,
          processId: request.processId,
          version: request.version,
          stamp,
          status: "running",
          report: null,
          failure: null,
          createdAt: this.time(),
          updatedAt: this.time(),
        } as Job,
      };
      this.db
        .prepare("INSERT INTO agent_process_contract_test VALUES (?,?,?,?)")
        .run(
          this.key(actor, request.requestId),
          stored.job.testId,
          request.processId,
          JSON.stringify(stored),
        );
      if (native)
        this.db
          .prepare(
            "INSERT INTO agent_process_native_test_admission(test_id,server_id,organization_id,workspace_id,process_id,version) VALUES (?,?,?,?,?,?)",
          )
          .run(
            stored.job.testId,
            this.serverId,
            actor.organizationId,
            actor.workspaceId,
            request.processId,
            request.version,
          );
      this.event(
        stored,
        native ? "native_test_started" : "contract_test_started",
        "running",
      );
      return { created: true, job: structuredClone(stored.job) };
    });
  }
  private readValue(actor: ProcessActor, testId: string) {
    const stored = this.lookup(actor, testId);
    this.registry.version(actor, stored.job.processId, stored.job.version);
    return structuredClone(stored.job);
  }
  read(actor: ProcessActor, testId: string): ProcessTestJob {
    const job = this.readValue(actor, testId);
    if (job.profile !== PROCESS_TEST_PROFILE)
      throw new IdentityError(404, "process_test_not_found");
    return ProcessTestJobSchema.parse(job);
  }
  readNative(actor: ProcessActor, testId: string): NativeTestJob {
    const job = this.readValue(actor, testId);
    if (job.profile !== PROCESS_NATIVE_TEST_PROFILE)
      throw new IdentityError(404, "process_test_not_found");
    return NativeTestJobSchema.parse(job);
  }
  /** Creator-private original command for recovery/retest; no environment escapes. */
  nativeDetail(
    actor: ProcessActor,
    raw: NativeTestDetailQuery | NativeTestDetailV2Query,
  ) {
    const v2 = raw.profile === PROCESS_NATIVE_TEST_DETAIL_PROFILE;
    const query = v2
      ? NativeTestDetailV2QuerySchema.parse(raw)
      : NativeTestDetailQuerySchema.parse(raw);
    // Creator-private; a member's evidence exists only for a personal process
    // they manage, and nativeEvidence re-checks registry access.
    if (
      actor.organizationId !== query.organizationId ||
      actor.workspaceId !== query.workspaceId
    )
      throw new IdentityError(403, "identity_forbidden");
    const testId =
      query.testId ??
      this.db
        .prepare(
          "SELECT test_id FROM agent_process_contract_test WHERE command_key=?",
        )
        .get(this.key(actor, query.requestId!))?.test_id;
    if (typeof testId !== "string")
      throw new IdentityError(404, "process_test_not_found");
    const { job, request } = this.nativeEvidence(actor, testId);
    if (query.requestId !== undefined && request.requestId !== query.requestId)
      throw new IdentityError(409, "process_test_conflict");
    if (!v2) return NativeTestDetailSchema.parse({ job, request });
    const stored = this.lookup(actor, testId);
    return NativeTestDetailV2Schema.parse({
      profile: PROCESS_NATIVE_TEST_DETAIL_PROFILE,
      job,
      request,
      diagnostic: stored.nativeDiagnostic ?? null,
    });
  }
  /** Trusted server boundary: original private evidence without source or runner resolution. */
  nativeEvidence(actor: ProcessActor, testId: string): NativeEvidence {
    const stored = this.lookup(actor, testId);
    if (
      stored.job.profile !== PROCESS_NATIVE_TEST_PROFILE ||
      !("profile" in stored.request) ||
      !stored.environment
    )
      throw new IdentityError(404, "process_test_not_found");
    const creator = NativeCreatorSchema.safeParse(stored.creator);
    // A member creator is valid only for a personal process they own.
    if (
      !creator.success ||
      (creator.data.role === "member" &&
        !this.registry.canManage(creator.data, stored.job.processId))
    )
      throw new IdentityError(409, "process_test_conflict");
    const { request, job, environment } = stored;
    const original = creator.data;
    const artifact = this.registry.version(actor, job.processId, job.version);
    if (
      job.testId !== testId ||
      request.organizationId !== original.organizationId ||
      request.workspaceId !== original.workspaceId ||
      job.organizationId !== original.organizationId ||
      job.workspaceId !== original.workspaceId ||
      request.requestId !== job.requestId ||
      request.processId !== job.processId ||
      request.version !== job.version ||
      environment.catalog.organizationId !== original.organizationId ||
      environment.catalog.workspaceId !== original.workspaceId ||
      environment.catalog.userId !== original.userId ||
      environment.catalog.role !== original.role ||
      environment.catalog.budget.mode !== "enforce" ||
      request.artifactDigest !== artifact.digest ||
      job.stamp.artifactDigest !== artifact.digest ||
      job.stamp.sourcesDigest !== processDigest(artifact.sources) ||
      job.stamp.suiteDigest !== processDigest(request.suite) ||
      job.stamp.catalogDigest !== processDigest(environment.catalog) ||
      (job.report &&
        (processDigest(job.report.stamp) !== processDigest(job.stamp) ||
          processDigest(job.report.executionSettings) !==
            processDigest(environment.executionSettings)))
    )
      throw new IdentityError(409, "process_test_conflict");
    return structuredClone({ creator: original, request, job, environment });
  }
  /** Latest reservation wins across creators, including running and interrupted
   * attempts. With `latest: false` it only proves this test's own durable
   * admission ordinal and namespace still exist (an active binding keeps
   * serving while a newer test runs, but never without its own proof). */
  assertLatestNative(
    actor: ProcessActor,
    processId: string,
    version: number,
    testId: string,
    latest = true,
  ): void {
    this.registry.version(actor, processId, version);
    const row = this.db
      .prepare(
        `SELECT admission.test_id,
          (test.process_id=admission.process_id AND json_extract(data,'$.job.profile')=?
          AND json_extract(data,'$.request.profile')=json_extract(data,'$.job.profile')
          AND json_extract(data,'$.job.processId')=admission.process_id
          AND json_extract(data,'$.request.processId')=admission.process_id
          AND json_extract(data,'$.creator.organizationId')=admission.organization_id
          AND json_extract(data,'$.creator.workspaceId')=admission.workspace_id
          AND (json_extract(data,'$.creator.role') IN ('owner','admin')
            OR (json_extract(data,'$.creator.role')='member' AND EXISTS (
              SELECT 1 FROM agent_service_process AS personal
              WHERE personal.id=admission.process_id AND personal.owner_type='user'
                AND personal.owner_user_id=json_extract(data,'$.creator.userId'))))
          AND json_extract(data,'$.job.organizationId')=json_extract(data,'$.creator.organizationId')
          AND json_extract(data,'$.job.workspaceId')=json_extract(data,'$.creator.workspaceId')
          AND json_extract(data,'$.request.organizationId')=json_extract(data,'$.creator.organizationId')
          AND json_extract(data,'$.request.workspaceId')=json_extract(data,'$.creator.workspaceId')
          AND json_extract(data,'$.job.version')=admission.version
          AND json_extract(data,'$.request.version')=json_extract(data,'$.job.version')
          AND json_extract(data,'$.job.requestId')=json_extract(data,'$.request.requestId')
          AND json_extract(data,'$.job.testId')=test.test_id
          AND command_key=niaro_process_test_command_key(admission.server_id,
            json_extract(data,'$.creator.organizationId'),
            json_extract(data,'$.creator.workspaceId'),
            json_extract(data,'$.creator.userId'),
            json_extract(data,'$.request.requestId'))) AS valid_namespace
        FROM agent_process_native_test_admission AS admission
        LEFT JOIN agent_process_contract_test AS test ON test.test_id=admission.test_id
        WHERE admission.server_id=? AND admission.organization_id=?
          AND admission.workspace_id=? AND admission.process_id=? AND admission.version=?
          ${latest ? "" : "AND admission.test_id=?"}
        ORDER BY admission.seq DESC LIMIT 1`,
      )
      .get(
        PROCESS_NATIVE_TEST_PROFILE,
        this.serverId,
        actor.organizationId,
        actor.workspaceId,
        processId,
        version,
        ...(latest ? [] : [testId]),
      );
    if (!row || row.test_id !== testId || row.valid_namespace !== 1)
      throw new IdentityError(409, "process_test_superseded");
  }
  listNative(actor: ProcessActor, raw: NativeTestListQuery): NativeTestList {
    const query = NativeTestListQuerySchema.parse(raw);
    if (
      actor.organizationId !== query.organizationId ||
      actor.workspaceId !== query.workspaceId
    )
      throw new IdentityError(403, "identity_forbidden");
    // Registry read access: a member only for their own personal process.
    this.registry.getOwned(actor, query.processId);
    if (query.version !== undefined)
      this.registry.version(actor, query.processId, query.version);
    const predicates = `process_id=? AND json_extract(data,'$.job.profile')=?
      AND json_extract(data,'$.creator.organizationId')=?
      AND json_extract(data,'$.creator.workspaceId')=?
      AND json_extract(data,'$.creator.userId')=?
      AND json_extract(data,'$.job.organizationId')=json_extract(data,'$.creator.organizationId')
      AND json_extract(data,'$.job.workspaceId')=json_extract(data,'$.creator.workspaceId')
      AND command_key=niaro_process_test_command_key(?,
        json_extract(data,'$.creator.organizationId'),
        json_extract(data,'$.creator.workspaceId'),
        json_extract(data,'$.creator.userId'),
        json_extract(data,'$.request.requestId'))
      AND (? IS NULL OR json_extract(data,'$.job.version')=?)`;
    const parameters = [
      query.processId,
      query.profile,
      actor.organizationId,
      actor.workspaceId,
      actor.userId,
      this.serverId,
      query.version ?? null,
      query.version ?? null,
    ];
    if (
      query.after &&
      !this.db
        .prepare(
          `
      SELECT 1 FROM agent_process_contract_test WHERE ${predicates} AND test_id=?
    `,
        )
        .get(...parameters, query.after)
    )
      throw new IdentityError(404, "process_test_not_found");
    const rows = this.db
      .prepare(
        `
      SELECT json_remove(json_extract(data,'$.job'),'$.report') AS metadata,
        json_extract(data,'$.job.report.status') AS report_status,
        json_extract(data,'$.job.report.comparison') AS comparison
      FROM agent_process_contract_test
        WHERE ${predicates}
        AND (? IS NULL OR test_id>?)
      ORDER BY test_id LIMIT ?
    `,
      )
      .all(
        ...parameters,
        query.after ?? null,
        query.after ?? null,
        query.limit + 1,
      );
    const summaries = rows.slice(0, query.limit).map((row) =>
      NativeTestSummarySchema.parse({
        ...this.summaryMetadata(row.metadata),
        reportStatus: row.report_status,
        comparison:
          row.comparison === null ? null : JSON.parse(String(row.comparison)),
      }),
    );
    return NativeTestListSchema.parse({
      organizationId: query.organizationId,
      workspaceId: query.workspaceId,
      profile: query.profile,
      summaries,
      nextAfter: rows.length > query.limit ? summaries.at(-1)!.testId : null,
    });
  }
  private summaryMetadata(raw: unknown) {
    const metadata = JSON.parse(String(raw));
    if (metadata.qualification) {
      const q = metadata.qualification;
      metadata.qualification = NativeQualificationSummarySchema.parse({
        policy: q.policy,
        scope: q.scope,
        liveAcceptance: q.liveAcceptance,
        status: q.status,
        reasons: q.reasons,
        coverage: q.coverage,
        qualificationDigest: q.qualificationDigest,
      });
    }
    return metadata;
  }
  complete(actor: ProcessActor, testId: string, rawReport: ProcessTestReport) {
    return ProcessTestJobSchema.parse(
      this.completeValue(
        actor,
        testId,
        ProcessTestReportSchema.parse(rawReport),
      ),
    );
  }
  completeNative(
    actor: ProcessActor,
    testId: string,
    rawReport: NativeTestReport,
    current: Pick<NativeEnvironment, "catalog" | "authorityEpoch">,
  ) {
    return NativeTestJobSchema.parse(
      this.completeValue(
        actor,
        testId,
        NativeTestReportSchema.parse(rawReport),
        current,
      ),
    );
  }
  private completeValue(
    actor: ProcessActor,
    testId: string,
    report: ProcessTestReport | NativeTestReport,
    current?: Pick<NativeEnvironment, "catalog" | "authorityEpoch">,
  ) {
    return this.atomic(() => {
      const stored = this.lookup(actor, testId);
      if (stored.job.status !== "running")
        throw new IdentityError(409, "process_test_terminal");
      if (stored.job.profile !== report.profile)
        throw new IdentityError(409, "process_test_conflict");
      const artifact = this.registry.testArtifact(
        actor,
        stored.job.processId,
        stored.job.version,
      );
      if (processDigest(stored.job.stamp) !== processDigest(report.stamp))
        throw new IdentityError(409, "process_test_conflict");
      const nativeStrategies =
        "profile" in stored.request &&
        stored.request.suite.comparisonMode === "configured_only"
          ? ["configured"]
          : ["configured", "generic"];
      const expected =
        "profile" in stored.request
          ? stored.request.suite.cases.flatMap((c) =>
              nativeStrategies.map((strategy) => [c.id, c.scenario, strategy]),
            )
          : stored.request.suite.cases.map((c) => [c.id, c.scenario]);
      const observed =
        report.profile === PROCESS_NATIVE_TEST_PROFILE
          ? report.observations.map((o) => [o.caseId, o.scenario, o.strategy])
          : report.observations.map((o) => [o.caseId, o.scenario]);
      if (processDigest(expected.sort()) !== processDigest(observed.sort()))
        throw new IdentityError(409, "process_test_conflict");
      if (report.profile === PROCESS_NATIVE_TEST_PROFILE) {
        if (!("profile" in stored.request))
          throw new IdentityError(409, "process_test_conflict");
        if (report.comparison.mode !== stored.request.suite.comparisonMode)
          throw new IdentityError(409, "process_test_conflict");
        for (const observation of report.observations) {
          const item = stored.request.suite.cases.find(
            (c) => c.id === observation.caseId,
          )!;
          const required = nativeObservableAssertions(item, observation);
          const budget =
            stored.environment &&
            nativePassedBudget(
              item,
              observation.strategy,
              stored.environment.catalog,
              stored.environment.executionSettings.effectiveBudgetLimits,
            );
          const settings = stored.environment?.executionSettings;
          const nativeLimitExceeded =
            settings &&
            (observation.strategy === "generic"
              ? observation.modelCalls >
                  Math.min(
                    settings.genericSafetyLimits.maxModelCalls,
                    settings.genericSafetyLimits.maxInference,
                  ) ||
                observation.receipts.length >
                  settings.genericSafetyLimits.maxActionCalls
              : artifact.definition.kind === "agent" &&
                item.actions.every((f) => f.decision === "none") &&
                observation.modelCalls >
                  settings.nativeAgentMaxStepsPerInvocation);
          if (
            required.some(
              (assertion) => !observation.assertions.includes(assertion),
            ) ||
            (observation.passed &&
              (required.length > 0 ||
                nativeLimitExceeded ||
                observation.modelCalls !==
                  item.models[observation.strategy].length ||
                observation.budget.unknownCalls > 0 ||
                observation.budget.overrun ||
                !budget ||
                processDigest(budget) !== processDigest(observation.budget)))
          )
            throw new IdentityError(409, "process_test_conflict");
        }
        if (
          !current ||
          !stored.environment ||
          current.authorityEpoch !== stored.environment.authorityEpoch ||
          processDigest(current.catalog) !==
            processDigest(stored.environment.catalog)
        )
          throw new IdentityError(409, "process_sources_changed");
        if (
          processDigest(report.executionSettings) !==
          processDigest(stored.environment.executionSettings)
        )
          throw new IdentityError(409, "process_test_conflict");
      }
      stored.job.report = report;
      stored.job.status = report.status === "passed" ? "completed" : "failed";
      if (
        stored.job.profile === PROCESS_NATIVE_TEST_PROFILE &&
        report.profile === PROCESS_NATIVE_TEST_PROFILE &&
        "profile" in stored.request &&
        stored.environment
      ) {
        const qualification = {
          ...deriveNativeQualification(
            artifact,
            stored.request.suite,
            report,
            stored.environment.catalog,
          ),
          serverId: this.serverId,
          organizationId: stored.creator.organizationId,
          workspaceId: stored.creator.workspaceId,
          creatorUserId: stored.creator.userId,
          testId: stored.job.testId,
          processId: stored.job.processId,
          version: stored.job.version,
          stamp: stored.job.stamp,
          reportDigest: processDigest(report),
          environmentDigest: processDigest(stored.environment),
        };
        stored.job.qualification = {
          ...qualification,
          qualificationDigest: nativeQualificationDigest(qualification),
        };
      }
      stored.job.updatedAt = this.time();
      this.save(stored);
      this.event(
        stored,
        report.profile === PROCESS_NATIVE_TEST_PROFILE
          ? "native_test_completed"
          : "contract_test_completed",
        report.status === "passed" ? "succeeded" : "failed",
      );
      if (
        stored.job.profile === PROCESS_NATIVE_TEST_PROFILE &&
        stored.job.qualification
      )
        this.event(
          stored,
          stored.job.qualification.status === "qualified"
            ? "native_test_qualified"
            : "native_test_qualification_failed",
          stored.job.qualification.status === "qualified"
            ? "succeeded"
            : "failed",
        );
      return structuredClone(stored.job);
    });
  }
  /** Private cleanup with the reserved creator; revocation cannot publish a staged report. */
  interrupt(
    actor: ProcessActor,
    testId: string,
    failure: NonNullable<ProcessTestJob["failure"]>,
    diagnostic?: {
      value: NativeTestDiagnostic;
      stamp: NativeTestJob["stamp"];
      current: Pick<NativeEnvironment, "catalog" | "authorityEpoch">;
    },
  ) {
    return this.atomic(() => {
      const stored = this.lookup(actor, testId);
      if (stored.job.status !== "running") return structuredClone(stored.job);
      if (diagnostic) {
        const value = NativeTestDiagnosticSchema.parse(diagnostic.value);
        if (
          failure !== "test_runner_failed" ||
          !stored.environment ||
          processDigest(diagnostic.stamp) !== processDigest(stored.job.stamp) ||
          diagnostic.current.authorityEpoch !==
            stored.environment.authorityEpoch ||
          processDigest(diagnostic.current.catalog) !==
            processDigest(stored.environment.catalog)
        )
          throw new IdentityError(409, "process_test_conflict");
        this.nativeEvidence(actor, testId);
        this.assertDiagnostic(stored, value);
        stored.nativeDiagnostic = structuredClone(value);
      }
      stored.job.status = "interrupted";
      stored.job.failure = failure;
      stored.job.updatedAt = this.time();
      this.save(stored);
      this.event(
        stored,
        stored.job.profile === PROCESS_NATIVE_TEST_PROFILE
          ? "native_test_interrupted"
          : "contract_test_interrupted",
        "interrupted",
      );
      return structuredClone(stored.job);
    });
  }
}
