import { ProcessStartStore } from "../../apps/server-identity/process-start-store";
import { IdentityError } from "../../apps/server-identity/error";
import {
  PROCESS_START_PROFILE,
  ProcessStartCommandSchema,
} from "../../packages/protocol/process-start";
import { processDigest } from "../../apps/server-identity/process-validation";
import { fixture, admin, scope } from "./service-process-runtime";
import type { ProcessDefinition } from "../../packages/protocol/service-processes";

export function startFixture(
  path: string,
  ids?: Parameters<typeof fixture>[1],
) {
  const h = fixture(path, ids);
  h.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  let allowed = true,
    readable = true;
  const starts = new ProcessStartStore(h.db, scope.serverId, h.registry, {
    authorize: (actor, value) => {
      if (
        !allowed ||
        actor.userId !== scope.userId ||
        value.userId !== scope.userId
      )
        throw new IdentityError(403, "identity_forbidden");
      return { ...actor, role: "member" };
    },
    read: () => {
      if (!readable) throw new IdentityError(403, "identity_forbidden");
    },
  });
  const issue = (processId: string, requestId = "TEST-menu") => {
    const artifact = h.registry.version(admin, processId, 1);
    return starts.issue(
      admin,
      scope,
      {
        origin: {
          type: "command",
          conversationId: "conversation-1",
          requestId,
        },
        processId,
        version: artifact.version,
        artifactDigest: artifact.digest,
        formDigest: processDigest({
          requestId,
          inputSchema: artifact.definition.inputSchema,
        }),
        fields: {},
      },
      () => {},
    );
  };
  return {
    ...h,
    starts,
    issue,
    setup: (definition?: ProcessDefinition) => {
      const processId = h.activate(definition ?? h.basic());
      const intent = issue(processId);
      const command = ProcessStartCommandSchema.parse({
        profile: PROCESS_START_PROFILE,
        type: "process.start",
        commandId: "TEST-start-command",
        idempotencyKey: "TEST-start-key",
        intentId: intent.intentId,
        conversationId: "conversation-1",
        language: "cs",
        input: { name: "TEST input" },
      });
      return { processId, intent, command };
    },
    revoke: () => {
      allowed = false;
    },
    denyRead: () => {
      readable = false;
    },
  };
}
