import { z } from "zod";
import { CatalogTarget } from "../../../../packages/protocol/service-catalog";
import {
  WORKSPACE_PROCESS_PROFILE,
  ProcessVersionSchema,
  type OwnedProcessSummarySchema,
} from "../../../../packages/protocol/service-processes";
import type { ProcessExecutionEntry } from "../../../../packages/protocol/process-execution";
import { api } from "../lib/api";
import { designAuthority } from "../lib/design-authority";
import { loadOwnedProcesses } from "../lib/owned-processes";
import type { AppWorkspace } from "./context";

type Target = z.infer<typeof CatalogTarget>;
type Summary = z.infer<typeof OwnedProcessSummarySchema>;

/** Where a personal process stands, as the list shows it. */
export type PersonalProcessState = "draft" | "tested" | "active" | "blocked";
export type PersonalProcess = {
  id: string;
  name: string;
  kind: "agent" | "workflow";
  updatedAt: string;
  state: PersonalProcessState;
  activeVersion: number | null;
  /** Why an active process can't start now. */
  reason: Extract<ProcessExecutionEntry, { availability: "blocked" }>["reason"] | null;
  /** The start inventory's entry when it can start now. */
  start: Extract<ProcessExecutionEntry, { availability: "ready" }> | null;
};
export type OwnedProcesses = {
  processes: Summary[];
  /** Latest version's test result for processes without an active version. */
  latestTest: Record<string, "untested" | "passed" | "failed">;
};

const versionResponse = CatalogTarget.extend({
  profile: z.literal(WORKSPACE_PROCESS_PROFILE),
  version: ProcessVersionSchema,
});

const isMine = (p: Summary, userId: string) =>
  "owner" in p && p.owner?.type === "user" && p.owner.userId === userId;

/**
 * The person's own processes from the `/2` registry, drafts included. Members
 * get only their own; administrators also see workspace processes, which stay
 * in administration and are filtered out here.
 */
export async function loadPersonalProcesses(
  target: Target,
  userId: string,
  signal: AbortSignal,
): Promise<OwnedProcesses> {
  const processes = (await loadOwnedProcesses(target, signal)).filter((p) =>
    isMine(p, userId),
  );
  const latestTest: OwnedProcesses["latestTest"] = {};
  // Only frozen, not yet active processes need their latest test result.
  await Promise.all(
    processes
      .filter((p) => !p.activeVersion && p.latestVersion > 0)
      .map(async (p) => {
        const response = versionResponse.parse(
          await api(
            `identity/catalog/processes?${new URLSearchParams({
              ...CatalogTarget.parse(target),
              profile: WORKSPACE_PROCESS_PROFILE,
              id: p.id,
              version: String(p.latestVersion),
            })}`,
            undefined,
            signal,
          ),
        );
        if (
          response.organizationId !== target.organizationId ||
          response.workspaceId !== target.workspaceId ||
          response.version.processId !== p.id
        )
          throw new SyntaxError("Personal process version mismatch");
        latestTest[p.id] = response.version.testStatus;
      }),
  );
  return { processes, latestTest };
}

/** Rows for "Mine": newest first, each with its state and start entry. */
export function personalProcessRows(
  owned: OwnedProcesses,
  inventory: readonly ProcessExecutionEntry[],
): PersonalProcess[] {
  const entries = new Map(
    inventory.filter((e) => e.personal === true).map((e) => [e.processId, e]),
  );
  return owned.processes
    .map((p): PersonalProcess => {
      const entry = entries.get(p.id);
      const blocked =
        !!p.activeVersion && entry?.availability === "blocked"
          ? entry.reason
          : null;
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        updatedAt: p.updatedAt,
        activeVersion: p.activeVersion,
        state: blocked
          ? "blocked"
          : p.activeVersion
            ? "active"
            : owned.latestTest[p.id] === "passed"
              ? "tested"
              : "draft",
        reason: blocked,
        start:
          p.activeVersion && entry?.availability === "ready" ? entry : null,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Binds saved designer and process-page state to this sign-in, person and
 * role; signing out rotates the generation and clears it.
 */
export function personalProcessAuthority(
  userId: string,
  workspace: AppWorkspace,
) {
  return ["app", designAuthority(), userId, workspace.role].join(":");
}
