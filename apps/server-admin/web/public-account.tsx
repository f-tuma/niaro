import { AccountProviderLinks } from "./account-providers";
import { useEffect, useState } from "react";
import { Check, KeyRound, Mail, Smartphone } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../../../packages/protocol/identity";
import { api, ApiError, authApi } from "./lib/api";
import { cs, en, failureText, redirectFailure } from "./public-account-copy";
import { ProviderSignIn } from "./provider-sign-in";
import { AuthLayout } from "@admin/components/console/auth-layout";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import { Skeleton } from "@admin/components/ui/skeleton";
import { SubmitButton } from "@admin/components/console/forms";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@admin/components/ui/select";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Spinner } from "@admin/components/ui/spinner";

/** No console session here: use the stored console choice, else the browser. */
function pageLanguage(): "en" | "cs" {
  try {
    const stored = localStorage.getItem("agent-admin-language");
    if (stored === "cs" || stored === "en") return stored;
  } catch {
    /* Storage can be unavailable; fall back to the browser language. */
  }
  return navigator.language.toLowerCase().startsWith("cs") ? "cs" : "en";
}

function Identity({ label, email }: { label: string; email?: string }) {
  if (!email) return null;
  return (
    <p className="text-center text-sm text-muted-foreground">
      {label} <span className="font-medium text-foreground">{email}</span>
    </p>
  );
}

/** End-user authentication surface. Never mounts console navigation or requests its overview. */
/**
 * Reads the one-time token in the link's fragment once, then removes it from
 * the address bar and the history entry so it is not left behind.
 */
function useFragmentToken() {
  const [token] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    if (window.location.hash)
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
  }, []);
  return token;
}

export function PublicAccount() {
  return window.location.pathname.endsWith("/reset") ? (
    <PasswordReset />
  ) : (
    <SignInAndInvite />
  );
}

function SignInAndInvite() {
  const [language] = useState(pageLanguage);
  const copy = language === "cs" ? cs : en;
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const client = useQueryClient();
  const invite = window.location.pathname.endsWith("/invite");
  const token = useFragmentToken();
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState("");
  const [org, setOrg] = useState(""),
    [workspace, setWorkspace] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(() =>
      redirectFailure(window.location.search, copy, invite),
    ),
    [done, setDone] = useState(false),
    [signInInstead, setSignInInstead] = useState(false);
  const identity = useQuery({
    queryKey: ["public-account"],
    queryFn: async () => IdentityStateSchema.parse(await api("identity")),
  });
  const invitation = useQuery({
    queryKey: ["invitation", token],
    enabled: invite && !!token,
    queryFn: async () =>
      z
        .object({
          email: z.email(),
          workspace: z.string(),
          // Absent for a copied link: the page offers both ways in.
          existing: z.boolean().optional(),
          organizationId: z.string(),
          matching: z.boolean(),
        })
        .parse(await api("identity/invitation", { token })),
  });
  const organizations = identity.data?.organizations ?? [];
  const organizationId = org || organizations[0]?.id;
  const detail = useQuery({
    queryKey: ["public-workspaces", organizationId],
    enabled: !!organizationId && !invite,
    queryFn: async () =>
      OrganizationDetailSchema.parse(
        await api(
          `identity/organization?id=${encodeURIComponent(organizationId!)}`,
        ),
      ),
  });
  const workspaceId = workspace || detail.data?.workspaces[0]?.id;
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      // The address already has an account: continue with its sign-in.
      if (
        failure instanceof ApiError &&
        failure.code === "invitation_sign_in_required"
      )
        setSignInInstead(true);
      setError(
        failure instanceof ApiError && failure.status === 401
          ? copy.wrongPassword
          : failureText(failure, copy, copy.continueFailed),
      );
    } finally {
      setBusy(false);
    }
  }
  async function signIn() {
    await authApi("sign-in/email", {
      email: invitation.data?.email ?? email,
      password,
    });
    setPassword("");
    await client.invalidateQueries({ queryKey: ["public-account"] });
    await client.invalidateQueries({ queryKey: ["invitation"] });
  }
  async function accept() {
    await api("identity/invitation", {
      token,
      accept: true,
      ...(!invitation.data?.existing && !signInInstead
        ? { name, password }
        : {}),
    });
    setPassword("");
    setDone(true);
    window.history.replaceState(null, "", window.location.pathname);
  }
  async function connect() {
    const result = z
      .object({ code: z.string(), state: z.string(), target: z.string() })
      .parse(
        await api("identity/app/consent", {
          id: token,
          organizationId,
          workspaceId,
        }),
      );
    setDone(true);
    window.history.replaceState(null, "", window.location.pathname);
    if (result.target === "agentclient://auth")
      window.location.assign(
        `agentclient://auth?code=${encodeURIComponent(result.code)}&state=${encodeURIComponent(result.state)}`,
      );
    else if (window.opener) {
      window.opener.postMessage(
        { type: "agent-app-login", code: result.code, state: result.state },
        result.target,
      );
      window.close();
    } else setError(copy.reopen);
  }
  const signOut = () =>
    void run(async () => {
      await authApi("sign-out", {});
      await client.invalidateQueries({ queryKey: ["public-account"] });
      client.removeQueries({ queryKey: ["public-workspaces"] });
    });
  if (done)
    return (
      <AuthLayout
        icon={<Check />}
        title={invite ? copy.inviteAccepted : copy.signedIn}
        description={invite ? copy.inviteAcceptedHint : copy.returnToApp}
      >
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </AuthLayout>
    );
  const loginNeeded =
    !identity.data?.user ||
    (invite &&
      (invitation.data?.existing || signInInstead) &&
      !invitation.data?.matching);
  const newAccount =
    invite &&
    invitation.data &&
    invitation.data.existing !== true &&
    !signInInstead;
  const signedIn = !!identity.data?.user && !loginNeeded;
  return (
    <AuthLayout
      icon={invite ? <Mail /> : <Smartphone />}
      title={invite ? copy.inviteTitle : copy.appTitle}
      description={
        invitation.data?.workspace ?? (
          <span className="font-mono text-xs">{window.location.host}</span>
        )
      }
      footer={
        signedIn && (
          <Button variant="link" size="sm" disabled={busy} onClick={signOut}>
            {copy.otherAccount}
          </Button>
        )
      }
    >
      {identity.isPending || (invite && invitation.isPending) ? (
        <div
          role="status"
          aria-label={copy.loading}
          className="flex flex-col gap-4"
        >
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {!token || invitation.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {failureText(invitation.error, copy, copy.invalidLink)}
              </AlertDescription>
            </Alert>
          ) : newAccount ? (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(accept);
                }}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="invite-email">{copy.email}</FieldLabel>
                    <Input
                      id="invite-email"
                      type="email"
                      autoComplete="username"
                      value={invitation.data.email}
                      readOnly
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="invite-name">{copy.name}</FieldLabel>
                    <Input
                      id="invite-name"
                      autoComplete="name"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="invite-password">
                      {copy.newPassword}
                    </FieldLabel>
                    <Input
                      id="invite-password"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={128}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <FieldDescription>{copy.passwordHint}</FieldDescription>
                  </Field>
                  <SubmitButton pending={busy}>{copy.accept}</SubmitButton>
                  {invitation.data.existing === undefined && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setError("");
                        setSignInInstead(true);
                      }}
                    >
                      {copy.haveAccount}
                    </Button>
                  )}
                </FieldGroup>
              </form>
              <ProviderSignIn
                language={language}
                disabled={busy}
                divider={copy.or}
                invitationToken={token}
                invitationOrganizationId={invitation.data.organizationId}
                organizationId={invitation.data.organizationId}
                returnHash={token ? `#${token}` : ""}
              />
            </>
          ) : loginNeeded ? (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(signIn);
                }}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="account-email">
                      {copy.email}
                    </FieldLabel>
                    <Input
                      id="account-email"
                      type="email"
                      autoComplete="username"
                      required
                      value={invitation.data?.email ?? email}
                      readOnly={!!invitation.data}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="account-password">
                      {copy.password}
                    </FieldLabel>
                    <Input
                      id="account-password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                  <SubmitButton pending={busy}>{copy.signIn}</SubmitButton>
                </FieldGroup>
              </form>
              <ProviderSignIn
                language={language}
                disabled={busy}
                divider={copy.or}
                invitationToken={invite ? token : undefined}
                invitationOrganizationId={invitation.data?.organizationId}
                returnHash={token ? `#${token}` : ""}
              />
            </>
          ) : invite ? (
            <>
              <Identity
                label={copy.signingInAs}
                email={identity.data?.user?.email}
              />
              <Button disabled={busy} onClick={() => void run(accept)}>
                {busy && <Spinner data-icon="inline-start" />}
                {copy.accept}
              </Button>
            </>
          ) : (
            <>
              <Identity
                label={copy.signingInAs}
                email={identity.data?.user?.email}
              />
              <AccountProviderLinks
                language={language}
                userId={identity.data?.user?.id}
                organizationId={organizationId}
                returnPath={
                  window.location.pathname + (token ? `#${token}` : "")
                }
              />
              <FieldGroup>
                {organizations.length > 1 && (
                  <Field>
                    <FieldLabel htmlFor="app-organization">
                      {copy.organization}
                    </FieldLabel>
                    <Select
                      value={organizationId}
                      onValueChange={(v) => {
                        setOrg(v);
                        setWorkspace("");
                      }}
                    >
                      <SelectTrigger id="app-organization" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {organizations.map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
                {!!detail.data?.workspaces.length && (
                  <Field>
                    <FieldLabel htmlFor="app-workspace">
                      {copy.workspace}
                    </FieldLabel>
                    <Select value={workspaceId} onValueChange={setWorkspace}>
                      <SelectTrigger id="app-workspace" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {detail.data.workspaces.map((w) => (
                          <SelectItem key={w.id} value={w.id}>
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
                {!detail.isPending && !workspaceId && (
                  <Alert>
                    <AlertDescription>{copy.noWorkspace}</AlertDescription>
                  </Alert>
                )}
                <Button
                  disabled={
                    busy || !workspaceId || detail.isPending || detail.isError
                  }
                  onClick={() => void run(connect)}
                >
                  {busy && <Spinner data-icon="inline-start" />}
                  {copy.continue}
                </Button>
              </FieldGroup>
            </>
          )}
        </>
      )}
    </AuthLayout>
  );
}

/** `/account/reset#token`: a one-time link from an administrator sets a new password. */
function PasswordReset() {
  const [language] = useState(pageLanguage);
  const copy = language === "cs" ? cs : en;
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const token = useFragmentToken();
  const [password, setPassword] = useState(""),
    [repeat, setRepeat] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  const reset = useQuery({
    queryKey: ["password-reset", token],
    enabled: /^[A-Za-z0-9_-]{43}$/.test(token),
    queryFn: async () =>
      z
        .object({ email: z.email() })
        .parse(await api("identity/account/reset", { token })),
  });
  async function save() {
    if (busy) return;
    if (password !== repeat) return setError(copy.mismatch);
    setBusy(true);
    setError("");
    try {
      await api("identity/account/reset", { token, password });
      setPassword("");
      setRepeat("");
      setDone(true);
      window.history.replaceState(null, "", window.location.pathname);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 400
          ? copy.shortPassword
          : failureText(failure, copy, copy.continueFailed),
      );
    } finally {
      setBusy(false);
    }
  }
  if (done)
    return (
      <AuthLayout
        icon={<Check />}
        title={copy.resetDone}
        description={copy.resetDoneHint}
      >
        <Button asChild>
          <a href="/">{copy.toSignIn}</a>
        </Button>
      </AuthLayout>
    );
  const invalid = !/^[A-Za-z0-9_-]{43}$/.test(token) || reset.isError;
  return (
    <AuthLayout
      icon={<KeyRound />}
      title={copy.resetTitle}
      description={
        reset.data?.email ?? (
          <span className="font-mono text-xs">{window.location.host}</span>
        )
      }
    >
      {invalid ? (
        <Alert variant="destructive">
          <AlertDescription>
            {failureText(reset.error, copy, copy.password_reset_invalid)}
          </AlertDescription>
        </Alert>
      ) : reset.isPending ? (
        <div
          role="status"
          aria-label={copy.loading}
          className="flex flex-col gap-4"
        >
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <FieldGroup>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <input
              type="email"
              autoComplete="username"
              value={reset.data.email}
              readOnly
              hidden
            />
            <Field>
              <FieldLabel htmlFor="reset-password">
                {copy.newPassword}
              </FieldLabel>
              <Input
                id="reset-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <FieldDescription>{copy.passwordHint}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="reset-repeat">
                {copy.repeatPassword}
              </FieldLabel>
              <Input
                id="reset-repeat"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </Field>
            <SubmitButton pending={busy}>{copy.resetSave}</SubmitButton>
          </FieldGroup>
        </form>
      )}
    </AuthLayout>
  );
}
