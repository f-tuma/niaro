/**
 * Niaro's one Pi provider. Pi never reaches a model by itself: every request
 * goes through a call plan the host builds per request (the catalog model a
 * route resolves to under the admin model policy, its key, Niaro's guarded
 * integration transport with the budget ledger around it, and the dispatch
 * guard), and through nothing else. pi-ai's vendor adapters and `fetch` are
 * never used.
 *
 * Pi model ids are route keys of the model policy (`chat`, `checker`,
 * `service:<id>`, `preset:<id>`, `escalation`, ...), never catalog or vendor
 * model names, so a policy change applies to the next request.
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { RouteKey } from "../../../packages/protocol/model-policy";
import {
  completionFromStream,
  CompletionStream,
  isEventStream,
} from "../../server-integrations/chat-stream";
import { providerFailure } from "../../server-integrations/failures";
import {
  MODEL_CALL_LIMITS,
  type ModelCallLimits,
  type NiaroModelSelection,
} from "../../server-integrations/mastra-model";
import { providerHeaders } from "../../server-integrations/provider-request";
import {
  canStream,
  IntegrationError,
  jsonResponse,
  sameEndpoint,
  type DispatchGuard,
  type IntegrationTransport,
  type TransportResponse,
} from "../../server-integrations/transport";
import {
  assistantMessage,
  emptyUsage,
  NIARO_PI_API,
  requestBody,
  type DisplayPrice,
  type MessageHead,
} from "./openai-wire";

export const NIARO_PI_PROVIDER = "niaro";

/** One model request as the host sees it. */
export type PiModelCall = {
  /** The route key the conversation is configured with. */
  route: string;
  /** Pi's provider session of the conversation (`pi.provider`). */
  sessionId: string | undefined;
  signal: AbortSignal | undefined;
};
/** How one request reaches its model; built by the host for each request. */
export type PiCallPlan = {
  selection: NiaroModelSelection;
  /** Niaro's integration transport, already wrapped by the budget ledger. */
  transport: IntegrationTransport;
  /** Runs right before the first byte leaves (provider quota, authority). */
  beforeDispatch: DispatchGuard;
  limits?: ModelCallLimits;
  /** For Pi's own usage record only; the ledger settles from the provider's counts. */
  price?: DisplayPrice;
  /**
   * The next model of the route after a failure that provably never reached
   * its provider, when the route's fallback is on; otherwise undefined.
   */
  next?: (error: unknown) => Promise<PiCallPlan | undefined>;
};
export type PiModelHost = {
  plan(call: PiModelCall): Promise<PiCallPlan>;
};

/** The route keys every Niaro Pi provider offers. */
export const BASE_ROUTES: readonly RouteKey[] = [
  "chat",
  "background",
  "designer",
  "checker",
  "selector",
  "web_search",
  "escalation",
];
const ROUTE =
  /^(?:[a-z_]{1,32}|service:[A-Za-z0-9-]{1,64}|preset:[a-z][a-z0-9-]{0,31})$/;

/**
 * Model metadata of a route as Pi sees it. A route may resolve to different
 * catalog models per workspace and over time, so these are conservative
 * bounds for Pi's compaction; the real model is decided per request.
 */
function routeModel(route: string): Model<typeof NIARO_PI_API> {
  return {
    id: route,
    name: route,
    api: NIARO_PI_API,
    provider: NIARO_PI_PROVIDER,
    baseUrl: "niaro:",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64_000,
    maxTokens: 8_192,
  };
}

/**
 * Whether a failure is transient. Pi retries an attempt only when its error
 * text matches pi-ai's retryable patterns; refusals (budget, policy, quota,
 * invalid input) never do, so they fail the run at once.
 */
export function retryableFailure(error: unknown) {
  if (!(error instanceof IntegrationError)) return false;
  if (["integration_timeout", "integration_unavailable"].includes(error.code))
    return true;
  const status = error.failure?.httpStatus ?? 0;
  return (
    error.code === "integration_provider_failed" &&
    (status === 429 || status >= 500)
  );
}
/** The error text Pi records: a code, never provider text or a key. */
export function failureText(error: unknown) {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z0-9_]{1,80}$/.test(error.code)
      ? error.code
      : "niaro_model_call_failed";
  return retryableFailure(error)
    ? `${code}: model service temporarily unavailable`
    : code;
}

/** The completion body of a response, streamed or not; provider errors fail it. */
function completion(response: TransportResponse, key: string): unknown {
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

/** A plan's model must still be a usable chat model of its provider. */
function usable(selection: NiaroModelSelection) {
  const { provider, model } = selection;
  if (
    !provider.enabled ||
    !model.enabled ||
    model.providerId !== provider.id ||
    !["chat", "router"].includes(model.kind)
  )
    throw new IntegrationError("integration_model_unavailable", 409);
}

export type NiaroPiProvider = Provider & {
  /** Offer a route (a service's or a preset's) and return its Pi model ref. */
  route(key: string): { provider: string; modelId: string };
};

export function niaroPiProvider(
  host: PiModelHost,
  routes: Iterable<string> = BASE_ROUTES,
): NiaroPiProvider {
  const known = new Map<string, Model<typeof NIARO_PI_API>>();
  const offer = (key: string) => {
    if (!ROUTE.test(key))
      throw new IntegrationError("integration_model_unavailable", 409);
    if (!known.has(key)) known.set(key, routeModel(key));
  };
  for (const key of routes) offer(key);

  const run = (
    model: Model<string>,
    context: TranscriptContext,
    options: (SimpleStreamOptions & StreamOptions) | undefined,
  ): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    const signal = options?.signal;
    const head: MessageHead = {
      api: NIARO_PI_API,
      provider: NIARO_PI_PROVIDER,
      model: model.id,
      timestamp: Date.now(),
    };
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      ...head,
      usage: emptyUsage(),
      stopReason: "pending",
    };
    let streamed = "";
    const send = async (plan: PiCallPlan) => {
      usable(plan.selection);
      const { provider, model: catalogModel, key } = plan.selection;
      const url = sameEndpoint(
        provider.url,
        provider.url.replace(/\/$/, "") + "/chat/completions",
      ).href;
      const live = canStream(plan.transport)
        ? new CompletionStream()
        : undefined;
      let body: unknown = requestBody(catalogModel, context, {
        stream: !!live,
        toolChoice: options?.toolChoice,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
      });
      // Pi's `beforeProviderRequest` hooks may rewrite the body; the model
      // stays the one the policy chose.
      const replaced = await options?.onPayload?.(body, model);
      if (replaced && typeof replaced === "object" && !Array.isArray(replaced))
        body = { ...replaced, model: catalogModel.model };
      signal?.throwIfAborted();
      const response = await plan.transport({
        url,
        method: "POST",
        headers: providerHeaders(provider, key),
        body,
        signal,
        ...(plan.limits ?? MODEL_CALL_LIMITS.chat),
        beforeDispatch: plan.beforeDispatch,
        ...(live && {
          onEvent: (data: string) => {
            if (!live.push(data)) return;
            const delta = live.reply.slice(streamed.length);
            if (!delta) return;
            if (!streamed) {
              partial.content.push({ type: "text", text: "" });
              out.push({ type: "text_start", contentIndex: 0, partial });
            }
            streamed = live.reply;
            (partial.content[0] as { text: string }).text = streamed;
            out.push({ type: "text_delta", contentIndex: 0, delta, partial });
          },
        }),
      });
      signal?.throwIfAborted();
      return assistantMessage(completion(response, key), head, plan.price);
    };

    void (async () => {
      out.push({ type: "start", partial });
      try {
        let plan = await host.plan({
          route: model.id,
          sessionId: options?.sessionId,
          signal,
        });
        let message: AssistantMessage;
        for (;;) {
          try {
            message = await send(plan);
            break;
          } catch (error) {
            // Only a call that provably never left may move to the next model.
            const next = streamed ? undefined : await plan.next?.(error);
            if (!next) throw error;
            plan = next;
          }
        }
        for (const [index, part] of message.content.entries()) {
          if (part.type === "text") {
            if (index !== 0 || !streamed) {
              partial.content[index] = { type: "text", text: "" };
              out.push({ type: "text_start", contentIndex: index, partial });
            }
            partial.content[index] = part;
            out.push({
              type: "text_end",
              contentIndex: index,
              content: part.text,
              partial,
            });
          } else if (part.type === "toolCall") {
            partial.content[index] = part;
            out.push({ type: "toolcall_start", contentIndex: index, partial });
            out.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall: part,
              partial,
            });
          }
        }
        out.push({
          type: "done",
          reason: message.stopReason as "stop" | "length" | "toolUse",
          message,
        });
      } catch (error) {
        const aborted = !!signal?.aborted;
        out.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error: {
            ...partial,
            content: aborted ? partial.content : [],
            stopReason: aborted ? "aborted" : "error",
            errorMessage: aborted ? "aborted" : failureText(error),
          },
        });
      }
    })();
    return out;
  };

  return {
    id: NIARO_PI_PROVIDER,
    name: "Niaro",
    // Keys come from the catalog per request; Pi's own auth is a placeholder.
    auth: {
      apiKey: {
        name: "Niaro catalog",
        resolve: async () => ({ auth: { apiKey: "niaro-catalog" } }),
      },
    } as Provider["auth"],
    getModels: () => [...known.values()],
    stream: (model, context, options) =>
      run(model, context, options as SimpleStreamOptions),
    streamSimple: (model, context, options) => run(model, context, options),
    route(key: string) {
      offer(key);
      return { provider: NIARO_PI_PROVIDER, modelId: key };
    },
  };
}
