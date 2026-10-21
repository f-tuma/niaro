import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Check,
  CodeXml,
  Copy,
  Globe,
  KeyRound,
  PanelsTopLeft,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  AuthProviderDraftSchema,
  AuthProviderKindSchema,
  AuthProvidersSchema,
  DeleteAuthProviderSchema,
  SaveAuthProviderSchema,
  type AuthProvider,
  type AuthProviderKind,
} from "../../../packages/protocol/auth-providers";
import {
  AlertAction,
  Alert,
  AlertDescription,
} from "@admin/components/ui/alert";
import { Button } from "@admin/components/ui/button";
import {
  Card,
  CardHeader,
  CardContent,
  CardFooter,
  CardTitle,
} from "@admin/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import { Input } from "@admin/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@admin/components/ui/input-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Switch } from "@admin/components/ui/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import { PageHeader, Section } from "@admin/components/console/page";
import {
  ConfirmAction,
  SubmitButton,
  DetailList,
  MoreActions,
  SearchField,
} from "@admin/components/console/forms";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import { StatusBadge, StatusDot } from "@admin/components/console/status";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { useConsoleScope } from "./console-scope";
import { useAdmin } from "./context";
import { api, ApiError } from "./lib/api";

const en = {
  title: "Sign-in methods",
  search: "Search sign-in methods…",
  notFound: "No matching sign-in methods",
  clearSearch: "Clear search",
  settings: "OAuth client",
  personalOnly: "A personal account is required",
  personalHint: "Sign in with your company account.",
  noCompany: "No company available",
  noCompanyHint: "Ask an owner for access.",
  empty: "No sign-in methods yet",
  emptyHint: "Google, Microsoft or GitHub.",
  emptyReadOnly: "A company admin can add one.",
  add: "Add method",
  edit: "Edit",
  editTitle: "Edit method",
  provider: "Provider",
  name: "Display name",
  clientId: "Client ID",
  clientSecret: "Client secret",
  savedSecret: "Saved; leave blank to keep",
  tenant: "Microsoft tenant ID",
  tenantHint: "Directory (tenant) ID from Microsoft Entra.",
  domain: "Google hosted domain",
  optional: "Optional",
  domainHint: "Limits sign-in to one Workspace domain.",
  enabled: "Enabled",
  disabled: "Disabled",
  enable: "Enabled",
  callback: "Callback URL",
  callbackHint: "Register this URL with the provider.",
  callbackLoading: "Preparing callback URL…",
  callbackFailed: "Could not prepare the callback URL.",
  copy: "Copy callback URL",
  copied: "Copied",
  copyFailed: "Copy failed. Select the URL and copy it manually.",
  secretMissing: "No secret",
  create: "Add",
  save: "Save",
  saved: "Saved.",
  deleted: "Deleted.",
  cancel: "Cancel",
  remove: "Delete method",
  moreActions: "More actions",
  removeConfirm: "Delete this sign-in method?",
  removeHelp: "Its settings and secret are removed.",
  confirmRemove: "Delete",
  refresh: "Reload",
  loading: "Loading sign-in methods…",
  conflict: "This method changed. Reload it first.",
  inUse: "A service signs in with this method. Change that service first.",
  forbidden: "You can no longer manage sign-in methods.",
  failed: "The request failed. Reload and try again.",
  limit: "This company has reached its sign-in method limit.",
  secretRequired: "Enter a client secret or turn the method off.",
  invalid: "Check the highlighted fields.",
  invalidName: "Enter a name of up to 100 characters.",
  invalidClientId: "Enter a Client ID of up to 512 characters.",
  invalidSecret: "Use a secret of up to 4,096 characters.",
  invalidTenant: "Enter a valid tenant GUID.",
  invalidDomain: "Enter a domain such as example.com.",
};
type CopyText = typeof en;
const cs: CopyText = {
  title: "Metody přihlášení",
  search: "Hledat metody přihlášení…",
  notFound: "Žádné odpovídající metody přihlášení",
  clearSearch: "Zrušit hledání",
  settings: "OAuth klient",
  personalOnly: "Je potřeba osobní účet",
  personalHint: "Přihlas se firemním účtem.",
  noCompany: "Žádná firma není dostupná",
  noCompanyHint: "Požádej vlastníka o přístup.",
  empty: "Zatím žádné metody přihlášení",
  emptyHint: "Google, Microsoft nebo GitHub.",
  emptyReadOnly: "Metodu může přidat správce firmy.",
  add: "Přidat metodu",
  edit: "Upravit",
  editTitle: "Upravit metodu",
  provider: "Poskytovatel",
  name: "Zobrazovaný název",
  clientId: "Client ID",
  clientSecret: "Client secret",
  savedSecret: "Uloženo; prázdné pole ho zachová",
  tenant: "ID tenantu Microsoft",
  tenantHint: "Directory (tenant) ID z Microsoft Entra.",
  domain: "Doména Google Workspace",
  optional: "Nepovinné",
  domainHint: "Omezí přihlášení na jednu doménu.",
  enabled: "Zapnuto",
  disabled: "Vypnuto",
  enable: "Zapnuto",
  callback: "Callback URL",
  callbackHint: "Tuto adresu zaregistruj u poskytovatele.",
  callbackLoading: "Připravuji callback URL…",
  callbackFailed: "Callback URL se nepodařilo připravit.",
  copy: "Zkopírovat callback URL",
  copied: "Zkopírováno",
  copyFailed: "Kopírování selhalo. Označ adresu a zkopíruj ji ručně.",
  secretMissing: "Bez secretu",
  create: "Přidat",
  save: "Uložit",
  saved: "Uloženo.",
  deleted: "Odstraněno.",
  cancel: "Zrušit",
  remove: "Odstranit metodu",
  moreActions: "Další akce",
  removeConfirm: "Odstranit tuto metodu přihlášení?",
  removeHelp: "Smaže se její nastavení i secret.",
  confirmRemove: "Odstranit",
  refresh: "Načíst znovu",
  loading: "Načítám metody přihlášení…",
  conflict: "Metoda se mezitím změnila. Načti ji znovu.",
  inUse: "Tuto metodu používá služba. Nejdřív změň její přihlášení.",
  forbidden: "Už nemáš oprávnění spravovat metody přihlášení.",
  failed: "Požadavek selhal. Načti data znovu a zkus to znovu.",
  limit: "Firma má maximální počet metod přihlášení.",
  secretRequired: "Zadej Client secret nebo metodu vypni.",
  invalid: "Zkontroluj označená pole.",
  invalidName: "Zadej název o délce nejvýše 100 znaků.",
  invalidClientId: "Zadej Client ID o délce nejvýše 512 znaků.",
  invalidSecret: "Použij Client secret o délce nejvýše 4 096 znaků.",
  invalidTenant: "Zadej platné GUID tenantu.",
  invalidDomain: "Zadej doménu, například example.com.",
};
const kinds = {
  google: { name: "Google", icon: Globe },
  microsoft: { name: "Microsoft", icon: PanelsTopLeft },
  github: { name: "GitHub", icon: CodeXml },
} satisfies Record<AuthProviderKind, { name: string; icon: typeof Globe }>;
const SavedResponse = z.object({ ok: z.literal(true) });

function requestError(error: unknown, copy: CopyText) {
  if (error instanceof ApiError) {
    if (error.code === "auth_provider_in_use") return copy.inUse;
    if (error.code === "auth_provider_limit") return copy.limit;
    if (error.code === "auth_provider_secret_required")
      return copy.secretRequired;
    if (error.status === 409) return copy.conflict;
    if (error.status === 401 || error.status === 403) return copy.forbidden;
  }
  return copy.failed;
}

export function AuthProvidersPage() {
  const { language, data } = useAdmin();
  const copy = language === "cs" ? cs : en;
  if (data.authentication.current !== "better-auth")
    return (
      <>
        <PageHeader title={copy.title} />
        <ProviderEmpty
          title={copy.personalOnly}
          description={copy.personalHint}
        />
      </>
    );
  return <ProviderScope copy={copy} />;
}

function ProviderEmpty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Empty variant="outline">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KeyRound />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}

function ProviderScope({ copy }: { copy: CopyText }) {
  const { authProviderId } = useParams({ strict: false });
  const scope = useConsoleScope();
  const { data } = useAdmin();
  if (scope.organization)
    return (
      <CompanyProviders
        key={`${data.authentication.principalId}:${scope.organization.id}:${authProviderId ?? "list"}`}
        organizationId={scope.organization.id}
        copy={copy}
      />
    );
  return (
    <>
      <PageHeader
        title={copy.title}
        back={
          authProviderId
            ? { to: "/auth-providers", label: copy.title }
            : undefined
        }
      />
      {scope.identity.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{copy.failed}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              onClick={() => void scope.identity.refetch()}
            >
              {copy.refresh}
            </Button>
          </AlertAction>
        </Alert>
      ) : scope.identity.isPending ? (
        <Skeleton className="h-40 w-full" aria-label={copy.loading} />
      ) : (
        <ProviderEmpty
          title={copy.noCompany}
          description={copy.noCompanyHint}
        />
      )}
    </>
  );
}

function CompanyProviders({
  organizationId,
  copy,
}: {
  organizationId: string;
  copy: CopyText;
}) {
  const { data } = useAdmin(),
    client = useQueryClient();
  const { authProviderId } = useParams({ strict: false });
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<AuthProvider | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const editorGeneration = useRef(0);
  useEffect(() => () => request.current?.abort(), []);
  const query = useQuery({
    queryKey: [
      "admin",
      "auth-providers",
      data.authentication.principalId,
      organizationId,
    ],
    queryFn: async ({ signal }) => {
      const result = AuthProvidersSchema.parse(
        await api("identity/auth-providers/list", { organizationId }, signal),
      );
      if (
        result.organizationId !== organizationId ||
        result.providers.some(
          (provider) => provider.organizationId !== organizationId,
        )
      )
        throw new Error("Invalid provider scope");
      return result;
    },
    retry: false,
  });
  function open(provider: AuthProvider | "new") {
    editorGeneration.current++;
    setError(null);
    setNotice(null);
    setEditor(provider);
  }
  function close() {
    editorGeneration.current++;
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setError(null);
    setEditor(null);
  }
  async function reload() {
    if (request.current) return;
    const generation = editorGeneration.current;
    const result = await query.refetch();
    if (result.isSuccess && generation === editorGeneration.current) {
      setError(null);
      if (editor && editor !== "new")
        setEditor(
          result.data.providers.find((provider) => provider.id === editor.id) ??
            null,
        );
    }
  }
  async function write(action: "save" | "delete", payload: unknown) {
    if (request.current || !query.data?.canManage) return false;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      SavedResponse.parse(
        await api(
          `identity/auth-providers/${action}`,
          payload,
          controller.signal,
        ),
      );
      if (controller.signal.aborted) return false;
      setNotice(action === "save" ? copy.saved : copy.deleted);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "auth-providers"] }),
        client.invalidateQueries({ queryKey: ["admin", "catalog"] }),
      ]);
      return !controller.signal.aborted;
    } catch (cause) {
      if (!controller.signal.aborted) setError(requestError(cause, copy));
      return false;
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }
  const issue =
    error ?? (query.isError ? requestError(query.error, copy) : null);
  const authorityError =
    query.error instanceof ApiError &&
    [401, 403, 404].includes(query.error.status);
  const providers = authorityError ? [] : (query.data?.providers ?? []);
  const provider = providers.find((p) => p.id === authProviderId);
  const matching = providers.filter((p) =>
    `${p.name} ${kinds[p.kind].name} ${p.hostedDomain ?? ""}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const canManage = !authorityError && !!query.data?.canManage;
  const addButton = (
    <Button disabled={busy} onClick={() => open("new")}>
      <Plus data-icon="inline-start" aria-hidden="true" />
      {copy.add}
    </Button>
  );
  return (
    <>
      {!provider && (
        <PageHeader
          title={copy.title}
          back={
            authProviderId
              ? { to: "/auth-providers", label: copy.title }
              : undefined
          }
          toolbar={
            !authProviderId &&
            providers.length > 0 && (
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder={copy.search}
              />
            )
          }
          actions={
            !authProviderId && canManage && !!providers.length && addButton
          }
        />
      )}
      {!editor && issue && (
        <Alert variant="destructive">
          <AlertDescription>{issue}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              disabled={busy || query.isFetching}
              onClick={() => void reload()}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {copy.refresh}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {query.isPending ? (
        <Skeleton className="h-48 w-full" aria-label={copy.loading} />
      ) : query.data && !authorityError ? (
        authProviderId ? (
          provider ? (
            <ProviderDetail
              provider={provider}
              copy={copy}
              canManage={canManage}
              busy={busy || query.isError}
              edit={() => open(provider)}
              remove={async () => {
                const removed = await write(
                  "delete",
                  DeleteAuthProviderSchema.parse({
                    organizationId,
                    providerId: provider.id,
                    revision: provider.revision,
                  }),
                );
                if (removed) void navigate({ to: "/auth-providers" });
                return removed;
              }}
            />
          ) : (
            <ProviderEmpty title={copy.notFound} description="" />
          )
        ) : providers.length ? (
          <>
            {matching.length ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {matching.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    copy={copy}
                  />
                ))}
              </div>
            ) : (
              <ProviderEmpty title={copy.notFound} description="">
                <Button variant="outline" onClick={() => setSearch("")}>
                  {copy.clearSearch}
                </Button>
              </ProviderEmpty>
            )}
          </>
        ) : (
          <ProviderEmpty
            title={copy.empty}
            description={canManage ? copy.emptyHint : copy.emptyReadOnly}
          >
            {canManage && addButton}
          </ProviderEmpty>
        )
      ) : null}
      <Sheet
        open={!!editor && canManage}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>
              {editor === "new" ? copy.add : copy.editTitle}
            </SheetTitle>
            {editor && editor !== "new" && (
              <SheetDescription>{editor.name}</SheetDescription>
            )}
          </SheetHeader>
          {editor && (
            <ProviderForm
              key={editor === "new" ? "new" : `${editor.id}:${editor.revision}`}
              organizationId={organizationId}
              provider={editor === "new" ? undefined : editor}
              copy={copy}
              busy={busy}
              error={issue}
              reload={() => void reload()}
              close={close}
              save={async (payload) => {
                if (await write("save", payload)) setEditor(null);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function useCopy(value: string) {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  }
  return { copied, failed, copy };
}

function CallbackURL({ value, copy }: { value: string; copy: CopyText }) {
  const id = useId();
  const clip = useCopy(value);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{copy.callback}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          value={value}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={clip.copied ? copy.copied : copy.copy}
            onClick={() => void clip.copy()}
          >
            {clip.copied ? <Check /> : <Copy />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <span className="sr-only" role="status">
        {clip.copied ? copy.copied : ""}
      </span>
      {clip.failed ? (
        <FieldError>{copy.copyFailed}</FieldError>
      ) : (
        <FieldDescription>{copy.callbackHint}</FieldDescription>
      )}
    </Field>
  );
}

function ProviderCard({
  provider,
  copy,
}: {
  provider: AuthProvider;
  copy: CopyText;
}) {
  const kind = kinds[provider.kind],
    Icon = kind.icon;
  return (
    <Card variant="interactive">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <EntityIcon>
            <Icon aria-hidden="true" />
          </EntityIcon>
          {!provider.enabled && (
            <StatusBadge tone="neutral">{copy.disabled}</StatusBadge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle>
            <Link
              to="/auth-providers/$authProviderId"
              params={{ authProviderId: provider.id }}
              className="block truncate outline-none after:absolute after:inset-0"
            >
              {provider.name}
            </Link>
          </CardTitle>
          <span className="truncate text-sm text-muted-foreground">
            {[kind.name, provider.hostedDomain].filter(Boolean).join(" · ")}
          </span>
        </div>
      </CardContent>
      {!provider.hasClientSecret && (
        <CardFooter className="mt-auto">
          <StatusDot size="sm" tone="warning">
            {copy.secretMissing}
          </StatusDot>
        </CardFooter>
      )}
    </Card>
  );
}

function ProviderDetail({
  provider,
  copy,
  canManage,
  busy,
  edit,
  remove,
}: {
  provider: AuthProvider;
  copy: CopyText;
  canManage: boolean;
  busy: boolean;
  edit(): void;
  remove(): Promise<boolean>;
}) {
  const kind = kinds[provider.kind],
    Icon = kind.icon;
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <PageHeader
        title={provider.name}
        back={{ to: "/auth-providers", label: copy.title }}
        media={
          <EntityIcon size="lg">
            <Icon aria-hidden="true" />
          </EntityIcon>
        }
        meta={
          !provider.enabled && (
            <StatusBadge tone="neutral">{copy.disabled}</StatusBadge>
          )
        }
        actions={
          canManage && (
            <>
              <Button variant="outline" disabled={busy} onClick={edit}>
                <Pencil data-icon="inline-start" aria-hidden="true" />
                {copy.edit}
              </Button>
              <MoreActions label={`${copy.moreActions}: ${provider.name}`}>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={busy}
                  onSelect={() => setRemoving(true)}
                >
                  <Trash2 aria-hidden="true" />
                  {copy.remove}
                </DropdownMenuItem>
              </MoreActions>
            </>
          )
        }
      />
      <ConfirmAction
        open={removing}
        onOpenChange={setRemoving}
        title={copy.removeConfirm}
        description={copy.removeHelp}
        confirmLabel={copy.confirmRemove}
        cancelLabel={copy.cancel}
        onConfirm={remove}
      />
      <Section title={copy.settings}>
        <DetailList
          items={[
            {
              label: copy.clientId,
              value: <Mono>{provider.clientId}</Mono>,
            },
            ...(provider.tenantId
              ? [
                  {
                    label: copy.tenant,
                    value: <Mono>{provider.tenantId}</Mono>,
                  },
                ]
              : []),
            ...(provider.hostedDomain
              ? [{ label: copy.domain, value: provider.hostedDomain }]
              : []),
            {
              label: copy.clientSecret,
              value: provider.hasClientSecret ? (
                "••••••••"
              ) : (
                <StatusBadge tone="warning">{copy.secretMissing}</StatusBadge>
              ),
            },
            {
              label: copy.callback,
              value: <CopyValue value={provider.callbackURL} copy={copy} />,
            },
          ]}
        />
      </Section>
    </>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-xs break-all">{children}</code>;
}

/** A read-only value with an inline copy button, for detail lists. */
function CopyValue({ value, copy }: { value: string; copy: CopyText }) {
  const clip = useCopy(value);
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-baseline gap-1">
        <Mono>{value}</Mono>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 self-center"
          aria-label={clip.copied ? copy.copied : copy.copy}
          onClick={() => void clip.copy()}
        >
          {clip.copied ? <Check /> : <Copy />}
        </Button>
      </span>
      <span className="sr-only" role="status">
        {clip.copied ? copy.copied : ""}
      </span>
      {clip.failed && (
        <span className="text-xs text-destructive">{copy.copyFailed}</span>
      )}
    </span>
  );
}

function ProviderForm({
  organizationId,
  provider,
  copy,
  busy,
  error,
  reload,
  close,
  save,
}: {
  organizationId: string;
  provider?: AuthProvider;
  copy: CopyText;
  busy: boolean;
  error: string | null;
  reload(): void;
  close(): void;
  save(payload: z.infer<typeof SaveAuthProviderSchema>): Promise<void>;
}) {
  const id = useId();
  const { data } = useAdmin();
  const draft = useQuery({
    queryKey: [
      "admin",
      "auth-provider-draft",
      data.authentication.principalId,
      organizationId,
      id,
    ],
    enabled: !provider,
    queryFn: async ({ signal }) => {
      const value = AuthProviderDraftSchema.parse(
        await api("identity/auth-providers/draft", { organizationId }, signal),
      );
      if (value.organizationId !== organizationId)
        throw new Error("Invalid provider scope");
      return value;
    },
    // Keep the copied address even when the shell refreshes all admin queries.
    staleTime: "static",
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const [kind, setKind] = useState<AuthProviderKind>(
    provider?.kind ?? "google",
  );
  const [name, setName] = useState(provider?.name ?? "");
  const [clientId, setClientId] = useState(provider?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [tenant, setTenant] = useState(provider?.tenantId ?? "");
  const [domain, setDomain] = useState(provider?.hostedDomain ?? "");
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider && !draft.data) return;
    const result = SaveAuthProviderSchema.safeParse({
      organizationId,
      providerId: provider?.id ?? null,
      ...(!provider && draft.data ? { creationId: draft.data.providerId } : {}),
      revision: provider?.revision ?? 0,
      input: {
        kind,
        name,
        clientId,
        enabled,
        ...(secret ? { clientSecret: secret } : {}),
        tenantId: kind === "microsoft" ? tenant.trim() : null,
        hostedDomain: kind === "google" && domain.trim() ? domain.trim() : null,
      },
    });
    const fields: Record<string, string> = {};
    if (!result.success) {
      const messages: Record<string, string> = {
        name: copy.invalidName,
        clientId: copy.invalidClientId,
        clientSecret: copy.invalidSecret,
        tenantId: copy.invalidTenant,
        hostedDomain: copy.invalidDomain,
      };
      for (const issue of result.error.issues) {
        const field = String(issue.path[1] ?? "form");
        fields[field] = messages[field] ?? copy.invalid;
      }
    }
    if (enabled && !secret && !provider?.hasClientSecret)
      fields.clientSecret = copy.secretRequired;
    setInvalid(fields);
    if (!result.success || Object.keys(fields).length) return;
    setSecret("");
    await save(result.data);
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <fieldset disabled={busy} className="min-w-0">
          <FieldGroup>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
                <AlertAction>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={reload}
                  >
                    {copy.refresh}
                  </Button>
                </AlertAction>
              </Alert>
            )}
            <Field>
              <FieldLabel
                id={`${id}-provider-label`}
                htmlFor={provider ? `${id}-provider` : undefined}
              >
                {copy.provider}
              </FieldLabel>
              {provider ? (
                <Input
                  id={`${id}-provider`}
                  value={kinds[kind].name}
                  readOnly
                />
              ) : (
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={kind}
                  aria-labelledby={`${id}-provider-label`}
                  className="flex-wrap"
                  onValueChange={(value) => {
                    const parsed = AuthProviderKindSchema.safeParse(value);
                    if (parsed.success) {
                      setKind(parsed.data);
                      setInvalid({});
                    }
                  }}
                >
                  {AuthProviderKindSchema.options.map((value) => {
                    const Icon = kinds[value].icon;
                    return (
                      <ToggleGroupItem key={value} value={value}>
                        <Icon data-icon="inline-start" />
                        {kinds[value].name}
                      </ToggleGroupItem>
                    );
                  })}
                </ToggleGroup>
              )}
            </Field>
            {provider || draft.data ? (
              <CallbackURL
                value={(provider ?? draft.data)!.callbackURL}
                copy={copy}
              />
            ) : draft.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{copy.callbackFailed}</AlertDescription>
                <AlertAction>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={draft.isFetching}
                    onClick={() => void draft.refetch()}
                  >
                    {copy.refresh}
                  </Button>
                </AlertAction>
              </Alert>
            ) : (
              <Field>
                <FieldLabel>{copy.callback}</FieldLabel>
                <Skeleton
                  className="h-9 w-full"
                  aria-label={copy.callbackLoading}
                />
              </Field>
            )}
            <Field data-invalid={!!invalid.name}>
              <FieldLabel htmlFor={`${id}-name`}>{copy.name}</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                autoComplete="off"
                required
                aria-invalid={!!invalid.name}
                aria-describedby={invalid.name ? `${id}-name-error` : undefined}
              />
              {invalid.name && (
                <FieldError id={`${id}-name-error`}>{invalid.name}</FieldError>
              )}
            </Field>
            <Field data-invalid={!!invalid.clientId}>
              <FieldLabel htmlFor={`${id}-client`}>{copy.clientId}</FieldLabel>
              <Input
                id={`${id}-client`}
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                maxLength={512}
                readOnly={!!provider}
                autoComplete="off"
                spellCheck={false}
                required
                aria-invalid={!!invalid.clientId}
                aria-describedby={
                  invalid.clientId ? `${id}-client-error` : undefined
                }
              />
              {invalid.clientId && (
                <FieldError id={`${id}-client-error`}>
                  {invalid.clientId}
                </FieldError>
              )}
            </Field>
            {kind === "microsoft" && (
              <Field data-invalid={!!invalid.tenantId}>
                <FieldLabel htmlFor={`${id}-tenant`}>{copy.tenant}</FieldLabel>
                <Input
                  id={`${id}-tenant`}
                  value={tenant}
                  onChange={(event) => setTenant(event.target.value)}
                  readOnly={!!provider}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  aria-invalid={!!invalid.tenantId}
                  aria-describedby={`${id}-tenant-note`}
                />
                {invalid.tenantId ? (
                  <FieldError id={`${id}-tenant-note`}>
                    {invalid.tenantId}
                  </FieldError>
                ) : (
                  <FieldDescription id={`${id}-tenant-note`}>
                    {copy.tenantHint}
                  </FieldDescription>
                )}
              </Field>
            )}
            {kind === "google" && (
              <Field data-invalid={!!invalid.hostedDomain}>
                <FieldLabel htmlFor={`${id}-domain`}>{copy.domain}</FieldLabel>
                <Input
                  id={`${id}-domain`}
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                  readOnly={!!provider}
                  maxLength={253}
                  placeholder={copy.optional}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!invalid.hostedDomain}
                  aria-describedby={`${id}-domain-note`}
                />
                {invalid.hostedDomain ? (
                  <FieldError id={`${id}-domain-note`}>
                    {invalid.hostedDomain}
                  </FieldError>
                ) : (
                  <FieldDescription id={`${id}-domain-note`}>
                    {copy.domainHint}
                  </FieldDescription>
                )}
              </Field>
            )}
            <Field data-invalid={!!invalid.clientSecret}>
              <FieldLabel htmlFor={`${id}-secret`}>
                {copy.clientSecret}
              </FieldLabel>
              <Input
                id={`${id}-secret`}
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                maxLength={4096}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={
                  provider?.hasClientSecret ? copy.savedSecret : undefined
                }
                aria-invalid={!!invalid.clientSecret}
                aria-describedby={
                  invalid.clientSecret ? `${id}-secret-error` : undefined
                }
              />
              {invalid.clientSecret && (
                <FieldError id={`${id}-secret-error`}>
                  {invalid.clientSecret}
                </FieldError>
              )}
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor={`${id}-enabled`}>{copy.enable}</FieldLabel>
              <Switch
                id={`${id}-enabled`}
                className="ml-auto"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </Field>
          </FieldGroup>
        </fieldset>
      </div>
      <SheetFooter>
        <Button type="button" variant="outline" onClick={close}>
          {copy.cancel}
        </Button>
        <SubmitButton pending={busy} disabled={!provider && !draft.data}>
          {provider ? copy.save : copy.create}
        </SubmitButton>
      </SheetFooter>
    </form>
  );
}
