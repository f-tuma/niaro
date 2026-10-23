import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  WorkspacePluginsSchema,
  type PluginPreferences,
  type WorkspacePlugins,
} from "../../../packages/protocol/workspace-plugins";
import {
  settingValid,
  type SettingField,
} from "../../../packages/plugin-sdk/manifest";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import { Badge } from "@admin/components/ui/badge";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Switch } from "@admin/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import { Section } from "@admin/components/console/page";
import { Disclosure } from "@admin/components/console/disclosure";
import { SettingRow, SettingRows } from "@admin/components/console/setting-row";
import {
  DetailList,
  SaveBar,
  SubmitButton,
} from "@admin/components/console/forms";
import { useAdmin } from "./context";
import { useCatalogCopy } from "./catalog-copy";
import { catalogIssue } from "./catalog-shared";
import { usePluginsCopy } from "./plugins-copy";
import { api, ApiError } from "./lib/api";

type Plugin = WorkspacePlugins["plugins"][number];
type Value = string | number | boolean;

/** The tools of a plugin as plugin.json declares them, for the technical details. */
export function PluginDetails({ plugin }: { plugin: Plugin }) {
  const copy = usePluginsCopy();
  return (
    <Disclosure title={copy.details}>
      <DetailList
        items={[
          {
            label: copy.toolsLabel,
            value: (
              <span className="flex flex-col gap-1.5">
                {plugin.toolDetails.map((tool) => (
                  <span key={tool.name} className="flex flex-wrap gap-1.5">
                    <code className="font-mono text-xs break-all">
                      {tool.name}
                    </code>
                    <Badge variant="outline">
                      {tool.access === "write" ? copy.writes : copy.reads}
                    </Badge>
                    {tool.approval === "explicit_command" && (
                      <Badge variant="outline">{copy.explicitCommand}</Badge>
                    )}
                  </span>
                ))}
              </span>
            ),
          },
          {
            label: copy.execution,
            value: copy[plugin.effect],
          },
          {
            label: copy.source,
            value: {
              "built-in": copy.builtIn,
              override: copy.override,
              operator: copy.operator,
            }[plugin.source],
          },
          { label: copy.version, value: plugin.version },
        ]}
      />
    </Disclosure>
  );
}

/**
 * Settings of a plugin other than date & time and memory: on/off for the
 * workspace and the fields its plugin.json declares.
 */
export function PluginSettingsForm({
  current,
  plugin,
  saved,
  reload,
  refreshFailed,
}: {
  current: WorkspacePlugins;
  plugin: Plugin;
  saved: (value: WorkspacePlugins) => Promise<void>;
  reload: () => Promise<boolean>;
  refreshFailed: boolean;
}) {
  const copy = usePluginsCopy(),
    common = useCatalogCopy();
  const { language } = useAdmin();
  const id = useId();
  const [draft, setDraft] = useState<{
    revision: number;
    settings: PluginPreferences;
    /** Text of number fields while typed. */
    text: Record<string, string>;
  } | null>(null);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const settings = draft?.settings ?? current.settings;
  const values: Record<string, Value> = {
    ...Object.fromEntries(
      Object.entries(plugin.settingFields).map(([key, field]) => [
        key,
        field.default,
      ]),
    ),
    ...settings.settings?.[plugin.id],
  };
  const enabled = settings.enabled.includes(plugin.id);
  const stale = !!draft && draft.revision !== current.revision;
  const locked =
    !current.canManage || busy || stale || conflict || refreshFailed;
  function edit(patch: Partial<PluginPreferences>, text?: [string, string]) {
    setDraft({
      revision: draft?.revision ?? current.revision,
      settings: { ...settings, ...patch },
      text: { ...draft?.text, ...(text ? { [text[0]]: text[1] } : {}) },
    });
    setError(null);
    if (text) setInvalid(invalid.filter((key) => key !== text[0]));
  }
  const setValue = (key: string, value: Value, text?: string) =>
    edit(
      {
        settings: {
          ...settings.settings,
          [plugin.id]: { ...settings.settings?.[plugin.id], [key]: value },
        },
      },
      text === undefined ? undefined : [key, text],
    );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || locked || request.current) return;
    const wrong = Object.entries(plugin.settingFields)
      .filter(([key, field]) => !settingValid(field, values[key]))
      .map(([key]) => key);
    setInvalid(wrong);
    if (wrong.length) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const result = WorkspacePluginsSchema.parse(
        await api(
          "identity/plugins",
          {
            organizationId: current.organizationId,
            workspaceId: current.workspaceId,
            revision: draft.revision,
            settings: {
              ...draft.settings,
              settings: { ...draft.settings.settings, [plugin.id]: values },
            },
          },
          controller.signal,
        ),
      );
      if (!controller.signal.aborted) {
        await saved(result);
        if (!controller.signal.aborted) setDraft(null);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(catalogIssue(failure, common));
        setConflict(failure instanceof ApiError && failure.status === 409);
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  const discard = () => {
    setDraft(null);
    setError(null);
    setInvalid([]);
    setConflict(false);
  };
  const control = (key: string, field: SettingField) => {
    const fieldId = `${id}-${key}`;
    const value = values[key];
    if (field.type === "boolean")
      return (
        <Switch
          id={fieldId}
          checked={value === true}
          disabled={locked}
          onCheckedChange={(checked) => setValue(key, checked)}
        />
      );
    if (field.type === "string" && field.options)
      return (
        <Select
          value={String(value)}
          disabled={locked}
          onValueChange={(next) => setValue(key, next)}
        >
          <SelectTrigger id={fieldId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    return (
      <Input
        id={fieldId}
        disabled={locked}
        aria-invalid={invalid.includes(key)}
        {...(field.type === "integer"
          ? {
              type: "number",
              inputMode: "numeric",
              min: field.min,
              max: field.max,
              step: 1,
              value: draft?.text[key] ?? String(value),
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                setValue(
                  key,
                  event.target.value.trim() === ""
                    ? Number.NaN
                    : Number(event.target.value),
                  event.target.value,
                ),
            }
          : {
              value: String(value),
              maxLength: field.maxLength,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                setValue(key, event.target.value, event.target.value),
            })}
      />
    );
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="min-w-0">
      <Section title={copy.settings}>
        {(error || stale) && (
          <Alert variant="destructive">
            <AlertDescription>{error ?? common.conflict}</AlertDescription>
            {(conflict || stale) && (
              <AlertAction>
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    if (!(await reload())) return;
                    discard();
                  }}
                >
                  {common.reloadSaved}
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
        {invalid.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>{copy.settingInvalid}</AlertDescription>
          </Alert>
        )}
        {!plugin.available && (
          <Alert>
            <AlertDescription>{copy.blocked}</AlertDescription>
          </Alert>
        )}
        <SettingRows>
          <SettingRow
            label={copy.enabled}
            htmlFor={`${id}-enabled`}
            disabled={locked || !plugin.available}
          >
            <Switch
              id={`${id}-enabled`}
              checked={enabled}
              disabled={locked || !plugin.available}
              onCheckedChange={(value) =>
                edit({
                  enabled: value
                    ? [...settings.enabled, plugin.id]
                    : settings.enabled.filter((item) => item !== plugin.id),
                })
              }
            />
          </SettingRow>
          {Object.entries(plugin.settingFields).map(([key, field]) => (
            <SettingRow
              key={key}
              label={field.label[language]}
              htmlFor={`${id}-${key}`}
              disabled={locked}
              wide={field.type !== "boolean"}
            >
              {control(key, field)}
            </SettingRow>
          ))}
        </SettingRows>
        <PluginDetails plugin={plugin} />
      </Section>
      {current.canManage && (draft || busy) && (
        <SaveBar status={common.unsavedChanges}>
          {draft && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={discard}
            >
              {common.discardChanges}
            </Button>
          )}
          <SubmitButton pending={busy} disabled={!draft || locked}>
            {common.save}
          </SubmitButton>
        </SaveBar>
      )}
    </form>
  );
}
