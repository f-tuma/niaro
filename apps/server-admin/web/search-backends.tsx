import { useState, type FormEvent } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import {
  SearchBackendSettings,
  MAX_SEARCH_BACKENDS,
  type SearchBackend,
} from "../../../packages/protocol/service-catalog";
import {
  SEARCH_BACKEND_KINDS,
  SEARCH_BACKEND_PRESETS,
  type SearchBackendKindValue,
} from "../../../packages/protocol/providers";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Switch } from "@admin/components/ui/switch";
import { Card } from "@admin/components/ui/card";
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import { Section } from "@admin/components/console/page";
import { ConfirmAction } from "@admin/components/console/forms";
import { StatusBadge } from "@admin/components/console/status";
import { Spinner } from "@admin/components/ui/spinner";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import type { CatalogState } from "./catalog-shared";
import { useProviderCopy } from "./provider-copy";

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The organization's web search backends (SearXNG, Brave, Tavily) on the
 * providers page. A workspace chooses one on the Models page; keys are
 * write-only like provider keys.
 */
export function SearchBackendsSection({ state }: { state: CatalogState }) {
  const text = useProviderCopy(),
    { copy } = state;
  const backends = state.query.data?.searchBackends ?? [];
  const [editing, setEditing] = useState<SearchBackend | "new" | null>(null);
  const [removing, setRemoving] = useState<SearchBackend | null>(null);
  return (
    <Section
      title={text.searchBackends}
      count={backends.length || undefined}
      actions={
        <Button
          variant="outline"
          disabled={state.busy || backends.length >= MAX_SEARCH_BACKENDS}
          onClick={() => {
            state.setError(null);
            setEditing("new");
          }}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {text.addSearchBackend}
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">{text.searchBackendsHint}</p>
      {backends.length ? (
        <Card variant="flush">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{copy.name}</TableHead>
                <TableHead className="hidden md:table-cell">
                  {text.searchKind}
                </TableHead>
                <TableHead className="w-24 text-right">
                  <span className="sr-only">{copy.edit}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backends.map((backend) => (
                <TableRow key={backend.id}>
                  <TableCell className="max-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {backend.name}
                      </span>
                      {!backend.enabled && (
                        <StatusBadge tone="neutral">{copy.paused}</StatusBadge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {host(backend.url)}
                    </p>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {SEARCH_BACKEND_PRESETS[backend.kind].label}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${copy.edit}: ${backend.name}`}
                      disabled={state.busy}
                      onClick={() => {
                        state.setError(null);
                        setEditing(backend);
                      }}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${text.deleteSearchBackend}: ${backend.name}`}
                      disabled={state.busy}
                      onClick={() => setRemoving(backend)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Search aria-hidden="true" className="size-4" />
          {text.noSearchBackends}
        </p>
      )}
      <Sheet
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !state.busy) setEditing(null);
        }}
      >
        <SheetContent size="wide">
          <SheetHeader>
            <div className="pr-8">
              <SheetTitle>
                {editing === "new"
                  ? text.addSearchBackend
                  : text.searchBackendSettings}
              </SheetTitle>
            </div>
          </SheetHeader>
          {editing !== null && (
            <SearchBackendForm
              state={state}
              backend={editing === "new" ? undefined : editing}
              close={() => setEditing(null)}
            />
          )}
        </SheetContent>
      </Sheet>
      <ConfirmAction
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={text.confirmRemoveSearchBackend}
        confirmLabel={text.deleteSearchBackend}
        cancelLabel={copy.cancel}
        onConfirm={async () => {
          if (!removing) return;
          await state.mutate("command", {
            type: "removeSearchBackend",
            id: removing.id,
            revision: removing.revision,
          });
          setRemoving(null);
        }}
      />
    </Section>
  );
}

export function SearchBackendForm({
  state,
  backend,
  close,
}: {
  state: CatalogState;
  backend?: SearchBackend;
  close: () => void;
}) {
  const text = useProviderCopy(),
    { copy } = state;
  const [value, setValue] = useState(() =>
    backend
      ? {
          name: backend.name,
          kind: backend.kind,
          url: backend.url,
          enabled: backend.enabled,
        }
      : {
          name: SEARCH_BACKEND_PRESETS.searxng.label,
          kind: "searxng" as SearchBackendKindValue,
          url: SEARCH_BACKEND_PRESETS.searxng.url,
          enabled: true,
        },
  );
  const [key, setKey] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const settings = SearchBackendSettings.safeParse(value);
    if (!settings.success) {
      state.setError(copy.invalid);
      return;
    }
    const result = await state.mutate("command", {
      type: "saveSearchBackend",
      ...(backend ? { id: backend.id } : {}),
      revision: backend?.revision ?? 0,
      settings: settings.data,
      ...(key ? { apiKey: key } : {}),
    });
    if (result) close();
  }
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => void submit(e)}
    >
      <fieldset disabled={state.busy} className="contents">
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {state.error && (
            <div className="pb-4">
              <Alert variant="destructive">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            </div>
          )}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="search-kind">{text.searchKind}</FieldLabel>
              <Select
                value={value.kind}
                onValueChange={(next) => {
                  const kind = next as SearchBackendKindValue;
                  const preset = SEARCH_BACKEND_PRESETS[kind];
                  const previous = SEARCH_BACKEND_PRESETS[value.kind];
                  setValue({
                    ...value,
                    kind,
                    // Untouched defaults follow the service; typed values stay.
                    name:
                      !value.name || value.name === previous.label
                        ? preset.label
                        : value.name,
                    url:
                      !value.url || value.url === previous.url
                        ? preset.url
                        : value.url,
                  });
                }}
              >
                <SelectTrigger id="search-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEARCH_BACKEND_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {SEARCH_BACKEND_PRESETS[kind].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="search-name">{copy.name}</FieldLabel>
              <Input
                id="search-name"
                value={value.name}
                maxLength={100}
                required
                onChange={(e) => setValue({ ...value, name: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="search-url">{copy.providerUrl}</FieldLabel>
              <Input
                id="search-url"
                type="url"
                value={value.url}
                required
                onChange={(e) => setValue({ ...value, url: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="search-key">{copy.key}</FieldLabel>
              <Input
                id="search-key"
                type="password"
                autoComplete="new-password"
                placeholder={backend?.hasCredential ? "••••••••" : undefined}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <FieldDescription>{text.searchKeyHint}</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="search-enabled">{copy.enabled}</FieldLabel>
              </FieldContent>
              <Switch
                id="search-enabled"
                checked={value.enabled}
                onCheckedChange={(enabled) => setValue({ ...value, enabled })}
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
            {copy.save}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
