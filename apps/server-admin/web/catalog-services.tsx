import { useState, useRef, useEffect, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Navigate,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  Pencil,
  Plus,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import { z } from "zod";
import {
  DiscoveryChoice,
  ActionSettings,
  ServiceIcon,
  ServiceSettings,
  type Service,
  type ServiceAction,
} from "../../../packages/protocol/service-catalog";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Textarea } from "@admin/components/ui/textarea";
import { Checkbox } from "@admin/components/ui/checkbox";
import { Switch } from "@admin/components/ui/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldLegend,
} from "@admin/components/ui/field";
import {
  Card,
  CardHeader,
  CardContent,
  CardFooter,
} from "@admin/components/ui/card";
import { Badge } from "@admin/components/ui/badge";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@admin/components/ui/empty";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@admin/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@admin/components/ui/sheet";
import {
  AlertAction,
  Alert,
  AlertDescription,
} from "@admin/components/ui/alert";
import { PageHeader, Toolbar } from "@admin/components/console/page";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { Disclosure } from "@admin/components/console/disclosure";
import { StatusBadge } from "@admin/components/console/status";
import {
  ConfirmAction,
  MoreActions,
  SearchField,
  SubmitButton,
} from "@admin/components/console/forms";
import {
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuSeparator,
} from "@admin/components/ui/dropdown-menu";
import {
  useCatalog,
  CatalogBoundary,
  ServiceGlyph,
  DeleteButton,
  type CatalogState,
  catalogIssue,
  serviceSettings,
} from "./catalog-shared";
import { useAdmin } from "./context";
import { ServiceAccess } from "./service-access";
import { ServiceAuthentication } from "./service-auth";
import { WorkspaceRolePicker } from "./workspace-roles";
import { ServiceAvatar } from "./service-avatar";
import { ServiceActionList } from "./service-action-list";
import {
  personallyManaged,
  usePersonalMode,
  type PersonalMode,
} from "./service-personal";
import { ServiceProcesses } from "./process-design-page";
import { designEn, designCs } from "./process-design-copy";
import { IdentityId } from "../../../packages/protocol/identity";
import { ServiceSetupOverview } from "./service-setup-overview";
import { api } from "./lib/api";
import { Progress } from "@admin/components/ui/progress";
import {
  clearReadOnly,
  discoveryKey,
  markReadOnly,
  readOnlyActions,
  resetDiscovery,
  runDiscovery,
  useDiscoveryJob,
} from "./service-discovery";
import {
  addServiceSearchSchema,
  serviceDetailSearchSchema,
  serviceTabSchema,
  connectLimit,
  signInLine,
  signInOutcomeSchema,
  useServiceSetupCopy,
  type SignInOutcome,
} from "./service-setup-copy";

export function ServicesPage() {
  const { data } = useAdmin();
  return data.authentication.current === "better-auth" ? (
    <Services />
  ) : (
    <Navigate to="/people" replace />
  );
}

/** Only exceptions carry a status: off, or on without any enabled action. */
function serviceState(service: Service, copy: CatalogState["copy"]) {
  const active = service.actions.some((a) => a.enabled);
  return !service.enabled
    ? ({ tone: "neutral", label: copy.paused } as const)
    : !active
      ? ({ tone: "warning", label: copy.draft } as const)
      : null;
}

function Services() {
  const state = useCatalog(),
    { copy } = state;
  const [search, setSearch] = useState(""),
    [protocol, setProtocol] = useState("all");
  const all = state.query.data?.services ?? [];
  const services = all.filter(
    (s) =>
      (protocol === "all" || s.protocol === protocol) &&
      (s.name + " " + s.url).toLowerCase().includes(search.toLowerCase()),
  );
  const canManage = !!state.query.data?.canManage;
  return (
    <>
      <PageHeader
        title={copy.services}
        count={all.length || undefined}
        toolbar={
          all.length > 0 && (
            <>
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder={copy.searchServices}
              />
              <ToggleGroup
                type="single"
                variant="outline"
                value={protocol}
                aria-label={copy.protocol}
                onValueChange={(value) => value && setProtocol(value)}
              >
                <ToggleGroupItem value="all">{copy.all}</ToggleGroupItem>
                <ToggleGroupItem value="openapi">{copy.api}</ToggleGroupItem>
                <ToggleGroupItem value="mcp">{copy.mcp}</ToggleGroupItem>
              </ToggleGroup>
            </>
          )
        }
        actions={
          canManage &&
          all.length > 0 && (
            <Button asChild>
              <Link to="/services/new">
                <Plus data-icon="inline-start" aria-hidden="true" />
                {copy.addService}
              </Link>
            </Button>
          )
        }
      />
      <CatalogBoundary state={state}>
        {all.length ? (
          <>
            {services.length ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {services.map((service) => (
                  <ServiceCard
                    key={service.id}
                    service={service}
                    state={state}
                  />
                ))}
              </div>
            ) : (
              <Empty variant="outline">
                <EmptyHeader>
                  <EmptyTitle>{copy.noResults}</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSearch("");
                      setProtocol("all");
                    }}
                  >
                    {copy.clearSearch}
                  </Button>
                </EmptyContent>
              </Empty>
            )}
          </>
        ) : (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Plus />
              </EmptyMedia>
              <EmptyTitle>{copy.noServices}</EmptyTitle>
              <EmptyDescription>{copy.noServicesHint}</EmptyDescription>
            </EmptyHeader>
            {canManage && (
              <EmptyContent>
                <Button asChild>
                  <Link to="/services/new">
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {copy.addService}
                  </Link>
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}
      </CatalogBoundary>
    </>
  );
}

function ServiceCard({
  service,
  state,
}: {
  service: Service;
  state: CatalogState;
}) {
  const { copy } = state;
  const status = serviceState(service, copy);
  return (
    <Card variant="interactive">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <ServiceAvatar service={service} state={state} />
          {status && (
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            to="/services/$serviceId"
            params={{ serviceId: service.id }}
            className="truncate text-md font-semibold outline-none after:absolute after:inset-0"
          >
            {service.name}
          </Link>
          {service.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {service.description}
            </p>
          )}
        </div>
      </CardContent>
      <CardFooter className="mt-auto">
        <div className="flex w-full min-w-0 items-center justify-between gap-3">
          <span className="truncate font-mono text-xs text-muted-foreground">
            {new URL(service.url).host}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {service.protocol === "openapi" ? copy.api : copy.mcp}
          </span>
        </div>
      </CardFooter>
    </Card>
  );
}

export function AddServicePage() {
  const state = useCatalog(),
    admin = useAdmin();
  const scopeKey = JSON.stringify([
    admin.authorityGeneration,
    admin.data.authentication.principalId,
    state.scope.organization?.role,
    state.target,
  ]);
  return <AddService key={scopeKey} state={state} />;
}
function AddService({ state }: { state: CatalogState }) {
  const navigate = useNavigate(),
    copy = useServiceSetupCopy();
  const search = addServiceSearchSchema.parse(useSearch({ strict: false }));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const open = (id: string, result?: AddResult) => {
    if (!mounted.current) return;
    void navigate({
      to: "/services/$serviceId",
      params: { serviceId: id },
      search: {
        ...(search.mode === "assistant" ? { setup: "assistant" as const } : {}),
        // Connecting is done; the next step is choosing actions.
        tab: search.mode === "assistant" ? "processes" : "actions",
        ...(result?.signIn ? { signIn: result.signIn } : {}),
      },
    });
  };
  const chooseMode = (mode: "assistant" | "manual") => {
    void navigate({ to: "/services/new", search: { mode }, replace: true });
  };
  return (
    <>
      <PageHeader
        title={state.copy.addService}
        back={{ to: "/services", label: state.copy.services }}
      />
      <CatalogBoundary state={state}>
        {state.query.data?.canManage ? (
          !search.mode ? (
            <div
              data-service-setup-choice
              className="grid gap-4 md:grid-cols-2"
            >
              {(
                [
                  {
                    mode: "assistant",
                    title: copy.assistant,
                    description: copy.assistantDescription,
                    icon: <Sparkles />,
                  },
                  {
                    mode: "manual",
                    title: copy.manual,
                    description: copy.manualDescription,
                    icon: <SlidersHorizontal />,
                  },
                ] as const
              ).map((choice) => (
                <Card key={choice.mode} variant="interactive">
                  <CardHeader>
                    <EntityIcon>{choice.icon}</EntityIcon>
                  </CardHeader>
                  <CardContent>
                    <div className="flex min-w-0 flex-col gap-1">
                      <Link
                        to="/services/new"
                        search={{ mode: choice.mode }}
                        replace
                        className="text-md font-semibold outline-none after:absolute after:inset-0"
                      >
                        {choice.title}
                      </Link>
                      <p className="text-sm text-muted-foreground">
                        {choice.description}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div
              data-service-setup={search.mode}
              className="flex min-w-0 flex-col gap-6"
            >
              <ToggleGroup
                type="single"
                variant="outline"
                className="self-start"
                value={search.mode}
                aria-label={copy.setupMode}
                onValueChange={(mode) => {
                  if (mode === "assistant" || mode === "manual")
                    chooseMode(mode);
                }}
              >
                <ToggleGroupItem value="assistant">
                  {copy.assistant}
                </ToggleGroupItem>
                <ToggleGroupItem value="manual">{copy.manual}</ToggleGroupItem>
              </ToggleGroup>
              <ServiceForm state={state} onSaved={open} />
            </div>
          )
        ) : (
          <Alert>
            <AlertDescription>{state.copy.notManager}</AlertDescription>
          </Alert>
        )}
      </CatalogBoundary>
    </>
  );
}

export function ServiceDetailPage() {
  const { serviceId } = useParams({ strict: false });
  const state = useCatalog();
  const admin = useAdmin();
  const service = state.query.data?.services.find((s) => s.id === serviceId);
  return (
    <CatalogBoundary state={state}>
      {service ? (
        <ServiceDetail
          key={JSON.stringify([
            admin.authorityGeneration,
            admin.data.authentication.principalId,
            state.scope.organization?.role,
            state.target,
            service.id,
            state.query.data?.canManage,
          ])}
          state={state}
          service={service}
        />
      ) : (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyTitle>{state.copy.noResults}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link to="/services">{state.copy.services}</Link>
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </CatalogBoundary>
  );
}

/** What adding a service found out, for the result page. */
export type AddResult = {
  /** The automatic OAuth probe of an MCP service. */
  signIn?: SignInOutcome;
};
/** The probe outcome the status answers; unknown shapes read as not found. */
function probeOutcome(status: unknown): SignInOutcome {
  const parsed = z
    .object({
      config: z.object({
        lastProbe: z.object({ outcome: signInOutcomeSchema }).nullable(),
      }),
    })
    .safeParse(status);
  return parsed.success
    ? (parsed.data.config.lastProbe?.outcome ?? "none")
    : "none";
}
function ServiceForm({
  state,
  service,
  onSaved,
  onCancel,
}: {
  state: CatalogState;
  service?: Service;
  onSaved: (id: string, result?: AddResult) => void;
  /** Editing happens in a sheet; its footer cancels. */
  onCancel?: () => void;
}) {
  const { copy } = state;
  const [initial] = useState<z.infer<typeof ServiceSettings>>(() =>
    service
      ? serviceSettings(service)
      : {
          name: "",
          url: "",
          protocol: "openapi",
          icon: "plug",
          iconSource: "favicon",
          auth: { type: "bearer" },
          enabled: true,
        },
  );
  const [value, setValue] = useState(initial);
  const [key, setKey] = useState("");
  // Editing saves only real changes; creating always can submit.
  const dirty =
    !service || !!key || JSON.stringify(value) !== JSON.stringify(initial);
  const [revision] = useState(service?.revision ?? 0);
  const error = useRef<HTMLDivElement>(null);
  const inSheet = !!onCancel;
  useEffect(() => {
    if (state.error && inSheet) error.current?.focus();
  }, [state.error, inSheet]);
  async function save(e: FormEvent) {
    e.preventDefault();
    const result = await state.mutate("command", {
      type: "saveService",
      ...(service ? { id: service.id } : {}),
      revision,
      settings: value,
      ...(key ? { apiKey: key } : {}),
    });
    if (result && typeof result === "object" && "id" in result) {
      const savedId = IdentityId.safeParse(result.id);
      if (!savedId.success) {
        state.setError(copy.invalid);
        return;
      }
      setKey("");
      // An MCP address the server has not seen: it looks for the service's
      // OAuth on its own; waiting here lets the result page say what it found.
      if (value.protocol === "mcp" && service?.url !== value.url) {
        const status = await state.mutate("oauth/auto", {
          serviceId: savedId.data,
        });
        // A probe that could not be asked leaves the result page without
        // the line, never with a wrong one.
        onSaved(
          savedId.data,
          service || status === undefined
            ? undefined
            : { signIn: probeOutcome(status) },
        );
        return;
      }
      onSaved(savedId.data);
    }
  }
  // One column: every field shares the same width and left edge.
  const fields = (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="service-name">{copy.name}</FieldLabel>
        <Input
          id="service-name"
          value={value.name}
          onChange={(e) => setValue({ ...value, name: e.target.value })}
          maxLength={100}
          required
        />
      </Field>
      <Field>
        <FieldLabel id="service-protocol-label">{copy.protocol}</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          aria-labelledby="service-protocol-label"
          value={value.protocol}
          onValueChange={(protocol) =>
            protocol &&
            setValue({
              ...value,
              protocol: protocol as Service["protocol"],
            })
          }
        >
          <ToggleGroupItem value="openapi">OpenAPI</ToggleGroupItem>
          <ToggleGroupItem value="mcp">MCP</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <Field>
        <FieldLabel htmlFor="service-url">
          {value.protocol === "mcp" ? copy.mcpUrl : copy.url}
        </FieldLabel>
        <Input
          id="service-url"
          type="url"
          value={value.url}
          placeholder={
            value.protocol === "mcp"
              ? "https://example.com/mcp"
              : "https://api.example.com/v1"
          }
          onChange={(e) => setValue({ ...value, url: e.target.value })}
          required
        />
      </Field>
      {/* A saved service edits its purpose from the overview. */}
      {!service && (
        <Field>
          <FieldLabel htmlFor="service-description">
            {copy.serviceDescription}
          </FieldLabel>
          <Textarea
            id="service-description"
            rows={2}
            maxLength={500}
            value={value.description ?? ""}
            onChange={(e) => {
              const { description: _old, ...rest } = value;
              setValue(
                e.target.value.trim()
                  ? { ...rest, description: e.target.value }
                  : rest,
              );
            }}
          />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="service-auth">{copy.auth}</FieldLabel>
        <Select
          value={value.auth.type}
          onValueChange={(type) =>
            setValue({
              ...value,
              auth:
                type === "header"
                  ? { type: "header", header: "X-API-Key" }
                  : type === "none"
                    ? { type: "none" }
                    : { type: "bearer" },
            })
          }
        >
          <SelectTrigger id="service-auth" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bearer">{copy.bearer}</SelectItem>
            <SelectItem value="header">{copy.header}</SelectItem>
            <SelectItem value="none">{copy.none}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {value.auth.type === "header" && (
        <Field>
          <FieldLabel htmlFor="service-header">{copy.headerName}</FieldLabel>
          <Input
            id="service-header"
            mono
            value={value.auth.header}
            onChange={(e) =>
              setValue({
                ...value,
                auth: { type: "header", header: e.target.value },
              })
            }
            required
          />
        </Field>
      )}
      {value.auth.type !== "none" && (
        <Field>
          <FieldLabel htmlFor="service-key">{copy.key}</FieldLabel>
          <Input
            id="service-key"
            type="password"
            autoComplete="new-password"
            value={key}
            placeholder={service?.hasCredential ? copy.keyStored : ""}
            onChange={(e) => setKey(e.target.value)}
            required={!service?.hasCredential}
          />
        </Field>
      )}
      <Field>
        <FieldLabel id="service-icon-label">{copy.serviceIcon}</FieldLabel>
        <div className="flex flex-wrap items-center gap-3">
          <ServiceAvatar service={value} state={state} />
          <ToggleGroup
            type="single"
            variant="outline"
            aria-labelledby="service-icon-label"
            value={value.iconSource}
            onValueChange={(source) =>
              source &&
              setValue({
                ...value,
                iconSource: source as Service["iconSource"],
              })
            }
          >
            <ToggleGroupItem value="favicon">
              {copy.iconAutomatic}
            </ToggleGroupItem>
            <ToggleGroupItem value="custom">{copy.iconCustom}</ToggleGroupItem>
          </ToggleGroup>
        </div>
        {value.iconSource === "custom" && (
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={2}
            className="flex-wrap"
            aria-label={copy.serviceIcon}
            value={value.icon}
            onValueChange={(icon) => {
              if (icon) setValue({ ...value, icon: icon as Service["icon"] });
            }}
          >
            {ServiceIcon.options.map((icon) => (
              <ToggleGroupItem
                key={icon}
                value={icon}
                size="lg"
                aria-label={copy[`icon_${icon}`]}
                title={copy[`icon_${icon}`]}
              >
                <ServiceGlyph icon={icon} size="sm" />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </Field>
    </FieldGroup>
  );
  if (onCancel)
    return (
      <form
        onSubmit={(e) => void save(e)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <fieldset
          disabled={state.busy}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4"
        >
          {state.error && (
            <Alert ref={error} tabIndex={-1} variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {fields}
        </fieldset>
        <SheetFooter>
          <Button
            type="button"
            variant="outline"
            disabled={state.busy}
            onClick={onCancel}
          >
            {copy.cancel}
          </Button>
          <SubmitButton pending={state.busy} disabled={!dirty}>
            {copy.save}
          </SubmitButton>
        </SheetFooter>
      </form>
    );
  return (
    <form
      onSubmit={(e) => void save(e)}
      className="flex max-w-2xl flex-col gap-6"
    >
      <fieldset disabled={state.busy} className="contents">
        <Card>
          <CardContent>{fields}</CardContent>
        </Card>
        <div className="flex justify-end">
          <SubmitButton pending={state.busy}>{copy.addService}</SubmitButton>
        </div>
      </fieldset>
    </form>
  );
}

function ServiceDetail({
  state,
  service,
}: {
  state: CatalogState;
  service: Service;
}) {
  const { copy } = state;
  const processCopy = useAdmin().language === "cs" ? designCs : designEn;
  const setupCopy = useServiceSetupCopy();
  const search = serviceDetailSearchSchema.parse(useSearch({ strict: false }));
  const tab = search.tab ?? "overview";
  const canManage = state.query.data!.canManage;
  const [editor, setEditor] = useState<string | null>(null),
    // A service without actions opens straight into discovery: it's the only next step.
    [discover, setDiscover] = useState(
      () => tab === "actions" && canManage && !service.actions.length,
    ),
    [editingConnection, setEditingConnection] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function setTab(next: string) {
    if (!mounted.current) return;
    void navigate({
      to: "/services/$serviceId",
      params: { serviceId: service.id },
      search: { ...search, tab: serviceTabSchema.parse(next) },
      replace: true,
    });
  }
  function configureAssistant() {
    void navigate({
      to: "/services/$serviceId",
      params: { serviceId: service.id },
      search: { ...search, tab: "processes", setup: "assistant" },
    });
  }
  function openDiscovery() {
    state.setError(null);
    setEditor(null);
    setDiscover(true);
    if (tab !== "actions") setTab("actions");
  }
  function editConnection() {
    state.setError(null);
    setEditingConnection(true);
  }
  function setEnabled(enabled: boolean) {
    void state.mutate("command", {
      type: "saveService",
      id: service.id,
      revision: service.revision,
      settings: { ...serviceSettings(service), enabled },
    });
  }
  const selected = service.actions.find((a) => a.id === editor);
  const editorTrigger = useRef<HTMLElement | null>(null);
  const editorError = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.error && editor !== null) editorError.current?.focus();
  }, [state.error, editor]);
  function openEditor(id: string) {
    editorTrigger.current = document.activeElement as HTMLElement;
    state.setError(null);
    setEditor(id);
  }
  const status = serviceState(service, copy);
  const configured = service.actions.some((a) => a.enabled);
  const connectGate = connectLimit(
    service.access,
    {
      roles: { owner: copy.owner, admin: copy.admin, member: copy.member },
      workspaceRoles: state.scope.workspace?.roles ?? [],
    },
    setupCopy,
  );
  // Personal sign-in: people manage their own actions; this page is the ceiling.
  const personal = usePersonalMode(state, service);
  return (
    <>
      <PageHeader
        title={service.name}
        back={{ to: "/services", label: copy.services }}
        media={<ServiceAvatar service={service} state={state} size="lg" />}
        meta={
          <>
            {/* Managers see on/off on the header switch instead. */}
            {status && (service.enabled || !canManage) && (
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            )}
          </>
        }
        actions={
          <>
            {canManage && (
              <div className="flex h-8 items-center gap-2 pr-2">
                <Switch
                  id="service-enabled"
                  aria-label={copy.enabled}
                  checked={service.enabled}
                  disabled={state.busy}
                  onCheckedChange={setEnabled}
                />
                <label
                  htmlFor="service-enabled"
                  className="text-sm text-muted-foreground"
                >
                  {service.enabled ? copy.active : copy.paused}
                </label>
              </div>
            )}
            {canManage && (
              <Button
                variant={configured ? "outline" : "default"}
                onClick={configureAssistant}
              >
                <Sparkles data-icon="inline-start" aria-hidden="true" />
                {setupCopy.assistant}
              </Button>
            )}
            <MoreActions label={copy.moreActions}>
              <DropdownMenuGroup>
                {canManage && (
                  <DropdownMenuItem onSelect={editConnection}>
                    <Pencil aria-hidden="true" />
                    {setupCopy.editConnection}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>
                  <Link to="/audit">
                    <ScrollText aria-hidden="true" />
                    {copy.activity}
                  </Link>
                </DropdownMenuItem>
                {canManage && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={state.busy}
                      onSelect={() => setConfirmDelete(true)}
                    >
                      <Trash2 aria-hidden="true" />
                      {copy.deleteService}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuGroup>
            </MoreActions>
          </>
        }
      />
      <ConfirmAction
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={copy.confirmRemove}
        confirmLabel={copy.deleteService}
        cancelLabel={copy.cancel}
        onConfirm={() =>
          state
            .mutate("command", {
              type: "removeService",
              id: service.id,
              revision: service.revision,
            })
            .then((r) => {
              if (r) void navigate({ to: "/services" });
            })
        }
      />
      {canManage && (
        <Sheet
          open={editingConnection}
          onOpenChange={(open) => {
            if (!state.busy) setEditingConnection(open);
          }}
        >
          <SheetContent size="lg">
            <SheetHeader>
              <SheetTitle>{setupCopy.editConnection}</SheetTitle>
              <SheetDescription>{service.name}</SheetDescription>
            </SheetHeader>
            {editingConnection && (
              <ServiceForm
                state={state}
                service={service}
                onCancel={() => setEditingConnection(false)}
                onSaved={() => setEditingConnection(false)}
              />
            )}
          </SheetContent>
        </Sheet>
      )}
      {search.signIn && canManage && service.protocol === "mcp" && (
        <Alert data-service-sign-in={search.signIn}>
          <AlertDescription>
            <p>{signInLine(search.signIn, setupCopy)}</p>
            {search.signIn !== "none" && connectGate && <p>{connectGate}</p>}
          </AlertDescription>
          {search.signIn !== "none" && tab !== "access" && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTab("access")}
              >
                {setupCopy.edit}
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="-mx-4 overflow-x-auto overflow-y-hidden border-b px-4 pt-1 pb-px md:mx-0 md:px-0">
          <TabsList variant="line">
            <TabsTrigger value="overview">{setupCopy.overview}</TabsTrigger>
            <TabsTrigger value="actions">
              {copy.actions}
              <Badge variant="secondary">{service.actions.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="processes">{processCopy.processes}</TabsTrigger>
            <TabsTrigger value="access">{copy.access}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview" className="mt-4">
          <ServiceSetupOverview
            state={state}
            service={service}
            onTab={setTab}
            onAction={(action) => {
              setTab("actions");
              openEditor(action.id);
            }}
            onEditConnection={editConnection}
            onDiscover={openDiscovery}
            onCreateProcess={configureAssistant}
          />
        </TabsContent>
        <TabsContent value="actions" className="mt-4">
          <div className="flex flex-col gap-6">
            {discover && (
              <Discovery
                state={state}
                service={service}
                close={() => setDiscover(false)}
              />
            )}
            <ServiceActionList
              state={state}
              service={service}
              personal={personal}
              onOpen={(action) => openEditor(action.id)}
              actions={
                canManage && (
                  <>
                    <Button variant="outline" onClick={openDiscovery}>
                      <Sparkles data-icon="inline-start" aria-hidden="true" />
                      {copy.discover}
                    </Button>
                    <Button
                      variant={configured ? "default" : "outline"}
                      onClick={() => {
                        openEditor("new");
                        setDiscover(false);
                      }}
                    >
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      {copy.addAction}
                    </Button>
                  </>
                )
              }
            />
            <Sheet
              open={editor !== null}
              onOpenChange={(open) => {
                if (!open && !state.busy) setEditor(null);
              }}
            >
              <SheetContent
                size="lg"
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  (editorTrigger.current?.isConnected
                    ? editorTrigger.current
                    : (document.getElementById("action-list-search") ??
                      document.getElementById("console-content"))
                  )?.focus();
                }}
              >
                <SheetHeader>
                  <SheetTitle>
                    {canManage
                      ? selected
                        ? copy.editAction
                        : copy.addAction
                      : copy.actions}
                  </SheetTitle>
                  {selected && (
                    <SheetDescription>{selected.name}</SheetDescription>
                  )}
                </SheetHeader>
                {state.error && (
                  <div className="px-4">
                    <Alert
                      ref={editorError}
                      tabIndex={-1}
                      variant="destructive"
                    >
                      <AlertDescription>{state.error}</AlertDescription>
                      {state.conflict && (
                        <AlertAction>
                          <Button
                            variant="outline"
                            onClick={() => void state.resetDrafts()}
                          >
                            {copy.reloadSaved}
                          </Button>
                        </AlertAction>
                      )}
                    </Alert>
                  </div>
                )}
                {editor &&
                  (canManage ? (
                    <ActionEditor
                      key={editor}
                      state={state}
                      service={service}
                      action={selected}
                      personal={personal}
                      close={() => setEditor(null)}
                    />
                  ) : selected ? (
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                      <ActionRunner
                        key={selected.id}
                        state={state}
                        service={service}
                        action={selected}
                      />
                    </div>
                  ) : null)}
              </SheetContent>
            </Sheet>
          </div>
        </TabsContent>
        <TabsContent value="processes" className="mt-4">
          <div className="flex flex-col gap-6">
            {search.setup === "assistant" && canManage && !service.enabled && (
              <Alert>
                <Sparkles aria-hidden="true" />
                <AlertDescription>{setupCopy.paused}</AlertDescription>
                {!service.enabled && (
                  <AlertAction>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={state.busy}
                      onClick={() => setEnabled(true)}
                    >
                      {setupCopy.enable}
                    </Button>
                  </AlertAction>
                )}
              </Alert>
            )}
            <ServiceProcesses state={state} serviceId={service.id} />
          </div>
        </TabsContent>
        <TabsContent value="access" className="mt-4">
          <div className="flex flex-col gap-8">
            <ServiceAccess
              key={`${state.target.workspaceId}:${service.id}:${service.revision}`}
              state={state}
              service={service}
              personal={personal !== null}
            />
            {canManage && (
              <ServiceAuthentication
                key={`${state.target.workspaceId}:${service.id}`}
                state={state}
                service={service}
              />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}

function Discovery({
  state,
  service,
  close,
}: {
  state: CatalogState;
  service: Service;
  close: () => void;
}) {
  const { copy } = state;
  const client = useQueryClient();
  const key = discoveryKey(state.target.workspaceId, service.id);
  const job = useDiscoveryJob(key);
  const [documentUrl, setDocumentUrl] = useState("");
  const [enrich, setEnrich] = useState(job.running ? job.enrich : false);
  const choices = job.choices?.list ?? null;
  const [selected, setSelected] = useState<string[]>([]);
  const stale = !!job.choices && job.choices.revision !== service.revision;
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const processing = job.running;
  const continuation = job.continuation;
  const progress = job.progress;
  const result = job.result;
  const imported = (choice: z.infer<typeof DiscoveryChoice>) =>
    choice.existing ||
    service.actions.some(
      (action) =>
        action.sourceKey === choice.sourceKey ||
        action.sourceKey === `mcp:${choice.name}`,
    );
  const visible = choices?.filter(
    (choice) =>
      (category === "all" || `category:${choice.category}` === category) &&
      `${choice.name} ${choice.description}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  // Each request goes out on its own; the job outlives this sheet.
  function discover(e: FormEvent) {
    e.preventDefault();
    state.setError(null);
    if (!continuation && !choices) resetDiscovery(key);
    void runDiscovery(key, {
      send: (body) =>
        api("identity/catalog/discover", { ...state.target, ...body }),
      body: {
        serviceId: service.id,
        revision: job.choices?.revision ?? service.revision,
        ...(documentUrl ? { documentUrl } : {}),
        ...(choices ? { toolNames: selected } : {}),
      },
      enrich,
      ...(choices ? { total: selected.length } : {}),
      resume: !!continuation,
      onBatch: () =>
        client.invalidateQueries({ queryKey: ["admin", "catalog"] }),
    });
    setSelected([]);
  }
  const pending = state.busy || processing;
  const selectable = visible?.filter((choice) => !imported(choice)) ?? [];
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !state.busy) close();
      }}
    >
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>
            {choices ? copy.chooseActions : copy.discover}
          </SheetTitle>
        </SheetHeader>
        <form
          onSubmit={(e) => void discover(e)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <fieldset
            disabled={pending}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4"
          >
            {(state.error || (!!job.error && !processing)) && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>
                  {state.error ?? catalogIssue(job.error, copy)}
                </AlertDescription>
              </Alert>
            )}
            <FieldGroup>
              {service.protocol === "openapi" && !choices && (
                <Field>
                  <FieldLabel htmlFor="openapi-url">
                    {copy.documentUrl}
                  </FieldLabel>
                  <Input
                    id="openapi-url"
                    type="url"
                    mono
                    value={documentUrl}
                    onChange={(e) => setDocumentUrl(e.target.value)}
                    placeholder={`${service.url.replace(/\/$/, "")}/openapi.json`}
                  />
                </Field>
              )}
              {choices && (
                <FieldSet>
                  <FieldLegend>
                    {copy.availableActions}{" "}
                    <span className="text-muted-foreground tabular-nums">
                      {choices.length}
                    </span>
                  </FieldLegend>
                  <Toolbar>
                    <SearchField
                      value={search}
                      onChange={setSearch}
                      placeholder={copy.searchActions}
                    />
                    <Select value={category} onValueChange={setCategory}>
                      <SelectTrigger aria-label={copy.actionCategory}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">
                          {copy.allCategories}
                        </SelectItem>
                        {/* Remote catalog names are arbitrary: Radix rejects ""
                            and "all" is our sentinel, so values are prefixed. */}
                        {[...new Set(choices.map((choice) => choice.category))]
                          .filter(Boolean)
                          .sort()
                          .map((name) => (
                            <SelectItem key={name} value={`category:${name}`}>
                              {name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </Toolbar>
                  <div className="max-h-96 overflow-y-auto rounded-lg border">
                    <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background px-3 py-2.5">
                      <Checkbox
                        id="discover-all"
                        checked={
                          selectable.length > 0 &&
                          selectable.every((choice) =>
                            selected.includes(choice.name),
                          )
                        }
                        onCheckedChange={(checked) => {
                          const names = selectable.map((choice) => choice.name);
                          setSelected((old) =>
                            checked === true
                              ? [...new Set([...old, ...names])]
                              : old.filter((name) => !names.includes(name)),
                          );
                        }}
                      />
                      <label
                        htmlFor="discover-all"
                        className="flex-1 text-sm font-medium"
                      >
                        {copy.selectAllActions}
                      </label>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {copy.selectedActions}: {selected.length}
                      </span>
                    </div>
                    <ul className="divide-y">
                      {visible?.map((choice) => {
                        const existing = imported(choice),
                          checked = selected.includes(choice.name);
                        return (
                          <li
                            key={choice.name}
                            className="flex items-start gap-3 px-3 py-2.5"
                          >
                            <Checkbox
                              id={`discover-${choice.name}`}
                              checked={existing || checked}
                              disabled={existing}
                              onCheckedChange={(value) =>
                                setSelected((names) =>
                                  value === true
                                    ? [...names, choice.name]
                                    : names.filter(
                                        (name) => name !== choice.name,
                                      ),
                                )
                              }
                            />
                            <label
                              htmlFor={`discover-${choice.name}`}
                              className="flex min-w-0 flex-1 flex-col gap-0.5"
                            >
                              <span className="flex flex-wrap items-center gap-2 font-mono text-xs font-medium break-all">
                                {choice.name}
                                {existing && (
                                  <Badge variant="secondary">
                                    {copy.existing}
                                  </Badge>
                                )}
                              </span>
                              <span className="line-clamp-2 text-xs text-muted-foreground">
                                {choice.description}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                      {!visible?.length && (
                        <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                          {copy.noMatchingActions}
                        </li>
                      )}
                    </ul>
                  </div>
                </FieldSet>
              )}
              <Field orientation="horizontal">
                <FieldLabel htmlFor="enrich">{copy.enrich}</FieldLabel>
                <Switch
                  id="enrich"
                  checked={enrich}
                  onCheckedChange={setEnrich}
                />
              </Field>
              {stale && !processing && (
                <Alert>
                  <AlertDescription>{copy.discoveryChanged}</AlertDescription>
                </Alert>
              )}
              {progress && (
                <p
                  role="status"
                  aria-live="polite"
                  className="text-sm text-muted-foreground tabular-nums"
                >
                  {processing
                    ? job.enrich
                      ? copy.describingActions
                      : copy.importingActions
                    : progress.done < progress.total
                      ? copy.importPaused
                      : copy.processedActions}
                  : {progress.done} / {progress.total}
                </p>
              )}
              {progress && processing && (
                <Progress
                  aria-label={copy.importingActions}
                  value={Math.round((progress.done / progress.total) * 100)}
                />
              )}
              {result && (
                <div role="status" className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {copy.importedActions}: {result.added} · {copy.existing}:{" "}
                    {result.existing}
                    {result.enriched && ` · ${copy.aiEnriched}`}
                  </p>
                  {result.warnings.length > 0 && (
                    <Disclosure
                      title={`${copy.skipped}: ${result.warnings.length}`}
                    >
                      <ul className="flex max-h-72 flex-col gap-3 overflow-y-auto">
                        {result.warnings.map((action, index) => {
                          const issue = result.issues?.find(
                            (item) => item.action === action,
                          );
                          return (
                            <li
                              key={`${index}:${action}`}
                              className="flex min-w-0 flex-col gap-1 border-l-2 border-warning/40 pl-3 text-sm"
                            >
                              <span className="font-mono text-xs break-all">
                                {action}
                              </span>
                              <span className="text-muted-foreground">
                                {
                                  copy[
                                    `issue_${issue?.reason ?? "operation_unsupported"}`
                                  ]
                                }
                                {issue?.keyword ? ` (${issue.keyword})` : ""}
                              </span>
                              {issue?.path && (
                                <code className="text-xs break-all text-muted-foreground">
                                  {issue.path}
                                </code>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </Disclosure>
                  )}
                </div>
              )}
              {!processing && (
                <ReadOnlyHint
                  state={state}
                  service={service}
                  ids={job.readOnly}
                  onDone={() => clearReadOnly(key)}
                />
              )}
            </FieldGroup>
          </fieldset>
          <SheetFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={state.busy}
              onClick={close}
            >
              {processing ? copy.inBackground : copy.cancel}
            </Button>
            <SubmitButton
              pending={pending}
              disabled={!!choices && (!selected.length || stale)}
            >
              {pending
                ? copy.checking
                : continuation
                  ? copy.continueImport
                  : choices
                    ? `${copy.importSelected} (${selected.length})`
                    : copy.discover}
            </SubmitButton>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** The server's read-only labels, applied only when an administrator says so. */
function ReadOnlyHint({
  state,
  service,
  ids,
  onDone,
}: {
  state: CatalogState;
  service: Service;
  ids: string[];
  onDone: () => void;
}) {
  const { copy } = state;
  const count = readOnlyActions(service, ids).length;
  if (!count) return null;
  return (
    <Alert data-read-only-hint>
      <AlertDescription>
        {copy.readOnlyFound.replace("{n}", String(count))}
      </AlertDescription>
      <AlertAction>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={state.busy}
          onClick={() =>
            void markReadOnly(state, service, ids).then((saved) => {
              if (saved) onDone();
            })
          }
        >
          {copy.markReads}
        </Button>
      </AlertAction>
    </Alert>
  );
}

function ActionEditor({
  state,
  service,
  action,
  personal = null,
  close,
}: {
  state: CatalogState;
  service: Service;
  action?: ServiceAction;
  personal?: PersonalMode;
  close: () => void;
}) {
  const { copy } = state;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [base] = useState({
    serviceRevision: service.revision,
    revision: action?.revision ?? 0,
  });
  const [value, setValue] = useState<z.infer<typeof ActionSettings>>(
    action
      ? ActionSettings.parse(
          Object.fromEntries(
            Object.keys(ActionSettings.shape).map((k) => [
              k,
              action[k as keyof ServiceAction],
            ]),
          ),
        )
      : {
          name: "",
          description: "",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          binding:
            service.protocol === "mcp"
              ? { type: "mcp", name: "" }
              : {
                  type: "http",
                  method: "GET",
                  path: "/",
                  parameters: [],
                  body: false,
                },
          effect: "read",
          approval: "always",
          enabled: false,
          policy: { roles: [], users: [] },
        },
  );
  const [schema, setSchema] = useState(
      JSON.stringify(value.inputSchema, null, 2),
    ),
    [parameters, setParameters] = useState(
      JSON.stringify(
        value.binding.type === "http" ? value.binding.parameters : [],
        null,
        2,
      ),
    );
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const settings = ActionSettings.parse({
        ...value,
        inputSchema: JSON.parse(schema),
        binding:
          value.binding.type === "http"
            ? { ...value.binding, parameters: JSON.parse(parameters) }
            : value.binding,
      });
      const result = await state.mutate("command", {
        type: "saveAction",
        serviceId: service.id,
        ...base,
        ...(action ? { id: action.id } : {}),
        settings,
      });
      if (result) close();
    } catch (e) {
      if (e instanceof SyntaxError) setAdvancedOpen(true);
      state.setError(
        e instanceof SyntaxError ? copy.invalid : catalogIssue(e, copy),
      );
    }
  }
  const overrides = value.policy.users.length;
  return (
    <form
      onSubmit={(e) => void save(e)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <fieldset
        disabled={state.busy}
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4"
      >
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="action-enabled">{copy.enabled}</FieldLabel>
            <Switch
              id="action-enabled"
              checked={value.enabled}
              onCheckedChange={(enabled) => setValue({ ...value, enabled })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="action-name">{copy.name}</FieldLabel>
            <Input
              id="action-name"
              value={value.name}
              onChange={(e) => setValue({ ...value, name: e.target.value })}
              maxLength={100}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="action-description">
              {copy.description}
            </FieldLabel>
            <Textarea
              id="action-description"
              value={value.description}
              onChange={(e) =>
                setValue({ ...value, description: e.target.value })
              }
              maxLength={2000}
              rows={3}
            />
          </Field>
          {value.binding.type === "http" ? (
            <div className="grid grid-cols-3 gap-3">
              <Field>
                <FieldLabel htmlFor="action-method">{copy.method}</FieldLabel>
                <Select
                  value={value.binding.method}
                  onValueChange={(method) => {
                    if (value.binding.type === "http")
                      setValue({
                        ...value,
                        effect: method === "GET" ? value.effect : "write",
                        binding: {
                          ...value.binding,
                          method: method as "GET",
                        },
                      });
                  }}
                >
                  <SelectTrigger id="action-method" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field className="col-span-2">
                <FieldLabel htmlFor="action-path">{copy.path}</FieldLabel>
                <Input
                  id="action-path"
                  mono
                  value={value.binding.path}
                  onChange={(e) => {
                    if (value.binding.type === "http")
                      setValue({
                        ...value,
                        binding: { ...value.binding, path: e.target.value },
                      });
                  }}
                  required
                />
              </Field>
            </div>
          ) : (
            <Field>
              <FieldLabel htmlFor="action-tool">{copy.mcpTool}</FieldLabel>
              <Input
                id="action-tool"
                mono
                value={value.binding.catalogTool ?? value.binding.name}
                onChange={(e) =>
                  setValue({
                    ...value,
                    binding:
                      value.binding.type === "mcp" &&
                      value.binding.catalogTool !== undefined
                        ? { ...value.binding, catalogTool: e.target.value }
                        : { type: "mcp", name: e.target.value },
                  })
                }
                required
              />
            </Field>
          )}
          <Field>
            <FieldLabel id="action-effect-label">{copy.effect}</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              aria-labelledby="action-effect-label"
              value={value.effect}
              onValueChange={(effect) =>
                effect &&
                setValue({ ...value, effect: effect as "read" | "write" })
              }
            >
              <ToggleGroupItem
                value="read"
                disabled={
                  value.binding.type === "http" &&
                  value.binding.method !== "GET"
                }
              >
                {copy.read}
              </ToggleGroupItem>
              <ToggleGroupItem value="write">{copy.write}</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          {personallyManaged(personal, value) ? (
            <p className="text-sm text-muted-foreground">
              {copy.personalAction}
            </p>
          ) : (
            <Field>
              <FieldLabel id="action-approval-label">
                {copy.approval}
              </FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                aria-labelledby="action-approval-label"
                value={value.approval}
                onValueChange={(approval) =>
                  approval &&
                  setValue({
                    ...value,
                    approval: approval as "always" | "never",
                  })
                }
              >
                <ToggleGroupItem value="always">{copy.always}</ToggleGroupItem>
                <ToggleGroupItem value="never">{copy.never}</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          )}
        </FieldGroup>
        {/* Under personal sign-in the service's "who can connect" is the only grant. */}
        <FieldSet hidden={personallyManaged(personal, value)}>
          <FieldLegend variant="label">{copy.access}</FieldLegend>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {(["owner", "admin", "member"] as const).map((role) => (
              <Field key={role} orientation="horizontal" className="w-auto">
                <Checkbox
                  id={`role-${role}`}
                  checked={value.policy.roles.includes(role)}
                  onCheckedChange={(v) =>
                    setValue({
                      ...value,
                      policy: {
                        ...value.policy,
                        roles:
                          v === true
                            ? [...value.policy.roles, role]
                            : value.policy.roles.filter((r) => r !== role),
                      },
                    })
                  }
                />
                <FieldLabel htmlFor={`role-${role}`}>{copy[role]}</FieldLabel>
              </Field>
            ))}
          </div>
          <WorkspaceRolePicker
            roles={state.scope.workspace?.roles ?? []}
            value={value.policy.workspaceRoles ?? []}
            onChange={(workspaceRoles) =>
              setValue({
                ...value,
                policy: { ...value.policy, workspaceRoles },
              })
            }
          />
          <Disclosure
            title={
              <>
                {copy.people}
                {overrides > 0 && (
                  <Badge variant="secondary">{overrides}</Badge>
                )}
              </>
            }
          >
            <div className="divide-y rounded-lg border">
              {state.scope.detail.data?.members.map((member) => (
                <div
                  key={member.userId}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <label
                    htmlFor={`user-${member.userId}`}
                    className="min-w-0 truncate text-sm"
                  >
                    {member.name}
                  </label>
                  <Select
                    value={
                      value.policy.users.find((u) => u.userId === member.userId)
                        ?.access ?? "inherit"
                    }
                    onValueChange={(access) =>
                      setValue({
                        ...value,
                        policy: {
                          ...value.policy,
                          users: [
                            ...value.policy.users.filter(
                              (u) => u.userId !== member.userId,
                            ),
                            ...(access === "inherit"
                              ? []
                              : [
                                  {
                                    userId: member.userId,
                                    access: access as "allow" | "deny",
                                  },
                                ]),
                          ],
                        },
                      })
                    }
                  >
                    <SelectTrigger id={`user-${member.userId}`} size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">{copy.inherit}</SelectItem>
                      <SelectItem value="allow">{copy.allow}</SelectItem>
                      <SelectItem value="deny">{copy.deny}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </Disclosure>
        </FieldSet>
        <Disclosure
          title={copy.advanced}
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="action-schema">{copy.schema}</FieldLabel>
              <Textarea
                id="action-schema"
                mono
                className="min-h-40"
                value={schema}
                onChange={(e) => setSchema(e.target.value)}
                spellCheck={false}
              />
            </Field>
            {value.binding.type === "http" && (
              <>
                <Field>
                  <FieldLabel htmlFor="action-params">
                    {copy.parameters}
                  </FieldLabel>
                  <Textarea
                    id="action-params"
                    mono
                    value={parameters}
                    onChange={(e) => setParameters(e.target.value)}
                    spellCheck={false}
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="action-body">{copy.body}</FieldLabel>
                  <Switch
                    id="action-body"
                    checked={value.binding.body}
                    onCheckedChange={(body) => {
                      if (value.binding.type === "http")
                        setValue({
                          ...value,
                          binding: { ...value.binding, body },
                        });
                    }}
                  />
                </Field>
              </>
            )}
          </FieldGroup>
        </Disclosure>
        {action && (
          <ActionRunner state={state} service={service} action={action} />
        )}
      </fieldset>
      <SheetFooter>
        {action && (
          <span className="sm:mr-auto">
            <DeleteButton
              label={copy.deleteAction}
              title={`${copy.deleteAction}: ${action.name}`}
              disabled={state.busy}
              onDelete={() =>
                void state
                  .mutate("command", {
                    type: "removeAction",
                    serviceId: service.id,
                    serviceRevision: base.serviceRevision,
                    id: action.id,
                    revision: base.revision,
                  })
                  .then((r) => {
                    if (r) close();
                  })
              }
            />
          </span>
        )}
        <Button
          variant="outline"
          onClick={close}
          type="button"
          disabled={state.busy}
        >
          {copy.cancel}
        </Button>
        <SubmitButton pending={state.busy}>{copy.save}</SubmitButton>
      </SheetFooter>
    </form>
  );
}

function ActionRunner({
  state,
  service,
  action,
}: {
  state: CatalogState;
  service: Service;
  action: ServiceAction;
}) {
  const { copy } = state;
  const [input, setInput] = useState("{}"),
    [requestId, setRequestId] = useState(() => crypto.randomUUID()),
    [result, setResult] = useState<{ status: string; result?: unknown } | null>(
      null,
    );
  async function run(approve = false) {
    try {
      const response = await state.mutate("invoke", {
        serviceId: service.id,
        serviceRevision: service.revision,
        actionId: action.id,
        revision: action.revision,
        input: JSON.parse(input),
        requestId,
        approve,
      });
      if (response) setResult(response as typeof result);
    } catch (e) {
      state.setError(catalogIssue(e, copy));
    }
  }
  return (
    <Disclosure title={copy.test}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`run-${action.id}`}>{copy.input}</FieldLabel>
          <Textarea
            id={`run-${action.id}`}
            mono
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setResult(null);
              setRequestId(crypto.randomUUID());
            }}
            disabled={state.busy || result?.status === "running"}
          />
        </Field>
        {result && (
          <p role="status" className="text-sm">
            {copy[result.status as keyof typeof copy] ?? result.status}
          </p>
        )}
        {result?.result !== undefined && (
          <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
            {JSON.stringify(result.result, null, 2)}
          </pre>
        )}
        <Button
          type="button"
          className="self-start"
          variant="secondary"
          disabled={
            state.busy ||
            !service.enabled ||
            !action.enabled ||
            (!!result && result.status !== "awaiting_approval")
          }
          onClick={() => void run(result?.status === "awaiting_approval")}
        >
          {result?.status === "awaiting_approval" ? copy.approve : copy.run}
        </Button>
      </FieldGroup>
    </Disclosure>
  );
}
