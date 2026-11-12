import { generateObject, runTools, type ModelTool } from "./model-call";
import type { z } from "zod";
import type { LanguageModelV4 } from "./model-types";

/**
 * The two closed model calls behind an AI-filled overview widget. Neither
 * has memory, a shared thread or any tool beyond the ones passed in; the
 * caller decides which reads exist, executes them under the person's current
 * authority and validates everything that comes back.
 */
export type WidgetFillTool = ModelTool;

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
  },
  signal: AbortSignal,
) {
  await runTools(model, input, signal);
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
  },
  signal: AbortSignal,
): Promise<unknown> {
  return generateObject(
    model,
    {
      instructions: input.instructions,
      prompt: input.payload,
      schema: input.schema,
    },
    signal,
  );
}
