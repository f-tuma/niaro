import type { ServerResponse } from "node:http";
import type { Scope } from "../../packages/protocol";
import {
  ANSWER_STREAM_KEEP_ALIVE_MS,
  ANSWER_STREAM_MEDIA_TYPE,
  AnswerStreamApprovalSchema,
  AnswerStreamStepSchema,
  type AnswerStreamChunk,
  type AnswerStreamListener,
  type AnswerStreamApproval,
  type AnswerStreamStep,
} from "../../packages/protocol/answer-stream";
import { splitDraft } from "../../packages/openui-library/program";

const clip = (value: string, max: number) =>
  value.length > max ? value.slice(0, max - 1) + "…" : value;
const clipFields = (
  fields: readonly { label: string; value: string }[],
  max: number,
) =>
  fields
    .slice(0, max)
    .map((f) => ({ label: clip(f.label, 100), value: clip(f.value, 1000) }));
/**
 * A step as the schema allows it: a long title or value is clipped rather
 * than dropped by the client's parser, which would hide the step.
 */
function boundedStep(step: AnswerStreamStep): AnswerStreamStep | undefined {
  const parsed = AnswerStreamStepSchema.safeParse({
    ...step,
    toolCallId: clip(step.toolCallId, 160),
    label: clip(step.label, 160),
    input: clipFields(step.input, 12),
    output: clipFields(step.output, 12),
    ...(step.failure
      ? {
          failure: {
            kind: clip(step.failure.kind, 40),
            code: clip(step.failure.code, 80),
          },
        }
      : {}),
  });
  return parsed.success ? parsed.data : undefined;
}
function boundedApproval(
  approval: AnswerStreamApproval,
): AnswerStreamApproval | undefined {
  const parsed = AnswerStreamApprovalSchema.safeParse({
    ...approval,
    toolCallId: clip(approval.toolCallId, 160),
    toolName: clip(approval.toolName, 100),
    service: clip(approval.service, 100),
    input: {
      fields: clipFields(approval.input.fields, 20),
    },
    reviewTruncated:
      approval.reviewTruncated || approval.input.fields.length > 20,
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Streams a `message.send` or `service.resolve` run to the client as
 * server-sent events in the AI SDK UI message stream shape: the answer's
 * draft as text deltas, each tool step, a write that waits for the person's
 * decision, the program once its fence is complete, and finally what the
 * JSON response would have been. The stream only shows; the run neither
 * waits for it nor stops when it closes.
 */
export function openAnswerStream(
  res: ServerResponse,
  origin: string | undefined,
  subscribe: (
    scope: Scope,
    commandId: string,
    listener: AnswerStreamListener,
  ) => () => void,
  scope: Scope,
  commandId: string,
  keepAliveMs = ANSWER_STREAM_KEEP_ALIVE_MS,
) {
  res.writeHead(200, {
    "Content-Type": `${ANSWER_STREAM_MEDIA_TYPE}; charset=utf-8`,
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...(origin
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {}),
  });
  res.flushHeaders?.();
  let open = true;
  const write = (chunk: AnswerStreamChunk) => {
    if (open && !res.destroyed) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  const keepAlive = setInterval(() => {
    if (open && !res.destroyed) res.write(": keep-alive\n\n");
  }, keepAliveMs);
  // The draft arrives whole each time; the client gets what grew. A draft
  // that shrank or vanished (a checker repair, a tool step) ends its text
  // part, and the next one starts another.
  let textId = 0,
    sent = "",
    program: string | undefined;
  const endText = () => {
    if (!sent) return;
    write({ type: "text-end", id: `text-${textId}` });
    sent = "";
  };
  const draft = (value: string | null) => {
    if (!value) return endText();
    if (!value.startsWith(sent)) {
      endText();
    }
    if (!sent) {
      textId++;
      write({ type: "text-start", id: `text-${textId}` });
    }
    if (value.length > sent.length)
      write({
        type: "text-delta",
        id: `text-${textId}`,
        delta: value.slice(sent.length),
      });
    sent = value;
    const complete = /```\s*$/.test(value)
      ? splitDraft(value).program
      : undefined;
    if (complete && complete !== program) {
      program = complete;
      write({ type: "data-openui", data: { program } });
    }
  };
  const step = (raw: AnswerStreamStep) => {
    const value = boundedStep(raw);
    if (!value) return;
    if (value.status === "running") {
      write({
        type: "tool-input-start",
        toolCallId: value.toolCallId,
        toolName: value.label,
      });
      write({
        type: "tool-input-available",
        toolCallId: value.toolCallId,
        toolName: value.label,
        input: { fields: value.input },
      });
    } else if (value.status === "failed" || value.status === "cancelled") {
      write({
        type: "tool-output-error",
        toolCallId: value.toolCallId,
        errorText: value.failure
          ? `${value.failure.kind}: ${value.failure.code}`
          : value.status,
      });
    } else {
      write({
        type: "tool-output-available",
        toolCallId: value.toolCallId,
        output: { status: value.status, fields: value.output },
      });
    }
  };
  // The card the stored result will carry, a moment early, so a client can
  // show the write to review as soon as the run stops for it.
  const approval = (raw: AnswerStreamApproval) => {
    const value = boundedApproval(raw);
    if (value) write({ type: "data-tool-call-approval", data: value });
  };
  const unsubscribe = subscribe(scope, commandId, (event) => {
    if (event.type === "draft") draft(event.draft);
    else if (event.type === "step") step(event.step);
    else approval(event.approval);
  });
  const close = () => {
    if (!open) return;
    open = false;
    clearInterval(keepAlive);
    unsubscribe();
  };
  res.once("close", close);
  write({ type: "start", messageId: commandId });
  return {
    /** Sends the response the JSON path would have sent, then ends. */
    end(result: { status: number; body: unknown }) {
      if (!open) return;
      endText();
      if (result.status >= 400)
        write({
          type: "error",
          errorText:
            result.body &&
            typeof result.body === "object" &&
            "error" in result.body &&
            typeof result.body.error === "string"
              ? result.body.error
              : "request_failed",
        });
      write({ type: "data-niaro-result", data: result });
      write({ type: "finish" });
      if (!res.destroyed) res.write("data: [DONE]\n\n");
      close();
      res.end();
    },
  };
}
