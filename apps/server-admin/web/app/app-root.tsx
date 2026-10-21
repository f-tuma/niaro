import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { MessagesSquare, RefreshCw } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import { AuthLayout } from "@admin/components/console/auth-layout";
import { SubmitButton } from "@admin/components/console/forms";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../../../../packages/protocol/identity";
import { api, ApiError, authApi } from "../lib/api";
import { resetDesignAuthority } from "../lib/design-authority";
import { UiLanguageContext } from "../context";
import { ProviderSignIn } from "../provider-sign-in";
import { AppContext, type AppContextValue, type AppWorkspace } from "./context";
import { appCopy } from "./copy";
import { useChatSession } from "./chat-session";
import { appRouter } from "./router";

const languageKey = "agent-admin-language";
const workspaceKey = "niaro:app-workspace";
function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Still usable for this page. */
  }
}
const browserLanguage = (): "en" | "cs" =>
  (read(languageKey) ??
    (navigator.language.toLowerCase().startsWith("cs") ? "cs" : "en")) === "cs"
    ? "cs"
    : "en";

/** The web app: sign in, pick a workspace, then chat and the personal menu. */
export function WebApp() {
  const [language, setLanguageState] = useState(browserLanguage);
  const setLanguage = useCallback((value: "en" | "cs") => {
    setLanguageState(value);
    write(languageKey, value);
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const copy = appCopy[language];
  const client = useQueryClient();
  const identity = useQuery({
    queryKey: ["app", "identity"],
    queryFn: async ({ signal }) =>
      IdentityStateSchema.parse(await api("identity", undefined, signal)),
    retry: false,
  });
  const signedOutError =
    identity.error instanceof ApiError &&
    (identity.error.status === 401 || identity.error.status === 403);
  // A fresh server: nobody has signed up, the first account becomes the owner.
  const setupOpen = useQuery({
    queryKey: ["app", "setup-open"],
    enabled: signedOutError,
    queryFn: async ({ signal }) => {
      const value = await api("auth-methods", undefined, signal);
      return !!value && typeof value === "object" && "setup" in value
        ? value.setup === true
        : false;
    },
    retry: false,
  });
  const organizations = identity.data?.organizations ?? [];
  const details = useQuery({
    queryKey: ["app", "workspaces", organizations.map((o) => o.id)],
    enabled: organizations.length > 0,
    queryFn: async ({ signal }) =>
      (
        await Promise.all(
          organizations.map(async (organization) => {
            const detail = OrganizationDetailSchema.parse(
              await api(
                `identity/organization?id=${encodeURIComponent(organization.id)}`,
                undefined,
                signal,
              ),
            );
            return detail.workspaces.map(
              (workspace): AppWorkspace => ({
                organizationId: organization.id,
                organizationName: organization.name,
                role: organization.role,
                workspaceId: workspace.id,
                name: workspace.name,
              }),
            );
          }),
        )
      ).flat(),
  });
  const { refetch } = identity;
  const signedOut = useCallback(() => {
    // Designer drafts kept in this tab belong to the session that ended.
    resetDesignAuthority();
    client.removeQueries({ queryKey: ["app"] });
    void refetch();
  }, [client, refetch]);
  const signOut = useCallback(() => {
    void authApi("sign-out", {})
      .catch(() => {})
      .finally(signedOut);
  }, [signedOut]);

  if (
    identity.isPending ||
    (organizations.length > 0 && details.isPending) ||
    (signedOutError && setupOpen.isPending)
  )
    return (
      <AuthLayout title={copy.loading}>
        <div
          role="status"
          aria-label={copy.loading}
          className="flex flex-col gap-3"
        >
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </AuthLayout>
    );
  if (signedOutError && setupOpen.data)
    return (
      <AuthLayout title={copy.setupTitle}>
        <Button asChild>
          <a href="/admin/">{copy.createOwner}</a>
        </Button>
      </AuthLayout>
    );
  if (signedOutError)
    return (
      <SignIn language={language} onSignedIn={() => void identity.refetch()} />
    );
  if (identity.error || details.error || !identity.data)
    return (
      <AuthLayout title={copy.unavailable}>
        <Button
          variant="outline"
          onClick={() => {
            void identity.refetch();
            void details.refetch();
          }}
        >
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          {copy.retry}
        </Button>
      </AuthLayout>
    );
  if (identity.data.needsSetup)
    return (
      <AuthLayout title={copy.setupTitle}>
        <Button asChild>
          <a href="/admin/">{copy.createOwner}</a>
        </Button>
      </AuthLayout>
    );
  const workspaces = details.data ?? [];
  if (!workspaces.length)
    return (
      <AuthLayout title={copy.noWorkspace} description={copy.noWorkspaceHint}>
        <Button variant="outline" onClick={signOut}>
          {copy.signOut}
        </Button>
      </AuthLayout>
    );
  return (
    <SignedIn
      language={language}
      setLanguage={setLanguage}
      identity={identity.data}
      workspaces={workspaces}
      onSignedOut={signedOut}
      signOut={signOut}
    />
  );
}

function SignedIn({
  language,
  setLanguage,
  identity,
  signOut,
  workspaces,
  onSignedOut,
}: Pick<
  AppContextValue,
  "language" | "setLanguage" | "identity" | "workspaces" | "signOut"
> & { onSignedOut: () => void }) {
  const [selected, setSelected] = useState(() => read(workspaceKey));
  const workspace =
    workspaces.find((value) => value.workspaceId === selected) ??
    workspaces[0]!;
  const chat = useChatSession(
    workspace.organizationId,
    workspace.workspaceId,
    onSignedOut,
  );
  const value = useMemo<AppContextValue>(
    () => ({
      language,
      setLanguage,
      identity,
      signOut,
      workspaces,
      workspace,
      selectWorkspace: (id) => {
        write(workspaceKey, id);
        setSelected(id);
      },
      isAdmin: workspace.role === "owner" || workspace.role === "admin",
      session: chat.session,
      sessionError: chat.error,
      reconnect: chat.reconnect,
    }),
    [
      language,
      setLanguage,
      identity,
      signOut,
      workspaces,
      workspace,
      chat.session,
      chat.error,
      chat.reconnect,
    ],
  );
  return (
    <AppContext.Provider value={value}>
      {/* Console components shown here (process pages) read the language. */}
      <UiLanguageContext.Provider value={language}>
        <RouterProvider router={appRouter} />
      </UiLanguageContext.Provider>
    </AppContext.Provider>
  );
}

function SignIn({
  language,
  onSignedIn,
}: {
  language: "en" | "cs";
  onSignedIn: () => void;
}) {
  const copy = appCopy[language];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"signInFailed" | "unavailable" | null>(
    null,
  );
  return (
    <AuthLayout title={copy.signInTitle} icon={<MessagesSquare />}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          setError(null);
          void authApi("sign-in/email", { email: email.trim(), password })
            .then(() => {
              setPassword("");
              onSignedIn();
            })
            .catch((cause) =>
              setError(
                cause instanceof ApiError &&
                  (cause.status === 401 || cause.status === 403)
                  ? "signInFailed"
                  : "unavailable",
              ),
            )
            .finally(() => setPending(false));
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="app-email">{copy.email}</FieldLabel>
            <Input
              id="app-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={pending}
              required
            />
          </Field>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="app-password">{copy.password}</FieldLabel>
            <Input
              id="app-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
              aria-invalid={!!error}
              aria-describedby={error ? "app-sign-in-error" : undefined}
              required
            />
            {error && (
              <FieldError id="app-sign-in-error">{copy[error]}</FieldError>
            )}
          </Field>
          <SubmitButton pending={pending} disabled={pending || !password}>
            {copy.signIn}
          </SubmitButton>
        </FieldGroup>
      </form>
      <ProviderSignIn
        language={language}
        disabled={pending}
        divider={copy.or}
      />
    </AuthLayout>
  );
}
