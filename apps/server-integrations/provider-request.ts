import type { Provider } from "../../packages/protocol/service-catalog";
import type {
  ProviderAuthValue,
  ProviderDialectValue,
} from "../../packages/protocol/providers";

type ProviderShape = Pick<Provider, "url"> & {
  auth?: ProviderAuthValue;
  dialect?: ProviderDialectValue;
};

/** Whether the provider speaks OpenRouter's additions; stored providers always carry a dialect. */
export const isOpenRouterDialect = (provider: ProviderShape) =>
  (provider.dialect ?? "openai") === "openrouter";
/** The stored key in the form the provider asked for; nothing without a key. */
export function providerHeaders(
  provider: ProviderShape,
  key: string,
): Record<string, string> {
  const auth = provider.auth ?? { type: "bearer" as const };
  if (!key || auth.type === "none") return {};
  return auth.type === "header"
    ? { [auth.header]: key }
    : { Authorization: `Bearer ${key}` };
}
/** An endpoint below the provider's base URL. */
export const providerEndpoint = (provider: ProviderShape, path: string) =>
  provider.url.replace(/\/$/, "") + path;
