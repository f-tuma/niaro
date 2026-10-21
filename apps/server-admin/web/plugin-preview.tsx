import { useEffect, useId, useRef, useState } from "react";
import { Braces, Check, ChevronDown, Copy, Play } from "lucide-react";
import { DateTimeInput } from "../../../packages/protocol/internal-plugins";
import {
  WorkspacePluginPreviewSchema,
  type WorkspacePluginPreview,
  type WorkspacePlugins,
} from "../../../packages/protocol/workspace-plugins";
import { Card, CardContent } from "@admin/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@admin/components/ui/collapsible";
import { Field, FieldGroup, FieldLabel } from "@admin/components/ui/field";
import { Input } from "@admin/components/ui/input";
import { Button } from "@admin/components/ui/button";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import { Section } from "@admin/components/console/page";
import { DetailList, SubmitButton } from "@admin/components/console/forms";
import { api, ApiError } from "./lib/api";
import { usePluginsCopy } from "./plugins-copy";

type Mode = "tomorrow" | "nextTuesday" | "date" | "elapsed";
export function PluginPreview({
  current,
  blocked,
  unsaved,
}: {
  current: WorkspacePlugins;
  blocked: boolean;
  unsaved: boolean;
}) {
  const copy = usePluginsCopy();
  const id = useId();
  const [mode, setMode] = useState<Mode>("nextTuesday");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("14:00");
  const [minutes, setMinutes] = useState("60");
  const [duration, setDuration] = useState("30");
  const [result, setResult] = useState<WorkspacePluginPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const request = useRef<AbortController | null>(null);
  const unavailable = !current.settings.enabled.includes("datetime");
  const disabled = blocked || unavailable;
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (disabled) request.current?.abort();
  }, [disabled]);
  function edited(change: () => void) {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setResult(null);
    setError(null);
    setCopied(false);
    change();
  }
  async function run(utcOffset?: string) {
    if (disabled || request.current) return;
    const input = DateTimeInput.safeParse({
      when:
        mode === "tomorrow"
          ? { kind: "day_offset", days: 1 }
          : mode === "nextTuesday"
            ? { kind: "week_day", weeks: 1, weekday: 2 }
            : mode === "date"
              ? { kind: "date", date }
              : {
                  kind: "elapsed",
                  minutes: minutes.trim() ? Number(minutes) : NaN,
                },
      ...(mode !== "elapsed" ? { time } : {}),
      ...(duration.trim() ? { durationMinutes: Number(duration) } : {}),
      ...(utcOffset ? { utcOffset } : {}),
    });
    if (!input.success) {
      setError(copy.previewInvalid);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setResult(null);
    setError(null);
    setCopied(false);
    try {
      const value = WorkspacePluginPreviewSchema.parse(
        await api(
          "identity/plugins/preview",
          {
            organizationId: current.organizationId,
            workspaceId: current.workspaceId,
            revision: current.revision,
            tool: "internal_datetime_resolve",
            input: input.data,
          },
          controller.signal,
        ),
      );
      if (!controller.signal.aborted) {
        if (
          value.organizationId !== current.organizationId ||
          value.workspaceId !== current.workspaceId ||
          value.revision !== current.revision ||
          value.timeZone !== current.settings.timeZone
        )
          setError(copy.previewChanged);
        else setResult(value);
      }
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof ApiError && err.status === 409
            ? copy.previewChanged
            : err instanceof ApiError && [401, 403, 404].includes(err.status)
              ? copy.previewDenied
              : copy.previewFailed,
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  const visibleResult = disabled ? null : result;
  const json = visibleResult ? JSON.stringify(visibleResult, null, 2) : "";
  return (
    <Section title={copy.preview}>
      <Card>
        <CardContent>
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <FieldGroup>
              <Field data-disabled={disabled}>
                <FieldLabel id={`${id}-mode`}>
                  {copy.previewScenario}
                </FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={mode}
                  disabled={disabled}
                  aria-labelledby={`${id}-mode`}
                  className="flex-wrap justify-start"
                  onValueChange={(value) => {
                    if (value) edited(() => setMode(value as Mode));
                  }}
                >
                  {(
                    ["tomorrow", "nextTuesday", "date", "elapsed"] as const
                  ).map((value) => (
                    <ToggleGroupItem key={value} value={value}>
                      {copy[value]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                {mode === "date" && (
                  <Field data-disabled={disabled}>
                    <FieldLabel htmlFor={`${id}-date`}>{copy.date}</FieldLabel>
                    <Input
                      id={`${id}-date`}
                      type="date"
                      required
                      min="2000-01-01"
                      max="2100-12-31"
                      value={date}
                      disabled={disabled}
                      onChange={(e) => edited(() => setDate(e.target.value))}
                    />
                  </Field>
                )}
                <Field data-disabled={disabled}>
                  <FieldLabel htmlFor={`${id}-time`}>
                    {mode === "elapsed" ? copy.minutes : copy.localTime}
                  </FieldLabel>
                  {mode === "elapsed" ? (
                    <Input
                      id={`${id}-time`}
                      type="number"
                      min={-525600}
                      max={525600}
                      step={1}
                      value={minutes}
                      disabled={disabled}
                      onChange={(e) => edited(() => setMinutes(e.target.value))}
                    />
                  ) : (
                    <Input
                      id={`${id}-time`}
                      type="time"
                      required
                      step={60}
                      value={time}
                      disabled={disabled}
                      onChange={(e) => edited(() => setTime(e.target.value))}
                    />
                  )}
                </Field>
                <Field data-disabled={disabled}>
                  <FieldLabel htmlFor={`${id}-duration`}>
                    {copy.duration}
                  </FieldLabel>
                  <Input
                    id={`${id}-duration`}
                    type="number"
                    min={1}
                    max={10080}
                    step={1}
                    value={duration}
                    placeholder={copy.optional}
                    disabled={disabled}
                    onChange={(e) => edited(() => setDuration(e.target.value))}
                  />
                </Field>
              </div>
            </FieldGroup>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <SubmitButton
                variant="outline"
                pending={busy}
                disabled={disabled}
              >
                {!busy && <Play data-icon="inline-start" aria-hidden="true" />}
                {copy.calculate}
              </SubmitButton>
              {disabled && unsaved && (
                <p className="text-sm text-muted-foreground">
                  {copy.previewSaveFirst}
                </p>
              )}
            </div>
          </form>
          {visibleResult && (
            <div
              className="mt-6 flex min-w-0 flex-col gap-4 border-t pt-6"
              role="status"
            >
              {visibleResult.result.status === "resolved" ? (
                <>
                  <DetailList
                    items={(
                      [
                        [copy.localTime, visibleResult.result.values.iso],
                        ["UTC", visibleResult.result.values.utc],
                        [copy.endLocal, visibleResult.result.values.endIso],
                        [copy.endUtc, visibleResult.result.values.endUtc],
                        [copy.reference, visibleResult.referenceNow],
                      ] as const
                    )
                      .filter(([, value]) => value !== undefined)
                      .map(([label, value]) => ({
                        label,
                        value: (
                          <code className="font-mono text-xs break-all">
                            {String(value)}
                          </code>
                        ),
                      }))}
                  />
                </>
              ) : (
                <>
                  <Alert>
                    <AlertDescription>
                      {copy[visibleResult.result.reason]}
                    </AlertDescription>
                  </Alert>
                  {visibleResult.result.alternatives?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {visibleResult.result.alternatives.map((alternative) => (
                        <Button
                          key={alternative.utc}
                          type="button"
                          variant="outline"
                          onClick={() => void run(alternative.utcOffset)}
                        >
                          UTC{alternative.utcOffset}
                          <code className="font-mono text-xs text-muted-foreground">
                            {alternative.utc}
                          </code>
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  <DetailList
                    items={[
                      {
                        label: copy.reference,
                        value: (
                          <code className="font-mono text-xs break-all">
                            {visibleResult.referenceNow}
                          </code>
                        ),
                      },
                    ]}
                  />
                </>
              )}
              <Collapsible>
                <div className="flex flex-wrap items-center gap-2">
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="group/json -ml-2"
                    >
                      <Braces data-icon="inline-start" aria-hidden="true" />
                      {copy.jsonOutput}
                      <ChevronDown
                        data-icon="inline-end"
                        aria-hidden="true"
                        className="transition-transform group-data-[state=open]/json:rotate-180"
                      />
                    </Button>
                  </CollapsibleTrigger>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(json)
                        .then(() => setCopied(true))
                        .catch(() => setError(copy.copyFailed));
                    }}
                  >
                    {copied ? (
                      <Check data-icon="inline-start" aria-hidden="true" />
                    ) : (
                      <Copy data-icon="inline-start" aria-hidden="true" />
                    )}
                    {copied ? copy.copied : copy.copy}
                  </Button>
                </div>
                <CollapsibleContent>
                  <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
                    <code>{json}</code>
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}
        </CardContent>
      </Card>
    </Section>
  );
}
