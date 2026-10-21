import { useEffect, useState } from "react";
import { Check, Laptop, ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  BrowserLoginCode,
  BrowserLoginDetails,
} from "../../../packages/protocol/browser-login";
import { useAdmin } from "./context";
import { useConsoleScope, ScopePicker } from "./console-scope";
import { api } from "./lib/api";
import { Button } from "@admin/components/ui/button";
import { Skeleton } from "@admin/components/ui/skeleton";
import { AuthLayout } from "@admin/components/console/auth-layout";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Field, FieldGroup, FieldLabel } from "@admin/components/ui/field";
import { Checkbox } from "@admin/components/ui/checkbox";
import { Input } from "@admin/components/ui/input";

const en = {
  title: "Connect your app",
  code: "Code from your app",
  check: "Continue",
  match: "This code matches my app.",
  hint: "Approve only sign-ins you started.",
  approve: "Connect app",
  deny: "Decline",
  done: "App connected",
  declined: "Sign-in declined",
  return: "Return to the app. You can close this page.",
  failed:
    "This request is no longer available. Start sign-in again in the app.",
  unavailable: "Sign in with a personal account that belongs to a workspace.",
  signOut: "Use another account",
  account: "Signing in as",
  loading: "Checking sign-in…",
  retry: "Try again",
};
const cs: typeof en = {
  title: "Připojit aplikaci",
  code: "Kód z aplikace",
  check: "Pokračovat",
  match: "Kód se shoduje s mou aplikací.",
  hint: "Potvrď jen přihlášení, které jsi zahájil.",
  approve: "Připojit aplikaci",
  deny: "Odmítnout",
  done: "Aplikace připojena",
  declined: "Přihlášení odmítnuto",
  return: "Vrať se do aplikace. Tuto stránku můžeš zavřít.",
  failed:
    "Tento požadavek už není dostupný. Začni přihlášení v aplikaci znovu.",
  unavailable: "Přihlas se osobním účtem, který patří do pracovního prostoru.",
  signOut: "Použít jiný účet",
  account: "Přihlašuješ se jako",
  loading: "Ověřuji přihlášení…",
  retry: "Zkusit znovu",
};
export function DeviceLogin({
  logout,
}: {
  logout(): Promise<boolean | undefined>;
}) {
  const { language, data } = useAdmin();
  const copy = language === "cs" ? cs : en;
  const scope = useConsoleScope();
  const [draft, setDraft] = useState(() => window.location.hash.slice(1));
  const [code, setCode] = useState(() =>
    BrowserLoginCode.safeParse(window.location.hash.slice(1)).success
      ? window.location.hash.slice(1)
      : "",
  );
  const [matched, setMatched] = useState(false);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expired, setExpired] = useState(false);
  const personal = data.authentication.current !== "admin-key";
  const details = useQuery({
    queryKey: ["admin", "device", data.authentication.principalId, code],
    queryFn: async ({ signal }) =>
      BrowserLoginDetails.parse(
        await api("identity/device/inspect", { userCode: code }, signal),
      ),
    enabled: personal && !!code && !switching && !done,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    if (!details.data) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(details.data.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [details.data]);
  async function consent(approve: boolean) {
    if (
      busy ||
      expired ||
      details.data?.status !== "pending" ||
      (approve && (!matched || !scope.ready))
    )
      return;
    setBusy(true);
    setFailed(false);
    try {
      await api("identity/device/consent", {
        userCode: code,
        approve,
        ...(approve
          ? {
              organizationId: scope.organization!.id,
              workspaceId: scope.workspace!.id,
            }
          : {}),
      });
      setDone(approve ? "approved" : "denied");
      window.history.replaceState(null, "", window.location.pathname);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  async function switchAccount() {
    if (details.isFetching || switching) return;
    setSwitching(true);
    setBusy(true);
    try {
      if (details.data?.status === "pending" && !expired)
        await api("identity/device/release", { userCode: code });
      if (!(await logout())) throw new Error("Sign out failed");
    } catch {
      setFailed(true);
      setSwitching(false);
    } finally {
      setBusy(false);
    }
  }
  const unavailable =
    failed ||
    expired ||
    details.isError ||
    (details.data && details.data.status !== "pending");
  const grouped = code.match(/.{1,4}/g)?.join(" ") ?? code;
  if (done)
    return (
      <AuthLayout
        icon={<Check />}
        title={copy[done === "approved" ? "done" : "declined"]}
        description={copy.return}
      />
    );
  return (
    <AuthLayout
      icon={<Laptop />}
      title={copy.title}
      description={copy.hint}
      footer={
        <Button
          variant="link"
          size="sm"
          disabled={busy || details.isFetching || switching}
          onClick={() => void switchAccount()}
        >
          {copy.signOut}
        </Button>
      }
    >
      {personal && scope.identity.data?.user && (
        <p className="text-center text-sm text-muted-foreground">
          {copy.account}{" "}
          <span className="font-medium text-foreground">
            {scope.identity.data.user.email}
          </span>
        </p>
      )}
      {!personal && (
        <Alert>
          <AlertDescription>{copy.unavailable}</AlertDescription>
        </Alert>
      )}
      {!code && personal && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const next = draft.toUpperCase().replace(/[\s-]/g, "");
            if (BrowserLoginCode.safeParse(next).success) setCode(next);
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="device-code">{copy.code}</FieldLabel>
              <Input
                id="device-code"
                autoComplete="off"
                maxLength={16}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              disabled={
                !BrowserLoginCode.safeParse(
                  draft.toUpperCase().replace(/[\s-]/g, ""),
                ).success
              }
            >
              {copy.check}
            </Button>
          </FieldGroup>
        </form>
      )}
      {code && personal && !unavailable && (
        <>
          <div className="flex flex-col items-center gap-1 rounded-lg bg-muted p-4">
            <span className="text-xs text-muted-foreground">{copy.code}</span>
            <span className="font-mono text-xl font-semibold tracking-widest">
              {grouped}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {window.location.host}
            </span>
          </div>
          {details.isPending ? (
            <div
              role="status"
              aria-label={copy.loading}
              className="flex flex-col gap-3"
            >
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <FieldGroup>
              <ScopePicker />
              {!scope.ready && !scope.detail.isPending && (
                <Alert>
                  <AlertDescription>{copy.unavailable}</AlertDescription>
                </Alert>
              )}
              <Field orientation="horizontal">
                <Checkbox
                  id="device-match"
                  checked={matched}
                  onCheckedChange={(value) => setMatched(value === true)}
                  disabled={busy}
                />
                <FieldLabel htmlFor="device-match">{copy.match}</FieldLabel>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  disabled={busy || !details.data}
                  onClick={() => void consent(false)}
                >
                  {copy.deny}
                </Button>
                <Button
                  disabled={busy || !scope.ready || !matched || !details.data}
                  onClick={() => void consent(true)}
                >
                  <ShieldCheck data-icon="inline-start" aria-hidden="true" />
                  {copy.approve}
                </Button>
              </div>
            </FieldGroup>
          )}
        </>
      )}
      {unavailable && (
        <Alert variant="destructive">
          <AlertDescription>{copy.failed}</AlertDescription>
        </Alert>
      )}
    </AuthLayout>
  );
}
