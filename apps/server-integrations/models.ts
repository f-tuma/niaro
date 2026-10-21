import { z } from "zod";
import {
  ModelDiscoveryResponse,
  type DiscoveredModel,
  type CatalogModel,
  type Provider,
} from "../../packages/protocol/service-catalog";
import {
  IntegrationError,
  jsonResponse,
  type IntegrationTransport,
  type DispatchGuard,
} from "./transport";
import {
  normalizeModelCapabilities,
  OPENROUTER_URL,
  JEV_DECISION_MODEL,
} from "./model-capabilities";
const Completion = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().max(200),
                type: z.literal("function"),
                function: z.object({
                  name: z.string().max(128),
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
});
export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
};
export async function complete(
  transport: IntegrationTransport,
  provider: Provider,
  key: string,
  model: CatalogModel,
  messages: ModelMessage[],
  tools: unknown[],
  signal: AbortSignal,
  beforeDispatch: DispatchGuard,
) {
  const response = await transport({
    url: provider.url.replace(/\/$/, "") + "/chat/completions",
    method: "POST",
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: {
      model: model.model,
      messages,
      temperature: 0.1,
      max_tokens: 1600,
      ...(tools.length
        ? { tools, tool_choice: "auto", parallel_tool_calls: false }
        : {}),
    },
    signal,
    beforeDispatch,
  });
  const parsed = Completion.safeParse(jsonResponse(response));
  if (!parsed.success)
    throw new IntegrationError("integration_model_response_invalid", 502);
  return parsed.data.choices[0]!.message;
}
/** OpenRouter publishes USD per token as decimal strings; unknown or negative
 * (variable) prices are omitted rather than guessed. */
function listPrice(
  pricing:
    | { prompt?: string | null; completion?: string | null }
    | null
    | undefined,
) {
  const micros = (value?: string | null) => {
    if (!value || !/^\d+(\.\d+)?(e-?\d+)?$/i.test(value)) return null;
    const result = Math.round(Number(value) * 1e12);
    return Number.isSafeInteger(result) && result <= 1_000_000_000
      ? result
      : null;
  };
  const input = micros(pricing?.prompt),
    output = micros(pricing?.completion);
  return input === null || output === null
    ? null
    : { inputMicrosPerMillion: input, outputMicrosPerMillion: output };
}
export async function listModels(
  transport: IntegrationTransport,
  provider: Provider,
  key: string,
  signal: AbortSignal,
  beforeDispatch: DispatchGuard,
) {
  const base = provider.url.replace(/\/$/, "");
  const pages = await Promise.all(
    (base === OPENROUTER_URL
      ? ["", "?output_modalities=transcription", "?output_modalities=speech"]
      : [""]
    ).map(async (query) =>
      jsonResponse(
        await transport({
          url: base + "/models" + query,
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          signal,
          beforeDispatch,
        }),
      ),
    ),
  );
  const schema = z.object({
    data: z
      .array(
        z.object({
          id: z.string().min(1).max(200),
          name: z.string().max(200).optional(),
          supported_parameters: z.array(z.string().max(100)).max(200).nullish(),
          architecture: z
            .object({
              tokenizer: z.string().max(100).nullish(),
              input_modalities: z.array(z.string()).max(20).optional(),
              output_modalities: z.array(z.string()).max(20).optional(),
            })
            .nullish(),
          context_length: z.number().int().nonnegative().nullish(),
          pricing: z
            .object({
              prompt: z.string().max(40).nullish(),
              completion: z.string().max(40).nullish(),
            })
            .nullish(),
        }),
      )
      .max(5000),
  });
  const catalogs = pages.map((raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      throw new IntegrationError("integration_response_invalid", 502);
    return parsed.data.data;
  });
  const models = new Map<string, DiscoveredModel>();
  // The Decisions API has no model-list endpoint; expose its documented pinned model explicitly.
  if (provider.url.replace(/\/$/, "") === OPENROUTER_URL)
    models.set(JEV_DECISION_MODEL, {
      model: JEV_DECISION_MODEL,
      name: "TypeSafe: Jev 1.13",
      kind: "decision",
      tools: false,
      pricing: null,
      audioInput: false,
      audioOutput: false,
      contextLength: null,
    });
  for (const model of catalogs.flat()) {
    if (!models.has(model.id))
      models.set(
        model.id,
        normalizeModelCapabilities(provider.url, {
          kind:
            model.architecture?.tokenizer === "Router"
              ? "router"
              : model.architecture?.output_modalities?.includes("transcription")
                ? "transcription"
                : model.architecture?.output_modalities?.includes("speech")
                  ? "speech"
                  : "chat",
          model: model.id,
          name: (model.name?.trim() || model.id).slice(0, 100),
          tools: model.supported_parameters
            ? model.supported_parameters.includes("tools")
            : null,
          contextLength: model.context_length || null,
          audioOutput: model.architecture?.output_modalities
            ? model.architecture.output_modalities.includes("speech") ||
              (model.architecture.output_modalities.includes("audio") &&
                model.architecture.output_modalities.includes("text") &&
                model.architecture.input_modalities?.includes("text") === true)
            : null,
          audioInput:
            model.architecture?.input_modalities?.includes("audio") ?? null,
          pricing: listPrice(model.pricing),
        }),
      );
  }
  return ModelDiscoveryResponse.parse({
    models: [...models.values()].slice(0, 5000),
  }).models;
}
