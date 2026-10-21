import { useId, useMemo, type ReactNode } from "react";
import { ZodError } from "zod";
import { ChevronRight, Plus } from "lucide-react";
import type { DesignCapabilities } from "../../../packages/protocol/process-design";
import type { ProcessVersion } from "../../../packages/protocol/service-processes";
import type { NativeTestTools } from "../../../packages/protocol/process-native-testing";
import { ProcessTestScenarioSchema } from "../../../packages/protocol/process-testing";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Textarea } from "@admin/components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
  FieldDescription,
} from "@admin/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import { Card } from "@admin/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@admin/components/ui/collapsible";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import { MoreActions } from "@admin/components/console/forms";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { StatusDot } from "@admin/components/console/status";
import { Disclosure } from "./process-design-review";
import { testEn, testCs, type TestCopy } from "./process-test-copy";
import {
  readSuiteDraft,
  newCaseDraft,
  newActionDraft,
  newReceiptDraft,
  newModelDraft,
  newQuestionDraft,
  literalWorkflowStarterSuite,
  parseSuiteDraft,
  type SuiteDraft,
  type CaseDraft,
  type ModelDraft,
  type QuestionDraft,
} from "./lib/process-test-suite";

export function SuiteText({
  label,
  value,
  onChange,
  json = false,
  multiline = false,
  disabled = false,
  maxLength,
  required = false,
  invalid: invalidProp = false,
  errorMessage,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  json?: boolean;
  multiline?: boolean;
  disabled?: boolean;
  maxLength?: number;
  required?: boolean;
  invalid?: boolean;
  errorMessage?: string;
}) {
  const id = useId();
  let invalid = invalidProp || (required && !value.trim());
  if (json && value) {
    try {
      const v = JSON.parse(value);
      invalid = !v || typeof v !== "object" || Array.isArray(v);
    } catch {
      invalid = true;
    }
  }
  return (
    <Field data-invalid={invalid} data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {json || multiline ? (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-invalid={invalid}
          rows={3}
          spellCheck={false}
          maxLength={maxLength}
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-invalid={invalid}
          maxLength={maxLength}
        />
      )}
      {invalid && errorMessage && (
        <FieldDescription>{errorMessage}</FieldDescription>
      )}
    </Field>
  );
}
export function SuiteChoice({
  label,
  value,
  options,
  onChange,
  disabled = false,
  hideLabel = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
  /** For a compact toolbar select; the label stays as its accessible name. */
  hideLabel?: boolean;
}) {
  const id = useId();
  const known = options.some((o) => o.value === value);
  return (
    <Field data-disabled={disabled}>
      {!hideLabel && <FieldLabel htmlFor={id}>{label}</FieldLabel>}
      <Select
        value={value || undefined}
        onValueChange={onChange}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-label={hideLabel ? label : undefined}>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {!known && value && <SelectItem value={value}>{value}</SelectItem>}
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}
const ordering = <T,>(items: T[], index: number, delta: number) => {
  const next = [...items];
  [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
  return next;
};
function Order({
  index,
  count,
  onMove,
  onRemove,
  copy,
  disabled,
}: {
  index: number;
  count: number;
  onMove: (d: number) => void;
  onRemove: () => void;
  copy: TestCopy;
  disabled: boolean;
}) {
  return (
    <MoreActions label={copy.more} size="sm">
      <DropdownMenuItem
        disabled={disabled || index === 0}
        onSelect={() => onMove(-1)}
      >
        {copy.up}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={disabled || index === count - 1}
        onSelect={() => onMove(1)}
      >
        {copy.down}
      </DropdownMenuItem>
      <DropdownMenuItem
        variant="destructive"
        disabled={disabled}
        onSelect={onRemove}
      >
        {copy.remove}
      </DropdownMenuItem>
    </MoreActions>
  );
}
/** A numbered entry whose legend row carries its reorder/remove menu. */
function Entry({
  legend,
  order,
  children,
}: {
  legend: string;
  order: ReactNode;
  children: ReactNode;
}) {
  return (
    <FieldSet>
      <FieldLegend
        variant="label"
        className="flex w-full items-center justify-between"
      >
        <span className="min-w-0 truncate">{legend}</span>
        {order}
      </FieldLegend>
      {children}
    </FieldSet>
  );
}
export function SuiteEditor({
  value,
  onChange,
  capabilities,
  version,
  tools,
  disabled,
  language,
}: {
  value: string;
  onChange: (v: string) => void;
  capabilities: DesignCapabilities | null;
  version: ProcessVersion | null;
  tools: NativeTestTools | null;
  disabled: boolean;
  language: "en" | "cs";
}) {
  const copy = language === "cs" ? testCs : testEn;
  const draft = useMemo(() => {
    try {
      return readSuiteDraft(value);
    } catch {
      return null;
    }
  }, [value]);
  if (!draft)
    return (
      <Alert variant="destructive">
        <AlertDescription>{copy.invalid}</AlertDescription>
      </Alert>
    );
  const change = (patch: Partial<SuiteDraft>) =>
    onChange(JSON.stringify({ ...draft, ...patch }));
  const edit = (index: number, patch: Partial<CaseDraft>) =>
    change({
      cases: draft.cases.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  const options = (values: string[]) =>
    values.map((v) => ({ value: v, label: copy[v as keyof TestCopy] ?? v }));
  const modelOptions =
    capabilities?.models.map((m) => ({
      value: m.id,
      label: `${m.name} · ${m.model} · r${m.revision} / ${m.providerRevision}`,
    })) ?? [];
  const services = capabilities?.services ?? [];
  const configuredModels =
    version?.definition.kind === "agent"
      ? [version.definition.modelId]
      : (version?.definition.steps
          .filter((s) => s.type === "agent")
          .map((s) => s.modelId) ?? []);
  const configuredOnly = draft.comparisonMode === "configured_only";
  const modelFreeWorkflow =
    version?.definition.kind === "workflow" && configuredModels.length === 0;
  const starter = literalWorkflowStarterSuite(version);
  const issues: string[] = [];
  if (new Set(draft.cases.map((c) => c.id)).size !== draft.cases.length)
    issues.push(copy.duplicateIds);
  if (draft.cases.length) {
    try {
      parseSuiteDraft(value);
    } catch (error) {
      if (error instanceof ZodError)
        for (const issue of error.issues.slice(0, 8)) {
          const path = issue.path.map((part) =>
            typeof part === "number"
              ? part + 1
              : part === "genericModelId"
                ? copy.baseline
                : (copy[part as keyof TestCopy] ?? part),
          );
          issues.push(
            `${path.join(" · ") || copy.title}: ${copy.invalidField}`,
          );
        }
      else issues.push(error instanceof Error ? error.message : copy.invalid);
    }
  }
  function questions(
    c: CaseDraft,
    index: number,
    strategy: "configured" | "generic",
  ) {
    const fixtures = c.questions ?? { configured: [], generic: [] };
    const entries = fixtures[strategy];
    const update = (next: QuestionDraft[]) =>
      edit(index, { questions: { ...fixtures, [strategy]: next } });
    return (
      <Disclosure
        title={`${copy[strategy]} — ${copy.questions} (${entries.length})`}
      >
        <FieldGroup>
          {entries.map((entry, j) => (
            <Entry
              key={j}
              legend={`${copy[strategy]} ${j + 1}`}
              order={
                <Order
                  index={j}
                  count={entries.length}
                  copy={copy}
                  disabled={disabled}
                  onMove={(delta) => update(ordering(entries, j, delta))}
                  onRemove={() => update(entries.filter((_, i) => i !== j))}
                />
              }
            >
              <FieldGroup>
                <SuiteText
                  label={copy.question}
                  value={entry.question}
                  multiline
                  maxLength={2000}
                  onChange={(v) =>
                    update(
                      entries.map((fixture, i) =>
                        i === j ? { ...fixture, question: v } : fixture,
                      ),
                    )
                  }
                  disabled={disabled}
                />
                <SuiteText
                  label={copy.answer}
                  value={entry.answer}
                  multiline
                  maxLength={4000}
                  onChange={(v) =>
                    update(
                      entries.map((fixture, i) =>
                        i === j ? { ...fixture, answer: v } : fixture,
                      ),
                    )
                  }
                  disabled={disabled}
                />
              </FieldGroup>
            </Entry>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={disabled || entries.length >= 16}
            onClick={() => update([...entries, newQuestionDraft()])}
          >
            {copy.addQuestion}
          </Button>
        </FieldGroup>
      </Disclosure>
    );
  }
  function scripts(
    c: CaseDraft,
    index: number,
    strategy: "configured" | "generic",
  ) {
    const steps = c[strategy];
    const names =
      strategy === "configured"
        ? (tools?.configured.flatMap((n) =>
            n.tools.map((t) => ({
              value: t.name,
              label: `${n.nodeId} · ${capabilities?.models.find((m) => m.id === n.modelId)?.name ?? n.modelId} · ${t.name}${"actionId" in t ? ` · ${services.find((s) => s.id === t.serviceId)?.actions.find((a) => a.id === t.actionId)?.name ?? t.actionId}` : ""}`,
            })),
          ) ?? [])
        : (tools?.generic.map((t) => ({
            value: t.name,
            label: `${t.name}${t.actionId ? ` · ${services.find((s) => s.id === t.serviceId)?.actions.find((a) => a.id === t.actionId)?.name ?? t.actionId}` : ""}`,
          })) ?? []);
    const grouped = new Map<string, string[]>();
    for (const n of names)
      grouped.set(n.value, [...(grouped.get(n.value) ?? []), n.label]);
    const unique = [...grouped].map(([value, labels]) => ({
      value,
      label: labels.join("; "),
    }));
    const update = (j: number, patch: Partial<ModelDraft>) =>
      edit(index, {
        [strategy]: steps.map((s, i) => (i === j ? { ...s, ...patch } : s)),
      });
    return (
      <Disclosure title={`${copy[strategy]} — ${copy.steps} (${steps.length})`}>
        <div className="flex flex-col gap-4">
          {steps.map((s, j) => (
            <Entry
              key={j}
              legend={`${copy[strategy]} ${j + 1}`}
              order={
                <Order
                  index={j}
                  count={steps.length}
                  copy={copy}
                  disabled={disabled}
                  onMove={(d) =>
                    edit(index, { [strategy]: ordering(steps, j, d) })
                  }
                  onRemove={() =>
                    edit(index, { [strategy]: steps.filter((_, i) => i !== j) })
                  }
                />
              }
            >
              <FieldGroup>
                <SuiteChoice
                  label={copy.model}
                  value={s.modelId}
                  options={modelOptions}
                  onChange={(v) => update(j, { modelId: v })}
                  disabled={disabled}
                />
                <SuiteChoice
                  label={copy.replyType}
                  value={s.replyType}
                  options={options(["text", "tool"])}
                  onChange={(v) =>
                    update(j, { replyType: v as ModelDraft["replyType"] })
                  }
                  disabled={disabled}
                />
                {s.replyType === "text" ? (
                  <SuiteText
                    label={copy.replyText}
                    multiline
                    value={s.replyText}
                    onChange={(v) => update(j, { replyText: v })}
                    disabled={disabled}
                  />
                ) : (
                  <>
                    <SuiteChoice
                      label={copy.toolName}
                      value={s.tool}
                      options={unique}
                      onChange={(v) => update(j, { tool: v })}
                      disabled={disabled}
                    />
                    <SuiteText
                      label={copy.exactToolName}
                      value={s.tool}
                      onChange={(v) => update(j, { tool: v })}
                      disabled={disabled}
                    />
                    <SuiteText
                      label={copy.callId}
                      value={s.callId}
                      onChange={(v) => update(j, { callId: v })}
                      disabled={disabled}
                    />
                    <SuiteText
                      label={copy.input}
                      value={s.input}
                      onChange={(v) => update(j, { input: v })}
                      json
                      disabled={disabled}
                    />
                  </>
                )}
                <SuiteText
                  label={copy.tools}
                  multiline
                  value={s.requiredTools}
                  onChange={(v) => update(j, { requiredTools: v })}
                  disabled={disabled}
                />
                <div className="grid gap-4 md:grid-cols-2">
                  <SuiteText
                    label={copy.inputTokens}
                    value={s.inputTokens}
                    onChange={(v) => update(j, { inputTokens: v })}
                    disabled={disabled}
                  />
                  <SuiteText
                    label={copy.outputTokens}
                    value={s.outputTokens}
                    onChange={(v) => update(j, { outputTokens: v })}
                    disabled={disabled}
                  />
                </div>
              </FieldGroup>
            </Entry>
          ))}
          <Button
            variant="outline"
            disabled={disabled || steps.length >= 32}
            onClick={() =>
              edit(index, {
                [strategy]: [
                  ...steps,
                  newModelDraft(
                    strategy === "generic"
                      ? draft!.genericModelId
                      : configuredModels[0],
                  ),
                ],
              })
            }
          >
            {copy.addStep}
          </Button>
        </div>
      </Disclosure>
    );
  }
  return (
    <div data-test-suite className="flex flex-col gap-4">
      {issues.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{copy.invalid}</p>
            <ul className="list-disc pl-4">
              {issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {modelFreeWorkflow && (
        <SuiteChoice
          label={copy.testingMode}
          value={configuredOnly ? "configured_only" : "comparison"}
          options={[
            { value: "comparison", label: copy.compareGeneric },
            ...(!draft.cases.some(
              (c) =>
                c.configured.length ||
                c.generic.length ||
                (c.questions?.configured.length ?? 0) ||
                (c.questions?.generic.length ?? 0),
            )
              ? [{ value: "configured_only", label: copy.configuredOnly }]
              : []),
          ]}
          onChange={(mode) =>
            change({
              comparisonMode: mode === "configured_only" ? mode : undefined,
            })
          }
          disabled={disabled}
        />
      )}
      {configuredOnly && (
        <p className="text-sm text-muted-foreground">
          {copy.configuredOnlyHint}
        </p>
      )}
      {starter && !draft.cases.length && (
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => onChange(starter)}
        >
          {copy.prepareLiteralChecks}
        </Button>
      )}
      <div className="grid items-start gap-4 md:grid-cols-2">
        {!configuredOnly && (
          <SuiteChoice
            label={copy.baseline}
            value={draft.genericModelId}
            options={modelOptions}
            onChange={(v) => change({ genericModelId: v })}
            disabled={disabled}
          />
        )}
        <Field>
          <FieldLabel>{copy.coverage}</FieldLabel>
          <div className="flex min-h-8 flex-wrap items-center gap-1.5">
            {ProcessTestScenarioSchema.options.map((s) => (
              <StatusDot
                key={s}
                tone={
                  draft.cases.some((c) => c.scenario === s)
                    ? "success"
                    : "neutral"
                }
              >
                {copy[s]}
              </StatusDot>
            ))}
          </div>
        </Field>
      </div>
      <Card variant="list">
        {!draft.cases.length && (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {copy.empty}
          </p>
        )}
        {draft.cases.map((c, index) => (
          <Collapsible key={index} className="group/case">
            <div className="flex min-h-11 items-center gap-2 pr-3 pl-2">
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-w-0 flex-1 justify-start"
                >
                  <ChevronRight
                    data-icon="inline-start"
                    aria-hidden="true"
                    className="transition-transform group-data-open/case:rotate-90 motion-reduce:transition-none"
                  />
                  <span className="truncate">
                    {index + 1}. {copy[c.scenario]}
                  </span>
                  <span className="truncate font-mono text-xs font-normal text-muted-foreground">
                    {c.id}
                  </span>
                </Button>
              </CollapsibleTrigger>
              <Order
                index={index}
                count={draft.cases.length}
                copy={copy}
                disabled={disabled}
                onMove={(d) =>
                  change({ cases: ordering(draft.cases, index, d) })
                }
                onRemove={() =>
                  change({ cases: draft.cases.filter((_, i) => i !== index) })
                }
              />
            </div>
            <CollapsibleContent>
              <div className="border-t px-4 py-4">
                <FieldGroup>
                  <SuiteText
                    label={copy.id}
                    value={c.id}
                    required
                    invalid={
                      draft.cases.filter((item) => item.id === c.id).length > 1
                    }
                    errorMessage={
                      c.id.trim() ? copy.duplicateIds : copy.requiredField
                    }
                    onChange={(v) => edit(index, { id: v })}
                    disabled={disabled}
                  />
                  <SuiteChoice
                    label={copy.scenario}
                    value={c.scenario}
                    options={options(ProcessTestScenarioSchema.options)}
                    onChange={(v) =>
                      edit(index, {
                        scenario: v as CaseDraft["scenario"],
                        reopenAt:
                          v === "restart" ? c.reopenAt || "suspended" : "",
                      })
                    }
                    disabled={disabled}
                  />
                  <div className="grid gap-4 lg:grid-cols-2">
                    <SuiteText
                      label={copy.input}
                      value={c.input}
                      onChange={(v) => edit(index, { input: v })}
                      json
                      disabled={disabled}
                    />
                    <SuiteText
                      label={copy.output}
                      value={c.output}
                      onChange={(v) => edit(index, { output: v })}
                      json
                      disabled={disabled}
                    />
                  </div>
                  {!["success", "restart"].includes(c.scenario) && (
                    <div className="grid gap-4 md:grid-cols-2">
                      <SuiteText
                        label={copy.configuredCode}
                        value={c.configuredCode}
                        required
                        errorMessage={copy.requiredField}
                        onChange={(v) => edit(index, { configuredCode: v })}
                        disabled={disabled}
                      />
                      {!configuredOnly && (
                        <SuiteText
                          label={copy.genericCode}
                          value={c.genericCode}
                          required
                          errorMessage={copy.requiredField}
                          onChange={(v) => edit(index, { genericCode: v })}
                          disabled={disabled}
                        />
                      )}
                    </div>
                  )}
                  {c.scenario === "restart" && (
                    <SuiteChoice
                      label={copy.reopenAt}
                      value={c.reopenAt || "suspended"}
                      options={options(["suspended", "completed"])}
                      onChange={(v) =>
                        edit(index, { reopenAt: v as CaseDraft["reopenAt"] })
                      }
                      disabled={disabled}
                    />
                  )}
                  <Disclosure title={`${copy.actions} (${c.actions.length})`}>
                    <div className="flex flex-col gap-4">
                      {c.actions.map((a, j) => {
                        const update = (p: Partial<typeof a>) =>
                          edit(index, {
                            actions: c.actions.map((x, i) =>
                              i === j ? { ...x, ...p } : x,
                            ),
                          });
                        return (
                          <Entry
                            key={j}
                            legend={`${copy.action} ${j + 1}`}
                            order={
                              <Order
                                index={j}
                                count={c.actions.length}
                                copy={copy}
                                disabled={disabled}
                                onMove={(d) =>
                                  edit(index, {
                                    actions: ordering(c.actions, j, d),
                                  })
                                }
                                onRemove={() =>
                                  edit(index, {
                                    actions: c.actions.filter(
                                      (_, i) => i !== j,
                                    ),
                                  })
                                }
                              />
                            }
                          >
                            <FieldGroup>
                              <SuiteChoice
                                label={copy.service}
                                value={a.serviceId}
                                options={services.map((s) => ({
                                  value: s.id,
                                  label: s.name,
                                }))}
                                onChange={(v) => update({ serviceId: v })}
                                disabled={disabled}
                              />
                              <SuiteChoice
                                label={copy.action}
                                value={a.actionId}
                                options={
                                  services
                                    .find((s) => s.id === a.serviceId)
                                    ?.actions.map((x) => ({
                                      value: x.id,
                                      label: `${x.name} · ${x.effect}`,
                                    })) ?? []
                                }
                                onChange={(v) => update({ actionId: v })}
                                disabled={disabled}
                              />
                              <SuiteChoice
                                label={copy.decision}
                                value={a.decision}
                                options={options(["none", "approve", "reject"])}
                                onChange={(v) =>
                                  update({
                                    decision: v as typeof a.decision,
                                  })
                                }
                                disabled={disabled}
                              />
                              <SuiteChoice
                                label={copy.result}
                                value={a.outcome}
                                options={options([
                                  "complete",
                                  "failure",
                                  "unknown",
                                ])}
                                onChange={(v) =>
                                  update({ outcome: v as typeof a.outcome })
                                }
                                disabled={disabled}
                              />
                              <SuiteText
                                label={copy.input}
                                value={a.input}
                                json
                                onChange={(v) => update({ input: v })}
                                disabled={disabled}
                              />
                              <SuiteText
                                label={copy.actionOutput}
                                value={a.output}
                                json
                                onChange={(v) => update({ output: v })}
                                disabled={disabled}
                              />
                            </FieldGroup>
                          </Entry>
                        );
                      })}
                      <Button
                        variant="outline"
                        disabled={disabled || c.actions.length >= 32}
                        onClick={() =>
                          edit(index, {
                            actions: [...c.actions, newActionDraft()],
                          })
                        }
                      >
                        {copy.addAction}
                      </Button>
                    </div>
                  </Disclosure>
                  <Disclosure title={`${copy.receipts} (${c.receipts.length})`}>
                    <div className="flex flex-col gap-4">
                      {c.receipts.map((r, j) => {
                        const update = (p: Partial<typeof r>) =>
                          edit(index, {
                            receipts: c.receipts.map((x, i) =>
                              i === j ? { ...x, ...p } : x,
                            ),
                          });
                        return (
                          <Entry
                            key={j}
                            legend={`${copy.receipt} ${j + 1}`}
                            order={
                              <Order
                                index={j}
                                count={c.receipts.length}
                                copy={copy}
                                disabled={disabled}
                                onMove={(d) =>
                                  edit(index, {
                                    receipts: ordering(c.receipts, j, d),
                                  })
                                }
                                onRemove={() =>
                                  edit(index, {
                                    receipts: c.receipts.filter(
                                      (_, i) => i !== j,
                                    ),
                                  })
                                }
                              />
                            }
                          >
                            <FieldGroup>
                              <SuiteChoice
                                label={copy.service}
                                value={r.serviceId}
                                options={services.map((s) => ({
                                  value: s.id,
                                  label: s.name,
                                }))}
                                onChange={(v) => update({ serviceId: v })}
                                disabled={disabled}
                              />
                              <SuiteChoice
                                label={copy.action}
                                value={r.actionId}
                                options={
                                  services
                                    .find((s) => s.id === r.serviceId)
                                    ?.actions.map((x) => ({
                                      value: x.id,
                                      label: x.name,
                                    })) ?? []
                                }
                                onChange={(v) => update({ actionId: v })}
                                disabled={disabled}
                              />
                              <div className="grid gap-4 md:grid-cols-2">
                                <SuiteText
                                  label={copy.serviceRevision}
                                  value={r.serviceRevision}
                                  onChange={(v) =>
                                    update({ serviceRevision: v })
                                  }
                                  disabled={disabled}
                                />
                                <SuiteText
                                  label={copy.actionRevision}
                                  value={r.actionRevision}
                                  onChange={(v) =>
                                    update({ actionRevision: v })
                                  }
                                  disabled={disabled}
                                />
                              </div>
                              <SuiteChoice
                                label={copy.effect}
                                value={r.effect}
                                options={options(["read", "write"])}
                                onChange={(v) =>
                                  update({ effect: v as typeof r.effect })
                                }
                                disabled={disabled}
                              />
                              <SuiteChoice
                                label={copy.status}
                                value={r.status}
                                options={options([
                                  "succeeded",
                                  "failed",
                                  "unknown",
                                  "rejected",
                                ])}
                                onChange={(v) =>
                                  update({ status: v as typeof r.status })
                                }
                                disabled={disabled}
                              />
                              <SuiteText
                                label={copy.code}
                                value={r.code}
                                onChange={(v) => update({ code: v })}
                                disabled={disabled}
                              />
                              <SuiteText
                                label={copy.dispatches}
                                value={r.dispatches}
                                onChange={(v) => update({ dispatches: v })}
                                disabled={disabled}
                              />
                              <SuiteText
                                label={copy.input}
                                value={r.input}
                                json
                                onChange={(v) => update({ input: v })}
                                disabled={disabled}
                              />
                              <SuiteText
                                label={copy.actionOutput}
                                value={r.output}
                                json
                                onChange={(v) => update({ output: v })}
                                disabled={disabled}
                              />
                            </FieldGroup>
                          </Entry>
                        );
                      })}
                      <Button
                        variant="outline"
                        disabled={disabled || c.receipts.length >= 32}
                        onClick={() =>
                          edit(index, {
                            receipts: [...c.receipts, newReceiptDraft()],
                          })
                        }
                      >
                        {copy.addReceipt}
                      </Button>
                    </div>
                  </Disclosure>
                  {(!configuredOnly || c.configured.length > 0) &&
                    scripts(c, index, "configured")}
                  {(!configuredOnly || c.generic.length > 0) &&
                    scripts(c, index, "generic")}
                  {(!configuredOnly || c.questions !== undefined) && (
                    <Disclosure title={copy.questions}>
                      <FieldGroup>
                        <p className="text-sm text-muted-foreground">
                          {copy.questionsHint}
                        </p>
                        {questions(c, index, "configured")}
                        {questions(c, index, "generic")}
                        {c.questions !== undefined ? (
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={disabled}
                            onClick={() =>
                              edit(index, { questions: undefined })
                            }
                          >
                            {copy.removeQuestions}
                          </Button>
                        ) : null}
                      </FieldGroup>
                    </Disclosure>
                  )}
                </FieldGroup>
              </div>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </Card>
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || draft.cases.length >= 16}
          onClick={() =>
            change({
              cases: [
                ...draft.cases,
                newCaseDraft("success", draft.cases.length + 1),
              ],
            })
          }
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {copy.addCase}
        </Button>
      </div>
    </div>
  );
}
