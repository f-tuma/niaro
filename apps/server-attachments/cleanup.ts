import { ScopeSchema } from "../../packages/protocol";
import { AttachmentStore } from "./store";
import { AttachmentError } from "./schema";

/** One durable job and one object operation at a time; never an inference owner. */
export class AttachmentCleanup {
  private running = false;
  private stopped = false;
  private nextSweep = 0;
  constructor(
    private store: AttachmentStore,
    private nativePurge?: (
      scope: ReturnType<typeof ScopeSchema.parse>,
      generation: string,
    ) => Promise<void>,
    private foregroundBusy: () => boolean = () => false,
  ) {}
  stop() {
    this.stopped = true;
  }
  async tick() {
    if (this.stopped || this.running || this.foregroundBusy()) return;
    this.running = true;
    try {
      if (this.store.now() >= this.nextSweep) {
        this.store.expire();
        this.nextSweep = this.store.now() + 60000;
      }
      const job = this.store.claimJob();
      if (!job) return;
      try {
        const [connectionId, serverId, userId, workspaceId] = JSON.parse(
            job.scope_key,
          ),
          scope = ScopeSchema.parse({
            connectionId,
            serverId,
            userId,
            workspaceId,
          });
        if (job.kind === "object") {
          const c = this.store.content(scope, job.target_id, true);
          if (c.lifecycle !== "tombstoned" && c.lifecycle !== "purged")
            throw new AttachmentError("attachment_stale", 409);
          if (c.token) throw new AttachmentError("attachment_busy", 429);
          if (this.store.objectSettlement(c)?.state === "deleted") {
            /* durable prior settlement */
          } else if (!c.ever_dispatched) this.store.discardUnstarted(c);
          else await this.store.objectStore().delete(this.store.handle(c));
        } else if (job.kind === "native_context") {
          if (!this.store.isTombstoned(scope, job.generation_id))
            throw new AttachmentError("attachment_stale", 409);
          if (!this.nativePurge)
            throw new AttachmentError("attachment_unavailable", 503);
          await this.nativePurge(scope, job.generation_id);
        } else throw new AttachmentError("attachment_unavailable", 503);
        this.store.finishJob(job);
      } catch (error) {
        this.store.finishJob(job, error);
      }
    } finally {
      this.running = false;
    }
  }
}
