import { randomUUID } from "node:crypto";
import type { Scope } from "../../packages/protocol";
import {
  hubConversationId,
  hubEligibleInput,
} from "../../packages/protocol/hub";
import type {
  ProcessExecutionInventory,
  ProcessInputCard,
  ProcessInputRequest,
} from "../../packages/protocol/process-execution";
import {
  PROCESS_START_PROFILE,
  type ProcessStartIntent,
  type ProcessStartOriginalCommand,
} from "../../packages/protocol/process-start";
import type { ProcessRuntimeResponse } from "../../packages/protocol/process-coordinator";
import { IdentityError } from "./error";
import type { HubRunOutcome } from "./hub";
import type { ProcessActor } from "./service-processes";

/** How long a refresh waits for the person's agent to be free. */
const BUSY_RETRIES = 40;
const BUSY_PAUSE_MS = 3000;
/** The same deadline as an ordinary chat command. */
const RUN_DEADLINE_MS = 10 * 60_000;

/** Who a refresh runs for: the live credential that asked, or the scheduler
 * on the person's behalf (no bearer; their membership is checked again). */
export type HubCredential = {
  header?: string;
  /** A scheduled fill: no live credential, the stored membership instead. */
  scheduled?: boolean;
  workspaceId: string;
  serverId: string;
  /** The person as authenticated when the refresh was requested. */
  actor: ProcessActor;
};
type Credential = HubCredential;
/** What a fill authenticates with: a bearer header, or a member for a scheduled fill. */
export type HubFillCredential =
  | string
  | undefined
  | { member: { organizationId: string; userId: string } };
export type HubLaunch = (
  credential: HubCredential,
  scope: Scope,
  items: { id: string; processId?: string }[],
  language: "en" | "cs",
) => void;
export type HubRunnerDependencies = {
  /** One page of the person's start inventory (the ordinary passive read). */
  inventory(
    credential: Credential,
    query: { after?: string; fingerprint?: string },
  ): Promise<ProcessExecutionInventory>;
  /** The hub's write check under current policy: true when every service
   * action of this version only reads or waits for the person's approval. */
  unattended(
    credential: Credential,
    entry: { processId: string; version: number; artifactDigest: string },
  ): Promise<boolean>;
  /** The ordinary explicit form preparation; persists only a start intent. */
  prepare(
    credential: Credential,
    request: ProcessInputRequest,
  ): Promise<ProcessInputCard>;
  /** The ordinary authenticated process coordinator for this credential. */
  coordinator(credential: Credential): Promise<{
    scope: Scope;
    coordinator: {
      execute(
        raw: unknown,
        signal: AbortSignal,
        validateOrigin: (
          intent: ProcessStartIntent,
          command: ProcessStartOriginalCommand,
        ) => void,
        options?: { lane?: "hub" },
      ): Promise<ProcessRuntimeResponse>;
    };
  }>;
  /** Creates the item's chat once; later calls replay the same command. */
  createConversation(scope: Scope, conversationId: string): void;
  conversationExists(scope: Scope, conversationId: string): boolean;
  /** Records the outcome for the person; status comes from the run itself. */
  record(
    credential: Credential,
    scope: Scope,
    itemId: string,
    outcome: HubRunOutcome,
  ): Promise<void>;
  /** An AI widget's fill under this credential; it stores its own data. */
  fill(
    credential: Credential,
    itemId: string,
    language: "en" | "cs",
    signal: AbortSignal,
  ): Promise<HubRunOutcome>;
  /** Always called last, even when recording failed (e.g. the session ended). */
  release(scope: Scope, itemId: string): void;
};
const errorCode = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string" &&
  /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : "hub_refresh_failed";
const busy = (error: unknown) =>
  ["catalog_busy", "model_busy"].includes(errorCode(error));

/**
 * Refreshes hub items in the background with the person's live credential.
 * A process item goes through exactly the steps of a manual start:
 * inventory, form preparation with a command origin in the item's own chat,
 * and the process coordinator. An AI widget is filled by a closed read-only
 * agent (`fill`). One item at a time per person; nothing is retried after
 * admission, so an unconfirmed effect is never repeated.
 */
export class HubRunner {
  private queues = new Map<string, Promise<void>>();
  private controllers = new Set<AbortController>();
  private closed = false;
  constructor(private deps: HubRunnerDependencies) {}

  launch(
    credential: Credential,
    scope: Scope,
    items: { id: string; processId?: string }[],
    language: "en" | "cs",
  ) {
    for (const item of items) {
      if (this.closed) {
        this.deps.release(scope, item.id);
        continue;
      }
      // One queue per person, whichever credential (web or app) asked.
      const key = JSON.stringify([scope.workspaceId, scope.userId]);
      const previous = this.queues.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => this.run(credential, scope, item, language))
        .catch(() => {});
      this.queues.set(key, next);
      void next.finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    }
  }

  private async run(
    credential: Credential,
    scope: Scope,
    item: { id: string; processId?: string },
    language: "en" | "cs",
  ) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(RUN_DEADLINE_MS),
    ]);
    let outcome: HubRunOutcome;
    try {
      if (this.closed) throw new IdentityError(503, "identity_unavailable");
      outcome = item.processId
        ? await this.start(
            credential,
            { id: item.id, processId: item.processId },
            language,
            signal,
          )
        : await this.deps.fill(credential, item.id, language, signal);
    } catch (error) {
      outcome = { type: "failed", error: errorCode(error) };
    } finally {
      this.controllers.delete(controller);
    }
    try {
      if (!this.closed)
        await this.deps.record(credential, scope, item.id, outcome);
    } catch {
      /* The next read reconciles from the run or reports an interruption. */
    } finally {
      this.deps.release(scope, item.id);
    }
  }

  private async start(
    credential: Credential,
    item: { id: string; processId: string },
    language: "en" | "cs",
    signal: AbortSignal,
  ): Promise<HubRunOutcome> {
    if (this.closed) throw new IdentityError(503, "identity_unavailable");
    let query: { after?: string; fingerprint?: string } = {};
    let entry: ProcessExecutionInventory["processes"][number] | undefined;
    for (let page = 0; page < 11 && !entry; page++) {
      const inventory = await this.deps.inventory(credential, query);
      entry = inventory.processes.find(
        (value) => value.processId === item.processId,
      );
      if (!inventory.nextAfter) break;
      query = {
        after: inventory.nextAfter,
        fingerprint: inventory.fingerprint,
      };
    }
    signal.throwIfAborted();
    if (!entry) return { type: "failed", error: "hub_process_unavailable" };
    if (entry.availability !== "ready")
      return { type: "failed", error: entry.reason };
    if (!hubEligibleInput(entry.inputSchema))
      return { type: "failed", error: "hub_process_needs_input" };
    if (!(await this.deps.unattended(credential, entry)))
      return { type: "failed", error: "hub_process_writes" };
    signal.throwIfAborted();
    const access = await this.deps.coordinator(credential);
    const conversationId = hubConversationId(item.id);
    this.deps.createConversation(access.scope, conversationId);
    const card = await this.deps.prepare(credential, {
      processId: entry.processId,
      version: entry.version,
      artifactDigest: entry.artifactDigest,
      language,
      origin: { type: "command", conversationId, requestId: randomUUID() },
    });
    const commandId = randomUUID();
    const command = {
      profile: PROCESS_START_PROFILE,
      type: "process.start" as const,
      commandId,
      idempotencyKey: commandId,
      intentId: card.intent.intentId,
      conversationId,
      language,
      input: {},
    };
    // The same origin check as the app's start route.
    const validate = (
      intent: ProcessStartIntent,
      original: ProcessStartOriginalCommand,
    ) => {
      signal.throwIfAborted();
      if (
        intent.origin.type === "card" ||
        intent.origin.conversationId !== original.conversationId ||
        !this.deps.conversationExists(access.scope, original.conversationId)
      )
        throw new IdentityError(409, "process_origin_changed");
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await access.coordinator.execute(
          command,
          signal,
          validate,
          { lane: "hub" },
        );
        return result.admission.status === "rejected"
          ? { type: "failed", error: result.admission.reason }
          : { type: "admitted", parentRunId: result.admission.parentRunId };
      } catch (error) {
        // Busy is refused before admission; the exact same command may try again.
        if (!busy(error) || attempt >= BUSY_RETRIES) throw error;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, BUSY_PAUSE_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
    }
  }

  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.queues.values()]);
  }
}
