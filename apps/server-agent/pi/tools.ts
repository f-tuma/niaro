/**
 * Recovery policy A for external writes: after a restart a write is never
 * re-run blindly. A write either carries an idempotency key, so Pi may run
 * it again and the service deduplicates it (`replay: "safe"`), or Pi tells
 * the model the call was interrupted and may have partially run, and never
 * runs it again (`replay: "unsafe"`, Pi's default).
 */
import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

type Execute<P extends object> = ToolRegistration<P>["execute"];
type ExecuteApi<P extends object> = Parameters<Execute<P>>[1];
type Result<P extends object> = Awaited<ReturnType<Execute<P>>>;

/**
 * The key of one tool call: the same across Pi's re-run of that call after a
 * restart, different for every other call (also a model's new call of the
 * same write), and unique within the agent core's storage.
 */
export const idempotencyKey = (api: { taskId: unknown }) =>
  `niaro-pi-task:${String(api.taskId)}`;

/** A write the service deduplicates by key: Pi may run it again after a restart. */
export function idempotentWriteTool<P extends object>(
  tool: Omit<ToolRegistration<P>, "replay" | "execute"> & {
    execute(
      args: Parameters<Execute<P>>[0],
      api: ExecuteApi<P>,
      key: string,
      context: Context,
    ): Promise<Result<P>>;
  },
): ToolRegistration<P> {
  const { execute, ...rest } = tool;
  return defineTool<P>({
    ...rest,
    replay: "safe",
    execute: (args, api, context) =>
      execute(args, api, idempotencyKey(api), context),
  });
}

/** A write without a key: interrupted, the model is told so and decides. */
export function interruptibleWriteTool<P extends object>(
  tool: Omit<ToolRegistration<P>, "replay">,
): ToolRegistration<P> {
  return defineTool<P>({ ...tool, replay: "unsafe" });
}
