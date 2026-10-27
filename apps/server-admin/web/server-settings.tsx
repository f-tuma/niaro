import { useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import {
  ServerSettingsFileSchema,
  ServerSettingsSchema,
  ServerSettingsViewSchema,
  serverSettingsOfFile,
  type ServerSettings,
  type ServerSettingsFile,
} from "../../../packages/protocol/server-settings";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Textarea } from "@admin/components/ui/textarea";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Spinner } from "@admin/components/ui/spinner";
import { Switch } from "@admin/components/ui/switch";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@admin/components/ui/alert-dialog";
import { Section } from "@admin/components/console/page";
import { SettingRow, SettingRows } from "@admin/components/console/setting-row";
import { DetailList, SaveBar } from "@admin/components/console/forms";
import { api, ApiError, overviewKey } from "./lib/api";
import { downloadFile } from "./lib/download";
import { useServerSettingsCopy } from "./server-settings-copy";

type Copy = ReturnType<typeof useServerSettingsCopy>;
type Path =
  | ["name" | "timeZone" | "integrationOrigins" | "allowedOrigins"]
  | ["meetings", Exclude<keyof ServerSettings["meetings"], "diarization">]
  | ["meetings", "diarization", keyof ServerSettings["meetings"]["diarization"]]
  | ["hubScheduler", keyof ServerSettings["hubScheduler"]];
type Field = {
  path: Path;
  label: keyof Copy;
  meta?: keyof Copy;
  kind: "text" | "number" | "lines" | "switch";
};
const GROUPS: { title: keyof Copy; fields: Field[] }[] = [
  {
    title: "server",
    fields: [
      { path: ["name"], label: "name", kind: "text" },
      { path: ["timeZone"], label: "timeZone", kind: "text" },
    ],
  },
  {
    title: "meetings",
    fields: [
      {
        path: ["meetings", "audioRetentionDays"],
        label: "audioRetentionDays",
        meta: "audioRetentionMeta",
        kind: "number",
      },
      {
        path: ["meetings", "chunkSeconds"],
        label: "chunkSeconds",
        meta: "chunkSecondsMeta",
        kind: "number",
      },
      {
        path: ["meetings", "glossary"],
        label: "glossary",
        meta: "linesMeta",
        kind: "lines",
      },
      {
        path: ["meetings", "diarization", "enabled"],
        label: "diarization",
        kind: "switch",
      },
      {
        path: ["meetings", "diarization", "url"],
        label: "diarizerUrl",
        meta: "diarizerUrlMeta",
        kind: "text",
      },
    ],
  },
  {
    title: "hubScheduler",
    fields: [
      {
        path: ["hubScheduler", "intervalSeconds"],
        label: "intervalSeconds",
        meta: "intervalMeta",
        kind: "number",
      },
      {
        path: ["hubScheduler", "maxPerTick"],
        label: "maxPerTick",
        meta: "maxPerTickMeta",
        kind: "number",
      },
      {
        path: ["hubScheduler", "idleDays"],
        label: "idleDays",
        meta: "idleDaysMeta",
        kind: "number",
      },
    ],
  },
  {
    title: "origins",
    fields: [
      {
        path: ["integrationOrigins"],
        label: "integrationOrigins",
        kind: "lines",
      },
      { path: ["allowedOrigins"], label: "allowedOrigins", kind: "lines" },
    ],
  },
];
const FIELDS = GROUPS.flatMap((group) => group.fields);
const keyOf = (field: Field) => field.path.join(".");
function valueOf(settings: ServerSettings, path: Path): unknown {
  return (path as string[]).reduce<unknown>(
    (value, part) => (value as Record<string, unknown>)[part],
    settings,
  );
}
function textOf(field: Field, value: unknown) {
  return field.kind === "lines"
    ? (value as string[]).join("\n")
    : String(value);
}
function parse(field: Field, text: string): unknown {
  if (field.kind === "switch") return text === "true";
  if (field.kind === "number")
    return /^\d+$/.test(text.trim()) ? Number(text) : NaN;
  if (field.kind === "lines")
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  return text;
}
/** The saved settings with the edited fields, and the fields that do not validate. */
function withDraft(saved: ServerSettings, draft: Record<string, string>) {
  const next = JSON.parse(JSON.stringify(saved)) as Record<string, unknown>;
  for (const field of FIELDS) {
    const text = draft[keyOf(field)];
    if (text === undefined) continue;
    const parts = [...field.path] as string[];
    const last = parts.pop()!;
    const parent = parts.reduce(
      (value, part) => value[part] as Record<string, unknown>,
      next,
    );
    parent[last] = parse(field, text);
  }
  const result = ServerSettingsSchema.safeParse(next);
  return {
    settings: result.success ? result.data : null,
    invalid: new Set(
      result.success
        ? []
        : result.error.issues.flatMap((issue) =>
            FIELDS.filter((field) =>
              field.path.every((part, i) => issue.path[i] === part),
            ).map(keyOf),
          ),
    ),
  };
}
function shown(field: Field, value: unknown, copy: Copy) {
  if (field.kind === "switch") return value ? copy.on : copy.off;
  if (field.kind !== "lines") return String(value);
  const lines = value as string[];
  return lines.length ? lines.join(", ") : copy.none;
}
/** The fields an import would change, with their current and new values. */
export function serverSettingsChanges(
  current: ServerSettings,
  next: ServerSettings,
) {
  return FIELDS.filter(
    (field) =>
      JSON.stringify(valueOf(current, field.path)) !==
      JSON.stringify(valueOf(next, field.path)),
  ).map((field) => ({
    field,
    from: valueOf(current, field.path),
    to: valueOf(next, field.path),
  }));
}

/**
 * Server-wide settings from administration (owners and administrators): the
 * profile supplies the defaults. `children` are the read-only server rows.
 */
export function ServerSettingsSections({
  organizationId,
  children,
}: {
  organizationId: string;
  children?: ReactNode;
}) {
  const copy = useServerSettingsCopy();
  const client = useQueryClient();
  const key = ["admin", "server-settings", organizationId];
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      ServerSettingsViewSchema.parse(
        await api(
          `identity/server-settings?organizationId=${encodeURIComponent(organizationId)}`,
          undefined,
          signal,
        ),
      ),
  });
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<ServerSettingsFile | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const view = query.data;
  if (!view)
    return (
      <Section title={copy.server}>
        {query.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{copy.loadFailed}</AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void query.refetch()}
              >
                {copy.retry}
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
      </Section>
    );
  const edited = draft ? withDraft(view.settings, draft) : null;
  const send = async (path: string, body: object) => {
    setBusy(true);
    setError(null);
    try {
      client.setQueryData(
        key,
        ServerSettingsViewSchema.parse(
          await api(`identity/server-settings${path}`, body),
        ),
      );
      setDraft(null);
      setIncoming(null);
      // The console shows the server's name from the overview.
      void client.invalidateQueries({ queryKey: overviewKey });
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? copy.conflict
          : copy.failed,
      );
    } finally {
      setBusy(false);
    }
  };
  const exportFile = async () => {
    setError(null);
    try {
      const file = ServerSettingsFileSchema.parse(
        await api(
          `identity/server-settings/export?organizationId=${encodeURIComponent(organizationId)}`,
        ),
      );
      downloadFile("niaro-settings.json", `${JSON.stringify(file, null, 2)}\n`);
    } catch {
      setError(copy.exportFailed);
    }
  };
  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (upload.current) upload.current.value = "";
    if (!file) return;
    setError(null);
    try {
      if (file.size > 65536) throw Error();
      setIncoming(
        ServerSettingsFileSchema.parse(JSON.parse(await file.text())),
      );
    } catch {
      setError(copy.notSettingsFile);
    }
  };
  const changes = incoming
    ? serverSettingsChanges(view.settings, serverSettingsOfFile(incoming))
    : [];
  const row = (field: Field) => {
    const id = `server-${keyOf(field).replaceAll(".", "-")}`;
    const [first] = field.path;
    const restart =
      first === "integrationOrigins" || first === "allowedOrigins"
        ? view.restartPending.includes(first)
          ? copy.restartPending
          : copy.afterRestart
        : undefined;
    const value =
      draft?.[keyOf(field)] ??
      textOf(field, valueOf(view.settings, field.path));
    if (field.kind === "switch")
      return (
        <SettingRow
          key={id}
          label={copy[field.label]}
          htmlFor={id}
          meta={
            keyOf(field) === "meetings.diarization.enabled" ? (
              <DiarizerStatus
                organizationId={organizationId}
                enabled={view.settings.meetings.diarization.enabled}
                url={view.settings.meetings.diarization.url}
                copy={copy}
              />
            ) : undefined
          }
        >
          <Switch
            id={id}
            disabled={busy}
            checked={value === "true"}
            onCheckedChange={(checked) =>
              setDraft((current) => ({
                ...current,
                [keyOf(field)]: String(checked),
              }))
            }
          />
        </SettingRow>
      );
    const props = {
      id,
      disabled: busy,
      "aria-invalid": edited?.invalid.has(keyOf(field)) || undefined,
      value,
      onChange: (
        event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => {
        const text = event.target.value;
        setDraft((current) => ({ ...current, [keyOf(field)]: text }));
      },
    };
    return (
      <SettingRow
        key={id}
        label={copy[field.label]}
        htmlFor={id}
        meta={restart ?? (field.meta && copy[field.meta])}
        wide={field.kind !== "number"}
      >
        {field.kind === "lines" ? (
          <Textarea {...props} mono rows={3} />
        ) : field.kind === "number" ? (
          <Input {...props} className="w-28" inputMode="numeric" />
        ) : (
          <Input {...props} />
        )}
      </SettingRow>
    );
  };
  return (
    <>
      {GROUPS.map((group, index) => (
        <Section
          key={group.title}
          title={copy[group.title]}
          actions={
            index === 0 ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void exportFile()}
                >
                  <Download data-icon="inline-start" aria-hidden="true" />
                  {copy.export}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => upload.current?.click()}
                >
                  <Upload data-icon="inline-start" aria-hidden="true" />
                  {copy.import}
                </Button>
              </>
            ) : undefined
          }
        >
          {index === 0 && (
            <input
              ref={upload}
              type="file"
              hidden
              accept=".json,application/json"
              aria-label={copy.import}
              onChange={(event) => void pick(event.target.files)}
            />
          )}
          {index === 0 && error && draft === null && !incoming && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <SettingRows>
            {group.fields.map(row)}
            {index === 0 && children}
          </SettingRows>
        </Section>
      ))}
      <AlertDialog
        open={!!incoming}
        onOpenChange={(open) => {
          if (open || busy) return;
          setIncoming(null);
          setError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.importTitle}</AlertDialogTitle>
            {!changes.length && (
              <AlertDialogDescription>
                {copy.nothingChanges}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {changes.length > 0 && (
            <DetailList
              stacked
              items={changes.map(({ field, from, to }) => ({
                label: copy[field.label],
                value: (
                  <span className="flex flex-col gap-0.5">
                    <span>{shown(field, to, copy)}</span>
                    <span className="text-xs text-muted-foreground">
                      {copy.was}: {shown(field, from, copy)}
                    </span>
                  </span>
                ),
              }))}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !changes.length}
              onClick={(event) => {
                // Stays open until the import is applied.
                event.preventDefault();
                if (incoming)
                  void send("/import", {
                    organizationId,
                    revision: view.revision,
                    file: incoming,
                  });
              }}
            >
              {busy && <Spinner data-icon="inline-start" />}
              {copy.import}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {draft !== null && (
        <SaveBar
          status={
            error ?? (edited?.settings ? copy.unsavedChanges : copy.invalid)
          }
          tone={error || !edited?.settings ? "error" : "muted"}
        >
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
          >
            {copy.discardChanges}
          </Button>
          <Button
            disabled={busy || !edited?.settings}
            onClick={() =>
              edited?.settings &&
              void send("", {
                organizationId,
                revision: view.revision,
                settings: edited.settings,
              })
            }
          >
            {busy && <Spinner data-icon="inline-start" />}
            {copy.saveChanges}
          </Button>
        </SaveBar>
      )}
    </>
  );
}

const DiarizerHealthViewSchema = z.union([
  z.object({
    reachable: z.literal(true),
    ready: z.boolean(),
    model: z.string(),
    error: z.string().nullable().optional(),
  }),
  z.object({ reachable: z.literal(false), error: z.string() }),
]);
type DiarizerHealthView = z.infer<typeof DiarizerHealthViewSchema>;
/**
 * The saved diarizer's state: whether it answers and has its model. The
 * service is optional (compose profile "diarization"), so being off is fine.
 */
function DiarizerStatus({
  organizationId,
  enabled,
  url,
  copy,
}: {
  organizationId: string;
  enabled: boolean;
  url: string;
  copy: Copy;
}) {
  const query = useQuery({
    queryKey: ["admin", "server-settings", organizationId, "diarizer", url],
    enabled,
    refetchInterval: (query: { state: { data?: DiarizerHealthView } }) =>
      query.state.data?.reachable && !query.state.data.ready ? 10_000 : false,
    queryFn: async ({ signal }) =>
      DiarizerHealthViewSchema.parse(
        await api(
          `identity/server-settings/diarizer?organizationId=${encodeURIComponent(organizationId)}`,
          undefined,
          signal,
        ),
      ),
  });
  if (!enabled) return copy.diarizationMeta;
  const health = query.data;
  if (!health) return query.isError ? copy.diarizerUnreachable : copy.checking;
  if (!health.reachable)
    return health.error === "unauthorized"
      ? copy.diarizerUnauthorized
      : copy.diarizerUnreachable;
  if (health.ready) return copy.diarizerReady;
  return health.error
    ? `${copy.diarizerFailed}: ${health.error}`
    : copy.diarizerLoading;
}
