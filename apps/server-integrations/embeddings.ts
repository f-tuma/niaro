import { z } from "zod";
import type {
  CatalogModel,
  Provider,
} from "../../packages/protocol/service-catalog";
import {
  IntegrationError,
  type DispatchGuard,
  type IntegrationTransport,
} from "./transport";
import { providerEndpoint, providerHeaders } from "./provider-request";

/** Inputs one `/embeddings` request carries at most. */
export const EMBEDDING_BATCH = 32;
/** Characters one request carries at most, so a priced call fits its input ceiling. */
export const EMBEDDING_BATCH_CHARS = 8_000;
/** The widest vector accepted (the largest common models use 3072). */
export const MAX_EMBEDDING_DIMENSIONS = 8192;

export type EmbeddingSelection = {
  model: Pick<CatalogModel, "id" | "revision" | "model">;
  provider: Pick<Provider, "id" | "revision" | "url" | "auth" | "dialect">;
  key: string;
};

const Response = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        embedding: z
          .array(z.number().finite())
          .min(1)
          .max(MAX_EMBEDDING_DIMENSIONS),
      }),
    )
    .min(1)
    .max(EMBEDDING_BATCH),
});

/**
 * Embeds texts with the workspace's embedding model through the standard
 * OpenAI-compatible `POST {provider}/embeddings`, so any provider that
 * offers it works: OpenAI, OpenRouter, Mistral, Ollama, LM Studio, vLLM.
 * The model name is the administrator's catalog entry, never a default.
 * The transport is the caller's: it budgets the call and counts it against
 * the provider's daily limit before dispatch.
 */
export async function embedTexts(
  transport: IntegrationTransport,
  selected: EmbeddingSelection,
  texts: readonly string[],
  signal: AbortSignal,
  beforeDispatch: DispatchGuard,
): Promise<Float32Array[]> {
  if (!texts.length || texts.length > EMBEDDING_BATCH)
    throw new IntegrationError("embedding_input_invalid");
  const response = await transport({
    url: providerEndpoint(selected.provider, "/embeddings"),
    method: "POST",
    signal,
    beforeDispatch,
    timeoutMs: 120_000,
    maxResponseBytes: 16 * 1024 * 1024,
    headers: providerHeaders(selected.provider, selected.key),
    body: {
      model: selected.model.model,
      input: [...texts],
      encoding_format: "float",
    },
  });
  signal.throwIfAborted();
  if (response.status === 429)
    throw new IntegrationError("embedding_rate_limited", 503);
  if (response.status === 401 || response.status === 403)
    throw new IntegrationError("integration_provider_denied", 502);
  if (response.status < 200 || response.status >= 300)
    throw new IntegrationError("embedding_unavailable", 502);
  let parsed: z.infer<typeof Response>;
  try {
    parsed = Response.parse(JSON.parse(response.text));
  } catch {
    throw new IntegrationError("embedding_response_invalid", 502);
  }
  const vectors = new Array<Float32Array | undefined>(texts.length);
  for (const item of parsed.data) {
    if (item.index >= texts.length || vectors[item.index])
      throw new IntegrationError("embedding_response_invalid", 502);
    vectors[item.index] = Float32Array.from(item.embedding);
  }
  const width = vectors[0]?.length;
  if (vectors.some((vector) => !vector || vector.length !== width))
    throw new IntegrationError("embedding_response_invalid", 502);
  return vectors as Float32Array[];
}

/** Splits texts into requests that respect both batch limits, in order. */
export function embeddingBatches(texts: readonly string[]) {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const text of texts) {
    if (
      current.length &&
      (current.length >= EMBEDDING_BATCH ||
        chars + text.length > EMBEDDING_BATCH_CHARS)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}
