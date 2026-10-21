import type { Scope } from "../../packages/protocol";
import type { CatalogController, CatalogContext } from "./catalog-controller";
import type { ProcessStartStore } from "./process-start-store";
import type { ServiceProcessStore, ProcessActor } from "./service-processes";
import type { AgentMemory, AgentMemoryMetadata } from "./agent-memory";
import type { ProcessQuestionStore } from "./process-question-store";
import { JournalSchema } from "./service-process-journal";
import { IdentityError } from "./error";
import { CONTACT_CONTEXT_TTL } from "./contact-context";
import type { NativeTaskRoot, StoredInvocation } from "./service-catalog";

export const PROCESS_READ_MAX_RECEIPTS = 256;
export const PROCESS_READ_MAX_DEPENDENCY_EDGES = 1024;

/** Complete passive source proof. Shared descendants are allowed; cycles are not. */
export function captureTaskReadDependencies(
  controller: CatalogController,
  root: NativeTaskRoot,
  scope: Scope,
  organizationId: string,
  currentActor: Awaited<ReturnType<CatalogContext["actor"]>>,
) {
  if (
    !root.value ||
    typeof root.value !== "object" ||
    Array.isArray(root.value)
  )
    return { valid: false, receipts: [], memoryCurrent: [] };
  const state = root.value as {
    operations?: unknown;
    sources?: unknown;
    memoryMetadata?: AgentMemoryMetadata;
    agents?: Record<string, { memoryMetadata?: AgentMemoryMetadata }>;
  };
  let valid = true,
    edgeCount = 0;
  const memoryPins = [state.memoryMetadata];
  if (state.agents !== undefined) {
    if (
      !state.agents ||
      typeof state.agents !== "object" ||
      Array.isArray(state.agents)
    )
      valid = false;
    else
      for (const agent of Object.values(state.agents)) {
        if (!agent || typeof agent !== "object") valid = false;
        else memoryPins.push(agent.memoryMetadata);
      }
  }
  const entries = new Map<
    string,
    {
      id: string;
      source: boolean;
      expectedServices: string[];
      value?: StoredInvocation;
      edges: string[];
      available: boolean;
    }
  >();
  const add = (id: unknown, source: boolean, expectedService?: string) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(id)) {
      valid = false;
      return;
    }
    let entry = entries.get(id);
    if (!entry) {
      if (entries.size >= PROCESS_READ_MAX_RECEIPTS) {
        valid = false;
        return;
      }
      entry = { id, source, expectedServices: [], edges: [], available: false };
      entries.set(id, entry);
    }
    entry.source ||= source;
    if (expectedService && !entry.expectedServices.includes(expectedService))
      entry.expectedServices.push(expectedService);
  };
  const seed = (ids: unknown, source: boolean) => {
    if (ids === undefined) return;
    if (!Array.isArray(ids) || ids.length > PROCESS_READ_MAX_RECEIPTS) {
      valid = false;
      return;
    }
    for (const id of ids) add(id, source);
  };
  seed(state.operations, false);
  seed(state.sources, true);
  for (const pin of memoryPins) {
    if (pin === undefined) continue;
    if (
      !pin ||
      typeof pin !== "object" ||
      (pin.sources !== undefined &&
        (!Array.isArray(pin.sources) ||
          pin.sources.length > PROCESS_READ_MAX_RECEIPTS))
    ) {
      valid = false;
      continue;
    }
    for (const source of pin.sources ?? []) {
      if (!source || typeof source !== "object") valid = false;
      else if (source.type === "verified_operation")
        add(source.operationId, true, source.serviceId);
    }
  }

  // Map iteration visits newly added descendants, with a hard bound on receipts
  // and edges. Scope-filtered SQL alone cannot authorize mismatched saved data.
  for (const entry of entries.values()) {
    const value = controller.store.invocation(
      entry.id,
      scope.workspaceId,
      scope.userId,
    );
    entry.value = value;
    if (
      !value ||
      value.id !== entry.id ||
      value.organizationId !== organizationId ||
      value.workspaceId !== scope.workspaceId ||
      value.userId !== scope.userId
    ) {
      valid = false;
      continue;
    }
    if (
      value.dependencies !== undefined &&
      !Array.isArray(value.dependencies)
    ) {
      valid = false;
      continue;
    }
    const descendants = value.dependencies ?? [];
    if (
      descendants.length + (value.contactSource === undefined ? 0 : 1) >
      PROCESS_READ_MAX_DEPENDENCY_EDGES - edgeCount
    ) {
      valid = false;
      continue;
    }
    for (const id of [
      ...descendants,
      ...(value.contactSource === undefined ? [] : [value.contactSource]),
    ]) {
      edgeCount++;
      add(id, true);
      if (typeof id === "string") entry.edges.push(id);
    }
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const acyclic = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    const entry = entries.get(id);
    if (!entry) return false;
    visiting.add(id);
    const safe = entry.edges.every(acyclic);
    visiting.delete(id);
    visited.add(id);
    return safe;
  };
  for (const id of entries.keys()) if (!acyclic(id)) valid = false;
  for (const entry of entries.values()) {
    const value = entry.value;
    if (
      !value ||
      value.id !== entry.id ||
      value.organizationId !== organizationId ||
      value.workspaceId !== scope.workspaceId ||
      value.userId !== scope.userId ||
      entry.expectedServices.some((id) => id !== value.serviceId)
    )
      continue;
    try {
      if (entry.source)
        controller.store.contactSource(
          entry.id,
          organizationId,
          scope.workspaceId,
          currentActor,
          CONTACT_CONTEXT_TTL,
        );
      else {
        const permitted = controller.store.authorize(
          scope.workspaceId,
          value.serviceId,
          value.serviceRevision,
          value.actionId,
          value.actionRevision,
          currentActor,
        );
        controller.store.assertExecutionPin(value, permitted.executionPin);
      }
      entry.available = true;
    } catch (error) {
      if (!(error instanceof IdentityError)) throw error;
    }
  }
  const now = Date.now();
  const memoryCurrent = memoryPins.map(
    (pin) => pin?.expiresAt === undefined || now < pin.expiresAt,
  );
  return {
    valid:
      valid &&
      [...entries.values()].every((entry) => entry.available) &&
      memoryCurrent.every(Boolean),
    receipts: [...entries.values()],
    memoryCurrent,
  };
}

/** Same complete dependency and time/account proof used for Tasks and output publication. */
export function createTaskReadObservation(
  controller: CatalogController,
  context: CatalogContext,
  scope: Scope,
  organizationId: string,
  memoryObservation?: () => unknown,
) {
  return (
    roots: NativeTaskRoot[],
    currentActor: Awaited<ReturnType<CatalogContext["actor"]>>,
  ) =>
    JSON.stringify([
      roots,
      roots.map((root) =>
        captureTaskReadDependencies(
          controller,
          root,
          scope,
          organizationId,
          currentActor,
        ),
      ),
      context.epoch(organizationId),
      memoryObservation?.(),
    ]);
}

/** Capture under queue, validate potentially queue-using Memory outside it, then capture again. */
export function createProcessReadWindow(
  controller: CatalogController,
  registry: ServiceProcessStore,
  starts: ProcessStartStore,
  context: CatalogContext,
  scope: Scope,
  organizationId: string,
  memory?: AgentMemory,
  memoryObservation?: () => unknown,
  questions?: ProcessQuestionStore,
) {
  const target = { organizationId, workspaceId: scope.workspaceId };
  const observation = createTaskReadObservation(
    controller,
    context,
    scope,
    organizationId,
    memoryObservation,
  );
  async function actor(): Promise<ProcessActor> {
    context.validateRequest?.();
    const current = await context.actor(target);
    if (current.userId !== scope.userId)
      throw new IdentityError(403, "identity_forbidden");
    return { ...target, ...current };
  }
  async function captureHeld(id: string) {
    const current = await actor();
    let saved;
    try {
      saved = starts.forParent(current, scope, id);
    } catch (error) {
      if (error instanceof IdentityError && [403, 404].includes(error.status))
        return null;
      throw error;
    }
    if (saved.receipt.status !== "admitted") return null;
    const artifact = registry.pinnedVersion(current, id);
    const journal = JournalSchema.parse(
      controller.store.turn(id, scope.workspaceId, scope.userId),
    );
    // Reuse the exact complete source proof observed again during publication.
    // Failed proof hides data without erasing the original business receipts.
    const detailsAvailable = captureTaskReadDependencies(
      controller,
      { id, kind: "service-process-1", value: journal },
      scope,
      organizationId,
      current,
    ).valid;
    const receipts = journal.operations
      .map((id) =>
        controller.store.invocation(id, scope.workspaceId, scope.userId),
      )
      .filter((r) => r?.organizationId === organizationId);
    const answerHistory = questions?.history(current, scope, id) ?? [];
    return {
      saved,
      artifact,
      journal,
      detailsAvailable,
      receipts,
      answerHistory,
      // Private equality observation only. Public output digests are computed
      // separately after structural redaction; no raw-secret hash is exposed.
      signature: JSON.stringify([
        saved,
        artifact,
        journal,
        receipts,
        answerHistory,
        observation(
          [{ id, kind: "service-process-1", value: journal }],
          current,
        ),
      ]),
    };
  }
  const capture = (id: string) => context.serial(() => captureHeld(id));
  return {
    roots: () =>
      context.serial(async () => {
        await actor();
        return controller.store.taskRoots(scope, organizationId);
      }),
    read: async (id: string) => {
      let captured = await capture(id);
      if (!captured) return null;
      for (let attempt = 0; attempt < 3; attempt++) {
        let memoryAvailable = true;
        try {
          for (const agent of Object.values(captured.journal.agents)) {
            if (agent.memoryVersion === undefined) continue;
            if (!memory)
              throw new IdentityError(409, "process_memory_unavailable");
            await memory.validate(agent.memoryVersion, agent.memoryMetadata);
          }
        } catch (error) {
          if (!(error instanceof IdentityError)) throw error;
          memoryAvailable = false;
        }
        const fresh = await capture(id);
        if (!fresh) return null;
        if (fresh.signature !== captured.signature && attempt < 2) {
          captured = fresh;
          continue;
        }
        const value = {
          ...fresh,
          detailsAvailable:
            fresh.detailsAvailable &&
            memoryAvailable &&
            fresh.signature === captured.signature,
        };
        return {
          value,
          publish: <T>(render: () => T): Promise<T> =>
            context.serial(async () => {
              const current = await captureHeld(id);
              if (!current || current.signature !== fresh.signature)
                throw new IdentityError(409, "process_output_changed");
              if (!value.detailsAvailable || !current.detailsAvailable)
                throw new IdentityError(403, "process_output_unavailable");
              return render();
            }),
        };
      }
      return null;
    },
  };
}
export type ProcessReadWindow = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createProcessReadWindow>["read"]>>
>;
export type ProcessReadCapture = ProcessReadWindow["value"];
