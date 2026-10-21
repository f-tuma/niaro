import { z } from "zod";
import { CatalogTarget } from "../../../../packages/protocol/service-catalog";
import {
  WORKSPACE_PROCESS_PROFILE,
  OwnedProcessRecordSchema,
  type OwnedProcessRecord,
  PROCESS_PROFILE,
  ProcessVersionSchema,
  type ProcessVersion,
} from "../../../../packages/protocol/service-processes";
import {
  PROCESS_VERSION_PROFILE,
  ProcessFreezeCommandSchema,
  ProcessFreezeReceiptSchema,
  ProcessVersionListSchema,
  type ProcessFreezeReceipt,
} from "../../../../packages/protocol/process-versions";
import {
  PROCESS_NATIVE_TEST_PROFILE,
  PROCESS_NATIVE_TEST_DETAIL_PROFILE,
  NativeTestRequestSchema,
  NativeTestJobSchema,
  NativeTestListSchema,
  NativeTestDetailV2Schema,
  NativeTestToolsSchema,
  type NativeTestTools,
  type NativeTestRequest,
  type NativeTestJob,
  type NativeTestSummary,
  type NativeTestDiagnostic,
} from "../../../../packages/protocol/process-native-testing";
import {
  PROCESS_ACTIVATION_PROFILE,
  ProcessActivationCommandSchema,
  ProcessActivationReceiptSchema,
  ProcessActivationReviewSchema,
  type ProcessActivationReceipt,
} from "../../../../packages/protocol/process-activation";
import { IdentityId } from "../../../../packages/protocol/identity";
import {
  DesignCapabilitiesSchema,
  type DesignCapabilities,
} from "../../../../packages/protocol/process-design";
import { api, ApiError } from "./api";
import { loadDesignCapabilities } from "./process-design-api";
import { designStoragePrefix } from "./design-authority";
import {
  parseSuiteDraft,
  suiteToDraft,
  readSuiteDraft,
} from "./process-test-suite";

const base = "identity/catalog/processes";
const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("freeze"),
    body: ProcessFreezeCommandSchema,
  }),
  z.strictObject({ kind: z.literal("test"), body: NativeTestRequestSchema }),
  z.strictObject({
    kind: z.literal("decision"),
    body: ProcessActivationCommandSchema,
  }),
]);
export type ProcessConsoleCommand = z.infer<typeof commandSchema>;
const savedSchema = z.strictObject({
  format: z.literal(1),
  suite: z.string().max(250000),
  selectedVersion: z.number().int().positive().nullable(),
  selectedTestId: IdentityId.nullable(),
  lastTestRequestId: IdentityId.nullable(),
  pending: commandSchema.nullable(),
  lastFreeze: ProcessFreezeCommandSchema.nullable(),
  lastDecision: ProcessActivationCommandSchema.nullable(),
  rejected: z
    .strictObject({ command: commandSchema, code: z.string().max(120) })
    .nullable(),
});
type Saved = z.infer<typeof savedSchema>;
export type ProcessConsoleScope = z.infer<typeof CatalogTarget> & {
  authority: string;
  userId: string;
  serviceId: string;
  processId: string;
};
export type ProcessConsoleState = Saved & {
  process: OwnedProcessRecord | null;
  versions: ProcessVersion[];
  nextBefore: number | null;
  capabilities: DesignCapabilities | null;
  history: NativeTestSummary[];
  nextAfter: string | null;
  tools: NativeTestTools | null;
  toolsError: string | null;
  job: NativeTestJob | null;
  original: NativeTestRequest | null;
  diagnostic: NativeTestDiagnostic | null;
  review: z.infer<typeof ProcessActivationReviewSchema> | null;
  reviewError: string | null;
  freezeReceipt: ProcessFreezeReceipt | null;
  decisionReceipt: ProcessActivationReceipt | null;
  loading: boolean;
  dispatching: boolean;
  fresh: boolean;
  denied: boolean;
  error: string | null;
};
export type ProcessConsoleTransport = {
  request: typeof api;
  capabilities: typeof loadDesignCapabilities;
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const recordResponse = CatalogTarget.extend({
  profile: z.enum([PROCESS_PROFILE, WORKSPACE_PROCESS_PROFILE]),
  process: OwnedProcessRecordSchema,
});
const versionResponse = CatalogTarget.extend({
  profile: z.enum([PROCESS_PROFILE, WORKSPACE_PROCESS_PROFILE]),
  version: ProcessVersionSchema,
});
const freezeResponse = z.strictObject({ receipt: ProcessFreezeReceiptSchema });
const decisionResponse = z.strictObject({
  receipt: ProcessActivationReceiptSchema,
});
const testResponse = z.strictObject({ job: NativeTestJobSchema });
const reviewResponse = z.strictObject({
  review: ProcessActivationReviewSchema,
});
const same = (a: unknown, b: unknown): boolean => {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};
export const processConsoleStorageKey = (s: ProcessConsoleScope) =>
  designStoragePrefix +
  "console/" +
  [
    s.authority,
    s.userId,
    s.organizationId,
    s.workspaceId,
    s.serviceId || "~workspace",
    s.processId,
  ]
    .map(encodeURIComponent)
    .join("/");
function problem(error: unknown) {
  return error instanceof ApiError
    ? (error.code ?? `http_${error.status}`)
    : error instanceof SyntaxError || error instanceof z.ZodError
      ? "response_invalid"
      : "connection_lost";
}

/** One durable human command. Mount, recovery, refresh and polling only read. */
export class ProcessConsoleClient {
  private state: ProcessConsoleState;
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private disposed = false;
  private lifecycle = 0;
  private sequence = 0;
  private posting = false;
  private invalid = false;
  private readonly target: z.infer<typeof CatalogTarget>;
  private readonly key: string;
  constructor(
    readonly scope: ProcessConsoleScope,
    private storage: Storage,
    private transport: ProcessConsoleTransport = {
      request: api,
      capabilities: loadDesignCapabilities,
    },
  ) {
    this.target = CatalogTarget.parse({
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
    });
    IdentityId.parse(scope.userId);
    if (scope.serviceId) IdentityId.parse(scope.serviceId);
    IdentityId.parse(scope.processId);
    this.key = processConsoleStorageKey(scope);
    const empty: Saved = {
      format: 1,
      suite: "",
      selectedVersion: null,
      selectedTestId: null,
      lastTestRequestId: null,
      pending: null,
      lastFreeze: null,
      lastDecision: null,
      rejected: null,
    };
    let saved = empty;
    try {
      const raw = storage.getItem(this.key);
      if (raw) saved = savedSchema.parse(JSON.parse(raw));
      for (const c of [
        saved.pending,
        saved.rejected?.command,
        saved.lastFreeze && { kind: "freeze", body: saved.lastFreeze },
        saved.lastDecision && { kind: "decision", body: saved.lastDecision },
      ])
        if (c && (!this.scoped(c.body) || c.body.processId !== scope.processId))
          throw new SyntaxError("Stored command scope mismatch");
    } catch {
      this.invalid = true;
      saved = empty;
    }
    this.state = {
      ...saved,
      process: null,
      versions: [],
      nextBefore: null,
      capabilities: null,
      history: [],
      nextAfter: null,
      job: null,
      original: null,
      diagnostic: null,
      review: null,
      reviewError: null,
      tools: null,
      toolsError: null,
      freezeReceipt: null,
      decisionReceipt: null,
      loading: false,
      dispatching: false,
      fresh: false,
      denied: false,
      error: this.invalid ? "recovery_storage_invalid" : null,
    };
  }
  private scoped(value: z.infer<typeof CatalogTarget>) {
    return (
      value.organizationId === this.target.organizationId &&
      value.workspaceId === this.target.workspaceId
    );
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<ProcessConsoleState>) {
    if (!this.disposed) {
      this.state = { ...this.state, ...patch };
      this.listeners.forEach((l) => l());
    }
  }
  private persist(
    patch: Partial<Saved>,
    runtime: Partial<Omit<ProcessConsoleState, keyof Saved>> = {},
  ) {
    // Runtime fields are deliberately absent from durable recovery data.
    const {
      format,
      suite,
      selectedVersion,
      selectedTestId,
      lastTestRequestId,
      pending,
      lastFreeze,
      lastDecision,
      rejected,
    } = this.state;
    if (this.disposed || this.invalid || this.state.denied) return false;
    try {
      const saved = savedSchema.parse({
        format,
        suite,
        selectedVersion,
        selectedTestId,
        lastTestRequestId,
        pending,
        lastFreeze,
        lastDecision,
        rejected,
        ...patch,
      });
      this.storage.setItem(this.key, JSON.stringify(saved));
      this.set({ ...patch, ...runtime });
      return true;
    } catch {
      this.set({ error: "recovery_storage_unavailable", fresh: false });
      return false;
    }
  }
  private deny() {
    this.sequence++;
    try {
      this.storage.removeItem(this.key);
    } catch {
      /* Publication stays fenced even if cleanup fails. */
    }
    this.abort.abort();
    this.set({
      denied: true,
      fresh: false,
      loading: false,
      dispatching: false,
      process: null,
      versions: [],
      capabilities: null,
      history: [],
      job: null,
      original: null,
      diagnostic: null,
      review: null,
      tools: null,
      toolsError: null,
      freezeReceipt: null,
      decisionReceipt: null,
      suite: "",
      pending: null,
      lastFreeze: null,
      lastDecision: null,
      selectedTestId: null,
      lastTestRequestId: null,
      rejected: null,
      error: "authority_lost",
    });
  }
  dispose() {
    this.set({ job: null, original: null, diagnostic: null, review: null });
    this.disposed = true;
    this.lifecycle++;
    this.sequence++;
    this.abort.abort();
    this.listeners.clear();
  }
  attach() {
    if (this.disposed) {
      this.disposed = false;
      this.abort = new AbortController();
      this.posting = false;
      this.set({ dispatching: false, fresh: false });
    }
  }
  get blocked() {
    return (
      this.disposed ||
      this.invalid ||
      this.state.denied ||
      this.posting ||
      !!this.state.pending ||
      !this.state.fresh ||
      this.state.loading
    );
  }
  get artifact() {
    return (
      this.state.versions.find(
        (v) => v.version === this.state.selectedVersion,
      ) ?? null
    );
  }
  setSuite(value: string) {
    if (this.posting || this.state.pending || value.length > 250000) return;
    const baseline = (raw: string) => {
      try {
        const draft = readSuiteDraft(raw);
        return draft.comparisonMode === "configured_only"
          ? ""
          : draft.genericModelId;
      } catch {
        return "";
      }
    };
    const changed = baseline(value) !== baseline(this.state.suite);
    if (this.persist({ suite: value }) && changed) {
      this.sequence++;
      this.set({
        tools: null,
        toolsError: null,
        loading: false,
        fresh: false,
        review: null,
        diagnostic: null,
      });
    }
  }
  useOriginalSuite() {
    if (this.state.original && !this.blocked)
      this.setSuite(suiteToDraft(this.state.original.suite));
  }
  clearRejection() {
    this.persist({ rejected: null });
  }
  async selectVersion(version: number) {
    if (this.posting || this.state.pending || this.invalid || this.state.denied)
      return;
    if (
      this.persist(
        {
          selectedVersion: version,
          selectedTestId: null,
          lastTestRequestId: null,
        },
        {
          job: null,
          original: null,
          diagnostic: null,
          review: null,
          history: [],
          nextAfter: null,
        },
      )
    ) {
      await this.refresh();
    }
  }
  async selectTest(testId: string) {
    if (this.posting || this.state.pending || this.invalid || this.state.denied)
      return;
    if (
      this.persist(
        { selectedTestId: testId, lastTestRequestId: null },
        { job: null, original: null, diagnostic: null, review: null },
      )
    ) {
      await this.refresh();
    }
  }
  private query(extra: Record<string, string | number>) {
    return new URLSearchParams({
      ...this.target,
      ...Object.fromEntries(
        Object.entries(extra).map(([k, v]) => [k, String(v)]),
      ),
    });
  }
  private get(path: string, extra: Record<string, string | number>) {
    return this.transport.request(
      `${base}${path}?${this.query({ ...(!path && !this.scope.serviceId ? { profile: WORKSPACE_PROCESS_PROFILE } : {}), ...extra })}`,
      undefined,
      this.abort.signal,
    );
  }
  private assertRecord(value: z.infer<typeof recordResponse>) {
    if (
      value.profile !==
        (this.scope.serviceId ? PROCESS_PROFILE : WORKSPACE_PROCESS_PROFILE) ||
      !this.scoped(value) ||
      value.process.id !== this.scope.processId ||
      (value.process.serviceId ?? "") !== this.scope.serviceId
    )
      throw new SyntaxError("Process binding mismatch");
  }
  private assertVersion(version: ProcessVersion) {
    if (version.processId !== this.scope.processId)
      throw new SyntaxError("Version binding mismatch");
  }
  private assertHistory(
    list: z.infer<typeof NativeTestListSchema>,
    version: number,
  ) {
    if (
      !this.scoped(list) ||
      list.summaries.some(
        (s, i) =>
          !this.scoped(s) ||
          s.processId !== this.scope.processId ||
          s.version !== version ||
          (i > 0 && s.testId <= list.summaries[i - 1]!.testId),
      )
    )
      throw new SyntaxError("Private history binding mismatch");
    if (list.nextAfter && list.nextAfter !== list.summaries.at(-1)?.testId)
      throw new SyntaxError("History cursor mismatch");
  }
  private assertVersions(list: z.infer<typeof ProcessVersionListSchema>) {
    if (
      !this.scoped(list) ||
      list.processId !== this.scope.processId ||
      list.versions.some(
        (v, i) =>
          v.processId !== this.scope.processId ||
          (i > 0 && v.version >= list.versions[i - 1]!.version),
      ) ||
      (list.nextBefore && list.nextBefore !== list.versions.at(-1)?.version)
    )
      throw new SyntaxError("Version list binding mismatch");
  }
  private assertReceipt(
    receipt: ProcessFreezeReceipt | ProcessActivationReceipt,
    body: ProcessConsoleCommand["body"],
  ) {
    for (const [key, value] of Object.entries(body))
      if (!same((receipt as unknown as Record<string, unknown>)[key], value))
        throw new SyntaxError("Receipt command mismatch");
  }
  private assertDetail(
    detail: z.infer<typeof NativeTestDetailV2Schema>,
    expected?: NativeTestRequest,
  ) {
    const { job, request } = detail;
    const previous =
      this.state.job?.testId === job.testId ? this.state.original : null;
    const known = this.state.history.find(
      (entry) => entry.testId === job.testId,
    );
    if (
      !this.scoped(job) ||
      !this.scoped(request) ||
      request.processId !== this.scope.processId ||
      job.processId !== request.processId ||
      job.version !== request.version ||
      job.requestId !== request.requestId ||
      job.stamp.artifactDigest !== request.artifactDigest ||
      (job.qualification &&
        job.qualification.creatorUserId !== this.scope.userId) ||
      (previous && !same(previous, request)) ||
      (known &&
        (known.requestId !== request.requestId ||
          !same(known.stamp, job.stamp))) ||
      (expected && !same(expected, request))
    )
      throw new SyntaxError("Private test command mismatch");
  }
  private async optional<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  async refresh() {
    if (this.disposed || this.invalid || this.state.denied) return;
    const seq = ++this.sequence;
    this.set({ loading: true, fresh: false, review: null, diagnostic: null });
    const alive = () =>
      !this.disposed && !this.state.denied && seq === this.sequence;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const [record, capabilities, page] = await Promise.all([
          this.get("", { id: this.scope.processId }).then((v) =>
            recordResponse.parse(v),
          ),
          this.transport
            .capabilities(this.target, this.abort.signal)
            .then((v) => DesignCapabilitiesSchema.parse(v)),
          this.get("/versions", {
            profile: PROCESS_VERSION_PROFILE,
            processId: this.scope.processId,
          }).then((v) => ProcessVersionListSchema.parse(v)),
        ]);
        if (!alive()) return;
        this.assertRecord(record);
        this.assertVersions(page);
        if (!this.scoped(capabilities))
          throw new SyntaxError("Capability scope mismatch");
        let version =
          this.state.selectedVersion ?? page.versions[0]?.version ?? null;
        let testId = this.state.selectedTestId;
        let freezeReceipt: ProcessFreezeReceipt | null = null,
          decisionReceipt: ProcessActivationReceipt | null = null;
        const pending = this.state.pending;
        const freeze =
          pending?.kind === "freeze" ? pending.body : this.state.lastFreeze;
        const decision =
          pending?.kind === "decision" ? pending.body : this.state.lastDecision;
        const [f, d] = await Promise.all([
          freeze
            ? this.optional(() =>
                this.get("/versions/freeze", {
                  profile: PROCESS_VERSION_PROFILE,
                  requestId: freeze.requestId,
                }).then((v) => freezeResponse.parse(v).receipt),
              )
            : null,
          decision
            ? this.optional(() =>
                this.get("/activation", {
                  profile: PROCESS_ACTIVATION_PROFILE,
                  requestId: decision.requestId,
                }).then((v) => decisionResponse.parse(v).receipt),
              )
            : null,
        ]);
        if (!alive()) return;
        if (f && freeze) {
          this.assertReceipt(f, freeze);
          freezeReceipt = f;
        }
        if (d && decision) {
          this.assertReceipt(d, decision);
          decisionReceipt = d;
        }
        if (pending?.kind === "freeze" && f) {
          if (
            !this.persist(
              {
                pending: null,
                lastFreeze: pending.body,
                selectedVersion: f.version,
                selectedTestId: null,
                lastTestRequestId: null,
              },
              { job: null, original: null, diagnostic: null, review: null },
            )
          )
            return;
          version = f.version;
          testId = null;
        } else if (pending?.kind === "decision" && d) {
          if (!this.persist({ pending: null, lastDecision: pending.body }))
            return;
        }
        const testRequestId =
          pending?.kind === "test"
            ? pending.body.requestId
            : this.state.lastTestRequestId;
        const detail =
          testRequestId || testId
            ? await this.optional(() =>
                this.get("/tests/native/detail", {
                  profile: PROCESS_NATIVE_TEST_DETAIL_PROFILE,
                  ...(testRequestId
                    ? { requestId: testRequestId }
                    : { testId: testId! }),
                }).then((v) => NativeTestDetailV2Schema.parse(v)),
              )
            : null;
        if (!alive()) return;
        if (detail) {
          this.assertDetail(
            detail,
            pending?.kind === "test" ? pending.body : undefined,
          );
          if (
            (testRequestId && detail.request.requestId !== testRequestId) ||
            (!testRequestId && detail.job.testId !== testId)
          )
            throw new SyntaxError("Private test identifier mismatch");
          if (detail.job.version !== version)
            throw new SyntaxError("Selected test version mismatch");
          testId = detail.job.testId;
          if (pending?.kind === "test" && detail.job.status !== "running") {
            if (
              !this.persist({
                pending: null,
                lastTestRequestId: pending.body.requestId,
                selectedTestId: testId,
              })
            )
              return;
          }
        }
        const history = version
          ? await this.get("/tests/native/list", {
              profile: PROCESS_NATIVE_TEST_PROFILE,
              processId: this.scope.processId,
              version,
            }).then((v) => NativeTestListSchema.parse(v))
          : null;
        if (history && version) this.assertHistory(history, version);
        const versionMap = new Map(
          this.state.versions.map((v) => [v.version, v]),
        );
        for (const v of page.versions) {
          const old = versionMap.get(v.version);
          if (old && !same({ ...old, testStatus: v.testStatus }, v))
            throw new SyntaxError("Immutable version changed");
          versionMap.set(v.version, v);
        }
        const versions = [...versionMap.values()];
        if (version && !versions.some((v) => v.version === version)) {
          const response = versionResponse.parse(
            await this.get("", { id: this.scope.processId, version }),
          );
          if (
            response.profile !==
              (this.scope.serviceId
                ? PROCESS_PROFILE
                : WORKSPACE_PROCESS_PROFILE) ||
            !this.scoped(response) ||
            response.version.version !== version
          )
            throw new SyntaxError("Version response mismatch");
          this.assertVersion(response.version);
          versions.push(response.version);
        }
        const boundArtifact = versions.find((v) => v.version === version);
        if (
          boundArtifact &&
          ((detail &&
            detail.job.stamp.artifactDigest !== boundArtifact.digest) ||
            [
              ...this.state.history.filter((h) => h.version === version),
              ...(history?.summaries ?? []),
            ].some((h) => h.stamp.artifactDigest !== boundArtifact.digest))
        )
          throw new SyntaxError("Test artifact mismatch");
        let review: ProcessConsoleState["review"] = null,
          reviewError: string | null = null;
        if (detail?.job.qualification?.status === "qualified") {
          try {
            review = reviewResponse.parse(
              await this.get("/activation/review", {
                profile: PROCESS_ACTIVATION_PROFILE,
                processId: this.scope.processId,
                version: detail.job.version,
                testId: detail.job.testId,
              }),
            ).review;
            const q = detail.job.qualification;
            const summary = {
              policy: q.policy,
              scope: q.scope,
              liveAcceptance: q.liveAcceptance,
              status: q.status,
              reasons: q.reasons,
              coverage: q.coverage,
              qualificationDigest: q.qualificationDigest,
            };
            if (
              !this.scoped(review) ||
              review.processId !== this.scope.processId ||
              review.testId !== detail.job.testId ||
              review.version !== detail.job.version ||
              review.artifactDigest !== detail.job.stamp.artifactDigest ||
              !same(review.qualification, summary)
            )
              throw new SyntaxError("Activation review binding mismatch");
          } catch (e) {
            if (e instanceof ApiError && ![401, 403, 404].includes(e.status))
              reviewError = problem(e);
            else throw e;
          }
        }
        let tools: NativeTestTools | null = null,
          toolsError: string | null = null;
        let genericModelId = "";
        try {
          const draft = readSuiteDraft(this.state.suite);
          genericModelId =
            draft.comparisonMode === "configured_only"
              ? ""
              : draft.genericModelId;
        } catch {
          /* Invalid drafts stay editable. */
        }
        const artifact = versions.find((v) => v.version === version);
        if (genericModelId && artifact) {
          try {
            tools = NativeTestToolsSchema.parse(
              await this.get("/tests/native/tools", {
                profile: PROCESS_NATIVE_TEST_PROFILE,
                processId: this.scope.processId,
                version: artifact.version,
                genericModelId,
              }),
            );
            if (
              !this.scoped(tools) ||
              tools.processId !== this.scope.processId ||
              tools.version !== artifact.version ||
              tools.artifactDigest !== artifact.digest ||
              tools.genericModelId !== genericModelId
            )
              throw new SyntaxError("Tool inventory binding mismatch");
          } catch (e) {
            if (e instanceof ApiError && ![401, 403, 404].includes(e.status))
              toolsError = problem(e);
            else throw e;
          }
        }
        const current = recordResponse.parse(
          await this.get("", { id: this.scope.processId }),
        );
        this.assertRecord(current);
        if (!alive()) return;
        if (
          current.process.revision !== record.process.revision ||
          (review &&
            (review.revision !== current.process.revision ||
              review.activeVersion !== current.process.activeVersion))
        ) {
          if (!attempt) continue;
          throw new ApiError(409, "process_snapshot_changed");
        }
        if (!this.persist({ selectedVersion: version, selectedTestId: testId }))
          return;
        this.set({
          process: current.process,
          capabilities,
          tools,
          toolsError,
          versions: versions.sort((a, b) => b.version - a.version),
          nextBefore: this.state.versions.some(
            (v) => page.nextBefore && v.version < page.nextBefore,
          )
            ? this.state.nextBefore
            : page.nextBefore,
          history: history
            ? [
                ...new Map(
                  [
                    ...this.state.history.filter((h) => h.version === version),
                    ...history.summaries,
                  ].map((h) => [h.testId, h]),
                ).values(),
              ].sort((a, b) =>
                a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0,
              )
            : [],
          nextAfter:
            history &&
            this.state.history.some(
              (h) =>
                h.version === version &&
                history.nextAfter &&
                h.testId > history.nextAfter,
            )
              ? this.state.nextAfter
              : (history?.nextAfter ?? null),
          job: detail?.job ?? null,
          original: detail?.request ?? null,
          diagnostic: detail?.diagnostic ?? null,
          review,
          reviewError,
          freezeReceipt,
          decisionReceipt,
          fresh: true,
          error: null,
        });
        return;
      }
    } catch (e) {
      if (alive()) {
        if (e instanceof ApiError && [401, 403, 404].includes(e.status))
          this.deny();
        else this.set({ fresh: false, error: problem(e), review: null });
      }
    } finally {
      if (alive()) this.set({ loading: false });
    }
  }
  async more(kind: "versions" | "history") {
    if (this.blocked) return;
    const seq = ++this.sequence;
    this.set({ loading: true, fresh: false, review: null, diagnostic: null });
    try {
      if (kind === "versions" && this.state.nextBefore) {
        const before = this.state.nextBefore,
          p = ProcessVersionListSchema.parse(
            await this.get("/versions", {
              profile: PROCESS_VERSION_PROFILE,
              processId: this.scope.processId,
              before,
            }),
          );
        this.assertVersions(p);
        if (
          p.versions.some((v) => v.version >= before) ||
          (p.nextBefore && p.nextBefore >= before)
        )
          throw new SyntaxError("Version cursor did not advance");
        if (this.disposed || seq !== this.sequence) return;
        const versions = new Map(
          this.state.versions.map((v) => [v.version, v]),
        );
        for (const v of p.versions) versions.set(v.version, v);
        this.set({
          versions: [...versions.values()].sort(
            (a, b) => b.version - a.version,
          ),
          nextBefore: p.nextBefore,
        });
      } else if (
        kind === "history" &&
        this.state.nextAfter &&
        this.state.selectedVersion
      ) {
        const after = this.state.nextAfter,
          p = NativeTestListSchema.parse(
            await this.get("/tests/native/list", {
              profile: PROCESS_NATIVE_TEST_PROFILE,
              processId: this.scope.processId,
              version: this.state.selectedVersion,
              after,
            }),
          );
        this.assertHistory(p, this.state.selectedVersion);
        if (
          p.summaries.some(
            (h) => h.stamp.artifactDigest !== this.artifact?.digest,
          )
        )
          throw new SyntaxError("Paginated test artifact mismatch");
        if (
          p.summaries.some((s) => s.testId <= after) ||
          (p.nextAfter && p.nextAfter <= after)
        )
          throw new SyntaxError("History cursor did not advance");
        if (this.disposed || seq !== this.sequence) return;
        this.set({
          history: [...this.state.history, ...p.summaries],
          nextAfter: p.nextAfter,
        });
      }
      // Recheck current authority and activation eligibility without discarding older pages.
      await this.refresh();
    } catch (e) {
      if (!this.disposed && seq === this.sequence) {
        if (e instanceof ApiError && [401, 403, 404].includes(e.status))
          this.deny();
        else this.set({ error: problem(e) });
      }
    } finally {
      if (!this.disposed && seq === this.sequence) this.set({ loading: false });
    }
  }
  async freeze(revision: number) {
    if (this.blocked || this.state.process?.revision !== revision) return;
    await this.issue({
      kind: "freeze",
      body: ProcessFreezeCommandSchema.parse({
        ...this.target,
        profile: PROCESS_VERSION_PROFILE,
        requestId: crypto.randomUUID(),
        processId: this.scope.processId,
        revision,
      }),
    });
  }
  /** One human action for a changed draft: freeze it, then test the resulting
   * version. Freezing an unchanged draft is idempotent on the server. Returns
   * false when freezing succeeded but no test could be prepared (the person
   * then fixes the suite); an active version is never retested implicitly. */
  async freezeAndTest(revision: number): Promise<boolean> {
    const before = this.state.lastFreeze?.requestId;
    await this.freeze(revision);
    const { pending, rejected, process, freezeReceipt } = this.state;
    if (pending || rejected || !process || this.blocked) return true;
    // Only the version this freeze just produced is tested; a skipped or
    // failed freeze never falls back to testing an older version.
    const frozen = this.state.lastFreeze;
    if (
      !frozen ||
      frozen.requestId === before ||
      freezeReceipt?.requestId !== frozen.requestId
    )
      return true;
    const artifact = this.artifact;
    if (!artifact || artifact.version !== freezeReceipt.version) return true;
    if (process.activeVersion === artifact.version) return true;
    const request = this.prepareTest(false);
    if (!request) return false;
    await this.test(request);
    return true;
  }
  prepareTest(retestActive: boolean): NativeTestRequest | null {
    const p = this.state.process,
      artifact = this.artifact;
    if (
      this.blocked ||
      !p ||
      !artifact ||
      (p.activeVersion === artifact.version && !retestActive)
    )
      return null;
    const suite = parseSuiteDraft(this.state.suite);
    if (
      suite.comparisonMode === "configured_only" &&
      (artifact.definition.kind !== "workflow" ||
        artifact.definition.steps.some((step) => step.type === "agent"))
    )
      return null;
    if (
      suite.comparisonMode !== "configured_only" &&
      (!this.state.tools ||
        this.state.tools.genericModelId !== suite.genericModelId ||
        this.state.tools.version !== artifact.version ||
        this.state.tools.artifactDigest !== artifact.digest)
    )
      return null;
    return NativeTestRequestSchema.parse({
      ...this.target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      requestId: crypto.randomUUID(),
      processId: p.id,
      revision: p.revision,
      version: artifact.version,
      artifactDigest: artifact.digest,
      suite,
      ...(p.activeVersion === artifact.version ? { retestActive: true } : {}),
    });
  }
  async test(command: NativeTestRequest) {
    if (
      this.blocked ||
      !this.artifact ||
      command.version !== this.artifact.version ||
      command.artifactDigest !== this.artifact.digest ||
      command.revision !== this.state.process?.revision ||
      !same(command.suite, parseSuiteDraft(this.state.suite)) ||
      (this.state.process.activeVersion === command.version &&
        command.retestActive !== true)
    )
      return;
    await this.issue({
      kind: "test",
      body: NativeTestRequestSchema.parse(command),
    });
  }
  async decide(
    review: NonNullable<ProcessConsoleState["review"]>,
    type: "activate" | "rollback",
  ) {
    if (
      this.blocked ||
      !same(review, this.state.review) ||
      !(type === "activate" ? review.canActivate : review.canRollback)
    )
      return;
    await this.issue({
      kind: "decision",
      body: ProcessActivationCommandSchema.parse({
        ...this.target,
        profile: PROCESS_ACTIVATION_PROFILE,
        requestId: crypto.randomUUID(),
        type,
        processId: review.processId,
        revision: review.revision,
        expectedActiveVersion: review.activeVersion,
        version: review.version,
        artifactDigest: review.artifactDigest,
        testId: review.testId,
        qualificationDigest: review.qualification.qualificationDigest,
        acknowledgement: "controlled_native_test_only",
      }),
    });
  }
  private async issue(raw: ProcessConsoleCommand) {
    if (this.blocked) return;
    const command = commandSchema.parse(raw);
    if (
      !this.scoped(command.body) ||
      command.body.processId !== this.scope.processId
    )
      throw new SyntaxError("Command scope mismatch");
    if (
      this.persist(
        {
          pending: command,
          rejected: null,
          ...(command.kind === "test"
            ? {
                lastTestRequestId: command.body.requestId,
                selectedTestId: null,
              }
            : {}),
        },
        command.kind === "test"
          ? { job: null, original: null, diagnostic: null, review: null }
          : {},
      )
    ) {
      await this.dispatch();
    }
  }
  async retry() {
    if (
      !this.disposed &&
      !this.invalid &&
      !this.state.denied &&
      !this.posting &&
      this.state.pending &&
      this.state.fresh &&
      !this.state.loading
    )
      await this.dispatch();
  }
  private async dispatch() {
    const command = this.state.pending;
    if (
      !command ||
      this.posting ||
      this.disposed ||
      this.invalid ||
      this.state.denied
    )
      return;
    this.posting = true;
    const life = this.lifecycle;
    this.sequence++;
    this.set({ dispatching: true, fresh: false, error: null, review: null });
    try {
      const path =
        command.kind === "freeze"
          ? "/versions/freeze"
          : command.kind === "test"
            ? "/tests/native"
            : "/activation";
      const raw = await this.transport.request(
        base + path,
        command.body,
        this.abort.signal,
      );
      if (this.disposed || life !== this.lifecycle) return;
      if (command.kind === "test") {
        const { job } = testResponse.parse(raw);
        if (
          !this.scoped(job) ||
          job.processId !== command.body.processId ||
          job.requestId !== command.body.requestId ||
          job.version !== command.body.version ||
          job.stamp.artifactDigest !== command.body.artifactDigest
        )
          throw new SyntaxError("Test response mismatch");
      } else {
        const receipt =
          command.kind === "freeze"
            ? freezeResponse.parse(raw).receipt
            : decisionResponse.parse(raw).receipt;
        this.assertReceipt(receipt, command.body);
      }
      await this.refresh();
    } catch (e) {
      if (this.disposed || life !== this.lifecycle) return;
      if (e instanceof ApiError && [401, 403, 404].includes(e.status))
        this.deny();
      else if (this.state.pending?.body.requestId !== command.body.requestId) {
        /* A passive read already proved completion. */
      } else if (
        e instanceof ApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        (e.status !== 429 || e.code === "process_test_busy")
      ) {
        if (
          this.persist({
            pending: null,
            rejected: { command, code: problem(e) },
          })
        ) {
          await this.refresh();
          this.set({ error: problem(e) });
        }
      } else this.set({ error: problem(e), fresh: false });
    } finally {
      if (life === this.lifecycle) {
        this.posting = false;
        this.set({ dispatching: false });
      }
    }
  }
}
