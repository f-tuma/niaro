import { z } from "zod";

/**
 * How a provider's requests are shaped where OpenAI-compatible servers
 * differ. `openai`: the plain OpenAI API (`/v1/models`, multipart
 * `/v1/audio/transcriptions`, `/v1/audio/speech`), which local servers and
 * most vendors follow. `openrouter`: OpenRouter's additions on top of it
 * (routing privacy flags, audio sent as JSON, its audio catalogs, the web
 * search plugin and the decisions API). An administrator chooses it; a
 * preset only fills it in.
 */
export const ProviderDialect = z.enum(["openai", "openrouter"]);
export type ProviderDialectValue = z.infer<typeof ProviderDialect>;

/**
 * How the stored key is sent: as a bearer token, in a named header (Azure
 * OpenAI's `api-key`), or not at all (a local server without a key).
 */
export const ProviderAuth = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("bearer") }),
  z.strictObject({
    type: z.literal("header"),
    header: z.string().regex(/^[a-z][a-z0-9-]{0,60}$/i),
  }),
]);
export type ProviderAuthValue = z.infer<typeof ProviderAuth>;

export const PROVIDER_PRESET_IDS = [
  "openrouter",
  "openai",
  "anthropic",
  "gemini",
  "azure",
  "ollama",
  "lmstudio",
  "vllm",
  "llamacpp",
  "localai",
  "custom",
] as const;
export const ProviderPresetId = z.enum(PROVIDER_PRESET_IDS);
export type ProviderPresetIdValue = z.infer<typeof ProviderPresetId>;

/**
 * A starting point for a provider form: address, key handling, dialect and
 * whether its models cost nothing. Presets are data an administrator applies
 * and may then change entirely; they name no model and nothing in routing
 * reads them. `local` presets run on the administrator's own machine, whose
 * address must be a trusted origin (Settings) before it can be saved.
 */
export type ProviderPreset = {
  id: ProviderPresetIdValue;
  label: string;
  url: string;
  auth: ProviderAuthValue;
  dialect: ProviderDialectValue;
  free: boolean;
  local: boolean;
};
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    auth: { type: "bearer" },
    dialect: "openrouter",
    free: false,
    local: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    url: "https://api.openai.com/v1",
    auth: { type: "bearer" },
    dialect: "openai",
    free: false,
    local: false,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    url: "https://api.anthropic.com/v1",
    auth: { type: "bearer" },
    dialect: "openai",
    free: false,
    local: false,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai",
    auth: { type: "bearer" },
    dialect: "openai",
    free: false,
    local: false,
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    url: "https://your-resource.openai.azure.com/openai/v1",
    auth: { type: "header", header: "api-key" },
    dialect: "openai",
    free: false,
    local: false,
  },
  {
    id: "ollama",
    label: "Ollama",
    url: "http://localhost:11434/v1",
    auth: { type: "none" },
    dialect: "openai",
    free: true,
    local: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    url: "http://localhost:1234/v1",
    auth: { type: "none" },
    dialect: "openai",
    free: true,
    local: true,
  },
  {
    id: "vllm",
    label: "vLLM",
    url: "http://localhost:8000/v1",
    auth: { type: "none" },
    dialect: "openai",
    free: true,
    local: true,
  },
  {
    id: "llamacpp",
    label: "llama.cpp server",
    url: "http://localhost:8080/v1",
    auth: { type: "none" },
    dialect: "openai",
    free: true,
    local: true,
  },
  {
    id: "localai",
    label: "LocalAI",
    url: "http://localhost:8080/v1",
    auth: { type: "none" },
    dialect: "openai",
    free: true,
    local: true,
  },
  {
    id: "custom",
    label: "Custom",
    url: "",
    auth: { type: "bearer" },
    dialect: "openai",
    free: false,
    local: false,
  },
];
/** Whether a provider speaks OpenRouter's additions (decisions API, web plugin). */
export const isOpenRouterProvider = (provider: {
  dialect?: ProviderDialectValue;
}) => provider.dialect === "openrouter";
export const providerPreset = (id: string | undefined) =>
  PROVIDER_PRESETS.find((preset) => preset.id === id);

/**
 * The token ceilings of the zero price a free provider's models get when the
 * workspace has no price of its own for them: a call still reserves tokens
 * against the run's token cap, and costs nothing.
 */
export const FREE_MODEL_LIMITS = Object.freeze({
  maxInputTokens: 128_000,
  maxOutputTokens: 16_384,
});

/** Where a web search goes when a workspace does not use the provider's own search. */
export const SEARCH_BACKEND_KINDS = ["searxng", "brave", "tavily"] as const;
export const SearchBackendKind = z.enum(SEARCH_BACKEND_KINDS);
export type SearchBackendKindValue = z.infer<typeof SearchBackendKind>;
/**
 * Defaults a search backend form starts from; the address stays editable.
 * SearXNG starts at the compose "search" profile's service.
 */
export const SEARCH_BACKEND_PRESETS: Readonly<
  Record<
    SearchBackendKindValue,
    { label: string; url: string; keyRequired: boolean }
  >
> = {
  searxng: {
    label: "SearXNG",
    url: "http://searxng:8080",
    keyRequired: false,
  },
  brave: {
    label: "Brave Search",
    url: "https://api.search.brave.com/res/v1",
    keyRequired: true,
  },
  tavily: { label: "Tavily", url: "https://api.tavily.com", keyRequired: true },
};
