import { ZodError } from "zod";
import {
  NativeTestRequestSchema,
  NativeTestDiagnosticSchema,
  type NativeTestListQuery,
  type NativeTestDetailQuery,
  type NativeTestDetailV2Query,
  type NativeTestToolsQuery,
  type NativeTestRequest,
} from "../../packages/protocol/process-native-testing";
import { TestJsonSchema } from "../../packages/protocol/process-testing";
import type { ServiceProcessStore, ProcessActor } from "./service-processes";
import type { ServiceCatalogStore } from "./service-catalog";
import type { ProcessTestingStore } from "./process-testing-store";
import type { CatalogContext } from "./catalog-controller";
import { IdentityError } from "./error";
import { processDigest } from "./process-validation";
import { processNativeTools } from "./process-native-tools";
import { NativeTestDiagnosticError } from "../server-agent/process-native-diagnostic";

/** Internal adapter over the shared journal; never an activation or live-provider path. */
export function createProcessNativeTesting(
  registry: ServiceProcessStore,
  catalog: ServiceCatalogStore,
  journal: ProcessTestingStore,
) {
  return {
    async start(
      raw: NativeTestRequest,
      context: CatalogContext,
      signal: AbortSignal,
    ) {
      TestJsonSchema.parse(raw);
      const request = NativeTestRequestSchema.parse(raw);
      let creator!: ProcessActor;
      const authorize = async () => {
        signal.throwIfAborted();
        context.validateRequest?.();
        const current = await context.actor(request);
        // A member may test only a personal process they own; the journal's
        // admission and registry.testArtifact enforce it per process.
        if (creator && current.userId !== creator.userId)
          throw new IdentityError(403, "identity_forbidden");
        context.validateRequest?.();
        signal.throwIfAborted();
        return {
          organizationId: request.organizationId,
          workspaceId: request.workspaceId,
          userId: current.userId,
          role: current.role,
        };
      };
      // Replay precedes source/runtime resolution and never dispatches a runner.
      const previous = await context.serial(async () => {
        creator = await authorize();
        return journal.replayNative(creator, request);
      });
      if (previous) return previous;
      const native = await import("./process-native-testing");
      const snapshot = (actor: ProcessActor) => {
        const artifact = registry.testArtifact(
          actor,
          request.processId,
          request.version,
        );
        if (
          request.suite.comparisonMode === "configured_only" &&
          (artifact.definition.kind !== "workflow" ||
            artifact.definition.steps.some((step) => step.type === "agent"))
        )
          throw new IdentityError(400, "process_test_comparison_mode_invalid");
        if (request.suite.genericModelId)
          catalog.processModelMetadata(
            request.organizationId,
            request.suite.genericModelId,
          );
        const safe = catalog.processTestCatalog(
          request.organizationId,
          request.workspaceId,
          actor,
          artifact.sources,
          request.suite.genericModelId,
        );
        if (safe.budget.mode !== "enforce")
          throw new IdentityError(409, "process_test_budget_required");
        return {
          artifact,
          catalog: safe,
          authorityEpoch: context.epoch(request.organizationId),
        };
      };
      const reserved = await context.serial(async () => {
        creator = await authorize();
        const replay = journal.replayNative(creator, request);
        if (replay)
          return { created: false as const, job: replay, snapshot: null };
        const current = snapshot(creator);
        return {
          ...journal.reserveNative(
            creator,
            request,
            native.processNativeStamp(
              current.artifact,
              current.catalog,
              request.suite,
            ),
            {
              catalog: current.catalog,
              authorityEpoch: current.authorityEpoch,
              executionSettings: native.processNativeExecutionSettings(
                current.artifact,
                current.catalog,
              ),
            },
          ),
          snapshot: current,
        };
      });
      if (!reserved.created || !reserved.snapshot) return reserved.job;
      const fresh = async () => {
        const actor = await authorize();
        let current: ReturnType<typeof snapshot>;
        try {
          current = snapshot(actor);
        } catch (error) {
          if (error instanceof IdentityError)
            throw new IdentityError(409, "process_sources_changed");
          throw error;
        }
        if (
          current.authorityEpoch !== reserved.snapshot!.authorityEpoch ||
          processDigest(current.catalog) !== reserved.job.stamp.catalogDigest ||
          processDigest(current.artifact.sources) !==
            reserved.job.stamp.sourcesDigest
        )
          throw new IdentityError(409, "process_sources_changed");
        return { actor, ...current };
      };
      const held = () =>
        context.serial(async () => {
          await fresh();
        });
      try {
        const report = await native.runProcessNativeComparison(
          reserved.snapshot.artifact,
          reserved.snapshot.catalog,
          request.suite,
          signal,
          held,
        );
        return await context.serial(async () => {
          const current = await fresh();
          return journal.completeNative(
            current.actor,
            reserved.job.testId,
            report,
            current,
          );
        });
      } catch (error) {
        let retirement = error;
        await context.serial(async () => {
          let diagnostic: Parameters<typeof journal.interrupt>[3];
          if (error instanceof NativeTestDiagnosticError && !signal.aborted) {
            try {
              const current = await fresh();
              diagnostic = {
                value: error.diagnostic,
                stamp: reserved.job.stamp,
                current,
              };
            } catch (changed) {
              retirement = changed;
            }
          }
          if (signal.aborted) diagnostic = undefined;
          const failure = signal.aborted
            ? "test_aborted"
            : retirement instanceof IdentityError &&
                [401, 403, 404].includes(retirement.status)
              ? "test_authority_changed"
              : retirement instanceof IdentityError &&
                  retirement.code === "process_sources_changed"
                ? "test_source_changed"
                : "test_runner_failed";
          try {
            journal.interrupt(
              creator,
              reserved.job.testId,
              failure,
              diagnostic,
            );
          } catch (rejected) {
            // Only a positively identified, pre-write diagnostic validation
            // rejection may discard the diagnostic. Storage/commit errors and
            // corrupt stored reads keep their existing failure path.
            if (
              !diagnostic ||
              !(
                (rejected instanceof IdentityError &&
                  rejected.status === 409 &&
                  rejected.code === "process_test_conflict") ||
                (rejected instanceof ZodError &&
                  !NativeTestDiagnosticSchema.safeParse(diagnostic.value)
                    .success)
              )
            )
              throw rejected;
            journal.interrupt(
              creator,
              reserved.job.testId,
              signal.aborted ? "test_aborted" : failure,
            );
          }
        });
        throw retirement;
      }
    },
    async read(
      context: CatalogContext,
      target: { organizationId: string; workspaceId: string },
      testId: string,
    ) {
      return context.serial(async () => {
        context.validateRequest?.();
        const actor = await context.actor(target);
        // Members: only their personal processes, enforced by the journal/registry.
        context.validateRequest?.();
        return journal.readNative(
          {
            organizationId: target.organizationId,
            workspaceId: target.workspaceId,
            userId: actor.userId,
            role: actor.role,
          },
          testId,
        );
      });
    },
    async list(context: CatalogContext, query: NativeTestListQuery) {
      return context.serial(async () => {
        context.validateRequest?.();
        const actor = await context.actor(query);
        // Members: only their personal processes, enforced by the journal/registry.
        context.validateRequest?.();
        return journal.listNative(
          {
            organizationId: query.organizationId,
            workspaceId: query.workspaceId,
            userId: actor.userId,
            role: actor.role,
          },
          query,
        );
      });
    },
    async detail(
      context: CatalogContext,
      query: NativeTestDetailQuery | NativeTestDetailV2Query,
    ) {
      return context.serial(async () => {
        context.validateRequest?.();
        const actor = await context.actor(query);
        // Members: only their personal processes, enforced by the journal/registry.
        context.validateRequest?.();
        return journal.nativeDetail(
          {
            organizationId: query.organizationId,
            workspaceId: query.workspaceId,
            userId: actor.userId,
            role: actor.role,
          },
          query,
        );
      });
    },
    async tools(context: CatalogContext, query: NativeTestToolsQuery) {
      return context.serial(async () => {
        context.validateRequest?.();
        const current = await context.actor(query);
        context.validateRequest?.();
        const actor = {
          organizationId: query.organizationId,
          workspaceId: query.workspaceId,
          userId: current.userId,
          role: current.role,
        };
        const artifact = registry.testArtifact(
          actor,
          query.processId,
          query.version,
        );
        catalog.processModelMetadata(
          query.organizationId,
          query.genericModelId,
        );
        const safe = catalog.processTestCatalog(
          query.organizationId,
          query.workspaceId,
          actor,
          artifact.sources,
          query.genericModelId,
        );
        return processNativeTools(artifact, safe, query.genericModelId);
      });
    },
  };
}
