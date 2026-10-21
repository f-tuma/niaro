import { z } from "zod";
import { IdentityId } from "../../../../packages/protocol/identity";
import { CatalogTarget } from "../../../../packages/protocol/service-catalog";
import {
  PROCESS_PROFILE,
  ProcessListSchema,
  ProcessRecordSchema,
  ProcessVersionSchema,
  type ProcessDefinition,
} from "../../../../packages/protocol/service-processes";
import {
  PROCESS_VERSION_PROFILE,
  ProcessVersionListSchema,
} from "../../../../packages/protocol/process-versions";
import { api, ApiError } from "./api";
import { loadDesignCapabilities } from "./process-design-api";

const path = "identity/catalog/processes";
const scopeSchema = CatalogTarget.extend({
  serviceId: IdentityId,
  processId: IdentityId,
});
export type ProcessOverviewScope = z.infer<typeof scopeSchema>;
const recordResponse = CatalogTarget.extend({
  profile: z.literal(PROCESS_PROFILE),
  process: ProcessRecordSchema,
});
const versionResponse = CatalogTarget.extend({
  profile: z.literal(PROCESS_PROFILE),
  version: ProcessVersionSchema,
});
function scoped(
  value: z.infer<typeof CatalogTarget>,
  target: z.infer<typeof CatalogTarget>,
) {
  return (
    value.organizationId === target.organizationId &&
    value.workspaceId === target.workspaceId
  );
}

/** One workspace query; never repeat the full registry for every service card. */
export const workspaceProcessesKey = (
  authority: string,
  target: z.infer<typeof CatalogTarget>,
) =>
  [
    "admin",
    "processes",
    "registry",
    authority,
    target.organizationId,
    target.workspaceId,
  ] as const;

/** Passive, complete inventory. Foreign, repeated or nonadvancing pages never publish. */
export async function loadWorkspaceProcesses(
  rawTarget: z.infer<typeof CatalogTarget>,
  signal: AbortSignal,
) {
  const target = CatalogTarget.parse(rawTarget);
  const all: z.infer<typeof ProcessListSchema>["processes"] = [];
  const ids = new Set<string>();
  let after: string | undefined;
  do {
    signal.throwIfAborted();
    const page = ProcessListSchema.parse(
      await api(
        `${path}?${new URLSearchParams({ ...target, ...(after ? { after } : {}) })}`,
        undefined,
        signal,
      ),
    );
    if (
      !scoped(page, target) ||
      page.processes.some(
        (p, i) =>
          ids.has(p.id) ||
          (after !== undefined && p.id <= after) ||
          (i > 0 && p.id <= page.processes[i - 1]!.id),
      ) ||
      (page.nextAfter !== null && page.nextAfter !== page.processes.at(-1)?.id)
    )
      throw new SyntaxError("Process inventory scope or cursor mismatch");
    for (const process of page.processes) ids.add(process.id);
    all.push(...page.processes);
    after = page.nextAfter ?? undefined;
  } while (after);
  signal.throwIfAborted();
  return all;
}

/** Definition comparison is independent of JSON object insertion order. */
export function sameProcessDefinition(
  a: ProcessDefinition,
  b: ProcessDefinition,
) {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Draft, active artifact and bounded version history; no private test requests or commands. */
export async function loadProcessOverview(
  rawScope: ProcessOverviewScope,
  signal: AbortSignal,
) {
  const scope = scopeSchema.parse(rawScope);
  const target = {
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
  };
  async function record() {
    const value = recordResponse.parse(
      await api(
        `${path}?${new URLSearchParams({ ...target, id: scope.processId })}`,
        undefined,
        signal,
      ),
    );
    if (
      !scoped(value, target) ||
      value.process.id !== scope.processId ||
      value.process.serviceId !== scope.serviceId
    )
      throw new SyntaxError("Process overview binding mismatch");
    signal.throwIfAborted();
    return value.process;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const [process, capabilities, history] = await Promise.all([
      record(),
      loadDesignCapabilities(target, signal),
      api(
        `${path}/versions?${new URLSearchParams({ ...target, profile: PROCESS_VERSION_PROFILE, processId: scope.processId })}`,
        undefined,
        signal,
      ).then((value) => ProcessVersionListSchema.parse(value)),
    ]);
    if (
      !scoped(history, target) ||
      history.processId !== scope.processId ||
      history.versions.some(
        (version, i) =>
          version.processId !== scope.processId ||
          (i > 0 && version.version >= history.versions[i - 1]!.version),
      ) ||
      (history.nextBefore !== null &&
        history.nextBefore !== history.versions.at(-1)?.version)
    )
      throw new SyntaxError("Process overview history binding mismatch");
    const activeNumber = process.activeVersion;
    if (activeNumber !== null && activeNumber > process.latestVersion)
      throw new SyntaxError("Active process version exceeds registry history");
    let activeVersion =
      history.versions.find((version) => version.version === activeNumber) ??
      null;
    if (activeNumber !== null && !activeVersion) {
      const value = versionResponse.parse(
        await api(
          `${path}?${new URLSearchParams({ ...target, id: scope.processId, version: String(activeNumber) })}`,
          undefined,
          signal,
        ),
      );
      if (
        !scoped(value, target) ||
        value.version.processId !== scope.processId ||
        value.version.version !== activeNumber
      )
        throw new SyntaxError("Active process version binding mismatch");
      activeVersion = value.version;
    }
    const current = await record();
    if (
      current.revision !== process.revision ||
      current.activeVersion !== activeNumber ||
      current.latestVersion !== process.latestVersion ||
      (history.versions[0]?.version ?? 0) !== process.latestVersion
    ) {
      if (attempt === 0) continue;
      throw new ApiError(409, "process_snapshot_changed");
    }
    signal.throwIfAborted();
    return { process: current, activeVersion, capabilities, history };
  }
  throw new ApiError(409, "process_snapshot_changed");
}
export type ProcessOverview = Awaited<ReturnType<typeof loadProcessOverview>>;
