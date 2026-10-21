import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import {
  ModelDiscoveryResponse,
  type DiscoveredModel,
  type Provider,
} from "../../../packages/protocol/service-catalog";
import { Button } from "@admin/components/ui/button";
import { Badge } from "@admin/components/ui/badge";
import { Checkbox } from "@admin/components/ui/checkbox";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import { SheetHeader, SheetTitle } from "@admin/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@admin/components/ui/tooltip";
import { SearchField } from "@admin/components/console/forms";
import { Spinner } from "@admin/components/ui/spinner";
import { api } from "./lib/api";
import { useAdmin } from "./context";
import { catalogIssue, type CatalogState } from "./catalog-shared";

const isImportable = (model: DiscoveredModel) =>
  model.kind === "decision" ||
  model.kind === "transcription" ||
  model.kind === "speech" ||
  model.audioOutput === true ||
  model.tools === true ||
  (model.kind === "chat" && model.audioInput === true);

/** Body of the "Choose from catalog" sheet: browse and import provider models. */
export function ProviderModelPicker({
  state,
  provider,
  onConfigure,
  onClose,
}: {
  state: CatalogState;
  provider: Provider;
  onConfigure: (model: DiscoveredModel) => void;
  onClose?: () => void;
}) {
  const { copy } = state,
    { data, language } = useAdmin();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("usable");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const query = useQuery({
    queryKey: [
      "admin",
      "provider-models",
      data.authentication.principalId,
      state.target.organizationId,
      state.target.workspaceId,
      provider.id,
      provider.revision,
    ],
    queryFn: async ({ signal }) =>
      ModelDiscoveryResponse.parse(
        await api(
          "identity/catalog/models",
          {
            ...state.target,
            providerId: provider.id,
            revision: provider.revision,
          },
          signal,
        ),
      ),
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const existing = new Set(
    state.query
      .data!.models.filter((m) => m.providerId === provider.id)
      .map((m) => m.model),
  );
  const chosen = (query.data?.models ?? []).filter(
    (m) =>
      isImportable(m) && selected.includes(m.model) && !existing.has(m.model),
  );
  const matching = (query.data?.models ?? []).filter(
    (m) =>
      (filter === "all" ||
        m.kind === "decision" ||
        m.kind === "transcription" ||
        m.kind === "speech" ||
        m.audioOutput === true ||
        m.tools !== false ||
        (m.kind === "chat" && m.audioInput === true)) &&
      (m.name + " " + m.model)
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(matching.length / 25)),
    currentPage = Math.min(page, pages - 1);
  const visible = matching.slice(currentPage * 25, currentPage * 25 + 25);
  const selectable = visible.filter(
    (model) => isImportable(model) && !existing.has(model.model),
  );
  const allSelected =
    selectable.length > 0 &&
    selectable.every((model) => selected.includes(model.model));
  const ready = !!query.data && !query.isError;
  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-2 pr-8">
          <SheetTitle>{copy.fetchModels}</SheetTitle>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={copy.refresh}
                disabled={query.isFetching || state.busy}
                onClick={() => void query.refetch()}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={query.isFetching ? "motion-safe:animate-spin" : ""}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copy.refresh}</TooltipContent>
          </Tooltip>
        </div>
      </SheetHeader>
      {/* The page-level boundary is hidden behind this modal sheet. */}
      {state.error && (
        <div className="px-4">
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
            {state.conflict && (
              <AlertAction>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void state.resetDrafts()}
                >
                  {copy.reloadSaved}
                </Button>
              </AlertAction>
            )}
          </Alert>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-4">
        <div className="min-w-48 flex-1">
          <SearchField
            value={search}
            placeholder={copy.searchModels}
            onChange={(value) => {
              setSearch(value);
              setPage(0);
            }}
          />
        </div>
        <Select
          value={filter}
          onValueChange={(value) => {
            setFilter(value);
            setPage(0);
          }}
        >
          <SelectTrigger aria-label={copy.modelFilter}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="usable">{copy.modelsForServices}</SelectItem>
            <SelectItem value="all">{copy.allModels}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {query.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {catalogIssue(query.error, copy)}
            </AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                {copy.refresh}
              </Button>
            </AlertAction>
          </Alert>
        ) : query.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : matching.length ? (
          <ul className="divide-y">
            <li className="flex items-center gap-3 py-2">
              <Checkbox
                id="catalog-select-page"
                checked={
                  allSelected
                    ? true
                    : selectable.some((model) => selected.includes(model.model))
                      ? "indeterminate"
                      : false
                }
                disabled={
                  state.busy ||
                  query.isFetching ||
                  selectable.length === 0 ||
                  (!allSelected && chosen.length >= 50)
                }
                onCheckedChange={(checked) =>
                  setSelected((ids) =>
                    checked === true
                      ? [
                          ...new Set([
                            ...chosen.map((model) => model.model),
                            ...selectable.map((model) => model.model),
                          ]),
                        ].slice(0, 50)
                      : ids.filter(
                          (id) =>
                            !selectable.some((model) => model.model === id),
                        ),
                  )
                }
              />
              <label
                htmlFor="catalog-select-page"
                className="text-sm text-muted-foreground"
              >
                {copy.selectPage}
              </label>
            </li>
            {visible.map((m) => {
              const added = existing.has(m.model),
                checked = isImportable(m) && selected.includes(m.model);
              const verify =
                !added &&
                m.kind !== "decision" &&
                m.kind !== "transcription" &&
                m.kind !== "speech" &&
                m.audioOutput !== true &&
                m.tools === null &&
                !m.audioInput;
              return (
                <li key={m.model} className="flex items-center gap-3 py-3">
                  <Checkbox
                    aria-label={`${copy.selectModel}: ${m.name}`}
                    checked={added || checked}
                    disabled={
                      state.busy ||
                      added ||
                      !isImportable(m) ||
                      (!checked && chosen.length >= 50)
                    }
                    onCheckedChange={(v) =>
                      setSelected((ids) =>
                        v === true
                          ? [...ids, m.model]
                          : ids.filter((id) => id !== m.model),
                      )
                    }
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className="truncate text-sm font-medium"
                      title={m.name}
                    >
                      {m.name}
                    </span>
                    <span
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={m.model}
                    >
                      {m.model}
                    </span>
                  </div>
                  {m.contextLength && (
                    <span
                      className="hidden text-xs text-muted-foreground tabular-nums sm:inline"
                      title={copy.contextTokens}
                    >
                      {m.contextLength.toLocaleString(language, {
                        notation: "compact",
                      })}
                    </span>
                  )}
                  {added ? (
                    <Badge variant="outline">{copy.added}</Badge>
                  ) : verify ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={state.busy}
                      onClick={() => onConfigure(m)}
                    >
                      {copy.verifyTools}
                    </Button>
                  ) : m.kind === "chat" && m.tools && !m.audioInput ? null : (
                    <Badge variant="secondary">
                      {m.kind === "decision"
                        ? copy.decisionModel
                        : m.kind === "speech"
                          ? copy.speechDirect
                          : m.audioOutput
                            ? copy.audioOutput
                            : m.kind === "transcription"
                              ? copy.transcriptionModel
                              : m.kind === "router"
                                ? copy.routerModel
                                : m.audioInput
                                  ? copy.audioInput
                                  : copy.noToolSupport}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {copy.noMatchingModels}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t p-4">
        {ready && pages > 1 && (
          <div className="flex items-center gap-1">
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
        <span
          role="status"
          className="mr-auto text-sm text-muted-foreground tabular-nums"
        >
          {copy.selectedModels}: {chosen.length} / 50
        </span>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            disabled={state.busy}
            onClick={onClose}
          >
            {copy.cancel}
          </Button>
        )}
        <Button
          disabled={
            state.busy ||
            query.isFetching ||
            query.isError ||
            chosen.length === 0
          }
          onClick={() =>
            void state
              .mutate("command", {
                type: "importModels",
                providerId: provider.id,
                providerRevision: provider.revision,
                models: chosen.map(
                  ({ model, name, tools, audioInput, audioOutput, kind }) => ({
                    model,
                    name,
                    tools: tools === true,
                    audioInput: audioInput === true,
                    audioOutput: audioOutput === true,
                    kind,
                  }),
                ),
              })
              .then((result) => {
                if (result) setSelected([]);
              })
          }
        >
          {state.busy && <Spinner data-icon="inline-start" />}
          {copy.addSelectedModels}
        </Button>
      </div>
    </>
  );
}
