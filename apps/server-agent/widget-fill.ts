import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import type { z } from "zod";
import type { LanguageModelV4 } from "./model-types";

/**
 * The two closed Mastra agents behind an AI-filled overview widget. Neither
 * has memory, a shared thread or any tool beyond the ones passed in; the
 * caller decides which reads exist, executes them under the person's current
 * authority and validates everything that comes back.
 */
export type WidgetFillTool = {
  name: string;
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  run: (input: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Collects data for a widget: the model decides which services, read actions
 * and arguments answer the request, calling only the supplied tools. Its own
 * final text is discarded; what it read is what counts.
 */
export async function collectWidgetData(
  model: LanguageModelV4,
  input: {
    instructions: string;
    prompt: string;
    tools: WidgetFillTool[];
    maxSteps: number;
    maxOutputTokens: number;
  },
  signal: AbortSignal,
) {
  const agent = new Agent({
    id: "niaro-widget-collect-v1",
    name: "Widget data collection",
    model,
    instructions: input.instructions,
    tools: Object.fromEntries(
      input.tools.map((tool) => [
        tool.name,
        createTool({
          id: tool.name,
          description: tool.description,
          inputSchema: tool.input,
          execute: async (args) => {
            signal.throwIfAborted();
            return tool.run(args as Record<string, unknown>);
          },
        }),
      ]),
    ),
  });
  await agent.generate(input.prompt, {
    abortSignal: signal,
    maxSteps: input.maxSteps,
    modelSettings: {
      maxRetries: 0,
      maxOutputTokens: input.maxOutputTokens,
    },
  });
  signal.throwIfAborted();
}

/**
 * Assembles the widget's data from what was collected: one step, no tools,
 * the type's schema as enforced structured output. The caller validates the
 * result again before anything is stored.
 */
export async function assembleWidgetData<S extends z.ZodType>(
  model: LanguageModelV4,
  input: {
    schema: S;
    instructions: string;
    payload: string;
    maxOutputTokens: number;
  },
  signal: AbortSignal,
): Promise<unknown> {
  const agent = new Agent({
    id: "niaro-widget-assemble-v1",
    name: "Widget data",
    model,
    tools: {},
    instructions: input.instructions,
  });
  const result = await agent.generate(input.payload, {
    abortSignal: signal,
    maxSteps: 1,
    modelSettings: { maxRetries: 0, maxOutputTokens: input.maxOutputTokens },
    structuredOutput: {
      schema: input.schema,
      jsonPromptInjection: true,
      errorStrategy: "strict",
    },
  });
  signal.throwIfAborted();
  return result.object;
}
