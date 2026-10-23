import { useSyncExternalStore } from "react";
import type { z } from "zod";
import {
  ActionDiscoveryResponse,
  type DiscoveryChoice,
  type DiscoveryContinuation,
  type Service,
  twentyReadTool,
} from "../../../packages/protocol/service-catalog";
import type { CatalogState } from "./catalog-shared";

/** New actions one request describes with the model: one naming call each. */
export const DISCOVERY_SLICE = 5;

type Response = z.infer<typeof ActionDiscoveryResponse>;
export type DiscoveryJob = {
  running: boolean;
  /** The model describes the new actions (each slice is a model call). */
  enrich: boolean;
  /** The administrator chose the tools: progress counts every chosen one. */
  selection: boolean;
  /** New actions handled so far of all that will be; null until known. */
  progress: { done: number; total: number } | null;
  result: Omit<Response, "choices" | "next" | "readOnly"> | null;
  /** Saved write actions the server labels read-only, for an administrator. */
  readOnly: string[];
  /** A catalog that lets the administrator choose (Twenty), at its revision. */
  choices: { list: z.infer<typeof DiscoveryChoice>[]; revision: number } | null;
  /** Where an interrupted import continues. */
  continuation: z.infer<typeof DiscoveryContinuation> | null;
  error: unknown;
};
const idle: DiscoveryJob = {
  running: false,
  enrich: false,
  selection: false,
  progress: null,
  result: null,
  readOnly: [],
  choices: null,
  continuation: null,
  error: null,
};

/**
 * Discovery runs here, outside the sheet that starts it: closing the sheet or
 * leaving the service page keeps it going, and every view of the service reads
 * the same progress. One job per service; it lives as long as the console.
 */
const jobs = new Map<string, DiscoveryJob>();
const listeners = new Set<() => void>();
function put(key: string, job: DiscoveryJob) {
  jobs.set(key, job);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function discoveryKey(workspaceId: string, serviceId: string) {
  return `${workspaceId}:${serviceId}`;
}
export function useDiscoveryJob(key: string): DiscoveryJob {
  return useSyncExternalStore(
    subscribe,
    () => jobs.get(key) ?? idle,
    () => idle,
  );
}
export function readDiscoveryJob(key: string) {
  return jobs.get(key) ?? idle;
}
/** Forgets a finished job (a new discovery starts clean). */
export function resetDiscovery(key: string) {
  if (!jobs.get(key)?.running) put(key, idle);
}
/** The read-only hints were applied or dismissed. */
export function clearReadOnly(key: string) {
  const job = jobs.get(key);
  if (job) put(key, { ...job, readOnly: [] });
}

/**
 * Runs a discovery to its end, request by request: with `enrich`, each request
 * describes a few new actions, so progress moves between them. `send` makes
 * one request; `onBatch` runs after each one that imported something.
 */
export async function runDiscovery(
  key: string,
  options: {
    send: (body: Record<string, unknown>) => Promise<unknown>;
    /** serviceId, revision, documentUrl, toolNames, policyRevision. */
    body: Record<string, unknown>;
    enrich: boolean;
    /** How many were chosen, when the administrator chose (Twenty). */
    total?: number;
    /** Continue the job's interrupted import instead of starting over. */
    resume?: boolean;
    onBatch?: () => Promise<unknown> | void;
  },
) {
  const before = jobs.get(key) ?? idle;
  if (before.running) return;
  const resume = !!options.resume && !!before.continuation;
  let next = resume ? before.continuation : null;
  let job: DiscoveryJob = resume
    ? { ...before, running: true, error: null }
    : {
        ...idle,
        running: true,
        enrich: options.enrich,
        selection: !!options.total,
        progress: options.total ? { done: 0, total: options.total } : null,
      };
  put(key, job);
  try {
    do {
      const response = ActionDiscoveryResponse.parse(
        await options.send({
          ...options.body,
          enrich: job.enrich,
          ...(job.enrich && !job.selection ? { limit: DISCOVERY_SLICE } : {}),
          ...(next ?? {}),
        }),
      );
      if (response.choices) {
        job = {
          ...idle,
          choices: {
            list: response.choices,
            revision: Number(options.body.revision),
          },
        };
        put(key, job);
        return;
      }
      const done =
        (job.progress?.done ?? 0) +
        response.added +
        // A chosen selection counts every tool; otherwise only the new ones.
        (job.selection ? response.existing + response.warnings.length : 0);
      next = response.next ?? null;
      const total = Math.max(
        job.progress?.total ?? 0,
        done + (next?.toolNames.length ?? 0),
      );
      job = {
        ...job,
        progress: total ? { done, total } : null,
        result: {
          added: (job.result?.added ?? 0) + response.added,
          existing: (job.result?.existing ?? 0) + response.existing,
          warnings: [...(job.result?.warnings ?? []), ...response.warnings],
          issues: [...(job.result?.issues ?? []), ...(response.issues ?? [])],
          enriched: !!job.result?.enriched || response.enriched,
        },
        readOnly: [...new Set([...job.readOnly, ...(response.readOnly ?? [])])],
        continuation: next,
      };
      put(key, job);
      await options.onBatch?.();
    } while (next);
    put(key, { ...job, running: false, continuation: null });
  } catch (error) {
    put(key, { ...job, running: false, error });
  }
}

/** The write actions the server labels read-only: `ids` from the last
 * discovery (readOnlyHint), and Twenty's record reads by their stored names. */
export function readOnlyActions(service: Service, ids: string[]) {
  return service.actions.filter(
    (action) =>
      action.effect === "write" &&
      (ids.includes(action.id) ||
        (action.binding.type === "mcp" &&
          !!action.binding.catalogTool &&
          twentyReadTool(action.binding.catalogTool))),
  );
}
/** Marks the server's read-only labels as reads that run without approval
 * and turns them on: an administrator's choice, one command for all of them.
 * Actions nobody was granted yet get the service's audience, so the reads
 * are usable right away. Resolves to the command's result. */
export function markReadOnly(
  state: CatalogState,
  service: Service,
  ids: string[],
) {
  const actions = readOnlyActions(service, ids);
  if (!actions.length) return Promise.resolve(undefined);
  const ungranted = actions.every(
    ({ policy }) =>
      !policy.roles.length &&
      !policy.users.length &&
      !policy.workspaceRoles?.length,
  );
  const audience = service.access ?? {
    roles: ["owner", "admin", "member"] as const,
    workspaceRoles: [],
  };
  return state.mutate("command", {
    type: "updateActions",
    serviceId: service.id,
    serviceRevision: service.revision,
    actions: actions.map(({ id, revision }) => ({ id, revision })),
    patch: {
      effect: "read",
      approval: "never",
      enabled: true,
      ...(ungranted
        ? {
            roles: [...audience.roles],
            workspaceRoles: [...audience.workspaceRoles],
          }
        : {}),
    },
  });
}
