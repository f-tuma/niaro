/**
 * Pi transcripts on the OpenAI-compatible chat completions wire, the one
 * dialect Niaro's providers speak (OpenAI and OpenRouter alike): the request
 * body built from a Pi transcript, and a Pi assistant message built from the
 * completion, streamed or not. No network here; `provider.ts` sends it
 * through Niaro's integration transport.
 */
import { randomUUID } from "node:crypto";
import {
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type JsonObject,
  type Message,
  type StopReason,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import type { CatalogModel } from "../../../packages/protocol/service-catalog";
import { IntegrationError } from "../../server-integrations/transport";

/** The Pi api name of every Niaro route model. */
export const NIARO_PI_API: Api = "niaro-chat-completions";

type WireMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
};
export type WireOptions = {
  toolChoice?: "auto" | "none";
  temperature?: number;
  maxTokens?: number;
  stream: boolean;
};

const unsupported = () =>
  new IntegrationError("integration_model_input_unsupported");
const textOf = (
  content: string | readonly { type: string; text?: string }[],
): string => {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      // Images reach no model through this adapter yet.
      if (part.type !== "text") throw unsupported();
      return part.text ?? "";
    })
    .join("");
};

function wireMessages(messages: readonly Message[]): WireMessage[] {
  return messages.flatMap((message): WireMessage[] => {
    switch (message.role) {
      // The collapsed transcript has one leading system message; its text is
      // rebuilt from every section by the caller.
      case "system":
        return [];
      case "user":
        return [{ role: "user", content: textOf(message.content) }];
      case "toolResult": {
        const text = textOf(message.content);
        return [
          {
            role: "tool",
            tool_call_id: message.toolCallId,
            // A failed call stays distinguishable from tool data, as before.
            content: message.isError
              ? JSON.stringify({ type: "error-text", value: text })
              : text,
          },
        ];
      }
      case "assistant": {
        const text: string[] = [];
        const calls: NonNullable<WireMessage["tool_calls"]> = [];
        for (const part of message.content) {
          if (part.type === "text") text.push(part.text);
          else if (part.type === "toolCall")
            calls.push({
              id: part.id,
              type: "function",
              function: {
                name: part.name,
                arguments: JSON.stringify(part.arguments),
              },
            });
          // Thinking stays with the response that produced it.
        }
        if (!text.length && !calls.length) return [];
        return [
          {
            role: "assistant",
            content: text.length ? text.join("") : null,
            ...(calls.length ? { tool_calls: calls } : {}),
          },
        ];
      }
    }
    return [];
  });
}

/**
 * The chat completions body for one Pi request. Caller options never change
 * the endpoint, the key or the headers: only the model, the transcript and
 * sampling reach the body.
 */
export function requestBody(
  model: Pick<CatalogModel, "model" | "tools">,
  context: TranscriptContext,
  options: WireOptions,
) {
  const transcript = collapseSystemMessages(context).messages;
  const system = getCurrentSystemPrompt(transcript);
  const tools = getCurrentTools(transcript).map((tool) => {
    if (!model.tools) throw unsupported();
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  });
  return {
    model: model.model,
    messages: [
      ...(system ? [{ role: "system", content: system } as WireMessage] : []),
      ...wireMessages(transcript),
    ],
    temperature: options.temperature ?? 0.1,
    // No allowance unless a caller sets one; enforced usage limits clamp it
    // to the model's priced maximum in the budgeted transport.
    ...(options.maxTokens !== undefined
      ? { max_tokens: options.maxTokens }
      : {}),
    ...(tools.length
      ? {
          tools,
          tool_choice: options.toolChoice ?? "auto",
          parallel_tool_calls: false,
        }
      : {}),
    ...(options.stream
      ? { stream: true, stream_options: { include_usage: true } }
      : {}),
  };
}

const tokens = z.number().int().nonnegative().optional();
const Completion = z.object({
  id: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().max(100).nullish(),
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().max(200).optional(),
                type: z.literal("function").optional(),
                function: z.object({
                  name: z.string().min(1).max(128),
                  arguments: z.string().max(65536),
                }),
              }),
            )
            .max(5)
            .optional(),
        }),
      }),
    )
    .min(1)
    .max(10),
  usage: z
    .object({
      prompt_tokens: tokens,
      completion_tokens: tokens,
      prompt_tokens_details: z.object({ cached_tokens: tokens }).nullish(),
      completion_tokens_details: z
        .object({ reasoning_tokens: tokens })
        .nullish(),
      cost: z.union([z.number(), z.string()]).optional(),
    })
    .nullish(),
});

/** USD per million tokens, for Pi's own usage record; the ledger is ours. */
export type DisplayPrice = { input: number; output: number };

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** The provider's counts in Pi's shape. Niaro's ledger settles from the raw body itself. */
export function piUsage(
  raw: z.infer<typeof Completion>["usage"],
  price?: DisplayPrice,
): Usage {
  const usage = emptyUsage();
  if (!raw) return usage;
  const prompt = raw.prompt_tokens ?? 0;
  const cached = Math.min(
    raw.prompt_tokens_details?.cached_tokens ?? 0,
    prompt,
  );
  usage.input = prompt - cached;
  usage.cacheRead = cached;
  usage.output = raw.completion_tokens ?? 0;
  if (raw.completion_tokens_details?.reasoning_tokens !== undefined)
    usage.reasoning = raw.completion_tokens_details.reasoning_tokens;
  usage.totalTokens = prompt + usage.output;
  if (price) {
    usage.cost.input = (prompt * price.input) / 1e6;
    usage.cost.output = (usage.output * price.output) / 1e6;
    usage.cost.total = usage.cost.input + usage.cost.output;
  }
  const reported = Number(raw.cost);
  if (raw.cost !== undefined && Number.isFinite(reported) && reported >= 0) {
    usage.cost.total = reported;
    usage.cost.totalFromProvider = true;
  }
  return usage;
}

export type MessageHead = {
  api: Api;
  provider: string;
  model: string;
  timestamp: number;
};

/** A completion body as a Pi assistant message; throws on a malformed one. */
export function assistantMessage(
  body: unknown,
  head: MessageHead,
  price?: DisplayPrice,
): AssistantMessage {
  const parsed = Completion.safeParse(body);
  if (!parsed.success)
    throw new IntegrationError("integration_model_response_invalid", 502);
  const choice = parsed.data.choices[0]!;
  const content: AssistantMessage["content"] = [];
  if (choice.message.content)
    content.push({ type: "text", text: choice.message.content });
  for (const call of choice.message.tool_calls ?? []) {
    let args: unknown;
    let argumentsError: string | undefined;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      argumentsError = "The arguments are not valid JSON.";
    }
    if (
      !argumentsError &&
      (!args || typeof args !== "object" || Array.isArray(args))
    )
      argumentsError = "The arguments are not a JSON object.";
    content.push({
      type: "toolCall",
      // Provider ids can repeat across completions or carry private data;
      // the transcript gets a server id instead.
      id: randomUUID(),
      name: call.function.name,
      arguments: argumentsError ? {} : (args as JsonObject),
      ...(argumentsError ? { argumentsError } : {}),
    });
  }
  if (!content.length)
    throw new IntegrationError("integration_model_response_invalid", 502);
  const raw = choice.finish_reason ?? undefined;
  const stopReason: StopReason = content.some(
    (part) => part.type === "toolCall",
  )
    ? "toolUse"
    : raw === "length"
      ? "length"
      : "stop";
  return {
    role: "assistant",
    content,
    ...head,
    ...(parsed.data.model && parsed.data.model !== head.model
      ? { responseModel: parsed.data.model }
      : {}),
    usage: piUsage(parsed.data.usage, price),
    stopReason,
    ...(raw ? { rawStopReason: raw } : {}),
  };
}
