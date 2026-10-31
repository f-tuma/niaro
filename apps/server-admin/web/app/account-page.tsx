import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, Monitor, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import { Card, CardContent } from "@admin/components/ui/card";
import { Input } from "@admin/components/ui/input";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import { PageHeader, Section } from "@admin/components/console/page";
import {
  ConfirmAction,
  MoreActions,
  SubmitButton,
} from "@admin/components/console/forms";
import { StatusBadge } from "@admin/components/console/status";
import { RelativeTime } from "@admin/components/console/time";
import { api, ApiError } from "../lib/api";
import { AccessSchema, browserLabel, type Access } from "../lib/account-access";
import { useApp } from "./context";
import { MenuPage } from "./menu-page";
import { OutputVoiceSettings } from "./output-voice-settings";
import { ArchivedChats } from "./archived-chats";

const en = {
  title: "Account",
  password: "Password",
  current: "Current password",
  next: "New password",
  repeat: "New password again",
  hint: "At least 12 characters.",
  change: "Change password",
  changed:
    "Password changed. Your other browsers were signed out and your external AI apps were disconnected.",
  incorrect: "The current password isn't right.",
  mismatch: "The new passwords don't match.",
  tooShort: "The new password needs at least 12 characters.",
  limited: "Too many attempts. Wait a while and try again.",
  failed: "Something went wrong. Try again.",
  noPassword:
    "You sign in through a provider. For a password, ask an administrator for a reset link.",
  devices: "Devices",
  full: "You're at the limit. Remove a device you no longer use to sign in somewhere new.",
  of: "of",
  mobile: "Mobile app",
  chat: "Chat",
  noDevices: "No mobile devices yet.",
  lastActive: "last active",
  signedIn: "signed in",
  remove: "Remove",
  removeTitle: "Remove this device?",
  removeHint: "It's signed out and has to sign in again.",
  browsers: "Browsers",
  thisBrowser: "This browser",
  browser: "Browser",
  chatIn: "chat in",
  signOut: "Sign out",
  signOutTitle: "Sign this browser out?",
  signOutHint: "Whoever uses it has to sign in again.",
  everywhere: "Sign out everywhere",
  everywhereTitle: "Sign out everywhere?",
  everywhereHint:
    "Every browser and mobile app is signed out, this one too, and your external AI apps are disconnected. You'll sign in again here.",
  others: "Sign out other browsers",
  othersTitle: "Sign out other browsers?",
  othersHint: "This one stays signed in.",
  mcp: "External AI apps",
  more: "More",
  expires: "expires",
  neverUsed: "never used",
  lastUsed: "last used",
  revoke: "Revoke",
  revokeTitle: "Disconnect this app?",
  revokeHint: "The client stops working until you connect it again.",
  cancel: "Cancel",
  loadFailed: "Couldn't load your sign-ins.",
  retry: "Try again",
  loading: "Loading",
};
type Copy = typeof en;
const cs: Copy = {
  title: "Účet",
  password: "Heslo",
  current: "Současné heslo",
  next: "Nové heslo",
  repeat: "Nové heslo znovu",
  hint: "Aspoň 12 znaků.",
  change: "Změnit heslo",
  changed:
    "Heslo je změněné. Ostatní prohlížeče jsme odhlásili a externí AI aplikace jsme odpojili.",
  incorrect: "Současné heslo nesedí.",
  mismatch: "Nová hesla se neshodují.",
  tooShort: "Nové heslo musí mít aspoň 12 znaků.",
  limited: "Moc pokusů. Chvíli počkej a zkus to znovu.",
  failed: "Něco se nepovedlo. Zkus to znovu.",
  noPassword:
    "Přihlašuješ se přes poskytovatele. Heslo ti nastaví správce odkazem.",
  devices: "Zařízení",
  full: "Máš plno. Odeber zařízení, které už nepoužíváš, a pak se přihlas jinde.",
  of: "z",
  mobile: "Mobilní aplikace",
  chat: "Chat",
  noDevices: "Zatím žádné mobilní zařízení.",
  lastActive: "naposledy aktivní",
  signedIn: "přihlášeno",
  remove: "Odebrat",
  removeTitle: "Odebrat zařízení?",
  removeHint: "Odhlásí se a bude se muset přihlásit znovu.",
  browsers: "Prohlížeče",
  thisBrowser: "Tento prohlížeč",
  browser: "Prohlížeč",
  chatIn: "chat v",
  signOut: "Odhlásit",
  signOutTitle: "Odhlásit tenhle prohlížeč?",
  signOutHint: "Kdo ho používá, bude se muset přihlásit znovu.",
  everywhere: "Odhlásit všude",
  everywhereTitle: "Odhlásit všude?",
  everywhereHint:
    "Odhlásíme všechny prohlížeče i mobilní aplikace, i tenhle, a externí AI aplikace se odpojí. Tady se pak přihlásíš znovu.",
  others: "Odhlásit ostatní prohlížeče",
  othersTitle: "Odhlásit ostatní prohlížeče?",
  othersHint: "Tenhle zůstane přihlášený.",
  mcp: "Externí AI aplikace",
  more: "Další",
  expires: "vyprší",
  neverUsed: "zatím nepoužito",
  lastUsed: "naposledy použito",
  revoke: "Zrušit",
  revokeTitle: "Odpojit tuhle aplikaci?",
  revokeHint: "Klient přestane fungovat, dokud ho znovu nepřipojíš.",
  cancel: "Zrušit",
  loadFailed: "Přihlášení se nepodařilo načíst.",
  retry: "Zkusit znovu",
  loading: "Načítání",
};

/** The person's password, devices, browser sessions and archived chats.
 * Works without chat (the archive then stays out). */
export function AccountPage() {
  const { language, identity, signOut } = useApp();
  const copy = language === "cs" ? cs : en;
  const client = useQueryClient();
  const key = ["app", "account-access", identity.user?.id] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      AccessSchema.parse(
        await api("identity/account/access", { action: "list" }, signal),
      ),
    retry: false,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmEverywhere, setConfirmEverywhere] = useState(false);
  async function change(
    body: { action: "revoke"; id: string } | { action: "revokeOthers" },
  ) {
    setBusy(true);
    setError("");
    try {
      await api("identity/account/access", body);
    } catch {
      setError(copy.failed);
    } finally {
      setBusy(false);
      await client.invalidateQueries({ queryKey: key });
    }
  }
  const revoke = (id: string) => change({ action: "revoke", id });
  async function everywhere() {
    setBusy(true);
    setError("");
    try {
      await api("identity/account/access", { action: "revokeAll" });
    } catch {
      // Nothing confirmed the sign-out: say so and stay signed in here.
      setError(copy.failed);
      setBusy(false);
      return;
    }
    signOut();
  }
  return (
    <MenuPage>
      <PageHeader
        title={copy.title}
        description={[identity.user?.name, identity.user?.email]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <MoreActions label={copy.more}>
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              onSelect={() => setConfirmEverywhere(true)}
            >
              <LogOut aria-hidden="true" />
              {copy.everywhere}
            </DropdownMenuItem>
          </MoreActions>
        }
      />
      <ConfirmAction
        open={confirmEverywhere}
        onOpenChange={setConfirmEverywhere}
        title={copy.everywhereTitle}
        description={copy.everywhereHint}
        confirmLabel={copy.everywhere}
        cancelLabel={copy.cancel}
        onConfirm={everywhere}
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {query.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{copy.loadFailed}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {copy.retry}
            </Button>
          </AlertAction>
        </Alert>
      ) : query.isPending ? (
        <div role="status" aria-label={copy.loading}>
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <>
          <Section title={copy.password}>
            {query.data.hasPassword ? (
              <PasswordForm copy={copy} />
            ) : (
              <p className="text-sm text-muted-foreground">{copy.noPassword}</p>
            )}
          </Section>
          <Devices
            access={query.data}
            copy={copy}
            busy={busy}
            revoke={revoke}
          />
          <Browsers
            access={query.data}
            copy={copy}
            busy={busy}
            revoke={revoke}
            revokeOthers={() => change({ action: "revokeOthers" })}
            signOut={signOut}
          />
          {query.data.mcp.length > 0 && (
            <McpAccess
              access={query.data}
              copy={copy}
              busy={busy}
              revoke={revoke}
            />
          )}
        </>
      )}
      <OutputVoiceSettings />
      <ArchivedChats />
    </MenuPage>
  );
}

function PasswordForm({ copy }: { copy: Copy }) {
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [repeat, setRepeat] = useState(""),
    [pending, setPending] = useState(false),
    [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit() {
    if (pending) return;
    if (next !== repeat) {
      setResult({ ok: false, text: copy.mismatch });
      return;
    }
    setPending(true);
    setResult(null);
    try {
      // Direct request: passwords never enter a query or mutation cache.
      await api("identity/account/password", {
        currentPassword: current,
        newPassword: next,
      });
      setResult({ ok: true, text: copy.changed });
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (failure) {
      setResult({
        ok: false,
        text:
          failure instanceof ApiError
            ? failure.code === "password_incorrect"
              ? copy.incorrect
              : failure.status === 429
                ? copy.limited
                : failure.status === 400
                  ? copy.tooShort
                  : copy.failed
            : copy.failed,
      });
    } finally {
      setPending(false);
    }
  }
  return (
    <Card>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup>
            {result && (
              <Alert variant={result.ok ? "default" : "destructive"}>
                <AlertDescription>{result.text}</AlertDescription>
              </Alert>
            )}
            <Field>
              <FieldLabel htmlFor="account-current-password">
                {copy.current}
              </FieldLabel>
              <Input
                id="account-current-password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="account-new-password">
                {copy.next}
              </FieldLabel>
              <Input
                id="account-new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              <FieldDescription>{copy.hint}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="account-repeat-password">
                {copy.repeat}
              </FieldLabel>
              <Input
                id="account-repeat-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </Field>
            <SubmitButton pending={pending} className="self-start">
              {copy.change}
            </SubmitButton>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function RemoveButton({
  copy,
  busy,
  label,
  title,
  description,
  onConfirm,
}: {
  copy: Copy;
  busy: boolean;
  label: string;
  title: string;
  description: string;
  onConfirm: () => Promise<void>;
}) {
  return (
    <ConfirmAction
      trigger={
        <Button variant="outline" size="sm" disabled={busy}>
          {label}
        </Button>
      }
      title={title}
      description={description}
      confirmLabel={label}
      cancelLabel={copy.cancel}
      onConfirm={onConfirm}
    />
  );
}

function Devices({
  access,
  copy,
  busy,
  revoke,
}: {
  access: Access;
  copy: Copy;
  busy: boolean;
  revoke: (id: string) => Promise<void>;
}) {
  const rows = [
    ...access.devices.map((d) => ({
      id: d.id,
      title: copy.mobile,
      workspace: d.workspaceName,
      at: d.lastActiveAt,
      atLabel: copy.lastActive,
    })),
    ...access.sessions.map((s) => ({
      id: s.id,
      title: copy.chat,
      workspace: s.workspaceName,
      at: null,
      atLabel: "",
    })),
  ];
  return (
    <Section
      title={copy.devices}
      actions={
        <span className="text-sm text-muted-foreground tabular-nums">
          {access.used} {copy.of} {access.limit}
        </span>
      }
    >
      {access.used >= access.limit && (
        <Alert>
          <AlertDescription>{copy.full}</AlertDescription>
        </Alert>
      )}
      {rows.length ? (
        <Card variant="list">
          {rows.map((row) => (
            <Item key={row.id} variant="row" size="row">
              <ItemMedia variant="icon">
                <Smartphone aria-hidden="true" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{row.title}</ItemTitle>
                <ItemDescription>
                  {row.workspace}
                  {row.at !== null && (
                    <>
                      {row.workspace && " · "}
                      {row.atLabel} <RelativeTime value={row.at} />
                    </>
                  )}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <RemoveButton
                  copy={copy}
                  busy={busy}
                  label={copy.remove}
                  title={copy.removeTitle}
                  description={copy.removeHint}
                  onConfirm={() => revoke(row.id)}
                />
              </ItemActions>
            </Item>
          ))}
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.noDevices}</p>
      )}
    </Section>
  );
}

function Browsers({
  access,
  copy,
  busy,
  revoke,
  revokeOthers,
  signOut,
}: {
  access: Access;
  copy: Copy;
  busy: boolean;
  revoke: (id: string) => Promise<void>;
  revokeOthers: () => Promise<void>;
  signOut: () => void;
}) {
  const [confirmOthers, setConfirmOthers] = useState(false);
  // This browser first, then the others newest first.
  const browsers = [...access.browsers].sort(
    (a, b) => Number(b.current) - Number(a.current),
  );
  return (
    <Section
      title={copy.browsers}
      count={access.browsers.length}
      actions={
        browsers.some((browser) => !browser.current) && (
          <>
            <MoreActions label={copy.more} size="sm">
              <DropdownMenuItem
                variant="destructive"
                disabled={busy}
                onSelect={() => setConfirmOthers(true)}
              >
                <LogOut aria-hidden="true" />
                {copy.others}
              </DropdownMenuItem>
            </MoreActions>
            <ConfirmAction
              open={confirmOthers}
              onOpenChange={setConfirmOthers}
              title={copy.othersTitle}
              description={copy.othersHint}
              confirmLabel={copy.others}
              cancelLabel={copy.cancel}
              onConfirm={revokeOthers}
            />
          </>
        )
      }
    >
      <Card variant="list">
        {browsers.map((browser) => (
          <Item key={browser.id} variant="row" size="row">
            <ItemMedia variant="icon">
              <Monitor aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {browserLabel(browser.userAgent, copy.browser)}
                {browser.current && (
                  <StatusBadge tone="neutral">{copy.thisBrowser}</StatusBadge>
                )}
              </ItemTitle>
              <ItemDescription>
                {copy.signedIn} <RelativeTime value={browser.createdAt} />
                {browser.chats.length > 0 &&
                  ` · ${copy.chatIn} ${browser.chats.join(", ")}`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {browser.current ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={signOut}
                >
                  {copy.signOut}
                </Button>
              ) : (
                <RemoveButton
                  copy={copy}
                  busy={busy}
                  label={copy.signOut}
                  title={copy.signOutTitle}
                  description={copy.signOutHint}
                  onConfirm={() => revoke(browser.id)}
                />
              )}
            </ItemActions>
          </Item>
        ))}
      </Card>
    </Section>
  );
}

function McpAccess({
  access,
  copy,
  busy,
  revoke,
}: {
  access: Access;
  copy: Copy;
  busy: boolean;
  revoke: (id: string) => Promise<void>;
}) {
  return (
    <Section title={copy.mcp} count={access.mcp.length}>
      <Card variant="list">
        {access.mcp.map((grant) => (
          <Item key={grant.id} variant="row" size="row">
            <ItemMedia variant="icon">
              <KeyRound aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{grant.label}</ItemTitle>
              <ItemDescription>
                {grant.workspaceName && `${grant.workspaceName} · `}
                {grant.lastUsedAt === null ? (
                  copy.neverUsed
                ) : (
                  <>
                    {copy.lastUsed} <RelativeTime value={grant.lastUsedAt} />
                  </>
                )}
                {" · "}
                {copy.expires} <RelativeTime value={grant.expiresAt} />
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <RemoveButton
                copy={copy}
                busy={busy}
                label={copy.revoke}
                title={copy.revokeTitle}
                description={copy.revokeHint}
                onConfirm={() => revoke(grant.id)}
              />
            </ItemActions>
          </Item>
        ))}
      </Card>
    </Section>
  );
}
