import { useState, type FormEvent, type ReactNode } from "react";
import {
  ProviderSettings,
  type Provider,
} from "../../../packages/protocol/service-catalog";
import {
  PROVIDER_PRESETS,
  providerPreset,
  type ProviderAuthValue,
  type ProviderDialectValue,
  type ProviderPresetIdValue,
} from "../../../packages/protocol/providers";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Switch } from "@admin/components/ui/switch";
import { Textarea } from "@admin/components/ui/textarea";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
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
import { Spinner } from "@admin/components/ui/spinner";
import type { CatalogState } from "./catalog-shared";
import { useProviderCopy } from "./provider-copy";

type Draft = {
  name: string;
  url: string;
  enabled: boolean;
  dailyRequestLimit: number;
  preset: ProviderPresetIdValue;
  auth: ProviderAuthValue;
  dialect: ProviderDialectValue;
  free: boolean;
  dataHandling: string;
};

/** A new provider's form starts from this preset; an administrator picks another. */
const START_PRESET: ProviderPresetIdValue = "openrouter";

/**
 * The provider form: a preset fills the address, key handling, request
 * format, free choice and data-handling note, and every field stays
 * editable. Nothing here names a model.
 */
export function ProviderForm({
  state,
  provider,
  close,
  saved,
  errors,
}: {
  state: CatalogState;
  provider?: Provider;
  close: () => void;
  saved: (id: string) => void;
  /** The form's error banner. */
  errors?: ReactNode;
}) {
  const { copy } = state;
  const text = useProviderCopy();
  const fromPreset = (id: ProviderPresetIdValue, base: Draft): Draft => {
    const preset = providerPreset(id)!;
    const previous = providerPreset(base.preset);
    // A name or note the previous preset filled follows the new one; typed ones stay.
    const untouched = (value: string, filled: string | undefined) =>
      !value || value === filled;
    return {
      ...base,
      preset: id,
      name: untouched(base.name, previous?.label)
        ? id === "custom"
          ? ""
          : preset.label
        : base.name,
      // A custom provider keeps the address typed so far.
      url: preset.url || base.url,
      auth: preset.auth,
      dialect: preset.dialect,
      free: preset.free,
      dataHandling: untouched(
        base.dataHandling,
        previous && text.presetNotes[previous.id],
      )
        ? text.presetNotes[id]
        : base.dataHandling,
    };
  };
  const [value, setValue] = useState<Draft>(() =>
    provider
      ? {
          name: provider.name,
          url: provider.url,
          enabled: provider.enabled,
          dailyRequestLimit: provider.dailyRequestLimit,
          preset: provider.preset ?? "custom",
          auth: provider.auth ?? { type: "bearer" },
          dialect: provider.dialect ?? "openai",
          free: provider.free ?? false,
          dataHandling: provider.dataHandling ?? "",
        }
      : fromPreset(START_PRESET, {
          name: "",
          url: "",
          enabled: true,
          dailyRequestLimit: 1000,
          preset: START_PRESET,
          auth: { type: "bearer" },
          dialect: "openai",
          free: false,
          dataHandling: "",
        }),
  );
  const [revision] = useState(provider?.revision ?? 0),
    [key, setKey] = useState("");
  const local = providerPreset(value.preset)?.local ?? false;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const settings = ProviderSettings.safeParse({
      ...value,
      dataHandling: value.dataHandling.trim() || undefined,
    });
    if (!settings.success) {
      state.setError(copy.invalid);
      return;
    }
    const result = await state.mutate("command", {
      type: "saveProvider",
      ...(provider ? { id: provider.id } : {}),
      revision,
      settings: settings.data,
      ...(key && value.auth.type !== "none" ? { apiKey: key } : {}),
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
          {errors}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider-preset">{text.preset}</FieldLabel>
              <Select
                value={value.preset}
                onValueChange={(id) =>
                  setValue(fromPreset(id as ProviderPresetIdValue, value))
                }
              >
                <SelectTrigger id="provider-preset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_PRESETS.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{text.presetHint}</FieldDescription>
            </Field>
            {local && (
              <Alert>
                <AlertDescription>{text.localHint}</AlertDescription>
              </Alert>
            )}
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
              <FieldLabel htmlFor="provider-auth">{text.authType}</FieldLabel>
              <Select
                value={value.auth.type}
                onValueChange={(type) =>
                  setValue({
                    ...value,
                    auth:
                      type === "header"
                        ? { type: "header", header: "api-key" }
                        : { type: type as "bearer" | "none" },
                  })
                }
              >
                <SelectTrigger id="provider-auth" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bearer">{text.authBearer}</SelectItem>
                  <SelectItem value="header">{text.authHeader}</SelectItem>
                  <SelectItem value="none">{text.authNone}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {value.auth.type === "header" && (
              <Field>
                <FieldLabel htmlFor="provider-header">
                  {text.authHeaderName}
                </FieldLabel>
                <Input
                  id="provider-header"
                  value={value.auth.header}
                  maxLength={61}
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
            )}
            <Field>
              <FieldLabel htmlFor="provider-dialect">{text.dialect}</FieldLabel>
              <Select
                value={value.dialect}
                onValueChange={(dialect) =>
                  setValue({
                    ...value,
                    dialect: dialect as ProviderDialectValue,
                  })
                }
              >
                <SelectTrigger id="provider-dialect" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">{text.dialectOpenai}</SelectItem>
                  <SelectItem value="openrouter">
                    {text.dialectOpenrouter}
                  </SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>{text.dialectHint}</FieldDescription>
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
            <Field>
              <FieldLabel htmlFor="provider-data">
                {text.dataHandling}
              </FieldLabel>
              <Textarea
                id="provider-data"
                value={value.dataHandling}
                maxLength={500}
                onChange={(e) =>
                  setValue({ ...value, dataHandling: e.target.value })
                }
              />
              <FieldDescription>{text.dataHandlingHint}</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="provider-free">{text.free}</FieldLabel>
                <FieldDescription>{text.freeHint}</FieldDescription>
              </FieldContent>
              <Switch
                id="provider-free"
                checked={value.free}
                onCheckedChange={(free) => setValue({ ...value, free })}
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
