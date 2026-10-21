import type { ReplyInput } from "../protocol";
import {
  isProcessAnswerConsumed,
  type ProcessAnswerTarget,
} from "./process-answers";
import type { SessionCommand } from "./session";
import type { Store } from "./store";

/** A process question being answered from the composer; frozen at capture. */
export type ProcessReplyContext = {
  kind: "process";
  target: ProcessAnswerTarget;
};
/** What the composer is answering: a native question or a process question. */
export type ReplyContext = ReplyInput | ProcessReplyContext;
export function isProcessReply(
  input: ReplyContext | null | undefined,
): input is ProcessReplyContext {
  return !!input && "kind" in input && input.kind === "process";
}
/** Only exact authoritative consumption can retire the original submitted draft. */
export function recordedProcessAnswer(
  store: Store | null,
  context: ReplyContext,
  command: SessionCommand,
) {
  return !!store && isProcessReply(context) && command.type === "process.answer"
    ? isProcessAnswerConsumed(store, context.target, command)
    : false;
}
