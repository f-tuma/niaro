import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ServerResponse } from "node:http";
import { openAnswerStream } from "../apps/fixture-server/answer-stream";
import {
  parseAnswerStreamEvent,
  splitServerSentEvents,
  type AnswerStreamChunk,
  type AnswerStreamListener,
} from "../packages/protocol/answer-stream";
import { credential } from "./auth-fixtures";

/** A response that keeps what was written. */
function fakeResponse() {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const res = Object.assign(emitter, {
    destroyed: false,
    headers: {} as Record<string, unknown>,
    status: 0,
    writeHead(status: number, headers: Record<string, unknown>) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    flushHeaders() {},
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
    end() {
      res.destroyed = true;
      emitter.emit("close");
    },
  });
  const chunks = () =>
    splitServerSentEvents(written.join("")).events.map((event) =>
      parseAnswerStreamEvent(event),
    );
  return { res: res as unknown as ServerResponse, written, chunks };
}

test("the stream turns the growing draft into text deltas, restarts a text after a reset and ends with the result", async () => {
  const { res, written, chunks } = fakeResponse();
  let listener!: AnswerStreamListener;
  const unsubscribed: string[] = [];
  const stream = openAnswerStream(
    res,
    "https://app.example.test",
    (_scope, commandId, next) => {
      listener = next;
      return () => unsubscribed.push(commandId);
    },
    credential().scope,
    "TEST-command",
    20,
  );
  assert.equal((res as unknown as { status: number }).status, 200);
  assert.match(
    String(
      (res as unknown as { headers: Record<string, string> }).headers[
        "Content-Type"
      ],
    ),
    /^text\/event-stream/,
  );
  assert.equal(
    (res as unknown as { headers: Record<string, string> }).headers[
      "Access-Control-Allow-Origin"
    ],
    "https://app.example.test",
  );
  listener({ type: "draft", draft: "Sales grew" });
  listener({ type: "draft", draft: "Sales grew in Q3." });
  // A checker repair: the draft vanishes, then a new one starts.
  listener({ type: "draft", draft: null });
  listener({
    type: "draft",
    draft:
      'Revenue is up.\n```openui-lang\nroot = Stack([Metric("Revenue", "1.2 M")])\n```',
  });
  listener({
    type: "step",
    step: {
      toolCallId: "call-1",
      label: "Search loans",
      status: "running",
      input: [{ label: "Service", value: "TEST CRM" }],
      output: [],
    },
  });
  listener({
    type: "step",
    step: {
      toolCallId: "call-1",
      label: "Search loans",
      status: "succeeded",
      input: [{ label: "Service", value: "TEST CRM" }],
      output: [{ label: "Returned items", value: "71" }],
    },
  });
  listener({
    type: "step",
    step: {
      toolCallId: "call-2",
      label: "Create item",
      status: "running",
      input: [],
      output: [],
    },
  });
  listener({
    type: "step",
    step: {
      toolCallId: "call-2",
      label: "Create item",
      status: "failed",
      input: [],
      output: [],
      failure: { kind: "validation", code: "integration_input_invalid" },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(
    written.some((chunk) => chunk.startsWith(": keep-alive")),
    "A quiet stream sends keep-alive comments",
  );
  stream.end({
    status: 202,
    body: { status: "accepted", commandId: "TEST-command" },
  });
  assert.deepEqual(
    chunks().map((chunk) =>
      chunk === "done" || !chunk
        ? chunk
        : chunk.type === "text-delta"
          ? `${chunk.type}:${chunk.id}:${chunk.delta}`
          : chunk.type === "text-start" || chunk.type === "text-end"
            ? `${chunk.type}:${chunk.id}`
            : chunk.type,
    ),
    [
      "start",
      "text-start:text-1",
      "text-delta:text-1:Sales grew",
      "text-delta:text-1: in Q3.",
      "text-end:text-1",
      "text-start:text-2",
      'text-delta:text-2:Revenue is up.\n```openui-lang\nroot = Stack([Metric("Revenue", "1.2 M")])\n```',
      "data-openui",
      "tool-input-start",
      "tool-input-available",
      "tool-output-available",
      "tool-input-start",
      "tool-input-available",
      "tool-output-error",
      "text-end:text-2",
      "data-niaro-result",
      "finish",
      "done",
    ],
  );
  const typed = chunks().filter(
    (chunk): chunk is AnswerStreamChunk => !!chunk && chunk !== "done",
  );
  assert.deepEqual(
    typed.find((chunk) => chunk.type === "data-openui"),
    {
      type: "data-openui",
      data: { program: 'root = Stack([Metric("Revenue", "1.2 M")])' },
    },
  );
  assert.deepEqual(
    typed.find((chunk) => chunk.type === "tool-output-available"),
    {
      type: "tool-output-available",
      toolCallId: "call-1",
      output: {
        status: "succeeded",
        fields: [{ label: "Returned items", value: "71" }],
      },
    },
  );
  assert.deepEqual(
    typed.find((chunk) => chunk.type === "tool-output-error"),
    {
      type: "tool-output-error",
      toolCallId: "call-2",
      errorText: "validation: integration_input_invalid",
    },
  );
  assert.deepEqual(
    typed.find((chunk) => chunk.type === "data-niaro-result"),
    {
      type: "data-niaro-result",
      data: {
        status: 202,
        body: { status: "accepted", commandId: "TEST-command" },
      },
    },
  );
  assert.deepEqual(unsubscribed, ["TEST-command"]);
  // Nothing more is written once ended.
  const count = written.length;
  listener({ type: "draft", draft: "late" });
  assert.equal(written.length, count);
});

test("a failed run ends the stream with an error chunk and the JSON path's status", () => {
  const { res, chunks } = fakeResponse();
  const stream = openAnswerStream(
    res,
    undefined,
    () => () => {},
    credential().scope,
    "TEST-error",
  );
  stream.end({ status: 409, body: { error: "idempotency_conflict" } });
  const typed = chunks().filter(
    (chunk): chunk is AnswerStreamChunk => !!chunk && chunk !== "done",
  );
  assert.deepEqual(
    typed.map((chunk) => chunk.type),
    ["start", "error", "data-niaro-result", "finish"],
  );
  assert.deepEqual(typed[1], {
    type: "error",
    errorText: "idempotency_conflict",
  });
  assert.deepEqual(typed[2], {
    type: "data-niaro-result",
    data: { status: 409, body: { error: "idempotency_conflict" } },
  });
});

test("a closed connection stops the stream without touching the run", () => {
  const { res, written } = fakeResponse();
  let unsubscribed = 0;
  const stream = openAnswerStream(
    res,
    undefined,
    () => () => {
      unsubscribed++;
    },
    credential().scope,
    "TEST-closed",
  );
  (res as unknown as EventEmitter).emit("close");
  assert.equal(unsubscribed, 1);
  const count = written.length;
  stream.end({ status: 202, body: {} });
  assert.equal(written.length, count, "Nothing is written after the close");
});

test("server-sent events split on blank lines and keep an unfinished tail", () => {
  const { events, rest } = splitServerSentEvents(
    'data: {"type":"start"}\n\n: keep-alive\n\ndata: {"type":"text-delta",\ndata: "id":"t","delta":"a"}\n\ndata: {"type":"fini',
  );
  assert.deepEqual(events, [
    '{"type":"start"}',
    '{"type":"text-delta",\n"id":"t","delta":"a"}',
  ]);
  assert.equal(rest, 'data: {"type":"fini');
  assert.equal(parseAnswerStreamEvent("[DONE]"), "done");
  assert.equal(parseAnswerStreamEvent("not json"), undefined);
  assert.equal(parseAnswerStreamEvent('{"type":"unknown-chunk"}'), undefined);
});
