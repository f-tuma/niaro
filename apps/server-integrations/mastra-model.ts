import { randomUUID } from "node:crypto";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@niaro/server-agent/model-types";
import { z } from "zod";
import type {
  CatalogModel,
  Provider,
} from "../../packages/protocol/service-catalog";
import {
  canStream,
  IntegrationError,
  jsonResponse,
  MAX_TRANSPORT_TIMEOUT_MS,
  sameEndpoint,
  type DispatchGuard,
  type IntegrationTransport,
  type TransportResponse,
} from "./transport";
import {
  CompletionStream,
  completionFromStream,
  isEventStream,
} from "./chat-stream";
import { providerFailure } from "./failures";
import type { ModelMessage } from "./models";

export type NiaroModelSelection = {
  provider: Provider;
  key: string;
  model: CatalogModel;
};

const tokens = z.number().int().nonnegative().optional();
const Completion = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().max(100).nullish(),
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1).max(200),
                type: z.literal("function"),
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
    })
    .nullish(),
});

const unsupported = () =>
  new IntegrationError("integration_model_input_unsupported");
const encode = (value: unknown) => {
  const result = JSON.stringify(value);
  if (result === undefined) throw unsupported();
  return result;
};

/** Preserve structured results and distinguish errors/denials from successful tool data. */
function toolOutput(
  output: Extract<
    LanguageModelV4Prompt[number],
    { role: "tool" }
  >["content"][number],
) {
  if (output.type !== "tool-result") throw unsupported();
  const value = output.output;
  switch (value.type) {
    case "text":
      return value.value;
    case "json":
      return encode(value.value);
    case "error-text":
    case "error-json":
      return encode({ type: value.type, value: value.value });
    case "execution-denied":
      return encode({ type: value.type, reason: value.reason });
    case "content":
      if (value.value.some((part) => part.type !== "text")) throw unsupported();
      return encode({
        type: value.type,
        value: value.value.map((part) => {
          if (part.type !== "text") throw unsupported();
          return { type: part.type, text: part.text };
        }),
      });
  }
}

function promptMessages(prompt: LanguageModelV4Prompt): ModelMessage[] {
  return prompt.flatMap((message): ModelMessage[] => {
    if (message.role === "system")
      return [{ role: "system", content: message.content }];
    if (message.role === "tool")
      return message.content.map((part) => {
        if (part.type !== "tool-result") throw unsupported();
        return {
          role: "tool",
          tool_call_id: part.toolCallId,
          content: toolOutput(part),
        };
      });
    if (message.role === "user") {
      if (message.content.some((part) => part.type !== "text"))
        throw unsupported();
      return [
        {
          role: "user",
          content: message.content
            .map((part) => {
              if (part.type !== "text") throw unsupported();
              return part.text;
            })
            .join(""),
        },
      ];
    }
    const text: string[] = [];
    const calls: NonNullable<ModelMessage["tool_calls"]> = [];
    for (const part of message.content) {
      if (part.type === "text") text.push(part.text);
      else if (part.type === "tool-call" && !part.providerExecuted)
        calls.push({
          id: part.toolCallId,
          type: "function",
          function: { name: part.toolName, arguments: encode(part.input) },
        });
      else if (part.type !== "reasoning") throw unsupported();
    }
    return [
      {
        role: "assistant",
        content: text.length ? text.join("") : null,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
    ];
  });
}

function requestBody(model: CatalogModel, options: LanguageModelV4CallOptions) {
  const tools = (options.tools ?? []).map((tool) => {
    if (tool.type !== "function" || !model.tools) throw unsupported();
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    };
  });
  const choice = options.toolChoice;
  if (
    choice?.type === "tool" &&
    !tools.some((tool) => tool.function.name === choice.toolName)
  )
    throw unsupported();
  if (
    !tools.length &&
    choice &&
    choice.type !== "none" &&
    choice.type !== "auto"
  )
    throw unsupported();
  const format = options.responseFormat;
  if (
    format?.type === "json" &&
    format.name &&
    !/^[A-Za-z0-9_-]{1,64}$/.test(format.name)
  )
    throw unsupported();
  return {
    model: model.model,
    messages: promptMessages(options.prompt),
    temperature: options.temperature ?? 0.1,
    // No allowance unless a caller sets one: the model's own maximum applies,
    // and usage limits clamp it to the model's "Max reply" when enforced.
    ...(options.maxOutputTokens !== undefined
      ? { max_tokens: options.maxOutputTokens }
      : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.presencePenalty !== undefined
      ? { presence_penalty: options.presencePenalty }
      : {}),
    ...(options.frequencyPenalty !== undefined
      ? { frequency_penalty: options.frequencyPenalty }
      : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.stopSequences?.length ? { stop: options.stopSequences } : {}),
    ...(tools.length
      ? {
          tools,
          tool_choice:
            choice?.type === "tool"
              ? { type: "function", function: { name: choice.toolName } }
              : (choice?.type ?? "auto"),
          parallel_tool_calls: false,
        }
      : {}),
    ...(format?.type === "json"
      ? {
          response_format: format.schema
            ? {
                type: "json_schema",
                json_schema: {
                  name: format.name ?? "response",
                  description: format.description,
                  schema: format.schema,
                  strict: true,
                },
              }
            : { type: "json_object" },
        }
      : {}),
  };
}

/** Operators need to tell a truncated answer from a malformed one; only the
 * finish reason and token counts are logged, never content. */
function rejected(reason: string, response: unknown): never {
  const body = response as {
    choices?: { finish_reason?: unknown }[];
    usage?: {
      completion_tokens?: unknown;
      completion_tokens_details?: { reasoning_tokens?: unknown } | null;
    };
  } | null;
  const scalar = (value: unknown) =>
    typeof value === "string" || typeof value === "number"
      ? String(value).slice(0, 40)
      : null;
  console.warn("Model response rejected", {
    reason,
    finishReason: scalar(body?.choices?.[0]?.finish_reason),
    completionTokens: scalar(body?.usage?.completion_tokens),
    reasoningTokens: scalar(
      body?.usage?.completion_tokens_details?.reasoning_tokens,
    ),
  });
  throw new IntegrationError("integration_model_response_invalid", 502);
}
function resultFrom(response: unknown): LanguageModelV4GenerateResult {
  const parsed = Completion.safeParse(response);
  if (!parsed.success) rejected("shape", response);
  const choice = parsed.data.choices[0]!;
  const calls = choice.message.tool_calls ?? [];
  const content: LanguageModelV4GenerateResult["content"] = [];
  if (choice.message.content !== undefined && choice.message.content !== null)
    content.push({ type: "text", text: choice.message.content });
  for (const call of calls) {
    try {
      JSON.parse(call.function.arguments);
    } catch {
      rejected("tool_arguments", response);
    }
    // Syntactically valid JSON reaches the native tool boundary, which returns
    // a safe correction result for invalid root shapes and schema violations.
    // Provider IDs can repeat across completions or contain private data. Native history,
    // receipts and checkpoints share this server ID for the lifetime of the call instead.
    content.push({
      type: "tool-call",
      toolCallId: randomUUID(),
      toolName: call.function.name,
      input: call.function.arguments,
    });
  }
  if (!content.length) rejected("empty", response);
  const raw = choice.finish_reason ?? undefined;
  const unified = calls.length
    ? "tool-calls"
    : raw === "length"
      ? "length"
      : raw === "content_filter"
        ? "content-filter"
        : raw === "stop" || raw === undefined
          ? "stop"
          : "other";
  const usage = parsed.data.usage;
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    content,
    finishReason: { unified, raw },
    usage: {
      inputTokens: {
        total: usage?.prompt_tokens,
        cacheRead: cached,
        cacheWrite: undefined,
        noCache:
          usage?.prompt_tokens !== undefined && cached !== undefined
            ? Math.max(0, usage.prompt_tokens - cached)
            : undefined,
      },
      outputTokens: {
        total: usage?.completion_tokens,
        reasoning,
        text:
          usage?.completion_tokens !== undefined && reasoning !== undefined
            ? Math.max(0, usage.completion_tokens - reasoning)
            : undefined,
      },
    },
    warnings: [],
  };
}

export type ModelCallLimits = {
  timeoutMs: number;
  maxRequestBytes?: number;
};
/**
 * Bounds for one model call. Interactive turns end before the phone stops
 * waiting (115 s). A whole meeting record sends the complete transcript (up to
 * 1,000,000 characters) and can take several minutes to write.
 */
export const MODEL_CALL_LIMITS = {
  chat: { timeoutMs: 110_000 },
  meeting: {
    timeoutMs: MAX_TRANSPORT_TIMEOUT_MS,
    maxRequestBytes: 4 * 1024 * 1024,
  },
  // The designer writes whole process definitions as tool arguments.
  design: { timeoutMs: 5 * 60_000 },
} as const satisfies Record<string, ModelCallLimits>;

/** Sees the reply text of a streamed call grow; never its tool calls. */
export type ModelTextObserver = { onText(text: string): void };

/** The body of a completed call. A streamed one is assembled into the body
 * the same call returns without streaming; a provider error sent inside the
 * stream fails like an error status. */
function completion(response: TransportResponse, key: string) {
  if (
    !isEventStream(response) ||
    response.status < 200 ||
    response.status >= 300
  )
    return jsonResponse(response, [key]);
  const body = completionFromStream(response.text) as
    | { error?: unknown }
    | undefined;
  if (body?.error)
    throw new IntegrationError(
      "integration_provider_failed",
      502,
      providerFailure(JSON.stringify({ error: body.error }), {
        httpStatus: 502,
        secretValues: [key],
      }),
    );
  return body;
}

/** A single provider invocation. Mastra owns the model/tool loop and all retries are disabled by its caller. */
export function createNiaroMastraModel(
  selected: NiaroModelSelection,
  transport: IntegrationTransport,
  beforeDispatch: DispatchGuard,
  limits: ModelCallLimits = MODEL_CALL_LIMITS.chat,
  observer?: ModelTextObserver,
): LanguageModelV4 {
  const provider = { ...selected.provider };
  const model = { ...selected.model };
  const key = selected.key;
  if (
    !provider.enabled ||
    !model.enabled ||
    model.providerId !== provider.id ||
    !["chat", "router"].includes(model.kind)
  )
    throw new IntegrationError("integration_model_unavailable", 409);
  const url = sameEndpoint(
    provider.url,
    provider.url.replace(/\/$/, "") + "/chat/completions",
  ).href;
  const generate = async (
    options: LanguageModelV4CallOptions,
    observe?: ModelTextObserver,
  ): Promise<LanguageModelV4GenerateResult> => {
    options.abortSignal?.throwIfAborted();
    // SDK options cannot change the configured endpoint or authentication headers.
    const body = requestBody(model, options);
    // A streamed call shows its reply while it is written. It still resolves
    // only with the whole completion, validated as without streaming.
    const stream = observe && new CompletionStream();
    const response = await transport({
      url,
      method: "POST",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: stream
        ? { ...body, stream: true, stream_options: { include_usage: true } }
        : body,
      signal: options.abortSignal,
      ...limits,
      beforeDispatch,
      ...(stream && {
        onEvent: (data: string) => {
          if (stream.push(data)) observe.onText(stream.reply);
        },
      }),
    });
    options.abortSignal?.throwIfAborted();
    const result = resultFrom(completion(response, key));
    if (options.topK !== undefined)
      result.warnings.push({ type: "unsupported", feature: "topK" });
    if (options.reasoning && options.reasoning !== "provider-default")
      result.warnings.push({ type: "unsupported", feature: "reasoning" });
    if (
      options.headers &&
      Object.entries(options.headers).some(
        ([name, value]) =>
          name.toLowerCase() !== "user-agent" && value !== undefined,
      )
    )
      result.warnings.push({ type: "unsupported", feature: "headers" });
    if (options.providerOptions && Object.keys(options.providerOptions).length)
      result.warnings.push({ type: "unsupported", feature: "providerOptions" });
    return result;
  };
  return {
    specificationVersion: "v4",
    provider: `niaro.${provider.id}`,
    modelId: model.model,
    // Prevent the SDK from fetching prompt URLs itself. File parts are rejected before dispatch.
    supportedUrls: { "*/*": [/.*/] },
    doGenerate: generate,
    async doStream(options) {
      const result = await generate(
        options,
        observer && canStream(transport) ? observer : undefined,
      );
      const chunks: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: result.warnings },
      ];
      for (const [index, part] of result.content.entries()) {
        if (part.type === "text") {
          const id = `text-${index}`;
          chunks.push(
            { type: "text-start", id },
            { type: "text-delta", id, delta: part.text },
            { type: "text-end", id },
          );
        } else if (part.type === "tool-call") chunks.push(part);
      }
      chunks.push({
        type: "finish",
        finishReason: result.finishReason,
        usage: result.usage,
      });
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  };
}
