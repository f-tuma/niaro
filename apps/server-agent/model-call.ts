import { z } from "zod";
import type {
  JSONValue,
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
} from "./model-types";

/**
 * Closed single-purpose model calls (meeting records, profile observations,
 * action names, widget data) straight through Niaro's provider: no agent
 * runtime, memory, stored thread or retries. They hold nothing a restart
 * could continue, so a durable Pi conversation would only keep transcripts
 * and service data in the agent core for no recovery.
 */

function jsonSchema(schema: z.ZodType) {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
  });
  return rest as LanguageModelV4FunctionTool["inputSchema"];
}

const textOf = (content: LanguageModelV4Content[]) =>
  content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

const opening = (
  instructions: string,
  prompt: string,
): LanguageModelV4Prompt => [
  { role: "system", content: instructions },
  { role: "user", content: [{ type: "text", text: prompt }] },
];

/** One call answered by one JSON object of `schema`, or `model_output_invalid`. */
export async function generateObject<S extends z.ZodType>(
  model: LanguageModelV4,
  input: {
    instructions: string;
    prompt: string;
    schema: S;
    maxOutputTokens?: number;
  },
  signal: AbortSignal,
): Promise<z.output<S>> {
  const result = await model.doGenerate({
    prompt: opening(
      `${input.instructions}\n\nAnswer with one JSON object only, no other text, matching this JSON schema:\n${JSON.stringify(jsonSchema(input.schema))}`,
      input.prompt,
    ),
    maxOutputTokens: input.maxOutputTokens,
    abortSignal: signal,
  });
  signal.throwIfAborted();
  let value: unknown;
  try {
    value = JSON.parse(
      textOf(result.content)
        .trim()
        .replace(/^```(?:json)?\s*|\s*```$/g, ""),
    );
  } catch {
    throw new Error("model_output_invalid");
  }
  const parsed = input.schema.safeParse(value);
  if (!parsed.success) throw new Error("model_output_invalid");
  return parsed.data;
}

export type ModelTool = {
  name: string;
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  /** Returns refusals as values; throws only when the run must stop. */
  run: (input: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Lets the model call `tools` for at most `maxSteps` calls, until it answers
 * without one. Its final text is discarded: what the tools did is the result.
 */
export async function runTools(
  model: LanguageModelV4,
  input: {
    instructions: string;
    prompt: string;
    tools: ModelTool[];
    maxSteps: number;
  },
  signal: AbortSignal,
) {
  const prompt = opening(input.instructions, input.prompt);
  const tools = input.tools.map(
    (tool): LanguageModelV4FunctionTool => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      inputSchema: jsonSchema(tool.input),
    }),
  );
  for (let step = 0; step < input.maxSteps; step++) {
    const result = await model.doGenerate({
      prompt,
      tools,
      toolChoice: { type: "auto" },
      abortSignal: signal,
    });
    signal.throwIfAborted();
    const calls = result.content.flatMap((part) =>
      part.type === "tool-call" ? [part] : [],
    );
    if (!calls.length) return;
    const text = textOf(result.content);
    const args = calls.map((call): unknown => {
      try {
        return JSON.parse(call.input || "{}");
      } catch {
        return undefined;
      }
    });
    prompt.push({
      role: "assistant",
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...calls.map((call, index) => ({
          type: "tool-call" as const,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: args[index] ?? {},
        })),
      ],
    });
    const outputs = [];
    for (const [index, call] of calls.entries()) {
      const tool = input.tools.find((tool) => tool.name === call.toolName);
      const parsed = tool?.input.safeParse(args[index]);
      const value = !tool
        ? { error: "unknown_tool" }
        : !parsed?.success
          ? { error: "invalid_arguments" }
          : await tool.run(parsed.data);
      signal.throwIfAborted();
      outputs.push({
        type: "tool-result" as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "json" as const, value: (value ?? null) as JSONValue },
      });
    }
    prompt.push({ role: "tool", content: outputs });
  }
}
