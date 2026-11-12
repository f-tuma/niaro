/**
 * Server-only contract of Niaro's guarded model transport: the subset of the
 * AI SDK language model specification (v4) our provider speaks and our agent
 * code reads. Our own types since NIAR-305; nothing here comes from a package.
 */
export type JSONValue =
  | null
  | string
  | number
  | boolean
  | { readonly [key: string]: JSONValue | undefined }
  | readonly JSONValue[];
type JSONObject = { [key: string]: JSONValue | undefined };
type ProviderOptions = Record<string, JSONObject>;
type ProviderMetadata = Record<string, JSONObject>;

export type LanguageModelV4ToolCall = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  /** The arguments as JSON text. */
  input: string;
  providerExecuted?: boolean;
  providerMetadata?: ProviderMetadata;
};
export type LanguageModelV4Content =
  | { type: "text"; text: string; providerMetadata?: ProviderMetadata }
  | { type: "reasoning"; text: string; providerMetadata?: ProviderMetadata }
  | LanguageModelV4ToolCall;

export type LanguageModelV4FinishReason = {
  unified:
    | "stop"
    | "length"
    | "content-filter"
    | "tool-calls"
    | "error"
    | "other";
  raw: string | undefined;
};
export type LanguageModelV4Usage = {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
};
type Warning =
  | { type: "unsupported"; feature: string; details?: string }
  | { type: "compatibility"; feature: string; details?: string }
  | { type: "other"; message: string };

export type LanguageModelV4GenerateResult = {
  content: LanguageModelV4Content[];
  finishReason: LanguageModelV4FinishReason;
  usage: LanguageModelV4Usage;
  warnings: Warning[];
  providerMetadata?: ProviderMetadata;
  request?: { body?: unknown };
  response?: { id?: string; timestamp?: Date; modelId?: string };
};

export type LanguageModelV4FunctionTool = {
  type: "function";
  name: string;
  description?: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  strict?: boolean;
  providerOptions?: ProviderOptions;
};

type ToolResultOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: JSONValue }
  | { type: "execution-denied"; reason?: string }
  | { type: "error-text"; value: string }
  | { type: "error-json"; value: JSONValue }
  | { type: "content"; value: { type: "text"; text: string }[] };
type Part<T> = T & { providerOptions?: ProviderOptions };
export type LanguageModelV4Message = (
  | { role: "system"; content: string }
  | { role: "user"; content: Part<{ type: "text"; text: string }>[] }
  | {
      role: "assistant";
      content: Part<
        | { type: "text"; text: string }
        | { type: "reasoning"; text: string }
        | {
            type: "tool-call";
            toolCallId: string;
            toolName: string;
            input: unknown;
            providerExecuted?: boolean;
          }
        | {
            type: "tool-result";
            toolCallId: string;
            toolName: string;
            output: ToolResultOutput;
          }
      >[];
    }
  | {
      role: "tool";
      content: Part<{
        type: "tool-result";
        toolCallId: string;
        toolName: string;
        output: ToolResultOutput;
      }>[];
    }
) & { providerOptions?: ProviderOptions };
export type LanguageModelV4Prompt = LanguageModelV4Message[];

export type LanguageModelV4CallOptions = {
  prompt: LanguageModelV4Prompt;
  maxOutputTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  responseFormat?:
    | { type: "text" }
    | {
        type: "json";
        schema?: Record<string, unknown>;
        name?: string;
        description?: string;
      };
  seed?: number;
  tools?: LanguageModelV4FunctionTool[];
  toolChoice?:
    | { type: "auto" }
    | { type: "none" }
    | { type: "required" }
    | { type: "tool"; toolName: string };
  reasoning?: string;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
  providerOptions?: ProviderOptions;
};

export type LanguageModelV4StreamPart =
  | { type: "stream-start"; warnings: Warning[] }
  | { type: "text-start"; id: string; providerMetadata?: ProviderMetadata }
  | {
      type: "text-delta";
      id: string;
      delta: string;
      providerMetadata?: ProviderMetadata;
    }
  | { type: "text-end"; id: string; providerMetadata?: ProviderMetadata }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | LanguageModelV4ToolCall
  | {
      type: "response-metadata";
      id?: string;
      timestamp?: Date;
      modelId?: string;
    }
  | {
      type: "finish";
      finishReason: LanguageModelV4FinishReason;
      usage: LanguageModelV4Usage;
      providerMetadata?: ProviderMetadata;
    }
  | { type: "error"; error: unknown };
export type LanguageModelV4StreamResult = {
  stream: ReadableStream<LanguageModelV4StreamPart>;
  request?: { body?: unknown };
  response?: { headers?: Record<string, string> };
};

export type LanguageModelV4 = {
  readonly specificationVersion: "v4";
  readonly provider: string;
  readonly modelId: string;
  supportedUrls:
    | Record<string, RegExp[]>
    | PromiseLike<Record<string, RegExp[]>>;
  doGenerate(
    options: LanguageModelV4CallOptions,
  ): PromiseLike<LanguageModelV4GenerateResult>;
  doStream(
    options: LanguageModelV4CallOptions,
  ): PromiseLike<LanguageModelV4StreamResult>;
};
