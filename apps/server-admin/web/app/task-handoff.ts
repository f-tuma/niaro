import type { HumanTaskReference } from "../../../../packages/protocol";

/**
 * An open task the person chose to resolve with the assistant, handed from
 * Tasks to a new chat once. The chat attaches it to its first message as
 * `message.send.humanTask`. Kept in memory only: a reload starts a plain chat.
 */
let pending: HumanTaskReference | null = null;
export function handOffHumanTask(task: HumanTaskReference) {
  pending = { id: task.id, title: task.title };
}
export function takeHumanTask() {
  const task = pending;
  pending = null;
  return task;
}
