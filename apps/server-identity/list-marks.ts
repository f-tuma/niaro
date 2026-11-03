import { randomBytes } from "node:crypto";
import type { Scope } from "../../packages/protocol";
import type {
  ListMarkName,
  ListMarks,
} from "../../packages/protocol/list-marks";

/**
 * Per-person change counters of Tasks and Meetings (`ListMarks`), kept in
 * memory: every write of `HumanTaskStore` and `MeetingStore` bumps its
 * owner's counter, and the events poll reports them, so a phone reads a list
 * again only after it changed. A restart starts a new epoch: every mark
 * changes once and clients read their lists once more. One server process
 * owns the database, so the counters see every write.
 */
export class ListMarkCounter {
  private readonly epoch = randomBytes(6).toString("hex");
  private readonly counts = new Map<string, number>();
  private key(list: ListMarkName, scope: Scope) {
    return JSON.stringify([
      list,
      scope.connectionId,
      scope.serverId,
      scope.workspaceId,
      scope.userId,
    ]);
  }
  bump(list: ListMarkName, scope: Scope) {
    const key = this.key(list, scope);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  read(scope: Scope): ListMarks {
    const mark = (list: ListMarkName) =>
      `${this.epoch}.${this.counts.get(this.key(list, scope)) ?? 0}`;
    return { tasks: mark("tasks"), meetings: mark("meetings") };
  }
}
