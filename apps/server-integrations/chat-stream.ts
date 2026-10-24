import type { TransportResponse } from "./transport";

type ToolCallDelta = {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};
type Chunk = {
  choices?: {
    index?: unknown;
    finish_reason?: unknown;
    delta?: { content?: unknown; tool_calls?: unknown };
  }[];
  usage?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

/**
 * One streamed OpenAI-compatible chat completion (`stream: true`), read event
 * by event. `completion()` gives the body the same call returns without
 * streaming, so the parsers, budget settlement and validation stay the same.
 * Only the first choice is kept, as without streaming.
 */
export class CompletionStream {
  private text = "";
  private hasContent = false;
  private calls = new Map<
    number,
    { id?: string; name: string; args: string[] }
  >();
  private finishReason: unknown = null;
  private usage: unknown;
  private error: unknown;
  private fields: Record<string, unknown> = {};
  private events = 0;
  /** Push one event's `data`; returns whether the reply text grew. */
  push(data: string) {
    if (data === "[DONE]") return false;
    let chunk: Chunk;
    try {
      chunk = JSON.parse(data) as Chunk;
    } catch {
      // A malformed event fails the assembled completion's validation.
      this.error ??= { message: "malformed stream event" };
      return false;
    }
    if (!chunk || typeof chunk !== "object") return false;
    this.events++;
    const { choices, usage, error, ...fields } = chunk;
    // The id, model and provider fields are the same on every event.
    Object.assign(this.fields, fields);
    if (usage) this.usage = usage;
    if (error) this.error = error;
    const choice = Array.isArray(choices)
      ? choices.find((value) => (value?.index ?? 0) === 0)
      : undefined;
    if (!choice) return false;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (Array.isArray(delta?.tool_calls))
      for (const call of delta.tool_calls as ToolCallDelta[]) {
        const index = typeof call?.index === "number" ? call.index : 0;
        const current = this.calls.get(index) ?? { name: "", args: [] };
        if (typeof call.id === "string" && call.id) current.id = call.id;
        if (typeof call.function?.name === "string")
          current.name += call.function.name;
        if (typeof call.function?.arguments === "string")
          current.args.push(call.function.arguments);
        this.calls.set(index, current);
      }
    if (typeof delta?.content === "string" && delta.content) {
      this.hasContent = true;
      this.text += delta.content;
      return true;
    }
    return false;
  }
  /** The reply text so far. */
  get reply() {
    return this.text;
  }
  completion(): unknown {
    if (this.error) return { ...this.fields, error: this.error };
    if (!this.events) return undefined;
    const calls = [...this.calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => ({
        id: call.id ?? `call_${index}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.args.join("") },
      }));
    return {
      ...this.fields,
      choices: [
        {
          index: 0,
          finish_reason: this.finishReason,
          message: {
            role: "assistant",
            content: this.hasContent ? this.text : null,
            ...(calls.length ? { tool_calls: calls } : {}),
          },
        },
      ],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

/** The data of each complete server-sent event in `text`, and what is left. */
export function streamEvents(text: string) {
  const parts = text.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const events = parts.flatMap((event) => {
    // Comment lines (": OPENROUTER PROCESSING") keep the connection open.
    const lines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    return lines.length ? [lines.join("\n")] : [];
  });
  return { events, rest };
}

export const isEventStream = (response: TransportResponse) =>
  !!response.headers["content-type"]?.includes("text/event-stream");

/** A whole streamed response, assembled as the non-streaming body. */
export function completionFromStream(text: string): unknown {
  const stream = new CompletionStream();
  for (const data of streamEvents(text + "\n\n").events) stream.push(data);
  return stream.completion();
}

/** A chat completion body: JSON, or a streamed response assembled into JSON. */
export function completionBody(response: TransportResponse): unknown {
  if (isEventStream(response)) return completionFromStream(response.text);
  try {
    return JSON.parse(response.text);
  } catch {
    return undefined;
  }
}
