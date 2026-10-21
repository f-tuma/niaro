import {
  WORKSPACE_PROCESS_PROFILE,
  WorkspaceProcessArchiveResultSchema,
} from "../../../../packages/protocol/service-processes";
import { api } from "./api";

/** The owner deletes (archives) their personal process at the revision they saw. */
export async function archivePersonalProcess(
  target: { organizationId: string; workspaceId: string },
  process: { id: string; revision: number },
) {
  const result = WorkspaceProcessArchiveResultSchema.parse(
    await api("identity/catalog/processes/archive", {
      profile: WORKSPACE_PROCESS_PROFILE,
      type: "archive",
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      id: process.id,
      revision: process.revision,
    }),
  );
  if (result.id !== process.id)
    throw new SyntaxError("Archived process mismatch");
  return result;
}
