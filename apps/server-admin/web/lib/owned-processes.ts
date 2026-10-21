import { z } from "zod";
import {
  WORKSPACE_PROCESS_PROFILE,
  WorkspaceProcessListSchema,
} from "../../../../packages/protocol/service-processes";
import { CatalogTarget } from "../../../../packages/protocol/service-catalog";
import { api } from "./api";

/** Complete passive /2 registry; no partial pages or foreign scope are published. */
export async function loadOwnedProcesses(
  target: z.infer<typeof CatalogTarget>,
  signal: AbortSignal,
) {
  const scope = CatalogTarget.parse(target),
    ids = new Set<string>();
  const all: z.infer<typeof WorkspaceProcessListSchema>["processes"] = [];
  let after: string | undefined;
  do {
    signal.throwIfAborted();
    const page = WorkspaceProcessListSchema.parse(
      await api(
        `identity/catalog/processes?${new URLSearchParams({ ...scope, profile: WORKSPACE_PROCESS_PROFILE, ...(after ? { after } : {}) })}`,
        undefined,
        signal,
      ),
    );
    if (
      page.organizationId !== scope.organizationId ||
      page.workspaceId !== scope.workspaceId ||
      page.processes.some(
        (p, i) =>
          ids.has(p.id) ||
          (after !== undefined && p.id <= after) ||
          (i > 0 && p.id <= page.processes[i - 1]!.id),
      ) ||
      (page.nextAfter !== null && page.nextAfter !== page.processes.at(-1)?.id)
    )
      throw new SyntaxError("Workspace process inventory mismatch");
    for (const p of page.processes) ids.add(p.id);
    all.push(...page.processes);
    after = page.nextAfter ?? undefined;
  } while (after);
  signal.throwIfAborted();
  return all;
}
