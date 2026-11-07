/**
 * Turns a Niaro-shaped runtime provider config (what the administration stores:
 * address, key handling, dialect, catalog models) into a pi-ai Provider.
 * Nothing here names a model: every model comes from the config object.
 */
import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export type NiaroProviderAuth =
  | { type: "none" }
  | { type: "bearer" }
  | { type: "header"; header: string };

export type NiaroCatalogModel = {
  /** Niaro catalog id (what the role policy lists). */
  catalogId: string;
  /** The upstream model id sent on the wire. */
  model: string;
  tools: boolean;
  /** USD per million tokens; from the workspace price table, or zero for free providers. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
};

export type NiaroProviderConfig = {
  /** Niaro catalog provider id; becomes the pi-ai provider id. */
  id: string;
  name: string;
  url: string;
  auth: NiaroProviderAuth;
  dialect: "openai" | "openrouter";
  /** Unsealed in-process. Never logged. */
  key: string;
  /** Extra headers an administrator configured (e.g. a gateway tenant header). */
  headers?: Record<string, string>;
  /** Local OpenAI-compatible servers often lack the developer role and reasoning_effort. */
  local?: boolean;
  models: NiaroCatalogModel[];
};

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function toPiModel(config: NiaroProviderConfig, m: NiaroCatalogModel): Model<"openai-completions"> {
  return {
    // The pi model id is the Niaro catalog id, so a role policy entry maps 1:1 to a pi ModelRef.
    id: m.catalogId,
    name: m.model,
    api: "openai-completions",
    provider: config.id,
    baseUrl: config.url,
    reasoning: m.reasoning ?? false,
    input: ["text"],
    cost: m.cost ?? ZERO,
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 4096,
    headers: config.headers,
    compat: {
      ...(config.local ? { supportsDeveloperRole: false, supportsReasoningEffort: false } : {}),
      // OpenRouter dialect: pi-ai auto-detects OpenRouter by URL; set the thinking format explicitly
      // so a custom OpenRouter-compatible URL behaves the same.
      ...(config.dialect === "openrouter" ? { thinkingFormat: "openrouter" as const } : {}),
    },
  };
}

/**
 * pi-ai sends `model.id` as the wire model name, so the wire id must be the
 * upstream one. We keep the Niaro catalog id as the pi model id and rewrite the
 * wire name in a provider-wide stream wrapper.
 */
export function niaroProvider(config: NiaroProviderConfig): Provider {
  const models = config.models.map((m) => toPiModel(config, m));
  const wire = new Map(config.models.map((m) => [m.catalogId, m.model]));
  const inner = openAICompletionsApi();
  const rename = <M extends Model<any>>(model: M): M => ({ ...model, id: wire.get(model.id) ?? model.id });
  return createProvider({
    id: config.id,
    name: config.name,
    baseUrl: config.url,
    auth: {
      apiKey: {
        name: config.name,
        resolve: async () => {
          if (config.auth.type === "none") return { auth: { apiKey: "none", headers: { authorization: null } } } as never;
          if (config.auth.type === "bearer") return { auth: { apiKey: config.key } };
          // Named header (Azure `api-key`): send the key there and suppress the bearer default.
          return {
            auth: { apiKey: "unused", headers: { [config.auth.header]: config.key, authorization: null } },
          } as never;
        },
      },
    },
    models,
    api: {
      stream: (model, context, options) => inner.stream(rename(model), context, options),
      streamSimple: (model, context, options) => inner.streamSimple(rename(model), context, options),
    },
  });
}
