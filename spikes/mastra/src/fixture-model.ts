import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];
type Prompt = CallOptions["prompt"];
type Message = Prompt[number];
type PromptPart = Exclude<Message, { role: "system" }>["content"][number];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type ToolResultPart = Extract<
  Extract<Message, { role: "tool" }>["content"][number],
  { type: "tool-result" }
>;

type Command =
  | { kind: "create-person"; operationId: string; name: string }
  | { kind: "verify-person"; operationId: string }
  | { kind: "remember"; fact: string }
  | { kind: "recall" };

const usage: GenerateResult["usage"] = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function userText(message: Message): string | undefined {
  if (message.role !== "user") return undefined;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function isRuntimeSignal(message: Message): boolean {
  const text = userText(message)?.trimStart();
  return (
    text?.startsWith("<current-objective") === true ||
    text?.startsWith("<system-reminder") === true
  );
}

function parseCommand(text: string | undefined): Command | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.kind === "remember" && typeof value.fact === "string") {
    return { kind: "remember", fact: value.fact };
  }
  if (value.kind === "recall") return { kind: "recall" };
  if (typeof value.operationId !== "string" || value.operationId.length === 0)
    return undefined;
  if (value.kind === "create-person" && typeof value.name === "string") {
    return {
      kind: "create-person",
      operationId: value.operationId,
      name: value.name,
    };
  }
  if (value.kind === "verify-person") {
    return { kind: "verify-person", operationId: value.operationId };
  }
  return undefined;
}

function textResult(text: string): GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
    usage,
    warnings: [],
  };
}

function generateFromHistory({ prompt }: CallOptions): GenerateResult {
  // Mastra projects goal state/reminders as user-shaped XML messages. Actual
  // user messages, including unrelated follow-ups, still form action boundaries.
  const userIndex = prompt.findLastIndex(
    (message) => message.role === "user" && !isRuntimeSignal(message),
  );
  const command = parseCommand(
    userIndex >= 0 ? userText(prompt[userIndex]!) : undefined,
  );
  if (!command)
    return textResult("Fixture model expects a supported JSON command.");

  if (command.kind === "remember") return textResult("zapamatováno");
  if (command.kind === "recall") {
    for (let index = userIndex - 1; index >= 0; index--) {
      const previous = parseCommand(userText(prompt[index]!));
      if (previous?.kind === "remember") return textResult(previous.fact);
    }
    return textResult("Žádný zapamatovaný fakt.");
  }

  const toolName =
    command.kind === "create-person" ? "createPerson" : "verifyPerson";
  const toolCallId = `fixture-${command.kind}-${command.operationId}`;
  const result = prompt
    .slice(userIndex + 1)
    .flatMap<PromptPart>((message) =>
      message.role === "system" ? [] : message.content,
    )
    .findLast(
      (part): part is ToolResultPart =>
        part.type === "tool-result" &&
        part.toolName === toolName &&
        part.toolCallId === toolCallId,
    );
  if (result) {
    // AI SDK wraps JSON/text results; expose the tool's actual payload as text.
    return textResult(
      JSON.stringify(
        "value" in result.output ? result.output.value : result.output,
      ),
    );
  }

  const input =
    command.kind === "create-person"
      ? { operationId: command.operationId, name: command.name }
      : { operationId: command.operationId };
  return {
    content: [
      { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  };
}

/** Offline provider fixture; every response is derived from the supplied history. */
export function createFixtureModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "niaro-fixture",
    modelId: "stateless-v1",
    doGenerate: async (options) => generateFromHistory(options),
    doStream: async (options) => {
      const result = generateFromHistory(options);
      const parts: StreamPart[] = [{ type: "stream-start", warnings: [] }];
      for (const [index, part] of result.content.entries()) {
        if (part.type === "text") {
          const id = `fixture-text-${index}`;
          parts.push(
            { type: "text-start", id },
            { type: "text-delta", id, delta: part.text },
            { type: "text-end", id },
          );
        } else if (part.type === "tool-call") {
          parts.push(part);
        }
      }
      parts.push({
        type: "finish",
        finishReason: result.finishReason,
        usage: result.usage,
      });
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}
