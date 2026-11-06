import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Button } from "@admin/components/ui/button";
import { Checkbox } from "@admin/components/ui/checkbox";
import { Input } from "@admin/components/ui/input";
import { Progress } from "@admin/components/ui/progress";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Switch } from "@admin/components/ui/switch";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@admin/components/ui/field";
import { PanelFooter, WorkspacePanel, usePanelBody } from "./workspace-panel";
import { Disclosure } from "@admin/components/console/disclosure";
import { SubmitButton } from "@admin/components/console/forms";
import { RelativeTime } from "@admin/components/console/time";
import {
  KNOWLEDGE_PROFILE,
  KnowledgeAdminView,
  KnowledgeSettings,
  type KnowledgeAdminViewValue,
  type KnowledgeSettingsValue,
} from "../../../packages/protocol/knowledge";
import { api, ApiError } from "./lib/api";
import { useAdmin } from "./context";

const copy = {
  en: {
    title: "Knowledge",
    description:
      "A searchable index of the files people send in chats and the sources you pick. People find only what they may open.",
    status: "Index",
    off: "Off: choose an embedding model on the Models page.",
    model: "Embedding model",
    passages: "Passages",
    documents: "Documents",
    lastSync: "Last sync",
    never: "Never",
    running: "Indexing",
    stale: "{count} passages use an earlier model; rebuild the index.",
    errors: "Errors",
    rebuild: "Rebuild index",
    rebuilding: "Rebuild started.",
    files: "Index files sent in chats",
    filesHint: "Each file is found only by the person who sent it.",
    filesUnreadable:
      "Attached files are not read on this server (no document converter), so none are indexed.",
    sources: "Sources",
    sourcesHint:
      "Read actions of shared services that need no input. Members find a source's passages only while they may use that action.",
    noSources: "No shared read action without input.",
    chunking: "Passages",
    size: "Passage length (characters)",
    overlap: "Overlap (characters)",
    cancel: "Cancel",
    save: "Save changes",
    saved: "Saved",
    loadFailed: "Knowledge didn't load.",
    retry: "Try again",
    conflict: "It changed in the meantime. Reopen it.",
    invalid: "Check the passage length and the overlap.",
    failed: "Saving failed.",
  },
  cs: {
    title: "Znalosti",
    description:
      "Prohledávatelný rejstřík souborů, které lidé pošlou v chatu, a zdrojů, které vyberete. Každý najde jen to, co smí otevřít.",
    status: "Rejstřík",
    off: "Vypnuto: vyber embeddingový model na stránce Modely.",
    model: "Embeddingový model",
    passages: "Pasáže",
    documents: "Dokumenty",
    lastSync: "Poslední synchronizace",
    never: "Nikdy",
    running: "Indexuje se",
    stale: "{count} pasáží používá dřívější model; sestav rejstřík znovu.",
    errors: "Chyby",
    rebuild: "Sestavit znovu",
    rebuilding: "Sestavení začalo.",
    files: "Indexovat soubory poslané v chatu",
    filesHint: "Každý soubor najde jen ten, kdo ho poslal.",
    filesUnreadable:
      "Tento server přílohy nečte (chybí převodník dokumentů), takže se žádné neindexují.",
    sources: "Zdroje",
    sourcesHint:
      "Čtecí akce sdílených služeb bez vstupu. Člen najde pasáže zdroje jen dokud smí tu akci použít.",
    noSources: "Žádná sdílená čtecí akce bez vstupu.",
    chunking: "Pasáže",
    size: "Délka pasáže (znaky)",
    overlap: "Překryv (znaky)",
    cancel: "Zrušit",
    save: "Uložit změny",
    saved: "Uloženo",
    loadFailed: "Znalosti se nenačetly.",
    retry: "Zkusit znovu",
    conflict: "Mezitím se změnily. Otevři je znovu.",
    invalid: "Zkontroluj délku pasáže a překryv.",
    failed: "Uložení se nepovedlo.",
  },
};

export const knowledgeKey = (organizationId: string, workspaceId: string) =>
  ["admin", "knowledge", organizationId, workspaceId] as const;

/**
 * What a workspace indexes as knowledge and where its index stands, with a
 * rebuild. Owners and administrators only; never a document store: nothing
 * here opens, edits or files a document.
 */
export function WorkspaceKnowledge({
  organizationId,
  workspaceId,
  name,
  inline = false,
  open = true,
  onOpenChange,
}: {
  organizationId: string;
  workspaceId: string;
  name: string;
  /** A section of the workspace page instead of a sheet. */
  inline?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { language } = useAdmin();
  const words = copy[language];
  const view = useQuery({
    queryKey: knowledgeKey(organizationId, workspaceId),
    queryFn: async ({ signal }) =>
      KnowledgeAdminView.parse(
        await api(
          "identity/knowledge/get",
          { organizationId, workspaceId },
          signal,
        ),
      ),
    enabled: open,
    retry: false,
    staleTime: 0,
    // While a pass runs, its progress is read again.
    refetchInterval: (query) =>
      query.state.data?.status.state === "running" ? 2000 : false,
  });
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <WorkspacePanel
      inline={inline}
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange?.(value);
      }}
      title={words.title}
      description={name}
    >
      {view.isError ? (
        <div
          className={
            inline ? "flex flex-col gap-3" : "flex flex-col gap-3 px-4"
          }
        >
          <Alert variant="destructive">
            <AlertDescription>{words.loadFailed}</AlertDescription>
          </Alert>
          <Button
            variant="outline"
            className="self-start"
            onClick={() => void view.refetch()}
          >
            {words.retry}
          </Button>
        </div>
      ) : !view.data ? (
        <div className={inline ? undefined : "px-4"}>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <KnowledgeForm
          key={view.data.revision}
          view={view.data}
          pending={pending}
          setPending={setPending}
          saved={saved}
          onChange={() => setSaved(false)}
          onSaved={() => (inline ? setSaved(true) : onOpenChange?.(false))}
          onCancel={inline ? undefined : () => onOpenChange?.(false)}
        />
      )}
    </WorkspacePanel>
  );
}

function KnowledgeStatusPanel({
  view,
  pending,
  rebuild,
}: {
  view: KnowledgeAdminViewValue;
  pending: boolean;
  rebuild: () => void;
}) {
  const { language } = useAdmin();
  const words = copy[language];
  const { status } = view;
  if (status.state === "off")
    return (
      <Alert data-testid="knowledge-off">
        <AlertDescription>{words.off}</AlertDescription>
      </Alert>
    );
  const percent =
    status.progress && status.progress.total
      ? Math.round((status.progress.done / status.progress.total) * 100)
      : 0;
  return (
    <section
      aria-label={words.status}
      data-testid="knowledge-status"
      className="flex flex-col gap-3"
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{words.model}</dt>
        <dd>{status.model}</dd>
        <dt className="text-muted-foreground">{words.passages}</dt>
        <dd className="tabular-nums">{status.chunks}</dd>
        <dt className="text-muted-foreground">{words.documents}</dt>
        <dd className="tabular-nums">{status.documents}</dd>
        <dt className="text-muted-foreground">{words.lastSync}</dt>
        <dd>
          {status.lastSync ? (
            <RelativeTime value={status.lastSync} />
          ) : (
            words.never
          )}
        </dd>
      </dl>
      {status.state === "running" && (
        <div className="flex flex-col gap-1">
          <p className="text-sm" role="status">
            {words.running}
            {status.progress
              ? ` ${status.progress.done} / ${status.progress.total}`
              : ""}
          </p>
          <Progress value={percent} aria-label={words.running} />
        </div>
      )}
      {status.stale > 0 && (
        <p className="text-sm text-muted-foreground">
          {words.stale.replace("{count}", String(status.stale))}
        </p>
      )}
      {status.errors.length > 0 && (
        <Disclosure title={`${words.errors} (${status.errors.length})`}>
          <ul className="flex flex-col gap-1 text-sm">
            {status.errors.map((error, index) => (
              <li key={index}>
                {error.source}:{" "}
                <code className="font-mono text-xs">{error.error}</code>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={pending || status.state === "running"}
        onClick={rebuild}
      >
        <RefreshCw data-icon="inline-start" aria-hidden="true" />
        {words.rebuild}
      </Button>
    </section>
  );
}

function KnowledgeForm({
  view,
  pending,
  setPending,
  saved,
  onChange,
  onSaved,
  onCancel,
}: {
  view: KnowledgeAdminViewValue;
  pending: boolean;
  setPending: (pending: boolean) => void;
  /** The last save went through and nothing changed since. */
  saved: boolean;
  onChange: () => void;
  onSaved: () => void;
  /** Closes the sheet; on the page, Cancel puts the saved settings back. */
  onCancel?: () => void;
}) {
  const { language } = useAdmin();
  const words = copy[language];
  const client = useQueryClient();
  const id = useId();
  const body = usePanelBody("gap-6");
  const [draft, setDraftState] = useState<KnowledgeSettingsValue>(
    view.settings,
  );
  const setDraft = (next: KnowledgeSettingsValue) => {
    setDraftState(next);
    onChange();
  };
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const key = knowledgeKey(view.organizationId, view.workspaceId);
  async function send(command: Record<string, unknown>) {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      const next = KnowledgeAdminView.parse(
        await api("identity/knowledge/command", {
          organizationId: view.organizationId,
          workspaceId: view.workspaceId,
          ...command,
        }),
      );
      client.setQueryData(key, next);
      return true;
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.code === "knowledge_conflict"
          ? words.conflict
          : failure instanceof ApiError && failure.status === 400
            ? words.invalid
            : words.failed,
      );
      return false;
    } finally {
      setPending(false);
    }
  }
  const selected = new Set(
    draft.sources.map((source) => `${source.serviceId}/${source.actionId}`),
  );
  const toggle = (serviceId: string, actionId: string, on: boolean) =>
    setDraft({
      ...draft,
      sources: on
        ? [...draft.sources, { serviceId, actionId }]
        : draft.sources.filter(
            (source) =>
              source.serviceId !== serviceId || source.actionId !== actionId,
          ),
    });
  const valid = KnowledgeSettings.safeParse(draft).success;
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      data-profile={KNOWLEDGE_PROFILE}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) {
          setError(words.invalid);
          return;
        }
        if (
          await send({
            type: "save",
            revision: view.revision,
            settings: draft,
          })
        )
          onSaved();
      }}
    >
      <fieldset disabled={pending} className={body}>
        <p className="text-sm text-muted-foreground">{words.description}</p>
        <KnowledgeStatusPanel
          view={view}
          pending={pending}
          rebuild={() =>
            void send({ type: "rebuild" }).then(
              (done) => done && setNotice(words.rebuilding),
            )
          }
        />
        {notice && (
          <p className="text-sm" role="status">
            {notice}
          </p>
        )}
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`${id}-files`}>{words.files}</FieldLabel>
              <FieldDescription>
                {view.filesReadable ? words.filesHint : words.filesUnreadable}
              </FieldDescription>
            </FieldContent>
            <Switch
              id={`${id}-files`}
              checked={draft.files}
              onCheckedChange={(files) => setDraft({ ...draft, files })}
            />
          </Field>
          <FieldSet>
            <FieldLegend>{words.sources}</FieldLegend>
            <FieldDescription>{words.sourcesHint}</FieldDescription>
            {view.candidates.length ? (
              <FieldGroup>
                {view.candidates.map((service) => (
                  <FieldSet key={service.serviceId}>
                    <FieldLegend variant="label">
                      {service.serviceName}
                    </FieldLegend>
                    {service.actions.map((action) => {
                      const checkbox = `${id}-${service.serviceId}-${action.id}`;
                      return (
                        <Field key={action.id} orientation="horizontal">
                          <Checkbox
                            id={checkbox}
                            checked={selected.has(
                              `${service.serviceId}/${action.id}`,
                            )}
                            onCheckedChange={(value) =>
                              toggle(
                                service.serviceId,
                                action.id,
                                value === true,
                              )
                            }
                          />
                          <FieldLabel htmlFor={checkbox}>
                            {action.name}
                          </FieldLabel>
                        </Field>
                      );
                    })}
                  </FieldSet>
                ))}
              </FieldGroup>
            ) : (
              <p className="text-sm text-muted-foreground">{words.noSources}</p>
            )}
          </FieldSet>
          <Disclosure title={words.chunking}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${id}-size`}>{words.size}</FieldLabel>
                <Input
                  id={`${id}-size`}
                  type="number"
                  min={300}
                  max={4000}
                  value={draft.chunking.size}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      chunking: {
                        ...draft.chunking,
                        size: Number(event.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-overlap`}>
                  {words.overlap}
                </FieldLabel>
                <Input
                  id={`${id}-overlap`}
                  type="number"
                  min={0}
                  max={1000}
                  value={draft.chunking.overlap}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      chunking: {
                        ...draft.chunking,
                        overlap: Number(event.target.value),
                      },
                    })
                  }
                />
              </Field>
            </FieldGroup>
          </Disclosure>
        </FieldGroup>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </fieldset>
      <PanelFooter>
        {saved && (
          <p role="status" className="text-sm text-muted-foreground sm:mr-auto">
            {words.saved}
          </p>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={
            onCancel ??
            (() => {
              setDraftState(view.settings);
              setError(null);
            })
          }
        >
          {words.cancel}
        </Button>
        <SubmitButton pending={pending}>{words.save}</SubmitButton>
      </PanelFooter>
    </form>
  );
}
