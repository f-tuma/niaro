import type { HumanTaskReference } from "../../../../packages/protocol";
/** In-memory, identity-owned handoff. Taking or rejecting consumes it exactly once. */
type ComposerHandoff = {
  identityKey: string;
  task?: HumanTaskReference;
  picker?: true;
};
let pending: ComposerHandoff | null = null;
export function handOffHumanTask(
  task: HumanTaskReference,
  identityKey: string,
) {
  pending = { identityKey, task: { id: task.id, title: task.title } };
}
export function handOffComposerPicker(identityKey: string) {
  pending = { identityKey, picker: true };
}
export function takeComposerHandoff(identityKey: string) {
  const value = pending;
  pending = null;
  return value?.identityKey === identityKey ? value : null;
}
export function takeHumanTask(identityKey: string) {
  return takeComposerHandoff(identityKey)?.task ?? null;
}
