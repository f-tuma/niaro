import {
  ProcessTestRequestSchema,
  TestJsonSchema,
  type ProcessTestRequest,
} from "../../packages/protocol/process-testing";
import type { ServiceProcessStore, ProcessActor } from "./service-processes";
import type { CatalogContext } from "./catalog-controller";
import type { ProcessTestingStore } from "./process-testing-store";
import { IdentityError } from "./error";
import { processDigest } from "./process-validation";

/** Internal only. Never attached to an HTTP handler, model tool or production executor. */
export function createProcessTesting(
  registry: ServiceProcessStore,
  journal: ProcessTestingStore,
) {
  return {
    async start(
      raw: ProcessTestRequest,
      context: CatalogContext,
      signal: AbortSignal,
    ) {
      TestJsonSchema.parse(raw);
      const request = ProcessTestRequestSchema.parse(raw);
      let creator!: ProcessActor;
      const authorize = async () => {
        signal.throwIfAborted();
        context.validateRequest?.();
        const current = await context.actor(request);
        if (
          current.role === "member" ||
          (creator && current.userId !== creator.userId)
        )
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
      const previous = await context.serial(async () => {
        creator = await authorize();
        return journal.replay(creator, request);
      });
      if (previous) return previous;
      const native = await import("../server-agent/process-testing");
      const reserved = await context.serial(async () => {
        creator = await authorize();
        const replay = journal.replay(creator, request);
        if (replay)
          return { created: false as const, job: replay, artifact: null };
        const artifact = registry.testArtifact(
          creator,
          request.processId,
          request.version,
        );
        return {
          artifact,
          ...journal.reserve(
            creator,
            request,
            native.processContractStamp(artifact, request.suite),
          ),
        };
      });
      if (!reserved.created || !reserved.artifact) return reserved.job;
      const held = () =>
        context.serial(async () => {
          const actor = await authorize();
          const current = registry.testArtifact(
            actor,
            request.processId,
            request.version,
          );
          if (
            processDigest(current.sources) !== reserved.job.stamp.sourcesDigest
          )
            throw new IdentityError(409, "process_sources_changed");
        });
      try {
        const report = await native.runProcessContractExperiment(
          reserved.artifact,
          request.suite,
          signal,
          held,
        );
        return await context.serial(async () =>
          journal.complete(await authorize(), reserved.job.testId, report),
        );
      } catch (error) {
        await context.serial(async () =>
          journal.interrupt(
            creator,
            reserved.job.testId,
            signal.aborted
              ? "test_aborted"
              : error instanceof IdentityError &&
                  [401, 403, 404].includes(error.status)
                ? "test_authority_changed"
                : error instanceof IdentityError &&
                    [
                      "process_sources_changed",
                      "process_definition_invalid",
                    ].includes(error.code)
                  ? "test_source_changed"
                  : "test_runner_failed",
          ),
        );
        throw error;
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
        context.validateRequest?.();
        return journal.read(
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
  };
}
