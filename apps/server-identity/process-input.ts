import type { Scope } from "../../packages/protocol";
import {
  PROCESS_INPUT_PROFILE,
  ProcessInputRequestSchema,
  ProcessInputFormSchema,
  ProcessInputCardSchema,
} from "../../packages/protocol/process-execution";
import type { ProcessActor, ServiceProcessStore } from "./service-processes";
import type { ProcessStartStore } from "./process-start-store";
import { processDigest } from "./process-validation";
import { IdentityError } from "./error";
import { assertMeetingProcessOrigin } from "./meeting-process-origin";

/** Explicit preparation persists only a scoped intent; it never admits or runs work. */
export function prepareProcessInput(
  registry: ServiceProcessStore,
  starts: ProcessStartStore,
  actor: ProcessActor,
  scope: Scope,
  raw: unknown,
  readMeetingRecord?: Parameters<typeof assertMeetingProcessOrigin>[0],
  readMeetingTask?: Parameters<typeof assertMeetingProcessOrigin>[4],
) {
  const request = ProcessInputRequestSchema.parse(raw);
  // Revalidate first, including intent-issuance replay. A stale form is never substituted.
  const artifact = registry.executionArtifact(
    actor,
    request.processId,
    request,
  );
  if (request.origin.type === "meeting") {
    if (!readMeetingRecord)
      throw new IdentityError(409, "process_origin_changed");
    assertMeetingProcessOrigin(
      readMeetingRecord,
      scope,
      request.origin,
      artifact.definition.inputSchema,
      readMeetingTask,
    );
  }
  const form = ProcessInputFormSchema.parse({
    profile: PROCESS_INPUT_PROFILE,
    scope,
    language: request.language,
    processId: artifact.processId,
    version: artifact.version,
    artifactDigest: artifact.digest,
    name: artifact.definition.name,
    description: artifact.definition.description,
    kind: artifact.definition.kind,
    inputSchema: artifact.definition.inputSchema,
    origin: request.origin,
  });
  const formDigest = processDigest(form);
  const validate = (intent: { formDigest: string; inputSchema: unknown }) => {
    if (
      intent.formDigest !== formDigest ||
      processDigest(intent.inputSchema) !== processDigest(form.inputSchema)
    )
      throw new IdentityError(409, "process_origin_changed");
  };
  const intent = starts.issue(
    actor,
    scope,
    {
      origin: request.origin,
      processId: artifact.processId,
      version: artifact.version,
      artifactDigest: artifact.digest,
      formDigest,
      fields: {},
    },
    validate,
  );
  validate(intent);
  return ProcessInputCardSchema.parse({ form, formDigest, intent });
}
