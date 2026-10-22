import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { FileCode } from "lucide-react";
import {
  PluginFilesResultSchema,
  PluginFilesSchema,
  type PluginFiles,
  type PluginFilesContent,
  type PluginFilesResult,
} from "../../../packages/protocol/workspace-plugins";
import { PLUGIN_ID_PATTERN } from "../../../packages/plugin-sdk/manifest";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  AlertAction,
} from "@admin/components/ui/alert";
import { Button } from "@admin/components/ui/button";
import { Textarea } from "@admin/components/ui/textarea";
import { Input } from "@admin/components/ui/input";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@admin/components/ui/tabs";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import { PageHeader } from "@admin/components/console/page";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { StatusBadge } from "@admin/components/console/status";
import {
  ConfirmAction,
  MoreActions,
  SaveBar,
  SubmitButton,
} from "@admin/components/console/forms";
import { useConsoleScope } from "./console-scope";
import { useCatalogCopy } from "./catalog-copy";
import { catalogIssue } from "./catalog-shared";
import { usePluginsCopy } from "./plugins-copy";
import { api, ApiError } from "./lib/api";

const FILES = ["index.ts", "plugin.json"] as const;
const filesKey = (organizationId?: string, pluginId?: string) => [
  "admin",
  "plugin-files",
  organizationId,
  pluginId,
];

/** Administration → Plugins → a plugin → Files: plugin.json and index.ts. Owners only. */
export function PluginFilesPage() {
  const { pluginId } = useParams({ strict: false }) as { pluginId: string };
  const scope = useConsoleScope();
  const copy = usePluginsCopy(),
    common = useCatalogCopy();
  const organizationId = scope.organization?.id;
  const owner = scope.organization?.role === "owner";
  const query = useQuery({
    queryKey: filesKey(organizationId, pluginId),
    queryFn: async ({ signal }) =>
      PluginFilesSchema.parse(
        await api(
          `identity/plugin-files?${new URLSearchParams({ organizationId: organizationId!, pluginId })}`,
          undefined,
          signal,
        ),
      ),
    enabled: !!organizationId && owner,
    staleTime: Infinity,
  });
  const error = query.error ?? scope.identity.error;
  const [confirming, setConfirming] = useState(false);
  const removable =
    !!query.data && !query.data.readOnly && query.data.source !== "built-in";
  return (
    <>
      <PageHeader
        title={pluginId}
        description={query.data?.directory}
        back={{ to: "/plugins", label: copy.title }}
        media={
          <EntityIcon size="lg">
            <FileCode aria-hidden="true" />
          </EntityIcon>
        }
        meta={query.data && <SourceBadge files={query.data} />}
        actions={
          removable && (
            <MoreActions label={common.moreActions}>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setConfirming(true)}
              >
                {query.data!.builtIn ? copy.resetBuiltIn : copy.deletePlugin}
              </DropdownMenuItem>
            </MoreActions>
          )
        }
      />
      {scope.identity.isPending || (owner && query.isPending) ? (
        <Skeleton className="h-96 w-full" />
      ) : !owner || error || !query.data ? (
        <Alert variant="destructive">
          <AlertDescription>
            {!owner || !error ? common.forbidden : catalogIssue(error, common)}
          </AlertDescription>
          {owner && (
            <AlertAction>
              <Button variant="outline" onClick={() => void query.refetch()}>
                {common.refresh}
              </Button>
            </AlertAction>
          )}
        </Alert>
      ) : (
        <FilesEditor
          key={`${query.data.source}:${query.dataUpdatedAt}`}
          organizationId={organizationId!}
          view={query.data}
          confirming={confirming}
          onConfirmingChange={setConfirming}
        />
      )}
    </>
  );
}

function SourceBadge({ files }: { files: PluginFiles }) {
  const copy = usePluginsCopy();
  if (!files.source)
    return <StatusBadge tone="danger">{copy.notLoaded}</StatusBadge>;
  return (
    <StatusBadge tone={files.source === "built-in" ? "neutral" : "info"}>
      {
        {
          "built-in": copy.builtIn,
          override: copy.override,
          operator: copy.operator,
        }[files.source]
      }
    </StatusBadge>
  );
}

function FilesEditor({
  organizationId,
  view,
  confirming,
  onConfirmingChange,
}: {
  organizationId: string;
  view: PluginFiles;
  /** Reset to built-in, or delete an own plugin: asked from the header menu. */
  confirming: boolean;
  onConfirmingChange: (open: boolean) => void;
}) {
  const copy = usePluginsCopy(),
    common = useCatalogCopy();
  const id = useId();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<PluginFilesContent | null>(null);
  const [checked, setChecked] = useState<{ rejected: string | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const files = draft ?? view.files;
  async function send(action: "check" | "save" | "reset") {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result: PluginFilesResult = PluginFilesResultSchema.parse(
        await api(
          "identity/plugin-files",
          {
            organizationId,
            pluginId: view.pluginId,
            action,
            ...(action === "reset" ? {} : { files }),
          },
          controller.signal,
        ),
      );
      if (controller.signal.aborted) return;
      void client.invalidateQueries({ queryKey: ["admin", "plugins"] });
      void client.invalidateQueries({ queryKey: ["admin", "audit"] });
      if (result.outcome === "deleted") {
        client.removeQueries({
          queryKey: filesKey(organizationId, view.pluginId),
        });
        void navigate({ to: "/plugins" });
        return;
      }
      setChecked({ rejected: result.rejected });
      if (result.outcome === "saved" || result.outcome === "reset") {
        // The editor remounts with the saved files.
        client.setQueryData(
          filesKey(organizationId, view.pluginId),
          result.current,
        );
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(catalogIssue(failure, common));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft && !view.readOnly) void send("save");
  };
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      {view.readOnly ? (
        <Alert>
          <AlertDescription>{copy.readOnly}</AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertDescription>{copy.runsOnServer}</AlertDescription>
        </Alert>
      )}
      {view.problem && !draft && (
        <Alert variant="destructive">
          <AlertTitle>{copy.notLoaded}</AlertTitle>
          <AlertDescription>{view.problem}</AlertDescription>
        </Alert>
      )}
      {checked?.rejected ? (
        <Alert variant="destructive">
          <AlertTitle>{copy.notSaved}</AlertTitle>
          <AlertDescription>{checked.rejected}</AlertDescription>
        </Alert>
      ) : checked && draft ? (
        <Alert>
          <AlertDescription>{copy.checkPassed}</AlertDescription>
        </Alert>
      ) : null}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue="index.ts">
        <div className="border-b">
          <TabsList variant="line">
            {FILES.map((name) => (
              <TabsTrigger key={name} value={name}>
                {name}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {FILES.map((name) => (
          <TabsContent key={name} value={name} className="mt-3">
            <Textarea
              id={`${id}-${name}`}
              aria-label={name}
              mono
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              readOnly={view.readOnly}
              value={files[name]}
              onChange={(event) => {
                setDraft({ ...files, [name]: event.target.value });
                setChecked(null);
              }}
            />
          </TabsContent>
        ))}
      </Tabs>
      {draft && !view.readOnly && (
        <SaveBar status={common.unsavedChanges}>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setChecked(null);
              setError(null);
            }}
          >
            {common.discardChanges}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void send("check")}
          >
            {copy.check}
          </Button>
          <SubmitButton pending={busy}>{common.save}</SubmitButton>
        </SaveBar>
      )}
      <ConfirmAction
        open={confirming}
        onOpenChange={onConfirmingChange}
        title={view.builtIn ? copy.resetBuiltIn : copy.deletePlugin}
        description={
          view.builtIn ? copy.resetDescription : copy.deleteDescription
        }
        confirmLabel={view.builtIn ? copy.resetBuiltIn : copy.deletePlugin}
        cancelLabel={common.cancel}
        onConfirm={() => send("reset")}
      />
    </form>
  );
}

/** "Add plugin": an ID, then the template opens in the editor. */
export function AddPluginSheet({
  organizationId,
  open,
  onOpenChange,
}: {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const copy = usePluginsCopy(),
    common = useCatalogCopy();
  const id = useId();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [pluginId, setPluginId] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!PLUGIN_ID_PATTERN.test(pluginId)) {
      setInvalid(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = PluginFilesResultSchema.parse(
        await api("identity/plugin-files", {
          organizationId,
          pluginId,
          action: "create",
        }),
      );
      client.setQueryData(filesKey(organizationId, pluginId), result.current);
      void client.invalidateQueries({ queryKey: ["admin", "plugins"] });
      onOpenChange(false);
      void navigate({
        to: "/plugins/$pluginId/files",
        params: { pluginId },
      });
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? copy.pluginExists
          : catalogIssue(failure, common),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open={open} onOpenChange={(value) => !busy && onOpenChange(value)}>
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{copy.addPlugin}</SheetTitle>
        </SheetHeader>
        <form
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <fieldset
            disabled={busy}
            className="min-h-0 flex-1 overflow-y-auto px-4"
          >
            <FieldGroup>
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor={`${id}-id`}>{copy.pluginId}</FieldLabel>
                <Input
                  id={`${id}-id`}
                  value={pluginId}
                  maxLength={40}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="word-count"
                  aria-invalid={invalid}
                  onChange={(event) => {
                    setPluginId(event.target.value.trim());
                    setInvalid(false);
                    setError(null);
                  }}
                />
                {invalid ? (
                  <FieldError>{copy.pluginIdInvalid}</FieldError>
                ) : (
                  <FieldDescription>{copy.pluginIdHint}</FieldDescription>
                )}
              </Field>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </FieldGroup>
          </fieldset>
          <SheetFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {common.cancel}
            </Button>
            <SubmitButton pending={busy}>{copy.addPlugin}</SubmitButton>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
