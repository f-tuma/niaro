import type { Scope } from "../../packages/protocol";
import type { MemorySettings } from "../../packages/protocol/memory";
import { MemoryStore, type MemoryActor } from "./memory";
import { ProfileCursorStore, type ProfileCursor } from "./profile-cursor";
import {
  ProfileInference,
  type ProfileInferenceAccess,
} from "./profile-inference";
import {
  buildProfileMaterial,
  profileDigest,
  type ProfileSourceRef,
  type ProfileChatSource,
  type ProfileMeetingSource,
} from "./profile-material";
export type ProfileOwner = {
  key: string;
  actor: MemoryActor;
  sequence: number;
};
export type ProfileLearnerPorts = {
  serial: <T>(run: () => T) => Promise<T>;
  discover: (
    type: "chat" | "meeting",
    after: string,
    limit: number,
  ) => ProfileOwner[] & { next?: string };
  access: (actor: MemoryActor) => {
    scope: Scope;
    settings: MemorySettings;
    inference: ProfileInferenceAccess;
  };
  refs: (
    scope: Scope,
    type: "chat" | "meeting",
    after: number,
  ) => ProfileSourceRef[];
  chat: (scope: Scope, ref: ProfileSourceRef) => ProfileChatSource | null;
  meeting: (scope: Scope, ref: ProfileSourceRef) => ProfileMeetingSource | null;
  valid: (scope: Scope, ref: ProfileSourceRef) => boolean;
  usedActions: (
    actor: MemoryActor,
    commandId: string,
    conversationId: string,
  ) => { service: string; action: string }[];
  log: (code: string) => void;
};
/** One bounded scheduler in the existing server. It never enables a plugin or repairs unknown paid calls. */
export class ProfileLearner {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private closed = false;
  private page = { chat: "", meeting: "" };
  private controllers = new Set<AbortController>();
  constructor(
    private memory: MemoryStore,
    private cursor: ProfileCursorStore,
    private inference: ProfileInference,
    private ports: ProfileLearnerPorts,
  ) {}
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 60000);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    const task = this.pass()
      .catch(() => this.ports.log("profile_tick_failed"))
      .finally(() => {
        if (this.active === task) this.active = undefined;
      });
    this.active = task;
    return task;
  }
  private async pass() {
    const candidates = await this.ports.serial(() => {
      this.cursor.expireResponses();
      for (const type of ["chat", "meeting"] as const) {
        const owners = this.ports.discover(type, this.page[type], 50);
        this.page[type] =
          owners.next ?? (owners.length === 50 ? owners.at(-1)!.key : "");
        for (const owner of owners)
          this.cursor.discover(owner.actor, type, owner.sequence);
      }
      return this.cursor.candidates(4);
    });
    await Promise.allSettled(candidates.map((actor) => this.learn(actor)));
  }
  private async learn(actor: MemoryActor) {
    let lease: ProfileCursor | null = null;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 120000);
    timeout.unref();
    try {
      const prepared = await this.ports.serial(() => {
        if (this.closed) throw Error("profile_closed");
        lease = this.cursor.acquire(actor);
        if (!lease) return null;
        const access = this.ports.access(actor);
        access.inference.check();
        if (!this.inference.canStart(actor, access.inference)) {
          this.cursor.defer(actor, lease, false);
          lease = null;
          return null;
        }
        return {
          access,
          lease,
          pending: this.inference.prepareRecovery(actor, lease),
        };
      });
      if (!prepared) return;
      const { access } = prepared,
        run = prepared.lease;
      const previous = await this.memory.observations(actor, {
        run: this.ports.serial,
      });
      const currentSource = (ref: ProfileSourceRef) =>
        this.ports
          .refs(access.scope, ref.type, run.progress[ref.type])
          .find(
            (current) =>
              current.sequence === ref.sequence &&
              current.sourceId === ref.sourceId &&
              current.digest === ref.digest &&
              this.ports.valid(access.scope, current),
          );
      let windowRefs: ProfileSourceRef[] = [];
      const material = await this.ports.serial(() => {
        access.inference.check();
        this.cursor.check(actor, run);
        if (this.memory.version(actor) !== previous.version)
          throw Error("profile_memory_changed");
        const pending =
          prepared.pending?.state === "unpaid_replan" ? null : prepared.pending;
        windowRefs = pending
          ? pending.window.refs.map((ref) => currentSource(ref) ?? ref)
          : [
              ...this.ports.refs(access.scope, "chat", run.progress.chat),
              ...this.ports.refs(access.scope, "meeting", run.progress.meeting),
            ];
        if (pending?.state === "unusable")
          throw Error("profile_batch_unusable");
        if (
          pending &&
          JSON.stringify(pending.window.progress) !==
            JSON.stringify(run.progress)
        )
          throw Error("profile_cursor_changed");
        return buildProfileMaterial({
          scope: access.scope,
          progress: run.progress,
          chat: windowRefs.filter((ref) => ref.type === "chat"),
          meetings: windowRefs.filter((ref) => ref.type === "meeting"),
          chatSource: (ref) => this.ports.chat(access.scope, ref),
          meetingSource: (ref) => this.ports.meeting(access.scope, ref),
          usedActions: (commandId, conversationId) =>
            this.ports.usedActions(actor, commandId, conversationId),
          observations: previous.items,
          personalThings: this.memory.readPreferences(actor).personalThings,
        });
      });
      const more = () =>
        this.ports.refs(access.scope, "chat", material.next.chat).length > 0 ||
        this.ports.refs(access.scope, "meeting", material.next.meeting).length >
          0;
      if (!material.evidence.length && !prepared.pending) {
        await this.ports.serial(() =>
          this.cursor.atomic(() => {
            access.inference.check();
            this.cursor.finish(actor, run, material.next, more());
          }),
        );
        return;
      }
      const batch = await this.ports.serial(() =>
        this.cursor.atomic(() =>
          this.cursor.bind(
            actor,
            run,
            { progress: run.progress, refs: windowRefs },
            profileDigest({
              material: material.inputDigest,
              model: [
                access.inference.selected.model.id,
                access.inference.selected.model.revision,
                access.inference.selected.provider.id,
                access.inference.selected.provider.revision,
              ],
              settingsRevision: access.inference.settingsRevision,
              policyVersion: access.inference.policyVersion,
              budgetRevision: access.inference.budgetRevision,
            }),
            material.next,
            (pending) => this.inference.proveUnpaid(actor, run, pending),
          ),
        ),
      );
      const inferenceAccess = {
        ...access.inference,
        beforeDispatch: () => {
          access.inference.beforeDispatch?.();
          if (this.memory.version(actor) !== previous.version)
            throw Error("profile_memory_changed");
        },
        check: () => {
          access.inference.check();
          if (material.refs.some((ref) => !currentSource(ref)))
            throw Error("profile_source_changed");
        },
      };
      const result = material.evidence.length
        ? await this.inference.extract(
            actor,
            run,
            batch,
            material.userPayload,
            inferenceAccess,
            controller.signal,
          )
        : { add: [], refresh: [], update: [] };
      controller.signal.throwIfAborted();
      const evidence = (ids: string[]) =>
        ids.map((id) => {
          const item = material.evidence.find((item) => item.id === id);
          if (!item) throw Error("profile_evidence_invalid");
          return item.source;
        });
      const check = () => {
        if (this.closed) throw Error("profile_closed");
        controller.signal.throwIfAborted();
        access.inference.check();
        this.cursor.check(actor, run);
        if (material.refs.some((ref) => !this.ports.valid(access.scope, ref))) {
          throw Error(
            material.refs.every((ref) => !!currentSource(ref))
              ? "profile_source_moved"
              : "profile_source_changed",
          );
        }
      };
      await this.memory.observe(
        actor,
        {
          batchId: batch.id,
          expectedVersion: previous.version,
          deadline: run.deadline,
          settings: access.settings,
          add: result.add
            .map((row) => ({ ...row, sources: evidence(row.evidence) }))
            .map(({ evidence: _, ...row }) => row),
          refresh: result.refresh.map((row) => ({
            id: row.id,
            revision: row.revision,
            sources: evidence(row.evidence),
          })),
          update: result.update
            .map((row) => ({ ...row, sources: evidence(row.evidence) }))
            .map(({ evidence: _, ...row }) => row),
        },
        {
          run: this.ports.serial,
          check,
          observationRunId: batch.id,
          observationLeaseToken: run.token!,
          observationSourceAccess: (source) =>
            material.evidence.some(
              (item) =>
                item.source.sourceId === source.sourceId &&
                item.source.digest === source.digest &&
                this.ports.valid(
                  access.scope,
                  material.refs.find(
                    (ref) => ref.sourceId === source.sourceId,
                  )!,
                ),
            ),
          batchCheckpoint: () =>
            this.cursor.committed(actor, run, batch, more()),
        },
      );
      this.ports.log("profile_committed");
    } catch (error) {
      if (lease)
        await this.ports
          .serial(() => {
            if (
              error instanceof Error &&
              [
                "profile_source_changed",
                "profile_pending_input_changed",
              ].includes(error.message)
            )
              this.cursor.scrub(actor);
            try {
              this.ports.access(actor).inference.check();
            } catch {
              this.cursor.scrub(actor);
            }
            this.cursor.defer(actor, lease!, true);
          })
          .catch(() => undefined);
      this.ports.log(
        error instanceof Error && /^profile_[a-z_]+$/.test(error.message)
          ? error.message
          : "profile_attempt_failed",
      );
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await this.active;
  }
}
