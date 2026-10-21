import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  PROCESS_ACTIVATION_PROFILE,
  ProcessActivationCommandSchema,
  ProcessActivationReceiptSchema,
  ProcessActivationReviewSchema,
  type ProcessActivationCommand,
  type ProcessActivationReceipt,
  type ProcessActivationReviewQuery,
} from "../../packages/protocol/process-activation";
import { NativeQualificationSummarySchema } from "../../packages/protocol/process-native-qualification";
import type { AuditRecord } from "../../packages/protocol/audit";
import type { ServiceCatalogStore } from "./service-catalog";
import {
  PROCESS_TEST_SCENARIOS,
  type ServiceProcessStore,
  type ProcessActor,
  type NativeProcessQualificationReference,
} from "./service-processes";
import type { ProcessTestingStore } from "./process-testing-store";
import {
  processNativeStamp,
  processNativeExecutionSettings,
} from "./process-native-environment";
import { processDigest } from "./process-validation";
import { IdentityError } from "./error";

type StoredDecision = {
  actor: ProcessActor;
  command: ProcessActivationCommand;
  receipt: ProcessActivationReceipt;
};
type Authority = {
  epoch: (organizationId: string) => number;
  creatorActor: (original: ProcessActor) => ProcessActor;
};

/** Synchronous human metadata decisions under the existing identity owner queue. */
export class ProcessActivationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly serverId: string,
    private readonly registry: ServiceProcessStore,
    private readonly catalog: ServiceCatalogStore,
    private readonly journal: ProcessTestingStore,
    private readonly audit: (record: AuditRecord) => void,
    private readonly authority: Authority,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_process_activation_command (
      command_key TEXT PRIMARY KEY, process_id TEXT NOT NULL
        REFERENCES agent_service_process(id) ON DELETE CASCADE,
      data TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS agent_process_activation_immutable
      BEFORE UPDATE ON agent_process_activation_command
      BEGIN SELECT RAISE(ABORT,'process_activation_immutable'); END;`);
    registry.attachNativeQualificationGate((actor, artifact, reference) => {
      if (reference.serverId !== this.serverId)
        throw new IdentityError(409, "process_qualification_unavailable");
      const creator = this.authority.creatorActor({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        userId: reference.creatorUserId,
        role: "owner",
      });
      // Checked before reading the creator-private journal so that a demoted
      // or departed qualifier reports the same code for every process kind.
      if (!this.registry.canManage(creator, artifact.processId))
        throw new IdentityError(409, "process_qualification_authority_changed");
      // The accepted binding keeps serving its active version while a newer
      // test of that version runs, fails or passes. Only a new human decision
      // (which requires the latest test) replaces it.
      this.current(
        creator,
        artifact.processId,
        artifact.version,
        reference,
        false,
      );
    });
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT process_activation");
    try {
      const value = fn();
      this.db.exec("RELEASE process_activation");
      return value;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO process_activation; RELEASE process_activation",
      );
      throw error;
    }
  }
  private actor(
    actor: ProcessActor,
    target: {
      organizationId: string;
      workspaceId: string;
    },
  ) {
    if (
      actor.organizationId !== target.organizationId ||
      actor.workspaceId !== target.workspaceId
    )
      throw new IdentityError(403, "identity_forbidden");
  }
  private key(actor: ProcessActor, requestId: string) {
    return processDigest([
      PROCESS_ACTIVATION_PROFILE,
      this.serverId,
      actor.organizationId,
      actor.workspaceId,
      actor.userId,
      requestId,
    ]);
  }
  private stored(actor: ProcessActor, requestId: string) {
    const row = this.db
      .prepare(
        "SELECT process_id,data FROM agent_process_activation_command WHERE command_key=?",
      )
      .get(this.key(actor, requestId));
    if (!row) return;
    const raw = JSON.parse(String(row.data)) as StoredDecision;
    const command = ProcessActivationCommandSchema.parse(raw.command);
    const receipt = ProcessActivationReceiptSchema.parse(raw.receipt);
    if (
      raw.actor.userId !== actor.userId ||
      raw.actor.organizationId !== actor.organizationId ||
      raw.actor.workspaceId !== actor.workspaceId ||
      command.organizationId !== actor.organizationId ||
      command.workspaceId !== actor.workspaceId ||
      command.requestId !== requestId ||
      row.process_id !== command.processId ||
      receipt.serverId !== this.serverId ||
      processDigest(command) !==
        processDigest(
          ProcessActivationCommandSchema.parse(
            Object.fromEntries(
              Object.keys(command).map((key) => [
                key,
                receipt[key as keyof typeof receipt],
              ]),
            ),
          ),
        )
    )
      throw new IdentityError(409, "process_activation_conflict");
    // Metadata scope only. Historical replay does not resolve current sources.
    this.registry.getOwned(actor, command.processId);
    return { command, receipt };
  }
  read(actor: ProcessActor, requestId: string) {
    this.actor(actor, actor);
    const result = this.stored(actor, requestId);
    if (!result) throw new IdentityError(404, "process_activation_not_found");
    return structuredClone(result.receipt);
  }
  private current(
    actor: ProcessActor,
    processId: string,
    version: number,
    reference: Pick<
      NativeProcessQualificationReference,
      "testId" | "qualificationDigest"
    >,
    requireLatest = true,
  ) {
    const evidence = this.journal.nativeEvidence(actor, reference.testId);
    const { job, request, environment, creator } = evidence;
    const q = job.qualification;
    if (
      job.processId !== processId ||
      job.version !== version ||
      job.status !== "completed" ||
      !q ||
      q.status !== "qualified" ||
      q.serverId !== this.serverId ||
      q.qualificationDigest !== reference.qualificationDigest
    )
      throw new IdentityError(409, "process_qualification_required");
    this.journal.assertLatestNative(
      actor,
      processId,
      version,
      job.testId,
      requireLatest,
    );
    const currentCreator = this.authority.creatorActor(creator);
    // The qualifying person must still be allowed to manage this exact process:
    // an owner/admin for a workspace or service process, the owner for a
    // personal one. Losing that authority stops the qualification serving runs.
    if (
      currentCreator.organizationId !== creator.organizationId ||
      currentCreator.workspaceId !== creator.workspaceId ||
      currentCreator.userId !== creator.userId ||
      !this.registry.canManage(currentCreator, processId)
    )
      throw new IdentityError(409, "process_qualification_authority_changed");
    const artifact = this.registry.testArtifact(
      currentCreator,
      processId,
      version,
    );
    if (request.suite.genericModelId)
      this.catalog.processModelMetadata(
        actor.organizationId,
        request.suite.genericModelId,
      );
    const catalog = this.catalog.processTestCatalog(
      actor.organizationId,
      actor.workspaceId,
      currentCreator,
      artifact.sources,
      request.suite.genericModelId,
    );
    // The qualification pins what this process actually uses: the creator's
    // current view of its sources, models, providers and grants (catalog) and
    // its execution settings. The organization-wide authority epoch also moves
    // for unrelated people and services, so it is carried over from the saved
    // environment instead of being compared; each run still enforces its own
    // actor's current permissions.
    const currentEnvironment = {
      catalog,
      authorityEpoch: environment.authorityEpoch,
      executionSettings: processNativeExecutionSettings(artifact, catalog),
    };
    if (
      artifact.digest !== q.stamp.artifactDigest ||
      processDigest(processNativeStamp(artifact, catalog, request.suite)) !==
        processDigest(q.stamp) ||
      processDigest(currentEnvironment) !== processDigest(environment) ||
      processDigest(currentEnvironment) !== q.environmentDigest
    )
      throw new IdentityError(409, "process_qualification_stale");
    return { artifact, qualification: q };
  }
  private summary(
    q: NonNullable<
      ReturnType<ProcessTestingStore["nativeEvidence"]>["job"]["qualification"]
    >,
  ) {
    return NativeQualificationSummarySchema.parse({
      policy: q.policy,
      scope: q.scope,
      liveAcceptance: q.liveAcceptance,
      status: q.status,
      reasons: q.reasons,
      coverage: q.coverage,
      qualificationDigest: q.qualificationDigest,
    });
  }
  private previouslyActivated(
    actor: ProcessActor,
    processId: string,
    version: number,
  ) {
    return !!this.db
      .prepare(
        `SELECT 1 FROM agent_process_activation_command
      WHERE process_id=? AND json_extract(data,'$.receipt.serverId')=?
      AND json_extract(data,'$.receipt.organizationId')=?
      AND json_extract(data,'$.receipt.workspaceId')=?
      AND json_extract(data,'$.receipt.activeVersion')=? LIMIT 1`,
      )
      .get(
        processId,
        this.serverId,
        actor.organizationId,
        actor.workspaceId,
        version,
      );
  }
  review(actor: ProcessActor, input: ProcessActivationReviewQuery) {
    this.actor(actor, input);
    const job = this.journal.nativeEvidence(actor, input.testId).job;
    if (!job.qualification)
      throw new IdentityError(409, "process_qualification_required");
    const { artifact, qualification } = this.current(
      actor,
      input.processId,
      input.version,
      {
        testId: input.testId,
        qualificationDigest: job.qualification.qualificationDigest,
      },
    );
    const process = this.registry.getOwned(actor, input.processId);
    return ProcessActivationReviewSchema.parse({
      profile: PROCESS_ACTIVATION_PROFILE,
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      processId: input.processId,
      revision: process.revision,
      activeVersion: process.activeVersion,
      version: artifact.version,
      artifactDigest: artifact.digest,
      testId: input.testId,
      qualification: this.summary(qualification),
      canActivate:
        artifact.version === process.latestVersion &&
        processDigest(process.draft) === processDigest(artifact.definition),
      canRollback: this.previouslyActivated(
        actor,
        input.processId,
        artifact.version,
      ),
    });
  }
  decide(actor: ProcessActor, raw: ProcessActivationCommand) {
    const command = ProcessActivationCommandSchema.parse(raw);
    this.actor(actor, command);
    const previous = this.stored(actor, command.requestId);
    if (previous) {
      if (processDigest(previous.command) !== processDigest(command))
        throw new IdentityError(409, "process_activation_conflict");
      return structuredClone(previous.receipt);
    }
    return this.atomic(() => {
      const process = this.registry.getOwned(actor, command.processId);
      if (
        process.revision !== command.revision ||
        process.activeVersion !== command.expectedActiveVersion
      )
        throw new IdentityError(409, "process_conflict");
      const { artifact, qualification } = this.current(
        actor,
        command.processId,
        command.version,
        command,
      );
      if (artifact.digest !== command.artifactDigest)
        throw new IdentityError(409, "process_activation_conflict");
      if (command.type === "rollback") {
        if (
          !this.previouslyActivated(actor, command.processId, command.version)
        )
          throw new IdentityError(409, "process_rollback_unavailable");
      } else if (
        artifact.version !== process.latestVersion ||
        processDigest(process.draft) !== processDigest(artifact.definition)
      ) {
        throw new IdentityError(409, "process_activation_version_changed");
      }
      this.registry.recordNativeQualification(
        actor,
        command.processId,
        command.version,
        {
          testId: qualification.testId,
          digest: artifact.digest,
          runnerVersion: qualification.stamp.runnerVersion,
          passed: true,
          scenarios: [...PROCESS_TEST_SCENARIOS],
          reportDigest: qualification.reportDigest,
        },
        {
          serverId: this.serverId,
          creatorUserId: actor.userId,
          testId: qualification.testId,
          qualificationDigest: qualification.qualificationDigest,
        },
      );
      const tested = this.registry.getOwned(actor, command.processId);
      const activated = this.registry.activate(
        actor,
        command.processId,
        tested.revision,
        command.version,
      );
      const receipt = ProcessActivationReceiptSchema.parse({
        ...command,
        receiptId: randomUUID(),
        serverId: this.serverId,
        activeVersion: activated.activeVersion,
        resultingRevision: activated.revision,
        qualification: this.summary(qualification),
        createdAt: new Date(this.now()).toISOString(),
      });
      this.db
        .prepare("INSERT INTO agent_process_activation_command VALUES (?,?,?)")
        .run(
          this.key(actor, command.requestId),
          command.processId,
          JSON.stringify({
            actor: { ...actor },
            command,
            receipt,
          } satisfies StoredDecision),
        );
      this.audit({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        source: "console",
        action: "catalog.process_changed",
        targetId: command.processId,
        outcome: "succeeded",
        details: {
          processEvent:
            command.type === "activate"
              ? "native_version_activated"
              : "native_version_rolled_back",
          processVersion: command.version,
          revision: activated.revision,
          previousRevision: command.revision,
        },
      });
      return structuredClone(receipt);
    });
  }
}
