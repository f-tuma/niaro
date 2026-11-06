import { useState, type ReactNode } from "react";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ServerSettingsSchema,
  ServerSettingsViewSchema,
  type ServerSettings,
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
import { Section } from "@admin/components/console/page";
import {
  SettingRow,
  SettingRows,
  SettingValue,
} from "@admin/components/console/setting-row";
import { SaveBar } from "@admin/components/console/forms";
import { api, ApiError, overviewKey } from "./lib/api";
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
const GROUPS: { title: keyof Copy; hint: keyof Copy; fields: Field[] }[] = [
  {
    title: "server",
    hint: "serverHint",
    fields: [
      { path: ["name"], label: "name", kind: "text" },
      { path: ["timeZone"], label: "timeZone", kind: "text" },
    ],
  },
  {
    title: "meetings",
    hint: "meetingsHint",
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
    hint: "hubSchedulerHint",
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
    hint: "originsHint",
    fields: [
      {
        path: ["integrationOrigins"],
        label: "integrationOrigins",
        meta: "integrationOriginsMeta",
        kind: "lines",
      },
      {
        path: ["allowedOrigins"],
        label: "allowedOrigins",
        meta: "allowedOriginsMeta",
        kind: "lines",
      },
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

/**
 * Server-wide settings from administration (owners and administrators): the
 * profile supplies the defaults. `children` are read-only rows added to the
 * Server section. Export and import live on the Configuration page.
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
  const save = async (settings: ServerSettings) => {
    setBusy(true);
    setError(null);
    try {
      client.setQueryData(
        key,
        ServerSettingsViewSchema.parse(
          await api("identity/server-settings", {
            organizationId,
            revision: view.revision,
            settings,
          }),
        ),
      );
      setDraft(null);
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
  const row = (field: Field) => {
    const id = `server-${keyOf(field).replaceAll(".", "-")}`;
    const [first] = field.path;
    const waiting =
      (first === "integrationOrigins" || first === "allowedOrigins") &&
      view.restartPending.includes(first);
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
    const meta = field.meta && copy[field.meta];
    return (
      <SettingRow
        key={id}
        label={copy[field.label]}
        htmlFor={id}
        meta={
          waiting ? (
            <>
              {meta}{" "}
              <span className="font-medium text-foreground">
                {copy.restartPending}
              </span>
            </>
          ) : (
            meta
          )
        }
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
      {GROUPS.map((group) => (
        <Section
          key={group.title}
          title={copy[group.title]}
          description={copy[group.hint]}
        >
          <SettingRows>
            {group.fields.map(row)}
            {group.title === "server" && children}
            {group.title === "origins" && view.operatorOrigins.length > 0 && (
              <SettingRow
                label={copy.operatorOrigins}
                meta={copy.operatorOriginsMeta}
                wide
              >
                <SettingValue>
                  <span className="font-mono text-xs">
                    {view.operatorOrigins.join(", ")}
                  </span>
                </SettingValue>
              </SettingRow>
            )}
          </SettingRows>
        </Section>
      ))}
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
            onClick={() => edited?.settings && void save(edited.settings)}
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
