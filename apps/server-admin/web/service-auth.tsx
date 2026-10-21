import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  KeyRound,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { z } from "zod";
import { AuthProvidersSchema } from "../../../packages/protocol/auth-providers";
import { Link } from "@tanstack/react-router";
import {
  ServiceOAuthStatus,
  type ServiceOAuthSettings,
} from "../../../packages/protocol/service-oauth";
import type { Service } from "../../../packages/protocol/service-catalog";
import { useAdmin } from "./context";
import { connectLimit, useServiceSetupCopy } from "./service-setup-copy";
import type { CatalogState } from "./catalog-shared";
import { api, ApiError } from "./lib/api";
import { Button } from "@admin/components/ui/button";
import { Card, CardContent } from "@admin/components/ui/card";
import {
  AlertAction,
  Alert,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import { Input } from "@admin/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@admin/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@admin/components/ui/tooltip";
import { Section } from "@admin/components/console/page";
import { SaveBar, SubmitButton } from "@admin/components/console/forms";
import { AuthLayout } from "@admin/components/console/auth-layout";

const en = {
  policyHint: "Never falls back to the shared credential.",
  source: "Sign-in with",
  sourceProvider: "Organization sign-in method",
  sourceService: "The service's own OAuth",
  provider: "Sign-in method",
  chooseProvider: "Choose Microsoft or Google",
  scopes: "Permissions",
  scopesProvider: "Separated by spaces. Sign-in scopes are added.",
  scopesService: "Empty uses api and profile.",
  redirectHint: "Add it to the sign-in method's app.",
  policy: "Personal sign-in",
  required: "When to require",
  none: "Never, use the shared credential",
  writes: "For changes",
  all: "For every action",
  signIn: "Required identity provider",
  service: "Service account only",
  manageProviders: "Manage authentication providers",
  setup: "Service OAuth",
  discover: "Detect OAuth",
  register: "Register Agent Server",
  registered: "Client configured",
  manual: "Existing OAuth client",
  clientId: "Client ID",
  clientSecret: "Client secret",
  stored: "Saved. Leave blank to keep.",
  redirect: "Redirect URL",
  save: "Save changes",
  saveFirst: "Unsaved changes",
  suggest: "Suggest settings",
  suggestion: "Personal OAuth is suitable. Apply the proposed policy?",
  apply: "Require personal account",
  manualSuggestion: "No adapter confirmed. Check the OAuth setup manually.",
  ready: "OAuth detected",
  notFound: "OAuth not found",
  pending: "An administrator needs to configure OAuth first.",
  error: "Request failed. Check the service settings and retry.",
  conflict: "Configuration changed. Reload it and try again.",
  invalidState:
    "This connection request expired or belongs to another session. Start again from the card in chat.",
  refresh: "Refresh",
  missingModel: "Enable a decision model in Routing first.",
  https: "Personal OAuth requires an HTTPS service URL.",
  mismatch:
    "You signed in with a different account than the one linked to your profile. Sign in with your own account and try again.",
  finish: "Connect service account",
  continueProvider: "Verify with",
  authorizeService: "Authorize service",
  returnApp: "Return to the app to continue your request.",
  finishButton: "Complete connection",
  done: "Service account connected",
  failed: "Connection unavailable",
  denied: "The service did not approve the connection.",
  cancelled: "You cancelled the sign-in at the service.",
  linkedElsewhere:
    "This account already belongs to another user here. Sign in to the app as that user, or choose a different account.",
  otherLinked:
    "A different account of this provider is already linked to you. Use that one.",
};
const cs: typeof en = {
  policyHint: "Sdílené přístupové údaje se nepoužijí.",
  source: "Přihlášení přes",
  sourceProvider: "Přihlašovací metodu organizace",
  sourceService: "Vlastní OAuth služby",
  provider: "Přihlašovací metoda",
  chooseProvider: "Vyber Microsoft nebo Google",
  scopes: "Oprávnění",
  scopesProvider: "Oddělené mezerou. Přihlášení se přidá samo.",
  scopesService: "Prázdné použije api a profile.",
  redirectHint: "Přidej ji do aplikace přihlašovací metody.",
  policy: "Osobní přihlášení",
  required: "Kdy vyžadovat",
  none: "Nikdy, použít sdílené údaje",
  writes: "Pro změny",
  all: "Pro všechny akce",
  signIn: "Požadovaný poskytovatel přihlášení",
  service: "Pouze účet služby",
  manageProviders: "Spravovat poskytovatele přihlášení",
  setup: "OAuth služby",
  discover: "Zjistit OAuth",
  register: "Zaregistrovat Agent Server",
  registered: "Klient nastaven",
  manual: "Existující OAuth klient",
  clientId: "Client ID",
  clientSecret: "Client secret",
  stored: "Uloženo. Prázdné zachová hodnotu.",
  redirect: "Adresa pro návrat",
  save: "Uložit změny",
  saveFirst: "Neuložené změny",
  suggest: "Navrhnout nastavení",
  suggestion: "Osobní OAuth je vhodný. Použít navržené nastavení?",
  apply: "Vyžadovat osobní účet",
  manualSuggestion: "Adaptér se nepotvrdil. Zkontroluj OAuth ručně.",
  ready: "OAuth nalezen",
  notFound: "OAuth nenalezeno",
  pending: "Nejdřív musí správce nastavit OAuth.",
  error: "Požadavek selhal. Zkontroluj nastavení služby a zkus znovu.",
  conflict: "Konfigurace se změnila. Načti ji znovu a opakuj akci.",
  invalidState:
    "Připojení vypršelo nebo patří jiné relaci. Začni znovu z karty v chatu.",
  refresh: "Obnovit",
  missingModel: "Nejdřív zapni rozhodovací model v přiřazení modelů.",
  https: "Osobní OAuth vyžaduje HTTPS adresu služby.",
  mismatch:
    "Přihlásil ses jiným účtem, než jaký máš propojený s profilem. Přihlas se vlastním účtem a zkus to znovu.",
  finish: "Připojit účet služby",
  continueProvider: "Ověřit přes",
  authorizeService: "Povolit přístup ke službě",
  returnApp: "Vrať se do aplikace a pokračuj v požadavku.",
  finishButton: "Dokončit připojení",
  done: "Účet služby připojen",
  failed: "Připojení není dostupné",
  denied: "Služba připojení neschválila.",
  cancelled: "Přihlášení ve službě jsi zrušil(a).",
  linkedElsewhere:
    "Tento účet už tu patří jinému uživateli. Přihlas se do aplikace jako on, nebo zvol jiný účet.",
  otherLinked:
    "K tobě je už propojený jiný účet tohoto poskytovatele. Použij ten.",
};
export function useServiceAuthCopy() {
  return useAdmin().language === "cs" ? cs : en;
}
/** The reason a provider or service sent back, in words the person can act on. */
function returnedError(code: string, copy: typeof en) {
  if (code === "access_denied") return copy.cancelled;
  if (code === "auth_provider_link_required") return copy.linkedElsewhere;
  if (code === "auth_provider_account_conflict") return copy.otherLinked;
  return copy.denied;
}
function issue(error: unknown, copy: typeof en) {
  if (error instanceof ApiError) {
    if (error.code === "service_oauth_state_invalid") return copy.invalidState;
    if (error.code === "catalog_model_required") return copy.missingModel;
    if (error.code === "service_oauth_https_required") return copy.https;
    if (error.code === "service_oauth_account_mismatch") return copy.mismatch;
    if (error.status === 409) return copy.conflict;
  }
  return error instanceof ApiError && error.code
    ? `${copy.error} (${error.code})`
    : copy.error;
}
const Status = ServiceOAuthStatus.extend({ redirectUri: z.string().url() });
export function ServiceAuthentication({
  state,
  service,
  onConfigured,
}: {
  state: CatalogState;
  service: Service;
  onConfigured?: () => void;
}) {
  const { language, data } = useAdmin(),
    client = useQueryClient();
  const copy = language === "cs" ? cs : en;
  const setupCopy = useServiceSetupCopy();
  // Personal sign-in lets the service gate decide who may connect.
  const gate = connectLimit(
    service.access,
    {
      roles: {
        owner: state.copy.owner,
        admin: state.copy.admin,
        member: state.copy.member,
      },
      workspaceRoles: state.scope.workspace?.roles ?? [],
    },
    setupCopy,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const query = useQuery({
    queryKey: [
      "admin",
      "catalog",
      "oauth",
      data.authentication.principalId,
      state.target.organizationId,
      state.target.workspaceId,
      service.id,
      service.revision,
    ],
    queryFn: async ({ signal }) =>
      Status.parse(
        await api(
          "identity/catalog/oauth/status",
          { ...state.target, serviceId: service.id },
          signal,
        ),
      ),
    retry: false,
  });
  async function run(action: string, body: Record<string, unknown> = {}) {
    if (request.current || !query.data) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await api(
        `identity/catalog/oauth/${action}`,
        {
          ...state.target,
          serviceId: service.id,
          ...(action === "disconnect"
            ? {}
            : { revision: query.data.config.revision }),
          ...body,
        },
        controller.signal,
      );
      await client.invalidateQueries({ queryKey: ["admin", "catalog"] });
      await client.invalidateQueries({ queryKey: ["admin", "audit"] });
      if (!controller.signal.aborted && action === "save") onConfigured?.();
      return controller.signal.aborted ? undefined : result;
    } catch (e) {
      if (!controller.signal.aborted) setError(issue(e, copy));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      request.current = null;
    }
  }
  const providers = useQuery({
    queryKey: [
      "admin",
      "auth-providers",
      data.authentication.principalId,
      state.target.organizationId,
    ],
    queryFn: async ({ signal }) =>
      AuthProvidersSchema.parse(
        await api(
          "identity/auth-providers/list",
          { organizationId: state.target.organizationId },
          signal,
        ),
      ),
    enabled: !!state.target.organizationId,
  });
  const value = query.data;
  return (
    <div className="flex flex-col gap-6">
      {(error || query.isError) && (
        <Alert variant="destructive">
          <AlertDescription>
            {error ?? issue(query.error, copy)}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
            >
              {copy.refresh}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {!value ? (
        <Skeleton className="h-64 w-full" />
      ) : state.query.data?.canManage ? (
        <OAuthConfiguration
          key={value.config.revision}
          value={value}
          providers={providers.data?.providers ?? []}
          copy={copy}
          busy={busy}
          run={run}
          decision={!!state.query.data.routing.decision.enabled}
          gate={gate}
        />
      ) : !value.config.hasClientId ? (
        <Alert>
          <AlertDescription>{copy.pending}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
function OAuthConfiguration({
  value,
  copy,
  busy,
  run,
  decision,
  providers,
  gate,
}: {
  value: z.infer<typeof Status>;
  copy: typeof en;
  busy: boolean;
  decision: boolean;
  /** Who the service gate lets connect, when it leaves a role out. */
  gate: string | null;
  providers: z.infer<typeof AuthProvidersSchema>["providers"];
  run(action: string, body?: Record<string, unknown>): Promise<unknown>;
}) {
  const [settings, setSettings] = useState(value.config.settings),
    [scopes, setScopes] = useState(
      (value.config.settings.scopes ?? []).join(" "),
    ),
    [clientId, setClientId] = useState(""),
    [secret, setSecret] = useState("");
  const [suggestion, setSuggestion] = useState<"twenty" | "manual" | null>(
    null,
  );
  const source = settings.source ?? "service";
  const required = settings.requiredFor !== "none";
  // Only OpenID Connect sign-in methods prove which account granted access.
  const signIns = providers.filter(
    (p) => p.kind === "microsoft" || p.kind === "google",
  );
  const requested = scopes.split(/\s+/).filter(Boolean);
  const next: ServiceOAuthSettings = {
    ...settings,
    ...(requested.length ? { scopes: requested } : { scopes: undefined }),
  };
  if (!next.scopes) delete next.scopes;
  const dirty =
    JSON.stringify(next) !== JSON.stringify(value.config.settings) ||
    !!clientId.trim() ||
    !!secret;
  const saved = value.config.settings.source ?? "service";
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        const credentials = {
          ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
          ...(secret ? { clientSecret: secret } : {}),
        };
        setSecret("");
        void run("save", { settings: next, client: credentials });
      }}
    >
      <fieldset disabled={busy} className="contents">
        <Section title={copy.policy}>
          <Card>
            <CardContent>
              {/* Viewport columns don't need size containment, which can collapse
                  this card in Chromium when a Select updates its form value. */}
              <FieldGroup className="@container-normal grid md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="oauth-required">
                    {copy.required}
                  </FieldLabel>
                  <Select
                    value={settings.requiredFor}
                    onValueChange={(requiredFor) =>
                      setSettings({
                        ...settings,
                        authProviderId:
                          requiredFor === "none"
                            ? null
                            : settings.authProviderId,
                        ...(requiredFor === "none"
                          ? { source: undefined }
                          : {}),
                        requiredFor:
                          requiredFor as ServiceOAuthSettings["requiredFor"],
                      })
                    }
                  >
                    <SelectTrigger id="oauth-required" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="none">{copy.none}</SelectItem>
                        <SelectItem value="writes">{copy.writes}</SelectItem>
                        <SelectItem value="all">{copy.all}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {required && (
                    <FieldDescription>{copy.policyHint}</FieldDescription>
                  )}
                  {required && gate && (
                    <FieldDescription data-service-gate>
                      {gate}
                    </FieldDescription>
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor="oauth-source">{copy.source}</FieldLabel>
                  <Select
                    value={source}
                    disabled={!required}
                    onValueChange={(value) =>
                      setSettings({
                        ...settings,
                        source: value === "provider" ? "provider" : undefined,
                        authProviderId:
                          value === "provider"
                            ? (signIns.find((p) => p.enabled)?.id ?? null)
                            : null,
                      })
                    }
                  >
                    <SelectTrigger id="oauth-source" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="provider">
                          {copy.sourceProvider}
                        </SelectItem>
                        <SelectItem value="service">
                          {copy.sourceService}
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                {required && source === "provider" && (
                  <Field>
                    <FieldLabel htmlFor="oauth-provider">
                      {copy.provider}
                    </FieldLabel>
                    <div className="flex items-center gap-2">
                      <Select
                        value={settings.authProviderId ?? ""}
                        onValueChange={(id) =>
                          setSettings({ ...settings, authProviderId: id })
                        }
                      >
                        <SelectTrigger
                          id="oauth-provider"
                          className="min-w-0 flex-1"
                        >
                          <SelectValue placeholder={copy.chooseProvider} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {signIns.map((provider) => (
                              <SelectItem
                                key={provider.id}
                                value={provider.id}
                                disabled={!provider.enabled}
                              >
                                {provider.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <ManageProviders copy={copy} />
                    </div>
                  </Field>
                )}
                {required && source === "service" && (
                  <Field>
                    <FieldLabel htmlFor="oauth-hint">{copy.signIn}</FieldLabel>
                    <div className="flex items-center gap-2">
                      <Select
                        value={settings.authProviderId ?? serviceOnly}
                        onValueChange={(id) =>
                          setSettings({
                            ...settings,
                            authProviderId: id === serviceOnly ? null : id,
                          })
                        }
                      >
                        <SelectTrigger
                          id="oauth-hint"
                          className="min-w-0 flex-1"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value={serviceOnly}>
                              {copy.service}
                            </SelectItem>
                            {providers.map((provider) => (
                              <SelectItem
                                key={provider.id}
                                value={provider.id}
                                disabled={!provider.enabled}
                              >
                                {provider.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <ManageProviders copy={copy} />
                    </div>
                  </Field>
                )}
                {required && (
                  <Field>
                    <FieldLabel htmlFor="oauth-scopes">
                      {copy.scopes}
                    </FieldLabel>
                    <Input
                      id="oauth-scopes"
                      mono
                      value={scopes}
                      onChange={(e) => setScopes(e.target.value)}
                      placeholder={
                        source === "provider"
                          ? "Calendars.ReadWrite Mail.Send"
                          : "api profile"
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <FieldDescription>
                      {source === "provider"
                        ? copy.scopesProvider
                        : copy.scopesService}
                    </FieldDescription>
                  </Field>
                )}
                {required && source === "provider" && (
                  <Field className="md:col-span-2">
                    <FieldLabel htmlFor="oauth-provider-redirect">
                      {copy.redirect}
                    </FieldLabel>
                    <Input
                      id="oauth-provider-redirect"
                      mono
                      value={value.redirectUri}
                      readOnly
                    />
                    <FieldDescription>{copy.redirectHint}</FieldDescription>
                  </Field>
                )}
              </FieldGroup>
            </CardContent>
          </Card>
        </Section>
        {required && source === "service" && saved === "service" && (
          <Section
            title={copy.setup}
            actions={
              <span className="text-xs text-muted-foreground">
                {[
                  value.config.discovery
                    ? copy.ready
                    : // What the automatic probe of this address found.
                      value.config.lastProbe?.outcome === "none" &&
                      `${copy.notFound} (${value.config.lastProbe.reason ?? "?"})`,
                  value.config.hasClientId && copy.registered,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            }
          >
            <Card>
              <CardContent>
                <div className="flex flex-col gap-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void run("discover")}
                      disabled={dirty}
                    >
                      <RefreshCw data-icon="inline-start" aria-hidden="true" />
                      {copy.discover}
                    </Button>
                    {decision && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={dirty || !value.config.discovery}
                        onClick={() =>
                          void run("suggest").then((raw) => {
                            const next = z
                              .object({
                                adapter: z.enum(["twenty", "manual"]),
                              })
                              .safeParse(raw);
                            if (next.success) setSuggestion(next.data.adapter);
                          })
                        }
                      >
                        <Sparkles data-icon="inline-start" aria-hidden="true" />
                        {copy.suggest}
                      </Button>
                    )}
                    {!value.config.hasClientId && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          dirty || !value.config.discovery?.registrationEndpoint
                        }
                        onClick={() => void run("register")}
                      >
                        <KeyRound data-icon="inline-start" aria-hidden="true" />
                        {copy.register}
                      </Button>
                    )}
                  </div>
                  {suggestion && (
                    <Alert>
                      <AlertDescription>
                        {suggestion === "twenty"
                          ? copy.suggestion
                          : copy.manualSuggestion}
                      </AlertDescription>
                      {suggestion === "twenty" && (
                        <AlertAction>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSettings({ ...settings, requiredFor: "all" });
                              setSuggestion(null);
                            }}
                          >
                            {copy.apply}
                          </Button>
                        </AlertAction>
                      )}
                    </Alert>
                  )}
                  <Collapsible>
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="-ml-2 self-start"
                      >
                        {copy.manual}
                        <ChevronDown
                          data-icon="inline-end"
                          aria-hidden="true"
                        />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <FieldGroup className="mt-3">
                        <Field>
                          <FieldLabel htmlFor="oauth-redirect">
                            {copy.redirect}
                          </FieldLabel>
                          <Input
                            id="oauth-redirect"
                            mono
                            value={value.redirectUri}
                            readOnly
                          />
                        </Field>
                        <div className="grid gap-5 md:grid-cols-2">
                          <Field>
                            <FieldLabel htmlFor="oauth-client">
                              {copy.clientId}
                            </FieldLabel>
                            <Input
                              id="oauth-client"
                              value={clientId}
                              onChange={(e) => setClientId(e.target.value)}
                              autoComplete="off"
                              placeholder={
                                value.config.hasClientId ? copy.stored : ""
                              }
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="oauth-secret">
                              {copy.clientSecret}
                            </FieldLabel>
                            <Input
                              id="oauth-secret"
                              type="password"
                              value={secret}
                              onChange={(e) => setSecret(e.target.value)}
                              autoComplete="new-password"
                              placeholder={
                                value.config.hasClientSecret ? copy.stored : ""
                              }
                            />
                          </Field>
                        </div>
                      </FieldGroup>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              </CardContent>
            </Card>
          </Section>
        )}
        {(dirty || busy) && (
          <SaveBar status={copy.saveFirst}>
            <SubmitButton pending={busy}>{copy.save}</SubmitButton>
          </SaveBar>
        )}
      </fieldset>
    </form>
  );
}
function ManageProviders({ copy }: { copy: typeof en }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="outline" size="icon" asChild>
          <Link to="/auth-providers" aria-label={copy.manageProviders}>
            <Settings2 aria-hidden="true" />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copy.manageProviders}</TooltipContent>
    </Tooltip>
  );
}
const serviceOnly = "service-account";
/** Standalone account handoff. No console navigation or administrator controls. */
export function ServiceConnect() {
  const { language, data } = useAdmin(),
    copy = language === "cs" ? cs : en;
  const [response] = useState(
    () =>
      ({
        ...Object.fromEntries(new URLSearchParams(window.location.search)),
        attemptId: window.location.hash.slice(1),
      }) as Record<string, string>,
  );
  const [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<z.infer<typeof HandoffDetails> | null>(
    null,
  );
  const request = useRef<AbortController | null>(null);
  const personal = data.authentication.current !== "admin-key";
  const callback =
    !!response.code && !!response.state && !response.error && personal;
  const handoff =
    /^[A-Za-z0-9_-]{43}$/.test(response.attemptId ?? "") &&
    !response.error &&
    personal;
  useEffect(() => {
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (handoff ? `#${response.attemptId}` : ""),
    );
    const controller = new AbortController();
    if (handoff) {
      void api(
        "service-connect",
        { action: "inspect", attemptId: response.attemptId },
        controller.signal,
      )
        .then((value) => {
          if (!controller.signal.aborted)
            setDetails(HandoffDetails.parse(value));
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(issue(e, copy));
        });
    }
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [handoff, response.attemptId, copy]);
  async function next() {
    if (request.current || (!callback && !handoff)) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const value = await api(
        "service-connect",
        callback
          ? {
              code: response.code,
              state: response.state,
              ...(response.iss ? { iss: response.iss } : {}),
            }
          : {
              action:
                details?.provider && !details.provider.linked
                  ? "provider"
                  : "authorize",
              attemptId: response.attemptId,
            },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (callback) {
        setDone(true);
        // Hand a phone back to the app; a browser client notices by polling.
        if (z.object({ app: z.boolean() }).safeParse(value).data?.app)
          window.location.assign("agentclient://service-connected");
      } else {
        const nextURL = new URL(
          z.object({ authorizationUrl: z.url() }).parse(value).authorizationUrl,
        );
        if (
          nextURL.protocol !== "https:" ||
          nextURL.username ||
          nextURL.password
        )
          throw new Error("invalid redirect");
        window.location.assign(nextURL.href);
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(issue(e, copy));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      request.current = null;
    }
  }
  return (
    <AuthLayout
      icon={done ? <Check /> : <ShieldCheck />}
      title={done ? copy.done : (details?.service ?? copy.finish)}
      description={done ? copy.returnApp : undefined}
      footer={!done && !error && (callback || handoff) && copy.returnApp}
    >
      {details && !done && (
        <div className="flex flex-col items-center gap-0.5 rounded-lg bg-muted px-3 py-2.5 text-center text-sm">
          <span className="font-medium break-words">{details.user.name}</span>
          <span className="text-xs break-all text-muted-foreground">
            {details.user.email}
          </span>
        </div>
      )}
      {(error || (!callback && !handoff)) && !done && (
        <Alert variant="destructive">
          <AlertDescription>
            {error ??
              (response.error
                ? returnedError(response.error, copy)
                : copy.invalidState)}
          </AlertDescription>
        </Alert>
      )}
      {!done && !error && (callback || details) && (
        <SubmitButton type="button" pending={busy} onClick={() => void next()}>
          {callback
            ? copy.finishButton
            : details?.provider && !details.provider.linked
              ? `${copy.continueProvider} ${details.provider.name}`
              : copy.authorizeService}
        </SubmitButton>
      )}
      {!done && !error && handoff && !details && (
        <Skeleton className="h-8 w-full" />
      )}
    </AuthLayout>
  );
}
const HandoffDetails = z.strictObject({
  service: z.string().max(100),
  user: z.strictObject({ name: z.string(), email: z.email() }),
  provider: z
    .strictObject({
      providerId: z.string(),
      providerRevision: z.number(),
      name: z.string(),
      kind: z.enum(["google", "microsoft", "github"]),
      linked: z.boolean(),
    })
    .nullable(),
});
