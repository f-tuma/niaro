import { useEffect, useRef, useState } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { DeviceLogin } from "./device-login";
import { ServiceConnect } from "./service-auth";
import { McpConsent } from "./mcp-consent";
import { readMcpOAuthQuery } from "./lib/mcp-oauth-query";

import { ProviderSignIn } from "./provider-sign-in";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { ConsoleShell } from "./console-shell";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import { AuthLayout } from "@admin/components/console/auth-layout";
import { SubmitButton } from "@admin/components/console/forms";
import { en, cs, type Copy } from "./i18n";
import { AdminContext } from "./context";
import { designAuthority, resetDesignAuthority } from "./lib/design-authority";
import {
  ApiError,
  authApi,
  api,
  errorMessage,
  loadOverview,
  mcpLoginRedirect,
  overviewKey,
} from "./lib/api";

function initialLanguage(): "en" | "cs" {
  try {
    return localStorage.getItem("agent-admin-language") === "cs" ? "cs" : "en";
  } catch {
    return "en";
  }
}
/** setTimeout's largest delay (2^31 - 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;

export function App() {
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [authorityReady, setAuthorityReady] = useState(true);
  const [authorityGeneration, setAuthorityGeneration] =
    useState(designAuthority);
  const devicePage = useRouterState({
    select: (state) =>
      ["/device", "/admin/device"].includes(
        state.location.pathname.replace(/\/$/, ""),
      ),
  });
  const serviceConnectPage = useRouterState({
    select: (state) =>
      ["/service-connect", "/admin/service-connect"].includes(
        state.location.pathname.replace(/\/$/, ""),
      ),
  });
  const mcpConsentPage = useRouterState({
    select: (state) =>
      ["/mcp/consent", "/admin/mcp/consent"].includes(
        state.location.pathname.replace(/\/$/, ""),
      ),
  });
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(
    null,
  );
  const [selectedOrganization, setSelectedOrganization] = useState<
    string | null
  >(null);
  const [language, setLanguage] = useState(initialLanguage);
  const copy = language === "cs" ? cs : en;
  const client = useQueryClient();
  const overview = useQuery({
    queryKey: overviewKey,
    queryFn: ({ signal }) => loadOverview(signal),
    staleTime: 30_000,
    refetchOnWindowFocus: "always",
  });
  const [action, setAction] = useState<"login" | "logout" | null>(null);
  const [actionError, setActionError] = useState<keyof Copy | null>(null);
  const methods = useQuery({
    queryKey: ["auth-methods"],
    queryFn: async () => {
      const value = await api("auth-methods");
      return (
        !!value &&
        typeof value === "object" &&
        "identity" in value &&
        value.identity === true
      );
    },
    staleTime: 30_000,
  });
  const [loginMode, setLoginMode] = useState<"key" | "account">("account");
  const useAccount = methods.data === true && loginMode === "account";
  const [email, setEmail] = useState("");
  const [key, setKey] = useState("");
  const request = useRef<AbortController | null>(null);
  const sessionChannel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("agent-admin-session");
    sessionChannel.current = channel;
    channel.onmessage = () => {
      setAuthorityReady(false);
      setAuthorityGeneration(resetDesignAuthority());
      request.current?.abort();
      setAction(null);
      setActionError(null);
      setKey("");
      setSelectedOrganization(null);
      void client.cancelQueries({ queryKey: ["admin"] }).then(() => {
        client.removeQueries({ queryKey: ["admin", "device"] });
        client.removeQueries({ queryKey: ["admin", "identity"] });
        client.removeQueries({ queryKey: ["admin", "organization"] });
        client.removeQueries({ queryKey: ["admin", "connections"] });
        client.removeQueries({ queryKey: ["admin", "mobile"] });
        client.removeQueries({ queryKey: ["admin", "audit"] });
        client.removeQueries({ queryKey: ["admin", "loops"] });
        client.removeQueries({ queryKey: ["admin", "ai"] });
        client.removeQueries({ queryKey: ["admin", "calendar"] });
        client.removeQueries({ queryKey: ["admin", "catalog"] });
        client.removeQueries({ queryKey: ["admin", "plugins"] });
        client.removeQueries({ queryKey: ["admin", "memory"] });
        client.removeQueries({ queryKey: ["admin", "processes"] });
        setSelectedWorkspace(null);
        client.setQueryData(overviewKey, null);
        setAuthorityReady(true);
        void client.invalidateQueries({ queryKey: overviewKey });
      });
    };
    return () => {
      sessionChannel.current = null;
      channel.close();
    };
  }, [client]);
  const data = overview.data;
  useEffect(() => {
    document.documentElement.lang = language;
    try {
      localStorage.setItem("agent-admin-language", language);
    } catch {
      /* Preference remains usable without storage. */
    }
  }, [language]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!data) return;
    const remaining = Date.parse(data.authentication.expiresAt) - Date.now();
    // Browsers fire a timer longer than ~24.8 days at once. A long account
    // session is re-read on focus and refresh instead, so only a near expiry
    // (the recovery key's short session) needs a timer here.
    if (remaining > MAX_TIMER_MS) return;
    const timer = setTimeout(
      () => {
        setAuthorityReady(false);
        setAuthorityGeneration(resetDesignAuthority());
        void client.cancelQueries({ queryKey: ["admin"] }).then(() => {
          client.removeQueries({ queryKey: ["admin", "device"] });
          client.removeQueries({ queryKey: ["admin", "identity"] });
          client.removeQueries({ queryKey: ["admin", "organization"] });
          client.removeQueries({ queryKey: ["admin", "connections"] });
          client.removeQueries({ queryKey: ["admin", "mobile"] });
          client.removeQueries({ queryKey: ["admin", "audit"] });
          client.removeQueries({ queryKey: ["admin", "loops"] });
          client.removeQueries({ queryKey: ["admin", "ai"] });
          client.removeQueries({ queryKey: ["admin", "calendar"] });
          client.removeQueries({ queryKey: ["admin", "catalog"] });
          client.removeQueries({ queryKey: ["admin", "plugins"] });
          client.removeQueries({ queryKey: ["admin", "memory"] });
          client.removeQueries({ queryKey: ["admin", "processes"] });
          setSelectedWorkspace(null);
          setSelectedOrganization(null);
          client.setQueryData(overviewKey, null);
          setActionError("authError");
        });
      },
      Math.max(0, remaining),
    );
    return () => clearTimeout(timer);
  }, [client, data]);
  async function authenticate(logout = false) {
    if (action) return;
    setAuthorityReady(false);
    setAuthorityGeneration(resetDesignAuthority());
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setAction(logout ? "logout" : "login");
    setActionError(null);
    const credentials = key.trim();
    setKey("");
    await client.cancelQueries({ queryKey: ["admin"] });
    try {
      let consentRedirect: string | null = null;
      // Keep the key out of Query's mutation cache and all persistent storage.
      if (!logout && useAccount) {
        const result = await authApi(
          "sign-in/email",
          {
            email: email.trim(),
            password: key,
            ...(mcpConsentPage ? { oauth_query: readMcpOAuthQuery() } : {}),
          },
          controller.signal,
        );
        if (mcpConsentPage)
          consentRedirect = mcpLoginRedirect(result, window.location.origin);
      } else
        await api(
          logout ? "logout" : "login",
          logout ? {} : { key: credentials },
          controller.signal,
        );
      client.removeQueries({ queryKey: ["admin", "device"] });
      client.removeQueries({ queryKey: ["admin", "identity"] });
      client.removeQueries({ queryKey: ["admin", "organization"] });
      client.removeQueries({ queryKey: ["admin", "connections"] });
      client.removeQueries({ queryKey: ["admin", "mobile"] });
      client.removeQueries({ queryKey: ["admin", "audit"] });
      client.removeQueries({ queryKey: ["admin", "loops"] });
      client.removeQueries({ queryKey: ["admin", "ai"] });
      client.removeQueries({ queryKey: ["admin", "calendar"] });
      client.removeQueries({ queryKey: ["admin", "catalog"] });
      client.removeQueries({ queryKey: ["admin", "plugins"] });
      client.removeQueries({ queryKey: ["admin", "memory"] });
      client.removeQueries({ queryKey: ["admin", "processes"] });
      setSelectedWorkspace(null);
      setSelectedOrganization(null);
      client.setQueryData(overviewKey, null);
      if (controller.signal.aborted) return false;
      if (consentRedirect) {
        window.location.replace(consentRedirect);
        return true;
      }
      if (!logout)
        await client.fetchQuery({
          queryKey: overviewKey,
          queryFn: ({ signal }) => loadOverview(signal),
          staleTime: 0,
        });
      return true;
    } catch (error) {
      if (!controller.signal.aborted) setActionError(errorMessage(error));
      return false;
    } finally {
      sessionChannel.current?.postMessage("changed");
      if (!controller.signal.aborted) setAction(null);
      if (!controller.signal.aborted) setAuthorityReady(true);
    }
  }
  const error =
    actionError ?? (overview.error ? errorMessage(overview.error) : null);
  const refresh = () => {
    setRefreshGeneration((n) => n + 1);
    setActionError(null);
    void client.invalidateQueries({ queryKey: ["admin"] });
  };
  const personalPage = devicePage || serviceConnectPage || mcpConsentPage;
  if (
    (overview.error instanceof ApiError &&
      overview.error.code === "admin_forbidden") ||
    (data && !data.authentication.console && !personalPage)
  )
    return (
      <AuthLayout
        title={language === "cs" ? "Pouze pro správce" : "Administrators only"}
        description={
          language === "cs"
            ? "Přihlas se v aplikaci."
            : "Sign in from the app instead."
        }
      >
        <Button onClick={() => void authenticate(true)}>
          {language === "cs" ? "Odhlásit" : "Sign out"}
        </Button>
      </AuthLayout>
    );
  if (!data)
    return (
      <AuthLayout
        title={copy.loginTitle}
        footer={
          methods.data && (
            <Button
              variant="link"
              size="sm"
              disabled={action !== null}
              onClick={() => {
                setLoginMode(useAccount ? "key" : "account");
                setKey("");
                setActionError(null);
              }}
            >
              {useAccount ? copy.useRecovery : copy.useAccount}
            </Button>
          )
        }
      >
        {overview.isPending || methods.isPending ? (
          <div
            role="status"
            aria-label={copy.loading}
            className="flex flex-col gap-4"
          >
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void authenticate();
              }}
            >
              <FieldGroup>
                {useAccount && (
                  <Field>
                    <FieldLabel htmlFor="admin-email">{copy.email}</FieldLabel>
                    <Input
                      id="admin-email"
                      type="email"
                      autoComplete="username"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      disabled={action !== null}
                      required
                    />
                  </Field>
                )}
                <Field data-invalid={error === "authError"}>
                  <FieldLabel htmlFor="admin-key">
                    {useAccount ? copy.password : copy.keyLabel}
                  </FieldLabel>
                  <Input
                    id="admin-key"
                    type="password"
                    autoComplete={useAccount ? "current-password" : "off"}
                    spellCheck={false}
                    placeholder={useAccount ? undefined : "acadmin_…"}
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    disabled={action !== null}
                    aria-invalid={error === "authError"}
                    aria-describedby={error ? "login-error" : undefined}
                    required
                  />
                  {error && (
                    <FieldError id="login-error">{copy[error]}</FieldError>
                  )}
                </Field>
                <SubmitButton
                  pending={action === "login"}
                  disabled={action !== null || !key.trim()}
                >
                  {copy.signIn}
                </SubmitButton>
              </FieldGroup>
            </form>
            {overview.error && (
              <Button
                variant="outline"
                onClick={refresh}
                disabled={overview.isFetching}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {copy.retry}
              </Button>
            )}
            {useAccount && (
              <ProviderSignIn
                language={language}
                disabled={action !== null}
                divider={copy.or}
              />
            )}
          </>
        )}
      </AuthLayout>
    );
  return (
    <AdminContext.Provider
      value={{
        data,
        authorityGeneration,
        refreshGeneration,
        copy,
        language,
        setLanguage,
        selectedOrganization,
        setSelectedOrganization: (id) => {
          setSelectedOrganization(id);
          setSelectedWorkspace(null);
        },
        selectedWorkspace,
        setSelectedWorkspace,
      }}
    >
      {devicePage ? (
        <DeviceLogin
          key={data.authentication.principalId}
          logout={() => authenticate(true)}
        />
      ) : serviceConnectPage ? (
        <ServiceConnect key={data.authentication.principalId} />
      ) : mcpConsentPage ? (
        authorityReady ? (
          <McpConsent
            key={`${authorityGeneration}:${data.authentication.principalId}`}
            logout={() => void authenticate(true)}
          />
        ) : (
          <Skeleton className="h-96 w-full" />
        )
      ) : (
        <ConsoleShell
          logout={() => void authenticate(true)}
          refresh={refresh}
          busy={action !== null}
          refreshing={overview.isFetching}
        >
          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                {copy[error]} {copy.stale}
              </AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" onClick={refresh}>
                  {copy.retry}
                </Button>
              </AlertAction>
            </Alert>
          )}
          {authorityReady ? <Outlet /> : <Skeleton className="h-96 w-full" />}
        </ConsoleShell>
      )}
    </AdminContext.Provider>
  );
}
