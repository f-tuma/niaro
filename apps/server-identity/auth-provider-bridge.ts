import { createRemoteJWKSet } from "jose";
import { AsyncLocalStorage } from "node:async_hooks";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import {
  createAuthMiddleware,
  addOAuthServerContext,
  getOAuthState,
  getSessionFromCtx,
  APIError,
} from "better-auth/api";
import { google, microsoft, github } from "better-auth/social-providers";
import {
  verifyProviderIdToken,
  type OAuthProvider,
} from "@better-auth/core/oauth2";
import {
  AuthProviderStore,
  type AuthProviderFlow,
  type AuthProviderSnapshot,
} from "./auth-providers";

/** Reasons a provider sign-in can tell the person; everything else stays generic. */
const SHOWN_FAILURES = new Set([
  "invitation_account_mismatch",
  "auth_provider_link_required",
  "auth_provider_account_conflict",
]);
/**
 * Set around one OAuth callback by the HTTP layer. A profile rejection that
 * the person can fix records its code here so the redirect can name it
 * instead of a generic failure. Never carries provider data.
 */
export const providerCallbackOutcome = new AsyncLocalStorage<{
  reason?: string;
}>();
const denied = () =>
  new APIError("FORBIDDEN", {
    code: "auth_provider_flow_invalid",
    message: "The authentication flow is no longer valid",
  });
async function flowId() {
  const id = (await getOAuthState())?.serverContext?.authProviderFlowId;
  if (typeof id !== "string") throw denied();
  return id;
}
async function bounded<T>(
  run: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(denied()), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const withoutCredentials = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};
export function nativeFactory(row: AuthProviderSnapshot): OAuthProvider {
  const common = {
    clientId: row.clientId,
    clientSecret: row.clientSecret,
    disableSignUp: true,
    disableImplicitSignUp: true,
  };
  if (row.kind === "google")
    return google({
      ...common,
      ...(row.hostedDomain ? { hd: row.hostedDomain } : {}),
    });
  if (row.kind === "microsoft") {
    const provider = microsoft({
      ...common,
      tenantId: row.tenantId!,
      disableProfilePhoto: true,
      disableDefaultScope: true,
      scope: ["openid", "profile", "email"],
    });
    // Microsoft's RSA JWKs omit alg. Use JOSE's resolver, which imports
    // keys with the verified JWT header algorithm and handles key rotation.
    return {
      ...provider,
      idToken: {
        ...provider.idToken,
        algorithms: ["RS256"],
        jwks: createRemoteJWKSet(
          new URL(
            `https://login.microsoftonline.com/${row.tenantId}/discovery/v2.0/keys`,
          ),
          { timeoutDuration: 5000 },
        ),
      },
    };
  }
  return github(common);
}

/** Immutable native-provider snapshot. Rebuild after registry writes, sharing the
 * same store/DB/secret. The caller must serialize handlers with registry/session
 * mutations; per-provider I/O is time bounded but currently holds that queue.
 * runStart is server-only and MUST surround a strictly sanitized start request.
 */
export function createAuthProviderBridge(
  store: AuthProviderStore,
  options: {
    /** Dependency injection for synthetic tests; never expose as an admin setting. */
    factory?: (row: AuthProviderSnapshot) => OAuthProvider;
    timeoutMs?: number;
  } = {},
) {
  const starts = new AsyncLocalStorage<AuthProviderFlow>();
  const snapshot = store.snapshot();
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 15_000, 20_000));
  const socialProviders = snapshot.map((row): OAuthProvider => {
    const native = (options.factory ?? nativeFactory)(row);
    const isOIDC = row.kind !== "github";
    const provider: OAuthProvider = {
      ...native,
      id: row.id,
      name: row.name,
      disableImplicitSignUp: true,
      options: { ...native.options, disableSignUp: true },
      ...(isOIDC ? { requiresIdTokenNonce: true } : {}),
      async createAuthorizationURL(data) {
        const url = await native.createAuthorizationURL(data);
        if (isOIDC) {
          if (!data.idTokenNonce) throw denied();
          url.searchParams.set("nonce", data.idTokenNonce);
        }
        return url;
      },
      async validateAuthorizationCode(data) {
        const id = await flowId();
        store.claimFlow(id, row.id, row.revision);
        const result = await bounded(
          () => native.validateAuthorizationCode(data),
          timeoutMs,
        );
        store.validateFlow(id, row.id);
        return result;
      },
      async getUserInfo(tokens) {
        let stage = "validate-flow";
        let emailPresent = false;
        try {
          const id = await flowId();
          const flow = store.validateFlow(id, row.id);
          if (flow.phase !== "exchanging") throw denied();
          stage = "verify-id-token";
          const result = await bounded(async () => {
            if (
              isOIDC &&
              (!tokens.idToken ||
                !tokens.expectedIdTokenNonce ||
                !(await verifyProviderIdToken(
                  native,
                  tokens.idToken,
                  tokens.expectedIdTokenNonce,
                )))
            )
              throw denied();
            stage = "read-profile";
            return native.getUserInfo(tokens);
          }, timeoutMs);
          if (!result) throw denied();
          emailPresent = Boolean(result.user.email);
          stage = "resolve-subject";
          const rawSubject = await native.accountSubject({
            tokens,
            profile: result.data,
          });
          if (
            (typeof rawSubject !== "string" &&
              typeof rawSubject !== "number") ||
            (typeof rawSubject === "number" && !Number.isFinite(rawSubject))
          )
            throw denied();
          stage = "verify-invitation-or-link";
          const verified = store.verifyFlow(
            id,
            row.id,
            String(rawSubject),
            result.user,
          );
          // Microsoft may omit email. The authenticated linker or already-linked
          // subject selects the local user; email is never used to select one.
          return {
            ...result,
            user: {
              ...result.user,
              email: verified.invitationId
                ? store.localEmail(verified.userId!)
                : (result.user.email ?? store.localEmail(verified.userId!)),
            },
          };
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "";
          const outcome = providerCallbackOutcome.getStore();
          if (outcome && SHOWN_FAILURES.has(code)) outcome.reason = code;
          // Deliberately excludes tokens, profile values, email and exception text.
          console.warn("Auth provider profile rejected", {
            provider: row.kind,
            stage,
            emailPresent,
          });
          return null;
        }
      },
    };
    return Object.freeze(provider);
  });
  const plugin: BetterAuthPlugin = {
    id: "agent-auth-provider-registry",
    init: () => ({ context: { socialProviders } }),
  };
  const bridgeOptions = {
    account: {
      encryptOAuthTokens: true,
      updateAccountOnSignIn: true,
      storeStateStrategy: "database",
      skipStateCookieCheck: false,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        // Explicit linking proves both the current local session and provider
        // subject. The two accounts need not use the same mutable email.
        allowDifferentEmails: true,
        allowUnlinkingAll: false,
        updateUserInfoOnLink: false,
      },
    },
    advanced: { cookies: { state: { attributes: { sameSite: "lax" } } } },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!["/sign-in/social", "/link-social"].includes(ctx.path)) return;
        const intent = starts.getStore();
        const mode = ctx.path === "/link-social" ? "link" : "sign-in";
        if (
          !intent ||
          ctx.body?.provider !== intent.providerId ||
          ctx.body?.idToken ||
          ctx.body?.requestSignUp ||
          ctx.body?.scopes ||
          ctx.body?.additionalData ||
          ctx.body?.additionalParams
        )
          throw denied();
        const flow = store.startFlow(intent.id, mode, intent.providerId);
        if (flow.mode === "link") {
          const session = await getSessionFromCtx(ctx, {
            disableCookieCache: true,
          });
          if (
            !session ||
            session.user.id !== flow.actor?.userId ||
            session.session.id !== flow.actor?.sessionId
          )
            throw denied();
        }
        await addOAuthServerContext({ authProviderFlowId: flow.id });
        const returnUrl = new URL(flow.returnPath, store.baseURL);
        const oauthQuery =
          returnUrl.pathname === "/admin/mcp/consent"
            ? returnUrl.search.slice(1)
            : undefined;
        return {
          context: {
            body: {
              provider: flow.providerId,
              disableRedirect: true,
              callbackURL: `${store.baseURL}${flow.returnPath}`,
              errorCallbackURL: `${store.baseURL}${flow.returnPath}`,
              ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
            },
          },
        };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (!ctx.path.startsWith("/callback/")) return;
        const id = (await getOAuthState())?.serverContext?.authProviderFlowId;
        if (typeof id === "string") store.fail(id);
      }),
    },
    user: {
      async validateUserInfo({ user, source }, ctx) {
        if (source.method !== "oauth") return;
        try {
          if (source.action === "create-user") throw denied();
          const id = await flowId();
          const flow = store.assertVerified(
            id,
            typeof user.id === "string" ? user.id : undefined,
            source.oauth?.providerId,
          );
          if (source.action === "link-account") {
            const state = await getOAuthState();
            if (
              flow.mode !== "link" ||
              !state?.link ||
              state.link.userId !== flow.actor?.userId ||
              user.id !== flow.actor?.userId
            )
              throw denied();
            // Mutable Microsoft email is not account ownership proof. Only this
            // verified, session-bound explicit link may bypass emailVerified.
            ctx.context.trustedProviders = [
              ...ctx.context.trustedProviders,
              flow.providerId,
            ];
          } else if (flow.mode !== "sign-in" || source.action !== "sign-in")
            throw denied();
        } catch {
          return { error: "auth_provider_flow_invalid" };
        }
      },
    },
    databaseHooks: {
      account: {
        create: {
          async before(account) {
            if (!account.providerId.startsWith("ap_")) return;
            store.assertVerified(
              await flowId(),
              account.userId,
              account.providerId,
              account.accountId,
            );
            return { data: { ...account, ...withoutCredentials } };
          },
          async after(account) {
            if (!account.providerId.startsWith("ap_")) return;
            const id = await flowId();
            const flow = store.assertVerified(
              id,
              account.userId,
              account.providerId,
              account.accountId,
            );
            if (flow.mode === "link") store.complete(id);
          },
        },
        update: {
          async before(account) {
            if (!account.providerId?.startsWith("ap_")) return;
            store.assertVerified(
              await flowId(),
              account.userId,
              account.providerId,
              account.accountId,
            );
            return { data: { ...account, ...withoutCredentials } };
          },
          async after(account) {
            if (!account.providerId.startsWith("ap_")) return;
            const id = await flowId();
            const flow = store.assertVerified(
              id,
              account.userId,
              account.providerId,
              account.accountId,
            );
            if (flow.mode === "link") store.complete(id);
          },
        },
      },
      session: {
        create: {
          async before(session, ctx) {
            if (!ctx?.path.startsWith("/callback/")) return;
            const flow = store.assertVerified(await flowId(), session.userId);
            if (flow.mode !== "sign-in") throw denied();
          },
          async after(session, ctx) {
            if (!ctx?.path.startsWith("/callback/")) return;
            const id = await flowId();
            store.assertVerified(id, session.userId);
            store.complete(id);
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
  return {
    plugin,
    options: bridgeOptions,
    runStart<T>(flow: AuthProviderFlow, run: () => Promise<T>): Promise<T> {
      store.validateFlow(flow.id, flow.providerId);
      return starts.run(flow, run);
    },
  };
}
