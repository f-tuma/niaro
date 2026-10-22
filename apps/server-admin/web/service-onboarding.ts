import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { AuthProvidersSchema } from "../../../packages/protocol/auth-providers";
import type {
  HostedOnboarding,
  HostedServer,
} from "../../../packages/protocol/hosted";
import {
  ServiceOAuthStatus,
  type ServiceOAuthSettings,
} from "../../../packages/protocol/service-oauth";
import { useAdmin } from "./context";
import { useHostedServers } from "./hosted-page";
import { api, ApiError } from "./lib/api";

type AuthProvider = z.infer<typeof AuthProvidersSchema>["providers"][number];
export type HostedSignIn = NonNullable<HostedOnboarding["signIn"]>;
export const OAuthStatusWithRedirect = ServiceOAuthStatus.extend({
  redirectUri: z.string().url(),
});

/** The organization's sign-in methods; shared by the service pages. */
export function useAuthProviders(organizationId: string) {
  const { data } = useAdmin();
  return useQuery({
    queryKey: [
      "admin",
      "auth-providers",
      data.authentication.principalId,
      organizationId,
    ],
    queryFn: async ({ signal }) =>
      AuthProvidersSchema.parse(
        await api("identity/auth-providers/list", { organizationId }, signal),
      ),
    enabled: !!organizationId,
  });
}

/** A built-in's onboarding comes from the shipped definition when the stored
 * one predates it. */
export function hostedOnboarding(
  server: HostedServer,
  builtins: { id: string; definition: HostedServer["definition"] }[],
): HostedOnboarding | undefined {
  return (
    server.definition.onboarding ??
    builtins.find((b) => b.id === server.builtin)?.definition.onboarding
  );
}

/** The hosted server a service points at, with its onboarding, if any. */
export function useHostedService(
  organizationId: string,
  url: string,
): { server: HostedServer; onboarding?: HostedOnboarding } | null {
  const hosted = useHostedServers(organizationId || undefined).data;
  const server = hosted?.servers.find((s) => s.url === url);
  return server
    ? { server, onboarding: hostedOnboarding(server, hosted!.builtins) }
    : null;
}

/** The enabled sign-in method of the kind the onboarding asks for. */
export function signInProvider(
  signIn: HostedSignIn,
  providers: AuthProvider[],
): AuthProvider | undefined {
  return providers.find((p) => p.enabled && p.kind === signIn.provider);
}

/** The service's personal sign-in as the onboarding describes it, through
 * `provider`. */
export function onboardingSettings(
  signIn: HostedSignIn,
  provider: AuthProvider,
): ServiceOAuthSettings {
  return {
    requiredFor: signIn.requiredFor,
    source: "provider",
    authProviderId: provider.id,
    ...(signIn.scopes.length ? { scopes: signIn.scopes } : {}),
  };
}

/** Saves the onboarding's personal sign-in on a service; resolves to the
 * server's error code when it refuses. */
export async function applySignIn(
  target: { organizationId: string; workspaceId: string },
  serviceId: string,
  settings: ServiceOAuthSettings,
): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    const status = OAuthStatusWithRedirect.parse(
      await api("identity/catalog/oauth/status", { ...target, serviceId }),
    );
    await api("identity/catalog/oauth/save", {
      ...target,
      serviceId,
      revision: status.config.revision,
      settings,
      client: {},
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof ApiError && error.code ? error.code : "request_failed",
    };
  }
}
