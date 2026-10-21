import { z } from "zod";
import { CatalogTarget } from "../../../../packages/protocol/service-catalog";
import {
  WORKSPACE_DESIGN_PROFILE,
  DESIGN_PROFILE,
  WorkspaceDesignStartSchema,
  DesignStartSchema,
  DesignAcknowledgeSchema,
  DesignAcceptSchema,
  DesignUpdateSchema,
  DesignTurnStartSchema,
  type OwnedDesignReview as DesignReview,
  type DesignTurn,
  type DesignCapabilities,
  type DesignBrief,
} from "../../../../packages/protocol/process-design";
import { type ProcessDefinition } from "../../../../packages/protocol/service-processes";
import { api, ApiError } from "./api";
import {
  designApiPath,
  designReviewResponse,
  designTurnsResponse,
  designTurnResponse,
  designMutationResponse,
  loadDesignCapabilities,
} from "./process-design-api";
import { designStoragePrefix } from "./design-authority";

const StartCommandSchema = z.strictObject({
  kind: z.literal("start"),
  body: z.union([DesignStartSchema, WorkspaceDesignStartSchema]),
});
const FirstMessageSchema = DesignTurnStartSchema.pick({
  requestId: true,
  modelId: true,
  text: true,
  language: true,
}).strict();
const CommandSchema = z.discriminatedUnion("kind", [
  StartCommandSchema,
  z.strictObject({ kind: z.literal("turns"), body: DesignTurnStartSchema }),
  z.strictObject({ kind: z.literal("update"), body: DesignUpdateSchema }),
  z.strictObject({
    kind: z.literal("acknowledge"),
    body: DesignAcknowledgeSchema,
  }),
  z.strictObject({ kind: z.literal("accept"), body: DesignAcceptSchema }),
]);
export type DesignCommand = z.infer<typeof CommandSchema>;
const SavedSchema = z.strictObject({
  version: z.literal(1),
  sessionId: z.string().nullable(),
  pending: CommandSchema.nullable(),
  composer: z.string().max(4000),
  modelId: z.string(),
  firstMessage: FirstMessageSchema.nullable().default(null),
  // Only the initial route-to-session transition may restore a different ID.
  handoff: StartCommandSchema.nullable().default(null),
  rejectedTurns: z
    .array(
      z.strictObject({
        command: DesignTurnStartSchema,
        code: z.string().regex(/^[a-z][a-z0-9_]{0,100}$/),
      }),
    )
    .max(8)
    .default([]),
});
type Saved = z.infer<typeof SavedSchema>;
export type DesignClientState = Saved & {
  review: DesignReview | null;
  turns: DesignTurn[];
  capabilities: DesignCapabilities | null;
  loading: boolean;
  dispatching: boolean;
  initializing: boolean;
  fresh: boolean;
  error: string | null;
  denied: boolean;
};
type Target = z.infer<typeof CatalogTarget>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type DesignClientScope = Target & {
  authority: string;
  serviceId: string;
  /** Who owns a new workspace-profile process: the workspace (console) or
   * the signed-in person ("user", a personal process from the web app). */
  owner?: "workspace" | "user";
  sessionId?: string;
  processId?: string;
  baselineVersion?: number;
};
export type DesignTransport = {
  request: typeof api;
  capabilities: typeof loadDesignCapabilities;
};
const defaultTransport: DesignTransport = {
  request: api,
  capabilities: loadDesignCapabilities,
};
const sameScope = (a: Target, b: Target) =>
  a.organizationId === b.organizationId && a.workspaceId === b.workspaceId;
const samePin = (a: DesignTurn["model"], b: DesignTurn["model"]) =>
  a.id === b.id &&
  a.revision === b.revision &&
  a.providerId === b.providerId &&
  a.providerRevision === b.providerRevision;
/** The owner a stored start command asked for; service starts have none. */
const startOwner = (body: DesignCommand["body"]) =>
  "owner" in body ? body.owner.type : undefined;
const query = (target: Target, extra: Record<string, string> = {}) =>
  new URLSearchParams({ ...target, ...extra });
export function designScopeStorageKey(scope: DesignClientScope) {
  return (
    designStoragePrefix +
    [
      scope.authority,
      scope.organizationId,
      scope.workspaceId,
      scope.serviceId || (scope.owner === "user" ? "~personal" : "~workspace"),
    ]
      .map(encodeURIComponent)
      .join("/")
  );
}
/** Only IDs are listed; proposal/history still require fresh authenticated reads. */
export function storedDesignSessions(
  scope: DesignClientScope,
  storage: globalThis.Storage,
): string[] {
  const sessions = new Set<string>();
  const prefix = `${designScopeStorageKey(scope)}/`;
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      const saved = raw ? SavedSchema.safeParse(JSON.parse(raw)) : null;
      if (saved?.success && saved.data.sessionId)
        sessions.add(saved.data.sessionId);
    }
  } catch {
    return [];
  }
  return [...sessions].slice(-8);
}
function problem(error: unknown): string {
  return error instanceof ApiError
    ? error.code && /^[a-z][a-z0-9_]{0,100}$/.test(error.code)
      ? error.code
      : `http_${error.status}`
    : error instanceof SyntaxError || error instanceof z.ZodError
      ? "response_invalid"
      : "connection_lost";
}

/** Holds one immutable in-flight command. Refresh/reload are read-only. */
export class ProcessDesignClient {
  private state: DesignClientState;
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private refreshSequence = 0;
  private disposed = false;
  private lifecycle = 0;
  private storageInvalid = false;
  private postBusy = false;
  private keys = new Set<string>();
  private target: Target;
  private baseKey: string;
  constructor(
    readonly scope: DesignClientScope,
    private storage: Storage,
    private transport: DesignTransport = defaultTransport,
  ) {
    this.target = CatalogTarget.parse({
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
    });
    this.baseKey = designScopeStorageKey(scope);
    let saved: Saved = {
      version: 1,
      sessionId: scope.sessionId ?? null,
      pending: null,
      composer: "",
      modelId: "",
      firstMessage: null,
      handoff: null,
      rejectedTurns: [],
    };
    let error: string | null = null;
    try {
      const raw = storage.getItem(this.key(saved.sessionId));
      if (raw) {
        const parsed = SavedSchema.parse(JSON.parse(raw));
        const initialHandoff =
          saved.sessionId === null &&
          parsed.sessionId !== null &&
          parsed.handoff !== null &&
          this.commandBound(parsed.handoff, null);
        if (
          (parsed.sessionId !== saved.sessionId && !initialHandoff) ||
          (parsed.pending &&
            !this.commandBound(parsed.pending, parsed.sessionId)) ||
          (parsed.firstMessage &&
            (parsed.sessionId !== null || parsed.pending?.kind !== "start")) ||
          (parsed.handoff &&
            (parsed.sessionId === null ||
              !this.startOwnerBound(parsed.handoff))) ||
          parsed.rejectedTurns.some(
            (r) =>
              !sameScope(r.command, this.target) ||
              r.command.sessionId !== parsed.sessionId,
          )
        )
          throw new SyntaxError("Stored design scope mismatch");
        saved = parsed;
        if (scope.sessionId && saved.handoff) {
          // A mounted session URL completes the temporary route handoff. A new
          // conversation can then use the initial route without reopening this one.
          const initialKey = this.startKey(saved.handoff);
          const initialRaw = storage.getItem(initialKey);
          const initial = initialRaw
            ? SavedSchema.parse(JSON.parse(initialRaw))
            : null;
          if (
            initial?.sessionId === saved.sessionId &&
            JSON.stringify(initial.handoff) === JSON.stringify(saved.handoff)
          )
            storage.removeItem(initialKey);
          saved = { ...saved, handoff: null };
          storage.setItem(this.key(saved.sessionId), JSON.stringify(saved));
        }
      }
    } catch {
      error = "recovery_storage_invalid";
      this.storageInvalid = true;
    }
    this.state = {
      ...saved,
      review: null,
      turns: [],
      capabilities: null,
      loading: false,
      dispatching: false,
      initializing: false,
      fresh: false,
      error,
      denied: false,
    };
  }
  private key(sessionId: string | null) {
    return `${this.baseKey}/${encodeURIComponent(sessionId ?? `new:${this.scope.processId ?? ""}:${this.scope.baselineVersion ?? ""}`)}`;
  }
  private startKey(command: z.infer<typeof StartCommandSchema>) {
    return `${this.baseKey}/${encodeURIComponent(`new:${command.body.processId ?? ""}:${command.body.baselineVersion ?? ""}`)}`;
  }
  private query(extra: Record<string, string> = {}) {
    return query(this.target, {
      ...(this.scope.serviceId ? {} : { profile: WORKSPACE_DESIGN_PROFILE }),
      ...extra,
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<DesignClientState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private persist(saved: Saved) {
    // Durability is mandatory before dispatch. Storage failures do not send commands.
    const key = this.key(saved.sessionId);
    this.storage.setItem(key, JSON.stringify(SavedSchema.parse(saved)));
    this.keys.add(key);
    if (saved.handoff) {
      const initialKey = this.startKey(saved.handoff);
      this.storage.setItem(initialKey, JSON.stringify(saved));
      this.keys.add(initialKey);
    }
  }
  private saved(patch: Partial<Saved> = {}): Saved {
    const {
      version,
      sessionId,
      pending,
      composer,
      modelId,
      firstMessage,
      handoff,
      rejectedTurns,
    } = this.state;
    return {
      version,
      sessionId,
      pending,
      composer,
      modelId,
      firstMessage,
      handoff,
      rejectedTurns,
      ...patch,
    };
  }
  private save(patch: Partial<Saved>) {
    if (this.disposed || this.state.denied || this.storageInvalid) return false;
    try {
      this.persist(this.saved(patch));
      this.set(patch);
      return true;
    } catch {
      this.set({ error: "recovery_storage_unavailable", fresh: false });
      return false;
    }
  }
  private commandBound(command: DesignCommand, sessionId: string | null) {
    if (!sameScope(command.body, this.target)) return false;
    return command.kind === "start"
      ? ("serviceId" in command.body ? command.body.serviceId : "") ===
          this.scope.serviceId &&
          startOwner(command.body) === this.ownerType &&
          sessionId === null &&
          command.body.processId === this.scope.processId &&
          command.body.baselineVersion === this.scope.baselineVersion
      : command.body.sessionId === sessionId;
  }
  private startOwnerBound(command: z.infer<typeof StartCommandSchema>) {
    return (
      sameScope(command.body, this.target) &&
      ("serviceId" in command.body ? command.body.serviceId : "") ===
        this.scope.serviceId &&
      startOwner(command.body) === this.ownerType
    );
  }
  /** The owner type this scope's start commands carry. */
  private get ownerType() {
    return this.scope.serviceId ? undefined : (this.scope.owner ?? "workspace");
  }
  setComposer(text: string) {
    if (!this.state.denied && text.length <= 4000)
      this.save({ composer: text });
  }
  setModel(id: string) {
    if (!this.state.turns.length && !this.state.pending && !this.postBusy)
      this.save({ modelId: id });
  }
  private assertReview(review: DesignReview, sessionId: string) {
    if (
      !sameScope(review, this.target) ||
      review.id !== sessionId ||
      (review.serviceId ?? "") !== this.scope.serviceId ||
      // A personal scope never shows or edits a workspace process.
      (this.scope.owner === "user" &&
        (!("owner" in review) || review.owner.type !== "user"))
    )
      throw new SyntaxError("Designer review binding mismatch");
  }
  private response<T extends { profile: string }>(value: T): T {
    if (
      value.profile !==
      (this.scope.serviceId ? DESIGN_PROFILE : WORKSPACE_DESIGN_PROFILE)
    )
      throw new SyntaxError("Designer profile binding mismatch");
    return value;
  }
  private assertTurn(turn: DesignTurn, sessionId: string) {
    if (!sameScope(turn, this.target) || turn.sessionId !== sessionId)
      throw new SyntaxError("Designer turn binding mismatch");
  }
  private deny() {
    try {
      for (const key of [
        ...this.keys,
        this.key(this.state.sessionId),
        ...(this.state.handoff ? [this.startKey(this.state.handoff)] : []),
      ])
        this.storage.removeItem(key);
    } catch {
      /* Access is still fenced even when storage cannot be changed. */
    }
    this.controller.abort();
    this.set({
      denied: true,
      review: null,
      turns: [],
      capabilities: null,
      composer: "",
      pending: null,
      modelId: "",
      firstMessage: null,
      handoff: null,
      rejectedTurns: [],
      fresh: false,
      loading: false,
      dispatching: false,
      initializing: false,
      error: "authority_lost",
    });
  }
  dispose() {
    this.disposed = true;
    this.lifecycle++;
    this.refreshSequence++;
    this.controller.abort();
    this.listeners.clear();
  }
  /** React StrictMode may detach and reattach the same mounted scope. */
  attach() {
    if (this.disposed) {
      this.disposed = false;
      this.controller = new AbortController();
      this.postBusy = false;
      this.set({ dispatching: false, initializing: false, fresh: false });
    }
  }
  /** Fetch all three sources; no POST, even when recovering a lost response. */
  async refresh(options: { reuseCapabilities?: boolean } = {}) {
    if (this.disposed || this.state.denied || this.storageInvalid) return;
    const sequence = ++this.refreshSequence;
    this.set({ loading: true, fresh: false });
    const sessionId = this.state.sessionId;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        // Polling keeps the verified catalog; a fingerprint mismatch below
        // retries with a complete fresh read.
        const cached =
          options.reuseCapabilities && !attempt
            ? this.state.capabilities
            : null;
        const [capabilities, proposal, history] = await Promise.all([
          cached ??
            this.transport.capabilities(this.target, this.controller.signal),
          sessionId
            ? this.transport
                .request(
                  `${designApiPath}?${this.query({ sessionId })}`,
                  undefined,
                  this.controller.signal,
                )
                .then((r) => designReviewResponse.parse(r).review)
            : null,
          sessionId
            ? this.transport
                .request(
                  `${designApiPath}/turns/list?${this.query({ sessionId })}`,
                  undefined,
                  this.controller.signal,
                )
                .then((r) => this.response(designTurnsResponse.parse(r)).turns)
            : [],
        ]);
        if (this.disposed || sequence !== this.refreshSequence) return;
        if (!sameScope(capabilities, this.target))
          throw new SyntaxError("Designer capabilities binding mismatch");
        if (proposal && sessionId) this.assertReview(proposal, sessionId);
        const ids = new Set<string>();
        const turnIds = new Set<string>();
        let time = "";
        for (const turn of history) {
          this.assertTurn(turn, sessionId!);
          if (
            ids.has(turn.requestId) ||
            turnIds.has(turn.turnId) ||
            turn.createdAt < time ||
            (history[0] && !samePin(turn.model, history[0].model))
          )
            throw new SyntaxError("Designer history mismatch");
          ids.add(turn.requestId);
          turnIds.add(turn.turnId);
          time = turn.createdAt;
        }
        if (history.filter((turn) => turn.status === "running").length > 1)
          throw new SyntaxError("Designer running history mismatch");
        const inconsistent =
          proposal &&
          (proposal.capabilityFingerprint !== capabilities.fingerprint ||
            history.some((turn) => turn.revision > proposal.revision));
        if (inconsistent) {
          if (!attempt) continue;
          throw new ApiError(409, "process_design_snapshot_changed");
        }
        const pending = this.state.pending;
        if (pending?.kind === "turns") {
          // The exact reader is useful when the journal/list response raced admission.
          let recorded = history.find(
            (turn) => turn.requestId === pending.body.requestId,
          );
          if (!recorded) {
            try {
              recorded = this.response(
                designTurnResponse.parse(
                  await this.transport.request(
                    `${designApiPath}/turns?${this.query({ sessionId: pending.body.sessionId, requestId: pending.body.requestId })}`,
                    undefined,
                    this.controller.signal,
                  ),
                ),
              ).turn;
              this.assertTurn(recorded, pending.body.sessionId);
            } catch (error) {
              if (!(error instanceof ApiError && error.status === 404))
                throw error;
            }
            if (recorded) {
              if (!attempt) continue;
              throw new ApiError(409, "process_design_snapshot_changed");
            }
          }
          if (recorded) {
            if (
              recorded.userText !== pending.body.text ||
              recorded.language !== pending.body.language ||
              recorded.model.id !== pending.body.modelId
            )
              throw new SyntaxError("Designer command binding mismatch");
            if (
              recorded.status !== "running" &&
              !this.save({
                pending: null,
                composer:
                  this.state.composer === pending.body.text
                    ? ""
                    : this.state.composer,
              })
            )
              return;
          }
        }
        if (this.disposed || sequence !== this.refreshSequence) return;
        this.set({
          capabilities,
          review: proposal,
          turns: history,
          fresh: true,
          error: null,
        });
        return;
      }
    } catch (error) {
      if (this.disposed || sequence !== this.refreshSequence) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status))
        this.deny();
      else this.set({ error: problem(error), fresh: false });
    } finally {
      if (sequence === this.refreshSequence) this.set({ loading: false });
    }
  }
  get blocked() {
    return (
      !!this.state.pending ||
      this.state.initializing ||
      this.postBusy ||
      !this.state.fresh ||
      this.state.turns.some((turn) => turn.status === "running") ||
      this.state.denied ||
      this.storageInvalid
    );
  }
  async start() {
    if (this.blocked || this.state.sessionId) return;
    await this.issue(this.startCommand());
  }
  private startCommand(): z.infer<typeof StartCommandSchema> {
    return {
      kind: "start",
      body: (this.scope.serviceId
        ? DesignStartSchema
        : WorkspaceDesignStartSchema
      ).parse({
        ...this.target,
        requestId: crypto.randomUUID(),
        ...(this.scope.serviceId
          ? { serviceId: this.scope.serviceId }
          : {
              profile: WORKSPACE_DESIGN_PROFILE,
              owner: { type: this.scope.owner ?? "workspace" },
            }),
        ...(this.scope.processId ? { processId: this.scope.processId } : {}),
        ...(this.scope.baselineVersion
          ? { baselineVersion: this.scope.baselineVersion }
          : {}),
      }),
    };
  }
  get canSend() {
    const review = this.state.review;
    const pin = this.state.turns[0]?.model;
    const modelId = pin?.id ?? this.state.modelId;
    const model = this.state.capabilities?.models.find((m) => m.id === modelId);
    return (
      !this.blocked &&
      (!this.state.sessionId || !!review) &&
      !review?.acceptedProcessId &&
      !!model &&
      (!pin || samePin(pin, model)) &&
      !!this.state.composer.trim()
    );
  }
  async send(language: "en" | "cs") {
    if (!this.canSend) return;
    const review = this.state.review;
    const modelId = this.state.turns[0]?.model.id ?? this.state.modelId;
    if (!this.state.sessionId) {
      const firstMessage = FirstMessageSchema.parse({
        requestId: crypto.randomUUID(),
        modelId,
        language,
        text: this.state.composer,
      });
      await this.issue(this.startCommand(), { firstMessage });
      return;
    }
    await this.issue({
      kind: "turns",
      body: DesignTurnStartSchema.parse({
        ...this.target,
        sessionId: review!.id,
        requestId: crypto.randomUUID(),
        revision: review!.revision,
        modelId,
        language,
        text: this.state.composer,
      }),
    });
  }
  async updateCandidate(
    expected: Pick<
      DesignReview,
      "revision" | "reviewDigest" | "capabilityFingerprint"
    >,
    candidate: ProcessDefinition,
    brief?: DesignBrief,
  ) {
    const review = this.state.review;
    if (
      this.blocked ||
      !review ||
      review.acceptedProcessId ||
      expected.revision !== review.revision ||
      expected.reviewDigest !== review.reviewDigest ||
      expected.capabilityFingerprint !== review.capabilityFingerprint
    )
      return;
    await this.issue({
      kind: "update",
      body: DesignUpdateSchema.parse({
        ...this.target,
        sessionId: review.id,
        requestId: crypto.randomUUID(),
        revision: review.revision,
        brief: brief ?? review.brief,
        candidate,
      }),
    });
  }
  async acknowledge(
    expected: Pick<DesignReview, "revision" | "reviewDigest">,
    assumptions: { id: string; digest: string }[],
    confirmation?: "catalog" | "every_write",
  ) {
    const review = this.state.review;
    if (
      this.blocked ||
      !review ||
      review.acceptedProcessId ||
      expected.revision !== review.revision ||
      expected.reviewDigest !== review.reviewDigest
    )
      return;
    if (
      assumptions.some(
        (a) =>
          !review.assumptions.some(
            (current) =>
              current.id === a.id &&
              current.digest === a.digest &&
              !current.acknowledged,
          ),
      )
    )
      return;
    await this.issue({
      kind: "acknowledge",
      body: DesignAcknowledgeSchema.parse({
        ...this.target,
        sessionId: review.id,
        requestId: crypto.randomUUID(),
        revision: review.revision,
        assumptions,
        ...(confirmation ? { confirmation } : {}),
      }),
    });
  }
  async accept(expected: Pick<DesignReview, "revision" | "reviewDigest">) {
    const review = this.state.review;
    if (
      this.blocked ||
      !review ||
      review.acceptedProcessId ||
      !review.candidate ||
      !review.validation.valid ||
      review.blockers.length ||
      expected.revision !== review.revision ||
      expected.reviewDigest !== review.reviewDigest
    )
      return;
    await this.issue({
      kind: "accept",
      body: DesignAcceptSchema.parse({
        ...this.target,
        sessionId: review.id,
        requestId: crypto.randomUUID(),
        revision: review.revision,
        reviewDigest: review.reviewDigest,
      }),
    });
  }
  private async issue(command: DesignCommand, patch: Partial<Saved> = {}) {
    if (
      this.postBusy ||
      this.state.pending ||
      this.disposed ||
      this.state.denied
    )
      return;
    if (!this.save({ ...patch, pending: CommandSchema.parse(command) })) return;
    await this.dispatchExplicit();
  }
  /** Explicit human retry only; never substitutes a new revision, model or digest. */
  async retry() {
    if (
      !this.postBusy &&
      this.state.pending &&
      !this.state.denied &&
      this.state.fresh &&
      !this.state.loading
    )
      await this.dispatchExplicit();
  }
  private async dispatchExplicit() {
    const firstMessage =
      this.state.pending?.kind === "start" ? this.state.firstMessage : null;
    if (!firstMessage) {
      await this.dispatch();
      return;
    }
    const lifecycle = this.lifecycle;
    this.set({ initializing: true });
    try {
      await this.dispatch();
      // Only this live explicit action may continue a verified start. Remount,
      // passive refresh and polling never send the queued first turn.
      if (
        !this.disposed &&
        lifecycle === this.lifecycle &&
        this.state.pending?.kind === "turns" &&
        this.state.pending.body.requestId === firstMessage.requestId &&
        this.state.fresh
      )
        await this.dispatch();
    } finally {
      if (lifecycle === this.lifecycle) this.set({ initializing: false });
    }
  }
  private async dispatch() {
    const command = this.state.pending;
    if (!command || this.disposed || this.postBusy) return;
    this.postBusy = true;
    const lifecycle = this.lifecycle;
    this.refreshSequence++;
    this.set({ dispatching: true, fresh: false, error: null });
    try {
      const result = await this.transport.request(
        `${designApiPath}/${command.kind}${this.scope.serviceId ? "" : `?profile=${encodeURIComponent(WORKSPACE_DESIGN_PROFILE)}`}`,
        command.body,
        this.controller.signal,
      );
      if (this.disposed || lifecycle !== this.lifecycle) return;
      if (command.kind === "turns") {
        const turn = this.response(designTurnResponse.parse(result)).turn;
        this.assertTurn(turn, command.body.sessionId);
        if (
          turn.requestId !== command.body.requestId ||
          turn.userText !== command.body.text ||
          turn.language !== command.body.language ||
          turn.model.id !== command.body.modelId
        )
          throw new SyntaxError("Designer command binding mismatch");
        // Full passive refresh decides when controls can be unblocked.
      } else {
        const { receipt, review } = designMutationResponse.parse(result);
        const expected = {
          start: "started",
          update: "updated",
          acknowledge: "acknowledged",
          accept: "accepted",
        }[command.kind];
        if (
          !sameScope(receipt, this.target) ||
          receipt.requestId !== command.body.requestId ||
          receipt.kind !== expected ||
          (command.kind !== "start" &&
            receipt.sessionId !== command.body.sessionId) ||
          receipt.revision > review.revision ||
          (command.kind === "accept" &&
            receipt.processId !== review.acceptedProcessId)
        )
          throw new SyntaxError("Designer receipt binding mismatch");
        this.assertReview(review, receipt.sessionId);
        if (
          command.kind === "start" &&
          (review.baseline?.processId !== command.body.processId ||
            (command.body.baselineVersion !== undefined &&
              review.baseline?.version !== command.body.baselineVersion))
        )
          throw new SyntaxError("Designer baseline binding mismatch");
        const firstMessage =
          command.kind === "start" ? this.state.firstMessage : null;
        if (
          !this.save({
            sessionId: receipt.sessionId,
            pending: firstMessage
              ? {
                  kind: "turns",
                  body: DesignTurnStartSchema.parse({
                    ...this.target,
                    ...firstMessage,
                    sessionId: receipt.sessionId,
                    revision: review.revision,
                  }),
                }
              : null,
            firstMessage: null,
            ...(command.kind === "start" ? { handoff: command } : {}),
          })
        )
          return;
      }
      await this.refresh();
    } catch (error) {
      if (this.disposed || lifecycle !== this.lifecycle) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status))
        this.deny();
      else if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        // These refusals happen before the server records the command.
        (error.status !== 429 ||
          /^(process_design_busy|catalog_busy|catalog_budget_)/.test(
            error.code ?? "",
          ))
      ) {
        // A definite rejection requires a new explicit command after fresh review.
        if (
          this.save({
            pending: null,
            ...(command.kind === "start" ? { firstMessage: null } : {}),
            ...(command.kind === "turns"
              ? {
                  rejectedTurns: [
                    ...this.state.rejectedTurns,
                    { command: command.body, code: problem(error) },
                  ].slice(-8),
                }
              : {}),
          })
        ) {
          await this.refresh();
          this.set({ error: problem(error) });
        }
      } else this.set({ error: problem(error), fresh: false });
    } finally {
      if (lifecycle === this.lifecycle) {
        this.postBusy = false;
        this.set({ dispatching: false });
      }
    }
  }
}
