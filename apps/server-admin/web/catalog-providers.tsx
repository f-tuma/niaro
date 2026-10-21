import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ChevronLeft,
  ChevronRight,
  Cpu,
  Download,
  GitBranch,
  Lock,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  ProviderSettings,
  CatalogModelSettings,
  type Provider,
  type CatalogModel,
  type DiscoveredModel,
  type Catalog,
} from "../../../packages/protocol/service-catalog";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Switch } from "@admin/components/ui/switch";
import { Checkbox } from "@admin/components/ui/checkbox";
import { Progress } from "@admin/components/ui/progress";
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
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@admin/components/ui/input-group";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@admin/components/ui/card";
import { Badge } from "@admin/components/ui/badge";
import {
  AlertAction,
  Alert,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import { PageHeader, Section } from "@admin/components/console/page";
import {
  ConfirmAction,
  MoreActions,
  SaveBar,
  SearchField,
} from "@admin/components/console/forms";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@admin/components/ui/dropdown-menu";
import { StatusBadge } from "@admin/components/console/status";
import { SettingRow, SettingRows } from "@admin/components/console/setting-row";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { Spinner } from "@admin/components/ui/spinner";
import {
  useCatalog,
  CatalogBoundary,
  type CatalogState,
} from "./catalog-shared";
import { ServiceAvatar } from "./service-avatar";
import { ProviderModelPicker } from "./provider-model-picker";
import { ModelChoicePicker, type ModelChoice } from "./model-choice-picker";
import { useAdmin } from "./context";
import { useShellCopy } from "./shell-copy";
import { ApiError } from "./lib/api";

/** Short lists are scanned by eye; search appears past this many items. */
const searchThreshold = 6;

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function NotManager({ state }: { state: CatalogState }) {
  return (
    <Empty variant="outline">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Lock />
        </EmptyMedia>
        <EmptyTitle>{state.copy.notManager}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

export function ProvidersPage() {
  const state = useCatalog(),
    { copy } = state;
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const providers = state.query.data?.providers ?? [];
  const matching = providers.filter((p) =>
    `${p.name} ${p.url}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const canManage = !!state.query.data?.canManage;
  return (
    <>
      <PageHeader
        title={copy.providers}
        count={providers.length || undefined}
        toolbar={
          canManage &&
          providers.length > searchThreshold && (
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder={copy.searchProviders}
            />
          )
        }
        actions={
          canManage &&
          providers.length > 0 && (
            <Button onClick={() => setAdding(true)} disabled={state.busy}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {copy.addProvider}
            </Button>
          )
        }
      />
      <CatalogBoundary state={state}>
        {!canManage ? (
          <NotManager state={state} />
        ) : !providers.length ? (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Cpu />
              </EmptyMedia>
              <EmptyTitle>{copy.noProviders}</EmptyTitle>
              <EmptyDescription>{copy.noProvidersHint}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setAdding(true)}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                {copy.addProvider}
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            {matching.length ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {matching.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    state={state}
                    provider={provider}
                  />
                ))}
              </div>
            ) : (
              <Empty variant="outline">
                <EmptyHeader>
                  <EmptyTitle>{copy.noProvidersFound}</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" onClick={() => setSearch("")}>
                    {copy.clearSearch}
                  </Button>
                </EmptyContent>
              </Empty>
            )}
          </>
        )}
      </CatalogBoundary>
      <ProviderSheet
        state={state}
        open={adding}
        onOpenChange={setAdding}
        saved={(id) => {
          setAdding(false);
          void navigate({
            to: "/providers/$providerId",
            params: { providerId: id },
          });
        }}
      />
    </>
  );
}

function ProviderCard({
  state,
  provider,
}: {
  state: CatalogState;
  provider: Provider;
}) {
  const { copy } = state;
  const models =
    state.query.data?.models.filter((m) => m.providerId === provider.id) ?? [];
  return (
    <Card variant="interactive">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <EntityIcon>
            <Cpu aria-hidden="true" />
          </EntityIcon>
          {!provider.enabled && (
            <StatusBadge tone="neutral">{copy.paused}</StatusBadge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle>
            <Link
              to="/providers/$providerId"
              params={{ providerId: provider.id }}
              className="block truncate outline-none after:absolute after:inset-0"
            >
              {provider.name}
            </Link>
          </CardTitle>
          <span className="truncate text-sm text-muted-foreground">
            {host(provider.url)}
          </span>
        </div>
      </CardContent>
      <CardFooter className="mt-auto">
        <div className="flex w-full items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{copy.models}</span>
          <span className="tabular-nums">
            {models.filter((m) => m.enabled).length}/{models.length}
          </span>
        </div>
      </CardFooter>
    </Card>
  );
}

export function ProviderDetailPage() {
  const { providerId } = useParams({ strict: false });
  const state = useCatalog();
  const provider = state.query.data?.providers.find((p) => p.id === providerId);
  const forbidden = [
    state.query.error,
    state.scope.identity.error,
    state.scope.detail.error,
  ].some(
    (error) =>
      error instanceof ApiError && [401, 403, 404].includes(error.status),
  );
  const visibleProvider =
    forbidden || !state.query.data?.canManage ? undefined : provider;
  const [editing, setEditing] = useState(false);
  const { language } = useAdmin();
  return (
    <>
      <PageHeader
        title={visibleProvider?.name ?? state.copy.providers}
        description={visibleProvider ? host(visibleProvider.url) : undefined}
        back={{ to: "/providers", label: state.copy.providers }}
        media={
          visibleProvider && (
            <EntityIcon size="lg">
              <Cpu aria-hidden="true" />
            </EntityIcon>
          )
        }
        meta={
          visibleProvider && (
            <>
              {!visibleProvider.enabled && (
                <StatusBadge tone="neutral">{state.copy.paused}</StatusBadge>
              )}
              <Progress
                className="w-16"
                aria-label={state.copy.used}
                value={Math.min(
                  100,
                  Math.round(
                    (visibleProvider.requestsToday /
                      visibleProvider.dailyRequestLimit) *
                      100,
                  ),
                )}
              />
              <span className="text-xs text-muted-foreground tabular-nums">
                {visibleProvider.requestsToday.toLocaleString(language)} /{" "}
                {visibleProvider.dailyRequestLimit.toLocaleString(language)}{" "}
                {state.copy.requestsUsed}
              </span>
            </>
          )
        }
        actions={
          visibleProvider && (
            <>
              <Button
                variant="outline"
                disabled={state.busy}
                onClick={() => setEditing(true)}
              >
                <Pencil data-icon="inline-start" aria-hidden="true" />
                {state.copy.edit}
              </Button>
              <ProviderMenu state={state} provider={visibleProvider} />
            </>
          )
        }
      />
      {visibleProvider && (
        <ProviderSheet
          state={state}
          provider={visibleProvider}
          open={editing}
          onOpenChange={setEditing}
          saved={() => setEditing(false)}
        />
      )}
      <CatalogBoundary state={state}>
        {!state.query.data?.canManage ? (
          <NotManager state={state} />
        ) : provider ? (
          <ProviderDetail
            key={`${state.target.organizationId}:${provider.id}`}
            state={state}
            provider={provider}
          />
        ) : (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyTitle>{state.copy.noProvidersFound}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </CatalogBoundary>
    </>
  );
}

/** Destructive provider actions live in the header overflow menu. */
function ProviderMenu({
  state,
  provider,
}: {
  state: CatalogState;
  provider: Provider;
}) {
  const { copy } = state;
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <MoreActions label={copy.moreActions}>
        <DropdownMenuItem asChild>
          <Link to="/routing">
            <GitBranch aria-hidden="true" />
            {copy.routing}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={state.busy}
          onSelect={() => setConfirm(true)}
        >
          <Trash2 aria-hidden="true" />
          {copy.deleteProvider}
        </DropdownMenuItem>
      </MoreActions>
      <ConfirmAction
        open={confirm}
        onOpenChange={setConfirm}
        title={copy.confirmRemoveProvider}
        confirmLabel={copy.deleteProvider}
        cancelLabel={copy.cancel}
        onConfirm={async () => {
          if (
            await state.mutate("command", {
              type: "removeProvider",
              id: provider.id,
              revision: provider.revision,
            })
          )
            void navigate({ to: "/providers" });
        }}
      />
    </>
  );
}

function ProviderSheet({
  state,
  provider,
  open,
  onOpenChange,
  saved,
}: {
  state: CatalogState;
  provider?: Provider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saved: (id: string) => void;
}) {
  const { copy } = state;
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && state.busy) return;
        onOpenChange(next);
      }}
    >
      <SheetContent size="lg">
        <SheetHeader>
          <div className="pr-8">
            <SheetTitle>
              {provider ? copy.providerSettings : copy.addProvider}
            </SheetTitle>
          </div>
          {provider && <SheetDescription>{provider.name}</SheetDescription>}
        </SheetHeader>
        {open && (
          <ProviderForm
            state={state}
            provider={provider}
            close={() => onOpenChange(false)}
            saved={saved}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ProviderForm({
  state,
  provider,
  close,
  saved,
}: {
  state: CatalogState;
  provider?: Provider;
  close: () => void;
  saved: (id: string) => void;
}) {
  const { copy } = state;
  const [value, setValue] = useState(
    provider
      ? {
          name: provider.name,
          url: provider.url,
          enabled: provider.enabled,
          dailyRequestLimit: provider.dailyRequestLimit,
        }
      : {
          name: "",
          url: "https://openrouter.ai/api/v1",
          enabled: true,
          dailyRequestLimit: 1000,
        },
  );
  const [revision] = useState(provider?.revision ?? 0),
    [key, setKey] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const settings = ProviderSettings.safeParse(value);
    if (!settings.success) {
      state.setError(copy.invalid);
      return;
    }
    const result = await state.mutate("command", {
      type: "saveProvider",
      ...(provider ? { id: provider.id } : {}),
      revision,
      settings: settings.data,
      ...(key ? { apiKey: key } : {}),
    });
    if (result && typeof result === "object" && "id" in result) {
      setKey("");
      saved(String(result.id));
    }
  }
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => void submit(e)}
    >
      <fieldset disabled={state.busy} className="contents">
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <EditorError state={state} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider-name">{copy.name}</FieldLabel>
              <Input
                id="provider-name"
                value={value.name}
                onChange={(e) => setValue({ ...value, name: e.target.value })}
                required
                maxLength={100}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-url">{copy.providerUrl}</FieldLabel>
              <Input
                id="provider-url"
                type="url"
                value={value.url}
                onChange={(e) => setValue({ ...value, url: e.target.value })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-key">{copy.key}</FieldLabel>
              <Input
                id="provider-key"
                type="password"
                autoComplete="new-password"
                placeholder={provider?.hasCredential ? "••••••••" : undefined}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-limit">{copy.budget}</FieldLabel>
              <Input
                id="provider-limit"
                type="number"
                min={1}
                max={100000}
                value={value.dailyRequestLimit}
                onChange={(e) =>
                  setValue({
                    ...value,
                    dailyRequestLimit: Number(e.target.value),
                  })
                }
                required
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="provider-enabled">
                  {copy.enabled}
                </FieldLabel>
              </FieldContent>
              <Switch
                id="provider-enabled"
                checked={value.enabled}
                onCheckedChange={(v) => setValue({ ...value, enabled: v })}
              />
            </Field>
          </FieldGroup>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t p-4">
          <Button type="button" variant="ghost" onClick={close}>
            {copy.cancel}
          </Button>
          <Button type="submit">
            {state.busy && <Spinner data-icon="inline-start" />}
            {provider ? copy.save : copy.addProvider}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function ProviderDetail({
  state,
  provider,
}: {
  state: CatalogState;
  provider: Provider;
}) {
  const { copy } = state;
  const [modelEditor, setModelEditor] = useState<string | null>(null),
    [catalogOpen, setCatalogOpen] = useState(false),
    [modelSeed, setModelSeed] = useState<DiscoveredModel | undefined>();
  const [deletingModel, setDeletingModel] = useState<CatalogModel | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const editorTrigger = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const models = state.query.data!.models.filter(
    (m) => m.providerId === provider.id,
  );
  const matching = models.filter((model) =>
    `${model.name} ${model.model}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(matching.length / 20));
  const currentPage = Math.min(page, pages - 1);
  const visible = matching.slice(currentPage * 20, currentPage * 20 + 20);
  const chosen = models.filter((model) => selected.includes(model.id));
  const allVisibleSelected =
    visible.length > 0 && visible.every((model) => selected.includes(model.id));
  const busy = state.busy || bulkBusy;
  async function setModelsEnabled(
    list: CatalogModel[],
    enabled: boolean,
    bulk = true,
  ) {
    setBulkBusy(true);
    try {
      for (const model of list) {
        if (!mounted.current) break;
        if (model.enabled !== enabled) {
          const { id, revision, ...settings } = model;
          const result = await state.mutate("command", {
            type: "saveModel",
            id,
            revision,
            settings: { ...settings, enabled },
          });
          if (!result) break;
        }
        if (bulk && mounted.current)
          setSelected((ids) => ids.filter((id) => id !== model.id));
      }
    } finally {
      if (mounted.current) setBulkBusy(false);
    }
  }
  function editModel(id: string, trigger: HTMLElement | null) {
    editorTrigger.current = trigger;
    state.setError(null);
    setModelSeed(undefined);
    setCatalogOpen(false);
    setModelEditor(id);
  }
  const editedModel = models.find((model) => model.id === modelEditor);
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Section
        title={copy.models}
        count={models.length}
        toolbar={
          models.length > searchThreshold && (
            <SearchField
              value={search}
              placeholder={copy.searchModels}
              onChange={(value) => {
                setSearch(value);
                setPage(0);
              }}
            />
          )
        }
        actions={
          models.length > 0 && (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setModelEditor(null);
                  setCatalogOpen(true);
                }}
              >
                <Download data-icon="inline-start" aria-hidden="true" />
                {copy.fetchModels}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={(event) => editModel("new", event.currentTarget)}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                {copy.addModel}
              </Button>
            </>
          )
        }
      >
        {matching.length ? (
          <Card variant="flush">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label={copy.selectPage}
                      checked={
                        allVisibleSelected
                          ? true
                          : visible.some((model) => selected.includes(model.id))
                            ? "indeterminate"
                            : false
                      }
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        setSelected((ids) =>
                          checked === true
                            ? [
                                ...new Set([
                                  ...ids,
                                  ...visible.map((model) => model.id),
                                ]),
                              ]
                            : ids.filter(
                                (id) =>
                                  !visible.some((model) => model.id === id),
                              ),
                        )
                      }
                    />
                  </TableHead>
                  <TableHead>{copy.model}</TableHead>
                  <TableHead className="hidden w-2/5 md:table-cell">
                    {copy.capabilities}
                  </TableHead>
                  <TableHead className="w-20 text-right">
                    {copy.enabled}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((m) => (
                  <TableRow
                    key={m.id}
                    data-state={
                      selected.includes(m.id) ? "selected" : undefined
                    }
                  >
                    <TableCell>
                      <Checkbox
                        aria-label={`${copy.selectModel}: ${m.name}`}
                        checked={selected.includes(m.id)}
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          setSelected((ids) =>
                            checked === true
                              ? [...ids, m.id]
                              : ids.filter((id) => id !== m.id),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell className="max-w-0">
                      <button
                        type="button"
                        className="block max-w-full truncate text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:underline disabled:opacity-50"
                        title={`${copy.edit}: ${m.name}`}
                        disabled={busy}
                        onClick={(event) =>
                          editModel(m.id, event.currentTarget)
                        }
                      >
                        {m.name}
                      </button>
                      <p
                        className="truncate font-mono text-xs text-muted-foreground"
                        title={m.model}
                      >
                        {m.model}
                      </p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Capabilities model={m} copy={copy} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Switch
                        aria-label={`${copy.enabled}: ${m.name}`}
                        checked={m.enabled}
                        disabled={busy}
                        onCheckedChange={(enabled) =>
                          void setModelsEnabled([m], enabled, false)
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <Empty variant="outline">
            <EmptyHeader>
              {!models.length && (
                <EmptyMedia variant="icon">
                  <Cpu />
                </EmptyMedia>
              )}
              <EmptyTitle>
                {models.length ? copy.noMatchingModels : copy.noModels}
              </EmptyTitle>
            </EmptyHeader>
            {!models.length && (
              <EmptyContent>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setModelEditor(null);
                    setCatalogOpen(true);
                  }}
                >
                  <Download data-icon="inline-start" aria-hidden="true" />
                  {copy.fetchModels}
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={copy.previous}
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">
              {currentPage + 1} / {pages}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={copy.next}
              disabled={currentPage + 1 >= pages}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        )}
      </Section>
      {chosen.length > 0 && (
        <SaveBar status={`${copy.selectedModels}: ${chosen.length}`}>
          <Button
            variant="outline"
            disabled={busy || chosen.every((model) => model.enabled)}
            onClick={() => void setModelsEnabled(chosen, true)}
          >
            {copy.enableSelected}
          </Button>
          <Button
            variant="outline"
            disabled={busy || chosen.every((model) => !model.enabled)}
            onClick={() => void setModelsEnabled(chosen, false)}
          >
            {copy.pauseSelected}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={copy.clearSelection}
            disabled={busy}
            onClick={() => setSelected([])}
          >
            <X aria-hidden="true" />
          </Button>
        </SaveBar>
      )}
      <Sheet
        open={catalogOpen}
        onOpenChange={(open) => {
          if (!open && state.busy) return;
          setCatalogOpen(open);
        }}
      >
        <SheetContent size="lg">
          {catalogOpen && (
            <ProviderModelPicker
              key={`${state.target.workspaceId}:${provider.id}:${provider.revision}`}
              state={state}
              provider={provider}
              onClose={() => setCatalogOpen(false)}
              onConfigure={(model) => {
                editorTrigger.current = null;
                state.setError(null);
                setModelSeed(model);
                setCatalogOpen(false);
                setModelEditor("new");
              }}
            />
          )}
        </SheetContent>
      </Sheet>
      <Sheet
        open={modelEditor !== null}
        onOpenChange={(open) => {
          if (!open && !state.busy) setModelEditor(null);
        }}
      >
        <SheetContent
          size="lg"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById("model-name")?.focus();
          }}
          onCloseAutoFocus={(event) => {
            const target = editorTrigger.current;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <SheetHeader>
            <div className="flex items-center justify-between gap-2 pr-8">
              <SheetTitle>
                {modelEditor === "new"
                  ? copy.addModel
                  : (editedModel?.name ?? copy.model)}
              </SheetTitle>
              {editedModel && (
                <MoreActions label={copy.moreActions} size="sm">
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={busy}
                    onSelect={() => setDeletingModel(editedModel)}
                  >
                    <Trash2 aria-hidden="true" />
                    {copy.deleteModel}
                  </DropdownMenuItem>
                </MoreActions>
              )}
            </div>
          </SheetHeader>
          {modelEditor && (
            <ModelForm
              key={`${modelEditor}:${modelSeed?.model ?? ""}`}
              seed={modelSeed}
              state={state}
              provider={provider}
              model={editedModel}
              close={() => setModelEditor(null)}
            />
          )}
        </SheetContent>
      </Sheet>
      <ConfirmAction
        open={!!deletingModel}
        onOpenChange={(open) => {
          if (!open) setDeletingModel(null);
        }}
        title={copy.confirmRemoveModel}
        confirmLabel={copy.deleteModel}
        cancelLabel={copy.cancel}
        onConfirm={async () => {
          if (!deletingModel) return;
          const result = await state.mutate("command", {
            type: "removeModel",
            id: deletingModel.id,
            revision: deletingModel.revision,
          });
          if (result) setModelEditor(null);
        }}
      />
    </div>
  );
}

function Capabilities({
  model: m,
  copy,
}: {
  model: CatalogModel;
  copy: CatalogState["copy"];
}) {
  const labels = [
    m.kind === "router" && copy.routerModel,
    m.kind === "transcription" && copy.transcriptionModel,
    m.kind === "decision" && copy.decisionModel,
    (m.kind === "chat" || m.kind === "router") && m.tools && copy.tools,
    (m.audioOutput || m.kind === "speech") && copy.audioOutput,
    m.kind === "chat" && m.audioInput && copy.audioInput,
  ].filter((label): label is string => !!label);
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <Badge key={label} variant="outline">
          {label}
        </Badge>
      ))}
    </div>
  );
}

function EditorError({ state }: { state: CatalogState }) {
  const error = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.error && !state.busy) error.current?.focus();
  }, [state.error, state.busy]);
  if (!state.error) return null;
  return (
    <div className="pb-4">
      <Alert ref={error} tabIndex={-1} variant="destructive">
        <AlertDescription>{state.error}</AlertDescription>
        {state.conflict && (
          <AlertAction>
            <Button
              type="button"
              variant="outline"
              disabled={state.busy}
              onClick={() => void state.resetDrafts()}
            >
              {state.copy.reloadSaved}
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
}

function SwitchField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Field>
  );
}

function ModelForm({
  state,
  provider,
  model,
  seed,
  close,
}: {
  state: CatalogState;
  provider: Provider;
  model?: CatalogModel;
  seed?: DiscoveredModel;
  close: () => void;
}) {
  const { copy } = state;
  const [value, setValue] = useState(
    model
      ? {
          providerId: model.providerId,
          name: model.name,
          model: model.model,
          enabled: model.enabled,
          tools: model.tools,
          audioInput: model.audioInput,
          audioOutput: model.audioOutput,
          kind: model.kind,
        }
      : {
          providerId: provider.id,
          name: seed?.name ?? "",
          model: seed?.model ?? "",
          enabled: true,
          tools: seed?.tools === true,
          audioInput: seed?.audioInput === true,
          audioOutput: seed?.audioOutput === true,
          kind: seed?.kind ?? ("chat" as CatalogModel["kind"]),
        },
  );
  const [revision] = useState(model?.revision ?? 0);
  function setKind(kind: CatalogModel["kind"]) {
    setValue({
      ...value,
      kind,
      ...(kind === "decision" || kind === "transcription" || kind === "speech"
        ? {
            tools: false,
            audioInput: false,
            audioOutput: kind === "speech",
            model:
              value.model || (kind === "decision" ? "typesafe/jev-1.13" : ""),
            name: value.name || (kind === "decision" ? "Jev 1.13" : ""),
          }
        : {}),
    });
  }
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        const settings = CatalogModelSettings.safeParse(value);
        if (!settings.success) {
          state.setError(copy.invalid);
          return;
        }
        void state
          .mutate("command", {
            type: "saveModel",
            ...(model ? { id: model.id } : {}),
            revision,
            settings: settings.data,
          })
          .then((r) => {
            if (r) close();
          });
      }}
    >
      <fieldset disabled={state.busy} className="contents">
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <EditorError state={state} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="model-name">{copy.name}</FieldLabel>
              <Input
                id="model-name"
                value={value.name}
                onChange={(e) => setValue({ ...value, name: e.target.value })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="model-id">{copy.modelId}</FieldLabel>
              <Input
                id="model-id"
                value={value.model}
                onChange={(e) => setValue({ ...value, model: e.target.value })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="model-kind">{copy.modelKind}</FieldLabel>
              <Select
                value={value.kind}
                onValueChange={(kind) => setKind(kind as CatalogModel["kind"])}
              >
                <SelectTrigger id="model-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {value.kind === "router" && (
                    <SelectItem value="router">{copy.routerModel}</SelectItem>
                  )}
                  <SelectItem value="chat">{copy.chatModel}</SelectItem>
                  <SelectItem value="speech">{copy.speechDirect}</SelectItem>
                  <SelectItem value="transcription">
                    {copy.transcriptionModel}
                  </SelectItem>
                  <SelectItem value="decision">{copy.decisionModel}</SelectItem>
                </SelectContent>
              </Select>
              {value.kind === "decision" && (
                <FieldDescription>{copy.decisionModelHint}</FieldDescription>
              )}
            </Field>
            {(value.kind === "chat" || value.kind === "router") && (
              <Card variant="list">
                <div className="px-4 py-3">
                  <SwitchField
                    id="model-tools"
                    label={copy.tools}
                    checked={value.tools}
                    onChange={(tools) => setValue({ ...value, tools })}
                  />
                </div>
                {value.kind === "chat" && (
                  <div className="px-4 py-3">
                    <SwitchField
                      id="model-audio"
                      label={copy.audioInput}
                      checked={value.audioInput}
                      onChange={(audioInput) =>
                        setValue({ ...value, audioInput })
                      }
                    />
                  </div>
                )}
                {value.kind === "chat" && (
                  <div className="px-4 py-3">
                    <SwitchField
                      id="model-audio-output"
                      label={copy.audioOutput}
                      checked={value.audioOutput}
                      onChange={(audioOutput) =>
                        setValue({ ...value, audioOutput })
                      }
                    />
                  </div>
                )}
              </Card>
            )}
            {(value.kind === "chat" || value.kind === "router") &&
              seed?.tools === null && (
                <Alert>
                  <AlertDescription>{copy.toolUnknownHint}</AlertDescription>
                </Alert>
              )}
            <SwitchField
              id="model-enabled"
              label={copy.enabled}
              checked={value.enabled}
              onChange={(enabled) => setValue({ ...value, enabled })}
            />
          </FieldGroup>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t p-4">
          <Button type="button" variant="ghost" onClick={close}>
            {copy.cancel}
          </Button>
          <Button type="submit">
            {state.busy && <Spinner data-icon="inline-start" />}
            {copy.save}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function ModelSelect({
  state,
  value,
  onChange,
  id,
  label,
  fallback,
  inheritedModelId,
  showDefaultWarning = false,
  capability = "tools",
  legacy = false,
  hideLabel = false,
}: {
  state: CatalogState;
  value: string;
  onChange: (v: string) => void;
  id: string;
  label: string;
  fallback: string;
  inheritedModelId?: string | null;
  showDefaultWarning?: boolean;
  capability?:
    | "tools"
    | "audioInput"
    | "audioOutput"
    | "decision"
    | "transcription"
    | "speech";
  legacy?: boolean;
  /** Keeps the label for assistive technology only (dense rows). */
  hideLabel?: boolean;
}) {
  const { copy } = state;
  const models = state.query.data?.models ?? [],
    providers = state.query.data?.providers ?? [];
  const available = models.filter(
    (m) =>
      m.enabled &&
      (capability === "decision" ||
      capability === "transcription" ||
      capability === "speech"
        ? m.kind === capability
        : capability === "tools"
          ? (m.kind === "chat" || m.kind === "router") && m.tools
          : m.kind === "chat" && m[capability]) &&
      providers.some(
        (p) =>
          p.id === m.providerId &&
          p.enabled &&
          (capability === "tools" ||
            p.url.replace(/\/$/, "") === "https://openrouter.ai/api/v1"),
      ),
  );
  const missing =
    value &&
    !(legacy && value === "legacy") &&
    !available.some((m) => m.id === value);
  const inherited = models.find((m) => m.id === inheritedModelId);
  const effective = models.find((m) => m.id === (value || inheritedModelId));
  const choices: ModelChoice[] = [
    { value: "", label: fallback, detail: inherited?.name },
    ...(legacy ? [{ value: "legacy", label: copy.legacyVoice }] : []),
    ...(missing
      ? [
          {
            value,
            label:
              models.find((model) => model.id === value)?.name ?? copy.model,
            detail: copy.unavailableModel,
            disabled: true,
          },
        ]
      : []),
    ...providers.flatMap((provider) =>
      available
        .filter((model) => model.providerId === provider.id)
        .map((model) => ({
          value: model.id,
          label: model.name,
          detail: model.model,
          mono: true,
          group: provider.name,
        })),
    ),
  ];
  return (
    <Field>
      <FieldLabel htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </FieldLabel>
      <ModelChoicePicker
        id={id}
        label={label}
        value={value}
        choices={choices}
        disabled={state.busy || !state.query.data?.canManage}
        searchLabel={copy.searchModels}
        emptyLabel={copy.noMatchingModels}
        onChange={(next) => {
          if (next !== value) onChange(next);
        }}
      />
      {effective && !available.some((model) => model.id === effective.id) && (
        <FieldDescription>
          <Badge variant="destructive">{copy.unavailableModel}</Badge>
        </FieldDescription>
      )}
      {showDefaultWarning && inheritedModelId === null && (
        <FieldDescription>
          <Link to="/routing">{copy.noDefaultModel}</Link>
        </FieldDescription>
      )}
      {available.length === 0 && state.query.data?.canManage && (
        <FieldDescription>
          <Link to="/providers">
            {capability === "tools"
              ? copy.noUsableModels
              : copy.noCapabilityModels}
          </Link>
        </FieldDescription>
      )}
    </Field>
  );
}

export function RoutingPage() {
  const state = useCatalog();
  return (
    <>
      <PageHeader title={state.copy.routing} />
      <CatalogBoundary state={state}>
        {state.query.data?.canManage ? (
          <RoutingForm key={state.target.workspaceId} state={state} />
        ) : (
          <NotManager state={state} />
        )}
      </CatalogBoundary>
    </>
  );
}

function RoutingForm({ state }: { state: CatalogState }) {
  const { copy } = state;
  const stage = useShellCopy();
  const [draft, setRouting] = useState<Catalog["routing"] | null>(null);
  const routing = draft ?? state.query.data!.routing;
  const catalog = state.query.data!;
  const invalid =
    (routing.decision.enabled &&
      (!routing.decision.modelId || !routing.modelId)) ||
    routing.decision.minConfidence < 0.5 ||
    routing.decision.minConfidence > 1;
  const voiceIn = (
    <Section
      title={stage.stageVoiceIn}
      actions={
        !catalog.voiceAvailable && (
          <StatusBadge tone="warning">{copy.voiceSetup}</StatusBadge>
        )
      }
    >
      <SettingRows>
        <SettingRow label={copy.voiceMethod} labelId="voice-method-label" wide>
          <ToggleGroup
            type="single"
            variant="outline"
            className="w-full"
            aria-labelledby="voice-method-label"
            value={routing.voiceMethod}
            disabled={state.busy}
            onValueChange={(method) => {
              if (method !== "interpreter" && method !== "transcription")
                return;
              if (method === routing.voiceMethod) return;
              setRouting({
                ...routing,
                voiceMethod: method,
                voiceModelId: null,
                voiceMode: "disabled",
              });
            }}
          >
            <ToggleGroupItem value="transcription" className="flex-1">
              {copy.directTranscription}
            </ToggleGroupItem>
            <ToggleGroupItem value="interpreter" className="flex-1">
              {copy.voiceInterpreter}
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>
        <SettingRow label={copy.model} wide>
          <ModelSelect
            state={state}
            hideLabel
            value={
              routing.voiceMode === "legacy"
                ? catalog.legacyVoiceAvailable
                  ? "legacy"
                  : ""
                : (routing.voiceModelId ?? "")
            }
            onChange={(id) =>
              setRouting({
                ...routing,
                voiceModelId: id === "legacy" ? null : id || null,
                voiceMode:
                  id === "legacy" ? "legacy" : id ? "catalog" : "disabled",
              })
            }
            id="routing-voice"
            label={`${stage.stageVoiceIn}: ${copy.model}`}
            fallback={copy.voiceOff}
            capability={
              routing.voiceMethod === "transcription"
                ? "transcription"
                : "audioInput"
            }
            legacy={catalog.legacyVoiceAvailable}
          />
        </SettingRow>
        {routing.voiceMethod !== "transcription" && (
          <SettingRow label={copy.meetingTranscription} wide>
            <ModelSelect
              state={state}
              hideLabel
              value={routing.meetingTranscriptionModelId ?? ""}
              onChange={(id) =>
                setRouting({
                  ...routing,
                  meetingTranscriptionModelId: id || null,
                })
              }
              id="routing-meeting-transcription"
              label={`${copy.meetingTranscription}: ${copy.model}`}
              fallback={copy.meetingTranscriptionFallback}
              capability="transcription"
            />
          </SettingRow>
        )}
      </SettingRows>
    </Section>
  );
  const voiceOut = (
    <Section title={stage.stageVoiceOut}>
      <SettingRows>
        <SettingRow label={copy.voiceMethod} labelId="speech-method-label" wide>
          <ToggleGroup
            type="single"
            variant="outline"
            className="w-full"
            aria-labelledby="speech-method-label"
            value={routing.speech.method}
            disabled={state.busy}
            onValueChange={(method) => {
              if (method !== "reader" && method !== "speech") return;
              if (method !== routing.speech.method)
                setRouting({
                  ...routing,
                  speech: { ...routing.speech, method, modelId: null },
                });
            }}
          >
            <ToggleGroupItem value="reader" className="flex-1">
              {copy.speechReader}
            </ToggleGroupItem>
            <ToggleGroupItem value="speech" className="flex-1">
              {copy.speechDirect}
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>
        <SettingRow label={copy.model} wide>
          <ModelSelect
            state={state}
            hideLabel
            value={routing.speech.modelId ?? ""}
            onChange={(id) =>
              setRouting({
                ...routing,
                speech: { ...routing.speech, modelId: id || null },
              })
            }
            id="routing-speech"
            label={`${stage.stageVoiceOut}: ${copy.model}`}
            fallback={copy.voiceOff}
            capability={
              routing.speech.method === "reader" ? "audioOutput" : "speech"
            }
          />
        </SettingRow>
        <SettingRow label={copy.speechVoice} htmlFor="speech-voice" wide>
          <Input
            id="speech-voice"
            disabled={state.busy}
            value={routing.speech.voice}
            maxLength={200}
            onChange={(e) =>
              setRouting({
                ...routing,
                speech: { ...routing.speech, voice: e.target.value },
              })
            }
          />
        </SettingRow>
        {routing.speech.method === "reader" && (
          <SettingRow
            label={copy.speechRetention}
            htmlFor="speech-retention"
            disabled={state.busy}
          >
            <Switch
              id="speech-retention"
              disabled={state.busy}
              checked={routing.speech.zeroDataRetention}
              onCheckedChange={(zeroDataRetention) =>
                setRouting({
                  ...routing,
                  speech: { ...routing.speech, zeroDataRetention },
                })
              }
            />
          </SettingRow>
        )}
      </SettingRows>
    </Section>
  );
  const decision = (
    <Section title={stage.stageDecision}>
      <SettingRows>
        <SettingRow label={copy.enableDecision} htmlFor="decision-enabled">
          <Switch
            id="decision-enabled"
            checked={routing.decision.enabled}
            onCheckedChange={(enabled) =>
              setRouting({
                ...routing,
                decision: { ...routing.decision, enabled },
              })
            }
          />
        </SettingRow>
        {routing.decision.enabled && (
          <>
            <SettingRow label={copy.model} wide>
              <ModelSelect
                state={state}
                hideLabel
                value={routing.decision.modelId ?? ""}
                onChange={(id) =>
                  setRouting({
                    ...routing,
                    decision: { ...routing.decision, modelId: id || null },
                  })
                }
                id="routing-decision"
                label={copy.decisionModel}
                fallback={copy.selectModel}
                capability="decision"
              />
            </SettingRow>
            <SettingRow
              label={copy.minConfidence}
              htmlFor="decision-confidence"
            >
              <InputGroup className="w-28">
                <InputGroupInput
                  id="decision-confidence"
                  type="number"
                  min={50}
                  max={100}
                  step={1}
                  disabled={state.busy}
                  value={Math.round(routing.decision.minConfidence * 100)}
                  onChange={(e) =>
                    setRouting({
                      ...routing,
                      decision: {
                        ...routing.decision,
                        minConfidence: Number(e.target.value) / 100,
                      },
                    })
                  }
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>%</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </SettingRow>
          </>
        )}
      </SettingRows>
    </Section>
  );
  return (
    <>
      <div className="@container/routing">
        <div className="grid items-start gap-8 @4xl/routing:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-8">
            <Section title={stage.stageModel}>
              <SettingRows>
                <SettingRow label={copy.defaultModel} wide>
                  <ModelSelect
                    state={state}
                    hideLabel
                    value={routing.modelId ?? ""}
                    onChange={(id) =>
                      setRouting({ ...routing, modelId: id || null })
                    }
                    id="routing-default"
                    label={copy.defaultModel}
                    fallback={copy.voiceOff}
                  />
                </SettingRow>
              </SettingRows>
            </Section>
            <Section title={copy.serviceModels} count={catalog.services.length}>
              {catalog.services.length ? (
                <SettingRows>
                  {catalog.services.map((s) => (
                    <SettingRow
                      key={s.id}
                      wide
                      label={
                        <>
                          <ServiceAvatar service={s} state={state} />
                          <span className="truncate">{s.name}</span>
                        </>
                      }
                    >
                      <ModelSelect
                        state={state}
                        id={`route-${s.id}`}
                        hideLabel
                        value={
                          routing.services.find((x) => x.serviceId === s.id)
                            ?.modelId ?? ""
                        }
                        onChange={(id) =>
                          setRouting({
                            ...routing,
                            services: [
                              ...routing.services.filter(
                                (x) => x.serviceId !== s.id,
                              ),
                              { serviceId: s.id, modelId: id || null },
                            ],
                          })
                        }
                        label={`${copy.model}: ${s.name}`}
                        fallback={copy.useDefault}
                        inheritedModelId={routing.modelId}
                      />
                    </SettingRow>
                  ))}
                </SettingRows>
              ) : (
                <Empty variant="outline">
                  <EmptyHeader>
                    <EmptyTitle>{copy.noServices}</EmptyTitle>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button asChild variant="outline">
                      <Link to="/services">{copy.addService}</Link>
                    </Button>
                  </EmptyContent>
                </Empty>
              )}
            </Section>
            {decision}
          </div>
          <div className="flex min-w-0 flex-col gap-8">
            {voiceIn}
            {voiceOut}
          </div>
        </div>
      </div>
      {(draft !== null || state.busy) && (
        <SaveBar status={copy.unsavedChanges}>
          <Button
            variant="ghost"
            disabled={state.busy || draft === null}
            onClick={() => setRouting(null)}
          >
            {copy.discardChanges}
          </Button>
          <Button
            disabled={state.busy || draft === null || invalid}
            onClick={() =>
              void state
                .mutate("command", {
                  type: "saveRouting",
                  routing: { ...routing, planner: "model" },
                })
                .then((result) => {
                  if (result) setRouting(null);
                })
            }
          >
            {state.busy && <Spinner data-icon="inline-start" />}
            {copy.save}
          </Button>
        </SaveBar>
      )}
    </>
  );
}
