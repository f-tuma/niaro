import { z } from "zod";

/**
 * A chat answer streamed while it is written: the shape of an AI SDK UI
 * message stream (server-sent events, one JSON chunk per `data:` line, a
 * final `[DONE]`), so a client built on `useChat` or assistant-ui can read
 * it later. The server sends it to `POST commands` for `message.send` and
 * `service.resolve` when the request accepts `text/event-stream`; clients
 * without that header get the JSON response as before.
 *
 * The stream is presentation only. Nothing in it is stored, decides anything
 * or grants permission: the stored message and the command result it ends
 * with (`data-niaro-result`) are the same the JSON response would carry, and
 * a client that loses the stream retries or joins the command as before.
 */
export const ANSWER_STREAM_PROFILE = "agent-answer-stream/1" as const;
export const ANSWER_STREAM_MEDIA_TYPE = "text/event-stream" as const;
/** Written while nothing else is, so a proxy does not close an idle stream. */
export const ANSWER_STREAM_KEEP_ALIVE_MS = 15_000;

const Field = z.strictObject({
  label: z.string().max(80),
  value: z.string().max(1000),
});
/** One tool step of the run, with the Runs page's safe previews only. */
export const AnswerStreamStepSchema = z.strictObject({
  toolCallId: z.string().min(1).max(160),
  /** The label the Runs page shows: a service action's title, "Find a service"… */
  label: z.string().min(1).max(160),
  status: z.enum(["running", "succeeded", "failed", "waiting", "cancelled"]),
  input: z.array(Field).max(12).default([]),
  output: z.array(Field).max(12).default([]),
  /** A failure's class and code, never its provider message. */
  failure: z
    .strictObject({ kind: z.string().max(40), code: z.string().max(80) })
    .optional(),
});
export type AnswerStreamStep = z.infer<typeof AnswerStreamStepSchema>;
/**
 * A write that waits for the person's decision, as the stream carries it:
 * the reviewed input as label/value pairs, like the stored card, never the
 * arguments themselves. Deciding is still `service.resolve` on the
 * operation; nothing in the stream approves anything.
 */
export const AnswerStreamApprovalSchema = z.strictObject({
  toolCallId: z.string().min(1).max(160),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  /** The action's title, as the card shows it. */
  toolName: z.string().min(1).max(100),
  service: z.string().min(1).max(100),
  effect: z.literal("write"),
  input: z.strictObject({
    fields: z
      .array(
        z.strictObject({
          label: z.string().max(100),
          value: z.string().max(1000),
        }),
      )
      .max(20),
  }),
  reviewTruncated: z.boolean(),
});
export type AnswerStreamApproval = z.infer<typeof AnswerStreamApprovalSchema>;
/** What an open stream is told by the server while the run goes on. */
export type AnswerStreamEvent =
  | { type: "draft"; draft: string | null }
  | { type: "step"; step: AnswerStreamStep }
  | { type: "approval"; approval: AnswerStreamApproval };
export type AnswerStreamListener = (event: AnswerStreamEvent) => void;

const chunk = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape });
export const AnswerStreamChunkSchema = z.discriminatedUnion("type", [
  chunk("start", { messageId: z.string().max(160).optional() }),
  chunk("text-start", { id: z.string().max(80) }),
  chunk("text-delta", { id: z.string().max(80), delta: z.string() }),
  chunk("text-end", { id: z.string().max(80) }),
  chunk("tool-input-start", {
    toolCallId: z.string().max(160),
    toolName: z.string().max(160),
  }),
  chunk("tool-input-available", {
    toolCallId: z.string().max(160),
    toolName: z.string().max(160),
    input: z.unknown(),
  }),
  chunk("tool-output-available", {
    toolCallId: z.string().max(160),
    output: z.unknown(),
  }),
  chunk("tool-output-error", {
    toolCallId: z.string().max(160),
    errorText: z.string().max(400),
  }),
  /** The answer's program once its fence is complete; admission still follows. */
  chunk("data-openui", { data: z.strictObject({ program: z.string() }) }),
  /** A write awaiting the person's decision, in the shape `@mastra/ai-sdk` emits. */
  chunk("data-tool-call-approval", { data: AnswerStreamApprovalSchema }),
  /**
   * What the JSON response would have been: its HTTP status and body (the
   * command result, or `{ error }`). Always the last chunk before `finish`.
   */
  chunk("data-niaro-result", {
    data: z.strictObject({ status: z.number().int(), body: z.unknown() }),
  }),
  chunk("error", { errorText: z.string().max(400) }),
  chunk("finish", {}),
]);
export type AnswerStreamChunk = z.infer<typeof AnswerStreamChunkSchema>;

/** The `data:` payloads of complete events in `text`; `rest` is the unfinished tail. */
export function splitServerSentEvents(text: string): {
  events: string[];
  rest: string;
} {
  const events: string[] = [];
  let rest = text.replace(/\r\n/g, "\n");
  for (;;) {
    const end = rest.indexOf("\n\n");
    if (end < 0) break;
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) events.push(data);
  }
  return { events, rest };
}

/** One event's payload as a chunk; `[DONE]` is the end, anything else is skipped. */
export function parseAnswerStreamEvent(
  data: string,
): AnswerStreamChunk | "done" | undefined {
  if (data.trim() === "[DONE]") return "done";
  try {
    const parsed = AnswerStreamChunkSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
