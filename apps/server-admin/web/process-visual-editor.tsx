import { useCallback, useEffect, useId, useState } from "react";
import {
  Bot,
  Plus,
  Settings2,
  Trash2,
  Workflow,
  RotateCcw,
  ChevronDown,
} from "lucide-react";
import {
  DesignBriefSchema,
  type DesignCapabilities,
  type OwnedDesignReview,
} from "../../../packages/protocol/process-design";
import {
  ProcessDefinitionSchema,
  ProcessDataSchema,
  type ProcessDefinition,
  type ProcessStep,
  type ProcessBinding,
} from "../../../packages/protocol/service-processes";
import { Button } from "@admin/components/ui/button";
import { Badge } from "@admin/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@admin/components/ui/card";
import { Input } from "@admin/components/ui/input";
import { Textarea } from "@admin/components/ui/textarea";
import { Field, FieldLabel, FieldGroup } from "@admin/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@admin/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@admin/components/ui/sheet";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@admin/components/ui/tabs";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Switch } from "@admin/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@admin/components/ui/tooltip";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyMedia,
} from "@admin/components/ui/empty";
import { StatusBadge } from "@admin/components/console/status";
import { Disclosure } from "@admin/components/console/disclosure";
import { ConfirmAction } from "@admin/components/console/forms";
import {
  createWorkflow,
  addStep,
  attachStep,
  connectStep,
  disconnectStep,
  insertStep,
  openPorts,
  parseDraftWorkflow,
  renameStep,
  removeStep,
  setEntry,
  structuralProblems,
  type StepPort,
  type ActionRef,
} from "./lib/process-editor";
import { editorEn, editorCs, type EditorCopy } from "./process-editor-copy";
import { ProcessEditorCanvas, readableName } from "./process-editor-canvas";
import { ProcessStepPicker } from "./process-step-picker";
import { ProcessBindingFields } from "./process-binding-fields";
import { ProcessSchemaFields } from "./process-schema-fields";
import { useIsMobile } from "./hooks/use-mobile";
import type { ProcessDesignClient } from "./lib/process-design-client";

const json = (v: unknown) => JSON.stringify(v, null, 2);
function FormField({
  label,
  children,
}: {
  label: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children(id)}
    </Field>
  );
}
function Choice({
  label,
  value,
  values,
  disabled,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  values: { id: string; name: string; disabled?: boolean }[];
  disabled: boolean;
  placeholder?: string;
  onChange(v: string): void;
}) {
  return (
    <FormField label={label}>
      {(id) => (
        <Select value={value} disabled={disabled} onValueChange={onChange}>
          <SelectTrigger id={id}>
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {value && !values.some((v) => v.id === value) && (
                <SelectItem value={value} disabled>
                  {value}
                </SelectItem>
              )}
              {values.map((v) => (
                <SelectItem key={v.id} value={v.id} disabled={v.disabled}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
    </FormField>
  );
}
function JsonField({
  label,
  text,
  original,
  disabled,
  copy,
  onChange,
  onApply,
}: {
  label: string;
  text: string;
  original: string;
  disabled: boolean;
  copy: EditorCopy;
  onChange(v: string): void;
  onApply(v: unknown): void;
}) {
  const [error, setError] = useState(false);
  return (
    <FormField label={label}>
      {(id) => (
        <>
          <Textarea
            id={id}
            value={text}
            maxLength={100_000}
            mono
            disabled={disabled}
            aria-invalid={error}
            className="min-h-28"
            onChange={(e) => {
              onChange(e.target.value);
              setError(false);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || text === original}
            onClick={() => {
              try {
                onApply(JSON.parse(text));
                setError(false);
              } catch {
                setError(true);
              }
            }}
          >
            {copy.apply}
          </Button>
          {error && (
            <span role="alert" className="text-sm text-destructive">
              {copy.invalid}
            </span>
          )}
        </>
      )}
    </FormField>
  );
}
function nodeTitle(
  step: ProcessStep,
  capabilities: DesignCapabilities,
  copy: EditorCopy,
) {
  return step.type === "action"
    ? (capabilities.services
        .find((s) => s.id === step.serviceId)
        ?.actions.find((a) => a.id === step.actionId)?.name ?? copy.action)
    : copy[step.type];
}
function problemText(key: string, copy: EditorCopy) {
  if (key.includes("referenced")) return copy.referenced;
  if (key.includes("entry_required")) return copy.entryRequired;
  if (key.includes("open_output")) return copy.openOutput;
  if (key.includes("step_id")) return copy.idInvalid;
  if (key.includes("limit")) return copy.limit;
  if (key.includes("capability")) return copy.capability;
  if (key.includes("duplicate")) return copy.duplicate;
  if (key.includes("missing_entry")) return copy.missingEntry;
  if (key.includes("dangling")) return copy.dangling;
  if (key.includes("cycle")) return copy.cycle;
  if (key.includes("unreachable")) return copy.unreachable;
  return copy.invalid;
}

export function ProcessVisualEditor({
  client,
  review,
  capabilities,
  language,
  blocked,
  onDirty,
  active = true,
}: {
  client: ProcessDesignClient;
  review: OwnedDesignReview;
  capabilities: DesignCapabilities;
  language: "en" | "cs";
  blocked: boolean;
  onDirty(dirty: boolean): void;
  active?: boolean;
}) {
  const mobile = useIsMobile();
  const copy = language === "cs" ? editorCs : editorEn;
  const [base, setBase] = useState(review),
    [candidate, setCandidate] = useState<ProcessDefinition | null>(
      review.candidate,
    ),
    [purpose, setPurpose] = useState(review.brief.purpose);
  const [selected, setSelected] = useState(
    review.candidate?.kind === "workflow" ? review.candidate.entry : "",
  );
  const [inspector, setInspector] = useState(false),
    [settings, setSettings] = useState(false),
    [palette, setPalette] = useState(false),
    [nodeTab, setNodeTab] = useState("parameters");
  const [rename, setRename] = useState(""),
    [problem, setProblem] = useState<string | null>(null),
    [saving, setSaving] = useState(false);
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({}),
    [bindingDrafts, setBindingDrafts] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<{
    past: (ProcessDefinition | null)[];
    future: (ProcessDefinition | null)[];
  }>({ past: [], future: [] });
  const [insertAt, setInsertAt] = useState<{
    from: string | null;
    port: StepPort;
    replace?: boolean;
  } | null>(null);
  const dirty =
    json(candidate) !== json(base.candidate) ||
    purpose !== base.brief.purpose ||
    Object.keys(jsonDrafts).length > 0 ||
    Object.keys(bindingDrafts).length > 0;
  const unapplied =
    Object.keys(jsonDrafts).length > 0 || Object.keys(bindingDrafts).length > 0;
  const stale =
    base.revision !== review.revision ||
    base.reviewDigest !== review.reviewDigest ||
    base.capabilityFingerprint !== review.capabilityFingerprint;
  const disabled = blocked || saving || !!review.acceptedProcessId;
  const parsed = ProcessDefinitionSchema.safeParse(candidate);
  // Open outputs are a valid draft state on the canvas but cannot be saved.
  const draftWorkflow =
    candidate?.kind === "workflow" ? parseDraftWorkflow(candidate) : null;
  const problems = draftWorkflow ? structuralProblems(draftWorkflow) : [];
  // Graph problems show on the canvas; this covers fields that do not parse.
  const invalidFields = !!candidate && !parsed.success && !draftWorkflow;
  const selectedStep =
    candidate?.kind === "workflow"
      ? candidate.steps.find((s) => s.id === selected)
      : undefined;
  const agent =
    candidate?.kind === "agent"
      ? candidate
      : selectedStep?.type === "agent"
        ? selectedStep
        : null;
  const options =
    candidate?.kind === "workflow"
      ? candidate.steps.map((s) => ({
          id: s.id,
          name: `${nodeTitle(s, capabilities, copy)} (${s.id})`,
        }))
      : [];
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  // Reconcile a clean incoming revision before children render the old graph.
  if (stale && !dirty && !saving) {
    setBase(review);
    setCandidate(review.candidate);
    setPurpose(review.brief.purpose);
    setSelected(
      review.candidate?.kind === "workflow" ? review.candidate.entry : "",
    );
    setRename("");
    setProblem(null);
    setHistory({ past: [], future: [] });
  }
  function edit(next: ProcessDefinition, strict = false) {
    setCandidate(strict ? ProcessDefinitionSchema.parse(next) : next);
    setProblem(null);
  }
  /** Graph changes are undoable; field typing is not recorded step by step. */
  function graphEdit(next: ProcessDefinition) {
    setHistory((current) => ({
      past: [...current.past.slice(-49), candidate],
      future: [],
    }));
    edit(next);
  }
  function travel(direction: "past" | "future") {
    const stack = history[direction];
    if (!stack.length || disabled) return;
    const target = stack[stack.length - 1]!;
    const other = direction === "past" ? "future" : "past";
    setHistory({
      [direction]: stack.slice(0, -1),
      [other]: [...history[other], candidate],
    } as typeof history);
    setCandidate(target);
    setProblem(null);
    if (
      target?.kind === "workflow" &&
      !target.steps.some((step) => step.id === selected)
    ) {
      setSelected(target.entry);
      setInspector(false);
    }
  }
  function patch(key: string, value: unknown, strict = false) {
    if (candidate)
      edit({ ...candidate, [key]: value } as ProcessDefinition, strict);
  }
  function stepPatch(key: string, value: unknown, strict = false) {
    if (candidate?.kind === "workflow") {
      edit(
        {
          ...candidate,
          steps: candidate.steps.map((s) =>
            s.id === selected ? ({ ...s, [key]: value } as ProcessStep) : s,
          ),
        },
        strict,
      );
      if (
        (strict && ["input", "output", "condition"].includes(key)) ||
        (key === "condition" &&
          (value as { operator?: string })?.operator !== "equals")
      )
        setBindingDrafts((previous) => {
          const next = { ...previous };
          if (strict) {
            const prefix = `${selected}/${key}/`;
            for (const id of Object.keys(next))
              if (id.startsWith(prefix)) delete next[id];
          }
          if (key === "condition") delete next[`${selected}/comparison`];
          return next;
        });
    }
  }
  const agentPatch = candidate?.kind === "agent" ? patch : stepPatch;
  function attempt(fn: () => void) {
    try {
      fn();
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "process_editor_invalid");
    }
  }
  const clearJson = useCallback(
    (key: string) =>
      setJsonDrafts((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      }),
    [],
  );
  const jsonField = (
    scope: string,
    key: string,
    value: unknown,
    apply: (v: unknown) => void,
  ) => {
    const id = `${scope}/${key}`;
    return (
      <JsonField
        key={id}
        label={copy[key as keyof EditorCopy] ?? key}
        text={jsonDrafts[id] ?? json(value)}
        original={json(value)}
        copy={copy}
        disabled={disabled}
        onChange={(text) =>
          setJsonDrafts((previous) => {
            const next = { ...previous };
            if (text === json(value)) delete next[id];
            else next[id] = text;
            return next;
          })
        }
        onApply={(v) => {
          apply(v);
          clearJson(id);
        }}
      />
    );
  };
  const schemaField = (
    scope: string,
    key: string,
    value: unknown,
    apply: (v: unknown) => void,
  ) => {
    const schema = ProcessDataSchema.safeParse(value);
    if (!schema.success) return jsonField(scope, key, value, apply);
    const prefix = `schema/${scope}/${key}/`;
    return (
      <ProcessSchemaFields
        label={copy[key as keyof EditorCopy] ?? key}
        value={schema.data}
        disabled={disabled || !!jsonDrafts[`${scope}/${key}`]}
        copy={copy}
        drafts={Object.fromEntries(
          Object.entries(bindingDrafts)
            .filter(([id]) => id.startsWith(prefix))
            .map(([id, text]) => [id.slice(prefix.length), text]),
        )}
        onDraft={(key, text) =>
          setBindingDrafts((previous) => {
            const next = { ...previous };
            if (text === null) delete next[prefix + key];
            else next[prefix + key] = text;
            return next;
          })
        }
        onChange={(value) => apply(ProcessDataSchema.parse(value))}
      />
    );
  };
  function selectAction(serviceId: string, actionId: string) {
    if (candidate?.kind !== "workflow" || selectedStep?.type !== "action")
      return;
    if (
      selectedStep.serviceId === serviceId &&
      selectedStep.actionId === actionId
    )
      return;
    edit({
      ...candidate,
      steps: candidate.steps.map((step) =>
        step.id === selected
          ? {
              ...selectedStep,
              serviceId,
              actionId,
              input: {},
              outputSchema: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
              },
            }
          : step,
      ),
    });
    setBindingDrafts((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(
          ([id]) =>
            !id.startsWith(`${selected}/input/`) &&
            !id.startsWith(`schema/node/${selected}/`),
        ),
      ),
    );
    setJsonDrafts((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(
          ([id]) => !id.startsWith(`node/${selected}/`),
        ),
      ),
    );
  }
  const bindField = (
    key: string,
    bindings: Record<string, ProcessBinding>,
    fields: string[],
    change: (v: Record<string, ProcessBinding>) => void,
  ) => {
    if (!candidate) return null;
    const prefix = `${selected}/${key}/`;
    const drafts = Object.fromEntries(
      Object.entries(bindingDrafts)
        .filter(([id]) => id.startsWith(prefix))
        .map(([id, text]) => [id.slice(prefix.length), text]),
    );
    return (
      <ProcessBindingFields
        key={prefix}
        bindings={bindings}
        fields={fields}
        inputSchema={candidate.inputSchema}
        steps={candidate.kind === "workflow" ? candidate.steps : []}
        disabled={disabled}
        copy={copy}
        drafts={drafts}
        onDraft={(id, text) =>
          setBindingDrafts((previous) => {
            const next = { ...previous };
            if (text === null) delete next[prefix + id];
            else next[prefix + id] = text;
            return next;
          })
        }
        onChange={change}
      />
    );
  };
  const fieldsFor = (schema: unknown, fallback: string[]) => {
    const result = ProcessDataSchema.safeParse(schema);
    if (result.success && result.data.type === "object")
      return [
        ...new Set([...Object.keys(result.data.properties), ...fallback]),
      ];
    if (
      schema &&
      typeof schema === "object" &&
      "properties" in schema &&
      schema.properties &&
      typeof schema.properties === "object"
    )
      return [...new Set([...Object.keys(schema.properties), ...fallback])];
    return fallback;
  };
  function reset() {
    setBase(review);
    setCandidate(review.candidate);
    setPurpose(review.brief.purpose);
    setSelected(
      review.candidate?.kind === "workflow" ? review.candidate.entry : "",
    );
    setJsonDrafts({});
    setBindingDrafts({});
    setProblem(null);
    setRename("");
    setHistory({ past: [], future: [] });
  }
  function save() {
    if (
      !parsed.success ||
      stale ||
      disabled ||
      unapplied ||
      problems.length ||
      !purpose.trim()
    )
      return;
    const brief = DesignBriefSchema.parse({ ...base.brief, purpose });
    setSaving(true);
    void client
      .updateCandidate(base, parsed.data, brief)
      .then(() => {
        const latest = client.getSnapshot();
        if (
          !latest.pending &&
          latest.review &&
          json(latest.review.candidate) === json(parsed.data) &&
          latest.review.brief.purpose === brief.purpose
        ) {
          setBase(latest.review);
          setCandidate(latest.review.candidate);
          setPurpose(latest.review.brief.purpose);
        }
      })
      .catch(() => setProblem("process_editor_invalid"))
      .finally(() => setSaving(false));
  }
  function add(type: ProcessStep["type"], action?: ActionRef) {
    attempt(() => {
      const initial = candidate ?? createWorkflow(capabilities);
      if (initial.kind !== "workflow") return;
      // Without a chosen place, continue from the selected step's open output.
      const open = openPorts(initial).find((port) => port.from === selected);
      const next = !candidate
        ? type === "return"
          ? initial
          : addStep(initial, type, capabilities, action)
        : !insertAt
          ? attachStep(
              initial,
              open?.from ?? null,
              open?.port ?? "next",
              type,
              capabilities,
              action,
            )
          : insertAt.from === null
            ? addStep(initial, type, capabilities, action)
            : (insertAt.replace ? attachStep : insertStep)(
                initial,
                insertAt.from,
                insertAt.port,
                type,
                capabilities,
                action,
              );
      const added = next.steps.find(
        (s) => !initial.steps.some((old) => old.id === s.id),
      );
      graphEdit(next);
      setSelected(added?.id ?? next.entry);
      setRename(added?.id ?? "");
      setNodeTab("parameters");
      setPalette(false);
      setInspector(true);
      setInsertAt(null);
    });
  }
  const stepName = (id: string) => {
    const step =
      candidate?.kind === "workflow"
        ? candidate.steps.find((item) => item.id === id)
        : undefined;
    return step ? readableName(nodeTitle(step, capabilities, copy)) : id;
  };
  const portLabel = (port: StepPort) =>
    port === "next"
      ? ""
      : ` · ${port === "whenTrue" ? copy.whenTrue : copy.whenFalse}`;
  const selectedOpen =
    draftWorkflow && openPorts(draftWorkflow).find((p) => p.from === selected);
  const pickerContext = !candidate
    ? copy.emptyCanvas
    : insertAt?.from === null && candidate.kind === "workflow"
      ? `${copy.pickerBefore}: ${stepName(candidate.entry)}`
      : insertAt?.from
        ? `${copy.pickerAfter}: ${stepName(insertAt.from)}${portLabel(insertAt.port)}`
        : selectedOpen
          ? `${copy.pickerAfter}: ${stepName(selectedOpen.from)}${portLabel(selectedOpen.port)}`
          : copy.addDetached;
  const parameters = (
    <FieldGroup>
      {selectedStep?.type === "action" && (
        <>
          <Choice
            label={copy.serviceId}
            value={selectedStep.serviceId}
            values={capabilities.services.map((s) => ({
              id: s.id,
              name: s.name,
              disabled:
                !s.enabled ||
                !s.actions.some(
                  (a) =>
                    a.enabled &&
                    a.status === "configured" &&
                    !a.schemaUnavailable,
                ),
            }))}
            disabled={disabled}
            onChange={(id) => {
              const action = capabilities.services
                .find((s) => s.id === id)
                ?.actions.find(
                  (a) =>
                    a.enabled &&
                    a.status === "configured" &&
                    !a.schemaUnavailable,
                );
              if (action) selectAction(id, action.id);
            }}
          />
          <Choice
            label={copy.actionId}
            value={selectedStep.actionId}
            values={(
              capabilities.services.find((s) => s.id === selectedStep.serviceId)
                ?.actions ?? []
            ).map((a) => ({
              id: a.id,
              name: `${a.name} (${copy[a.effect]}, ${copy[a.approval]})`,
              disabled:
                !a.enabled ||
                a.status !== "configured" ||
                !!a.schemaUnavailable,
            }))}
            disabled={disabled}
            onChange={(id) => selectAction(selectedStep.serviceId, id)}
          />
          <p className="text-sm text-muted-foreground">{copy.actionChanged}</p>
          {bindField(
            "input",
            selectedStep.input,
            fieldsFor(
              capabilities.services
                .find((s) => s.id === selectedStep.serviceId)
                ?.actions.find((a) => a.id === selectedStep.actionId)
                ?.inputSchema,
              Object.keys(selectedStep.input),
            ),
            (v) => stepPatch("input", v),
          )}
        </>
      )}
      {agent && (
        <>
          <Choice
            label={copy.modelId}
            value={agent.modelId}
            values={capabilities.models.map((m) => ({
              id: m.id,
              name: m.name,
            }))}
            disabled={disabled}
            onChange={(v) => agentPatch("modelId", v)}
          />
          <FormField label={copy.instructions}>
            {(id) => (
              <Textarea
                id={id}
                value={agent.instructions}
                maxLength={4000}
                disabled={disabled}
                className="max-h-72"
                onChange={(e) => agentPatch("instructions", e.target.value)}
              />
            )}
          </FormField>
          {selectedStep?.type === "agent" &&
            schemaField(
              `node/${selected}`,
              "inputSchema",
              selectedStep.inputSchema,
              (v) => stepPatch("inputSchema", v),
            )}
          {selectedStep?.type === "agent" &&
            bindField(
              "input",
              selectedStep.input,
              fieldsFor(
                selectedStep.inputSchema,
                Object.keys(selectedStep.input),
              ),
              (v) => stepPatch("input", v),
            )}
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">{copy.capabilities}</h3>
            {agent.capabilities.map((capability, index) => (
              <div
                key={index}
                className="flex flex-col gap-2 rounded-lg border p-3"
              >
                <Choice
                  label={copy.serviceId}
                  value={capability.serviceId}
                  values={capabilities.services.map((service) => ({
                    id: service.id,
                    name: service.name,
                    disabled: !service.enabled,
                  }))}
                  disabled={disabled}
                  onChange={(serviceId) => {
                    const service = capabilities.services.find(
                      (item) => item.id === serviceId && item.enabled,
                    );
                    if (!service?.actions.length) return;
                    agentPatch(
                      "capabilities",
                      agent.capabilities.map((item, i) =>
                        i === index
                          ? { serviceId, actionId: service.actions[0]!.id }
                          : item,
                      ),
                    );
                  }}
                />
                <Choice
                  label={copy.actionId}
                  value={capability.actionId}
                  values={(
                    capabilities.services.find(
                      (service) => service.id === capability.serviceId,
                    )?.actions ?? []
                  ).map((action) => ({ id: action.id, name: action.name }))}
                  disabled={disabled}
                  onChange={(actionId) =>
                    agentPatch(
                      "capabilities",
                      agent.capabilities.map((item, i) =>
                        i === index ? { ...item, actionId } : item,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    agentPatch(
                      "capabilities",
                      agent.capabilities.filter((_, i) => i !== index),
                    )
                  }
                >
                  {copy.removeCapability}
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              disabled={
                disabled ||
                agent.capabilities.length >= 16 ||
                !capabilities.services.some(
                  (service) => service.enabled && service.actions.length,
                )
              }
              onClick={() => {
                const service = capabilities.services.find(
                  (item) => item.enabled && item.actions.length,
                );
                if (service)
                  agentPatch("capabilities", [
                    ...agent.capabilities,
                    { serviceId: service.id, actionId: service.actions[0]!.id },
                  ]);
              }}
            >
              {copy.addCapability}
            </Button>
          </div>
        </>
      )}
      {selectedStep?.type === "branch" && (
        <>
          <Choice
            label={copy.operator}
            value={selectedStep.condition.operator}
            values={[
              { id: "exists", name: copy.exists },
              { id: "equals", name: copy.equals },
            ]}
            disabled={disabled}
            onChange={(operator) =>
              stepPatch(
                "condition",
                operator === "exists"
                  ? { operator, left: selectedStep.condition.left }
                  : { operator, left: selectedStep.condition.left, right: "" },
              )
            }
          />
          {bindField(
            "condition",
            { value: selectedStep.condition.left },
            ["value"],
            (v) => {
              if (v.value)
                stepPatch("condition", {
                  ...selectedStep.condition,
                  left: v.value,
                });
              else setProblem("process_editor_invalid");
            },
          )}
          {selectedStep.condition.operator === "equals" && (
            <ScalarField
              value={selectedStep.condition.right}
              copy={copy}
              disabled={disabled}
              draft={bindingDrafts[`${selected}/comparison`]}
              onDraft={(text) =>
                setBindingDrafts((previous) => {
                  const next = { ...previous };
                  if (text === null) delete next[`${selected}/comparison`];
                  else next[`${selected}/comparison`] = text;
                  return next;
                })
              }
              onChange={(right) =>
                stepPatch("condition", { ...selectedStep.condition, right })
              }
            />
          )}
          <Choice
            label={copy.whenTrue}
            value={selectedStep.whenTrue}
            values={options}
            disabled={disabled}
            placeholder={copy.unconnected}
            onChange={(v) => stepPatch("whenTrue", v)}
          />
          <Choice
            label={copy.whenFalse}
            value={selectedStep.whenFalse}
            values={options}
            disabled={disabled}
            placeholder={copy.unconnected}
            onChange={(v) => stepPatch("whenFalse", v)}
          />
        </>
      )}
      {selectedStep && "outputSchema" in selectedStep && (
        <>
          <p className="text-sm text-muted-foreground">{copy.outputContract}</p>
          {schemaField(
            `node/${selected}`,
            "outputSchema",
            selectedStep.outputSchema,
            (v) => stepPatch("outputSchema", v),
          )}
        </>
      )}
      {selectedStep?.type === "return" &&
        candidate &&
        bindField(
          "output",
          selectedStep.output,
          fieldsFor(candidate.outputSchema, Object.keys(selectedStep.output)),
          (v) => stepPatch("output", v),
        )}
      {selectedStep && "next" in selectedStep && (
        <Choice
          label={copy.next}
          value={selectedStep.next}
          values={options}
          disabled={disabled}
          placeholder={copy.unconnected}
          onChange={(v) => stepPatch("next", v)}
        />
      )}
    </FieldGroup>
  );
  const settingsFields = (
    <FieldGroup>
      {selectedStep && (
        <>
          <FormField label={copy.stepId}>
            {(id) => (
              <Input
                id={id}
                value={rename || selectedStep.id}
                maxLength={64}
                disabled={disabled || unapplied}
                onChange={(e) => setRename(e.target.value)}
              />
            )}
          </FormField>
          <Button
            variant="outline"
            disabled={
              disabled || unapplied || !rename || rename === selectedStep.id
            }
            onClick={() =>
              attempt(() => {
                if (candidate?.kind !== "workflow") return;
                edit(renameStep(candidate, selected, rename));
                setSelected(rename);
              })
            }
          >
            {copy.rename}
          </Button>
        </>
      )}
      {agent && (
        <>
          <Choice
            label={copy.memory}
            value={agent.memory}
            values={capabilities.memoryModes.map((m) => ({
              id: m,
              name: copy[m],
            }))}
            disabled={disabled}
            onChange={(v) => agentPatch("memory", v)}
          />
          <FormField label={copy.optionalHuman}>
            {(id) => (
              <Switch
                id={id}
                checked={agent.humanInput === "text"}
                disabled={disabled}
                onCheckedChange={(checked) => {
                  const next = { ...agent };
                  if (checked) next.humanInput = "text";
                  else delete next.humanInput;
                  if (candidate?.kind === "agent")
                    edit(next as ProcessDefinition);
                  else if (candidate?.kind === "workflow")
                    edit({
                      ...candidate,
                      steps: candidate.steps.map((s) =>
                        s.id === selected ? (next as ProcessStep) : s,
                      ),
                    });
                }}
              />
            )}
          </FormField>
        </>
      )}
      <Disclosure title={copy.advanced}>
        <FieldGroup>
          {selectedStep &&
            "input" in selectedStep &&
            jsonField(`node/${selected}`, "input", selectedStep.input, (v) =>
              stepPatch("input", v, true),
            )}
          {selectedStep &&
            "output" in selectedStep &&
            jsonField(`node/${selected}`, "output", selectedStep.output, (v) =>
              stepPatch("output", v, true),
            )}
          {selectedStep &&
            "condition" in selectedStep &&
            jsonField(
              `node/${selected}`,
              "condition",
              selectedStep.condition,
              (v) => stepPatch("condition", v, true),
            )}
          {selectedStep &&
            "inputSchema" in selectedStep &&
            jsonField(
              `node/${selected}`,
              "inputSchema",
              selectedStep.inputSchema,
              (v) => stepPatch("inputSchema", v),
            )}
          {selectedStep &&
            "outputSchema" in selectedStep &&
            jsonField(
              `node/${selected}`,
              "outputSchema",
              selectedStep.outputSchema,
              (v) => stepPatch("outputSchema", v),
            )}
        </FieldGroup>
      </Disclosure>
    </FieldGroup>
  );
  return (
    <div
      data-testid="process-visual-editor"
      data-process-editor
      className="flex min-w-0 flex-col rounded-lg border bg-background"
    >
      <div className="flex min-h-14 items-center gap-2 border-b px-3 py-2 sm:px-4">
        <div className="flex min-w-0 flex-1">
          <Button
            variant="ghost"
            disabled={saving}
            className="max-w-full"
            onClick={() => setSettings(true)}
          >
            <Workflow aria-hidden="true" data-icon="inline-start" />
            <span className="truncate">{candidate?.name || copy.title}</span>
            <ChevronDown aria-hidden="true" data-icon="inline-end" />
          </Button>
        </div>
        {!mobile &&
          (stale ? (
            <StatusBadge tone="warning">{copy.staleShort}</StatusBadge>
          ) : (
            dirty && <StatusBadge tone="warning">{copy.unsaved}</StatusBadge>
          ))}
        {(dirty || stale) && (
          <ConfirmAction
            trigger={
              <Button
                variant="ghost"
                size="icon"
                aria-label={copy.reset}
                title={copy.reset}
                disabled={saving || !!client.getSnapshot().pending}
              >
                <RotateCcw aria-hidden="true" />
              </Button>
            }
            title={copy.reset}
            confirmLabel={copy.reset}
            cancelLabel={copy.cancel}
            onConfirm={reset}
          />
        )}
        <Button
          variant="outline"
          size={mobile ? "icon" : "default"}
          aria-label={mobile ? copy.add : undefined}
          title={mobile ? copy.add : undefined}
          disabled={disabled || candidate?.kind === "agent"}
          onClick={() => {
            setInsertAt(null);
            setPalette(true);
          }}
        >
          <Plus
            aria-hidden="true"
            data-icon={mobile ? undefined : "inline-start"}
          />
          {!mobile && copy.add}
        </Button>
        {!mobile && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={copy.processSettings}
            title={copy.processSettings}
            onClick={() => setSettings(true)}
          >
            <Settings2 aria-hidden="true" />
          </Button>
        )}
        {/* What saving does matters only at the moment of saving. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex">
              <Button
                disabled={
                  disabled ||
                  stale ||
                  !dirty ||
                  !parsed.success ||
                  problems.length > 0 ||
                  unapplied ||
                  !purpose.trim()
                }
                onClick={save}
              >
                {saving ? copy.applying : copy.save}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{copy.draftHint}</TooltipContent>
        </Tooltip>
      </div>
      {(problem ||
        stale ||
        invalidFields ||
        (candidate && (!purpose.trim() || unapplied))) && (
        <div className="px-4 py-2">
          <Alert variant={problem || invalidFields ? "destructive" : "default"}>
            <AlertDescription>
              {problem
                ? problemText(problem, copy)
                : stale
                  ? copy.stale
                  : invalidFields
                    ? copy.invalid
                    : null}
              {candidate && !purpose.trim() && (
                <div className="flex flex-wrap items-center gap-2">
                  <span>{copy.purposeMissing}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSettings(true)}
                  >
                    {copy.processSettings}
                  </Button>
                </div>
              )}
              {unapplied && <div>{copy.pendingFields}</div>}
            </AlertDescription>
          </Alert>
        </div>
      )}
      {candidate?.kind === "workflow" ? (
        <ProcessEditorCanvas
          workflow={candidate}
          capabilities={capabilities}
          selected={selected}
          disabled={disabled}
          copy={copy}
          onSelect={(id) => {
            setSelected(id);
            setRename(id);
            setInspector(true);
          }}
          layoutKey={review.id}
          issues={problems.map((p) => problemText(p, copy))}
          canUndo={history.past.length > 0}
          canRedo={history.future.length > 0}
          onUndo={() => travel("past")}
          onRedo={() => travel("future")}
          onConnect={(from, to, port) =>
            attempt(() => graphEdit(connectStep(candidate, from, port, to)))
          }
          onEntry={(to) => attempt(() => graphEdit(setEntry(candidate, to)))}
          onDisconnect={(from, port) =>
            attempt(() => graphEdit(disconnectStep(candidate, from, port)))
          }
          onAdd={(from, port, options) => {
            setInsertAt({ from, port, replace: options?.replace });
            setPalette(true);
          }}
          onDelete={(id) =>
            attempt(() => {
              const next = removeStep(candidate, id);
              graphEdit(next);
              if (selected === id) {
                setSelected(next.entry);
                setRename("");
                setInspector(false);
              }
            })
          }
        />
      ) : candidate?.kind === "agent" ? (
        <div className="flex min-h-96 flex-1 items-center justify-center p-4">
          <Card className="w-full max-w-lg">
            <CardHeader>
              <CardTitle>
                <span className="flex items-center gap-2">
                  <Bot aria-hidden="true" />
                  {candidate.name || copy.agent}
                </span>
              </CardTitle>
              <CardDescription>
                {capabilities.models.find((m) => m.id === candidate.modelId)
                  ?.name ?? candidate.modelId}
              </CardDescription>
              <CardAction>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => setInspector(true)}
                >
                  {copy.editAgent}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3">
                <p className="line-clamp-4 text-sm whitespace-pre-wrap text-muted-foreground">
                  {candidate.instructions}
                </p>
                {candidate.capabilities.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      {copy.capabilities}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {candidate.capabilities.map((ref) => {
                        const service = capabilities.services.find(
                          (item) => item.id === ref.serviceId,
                        );
                        const action = service?.actions.find(
                          (item) => item.id === ref.actionId,
                        );
                        return (
                          <Badge
                            key={`${ref.serviceId}:${ref.actionId}`}
                            variant="outline"
                          >
                            {action?.name ?? ref.actionId}
                            {service && (
                              <span className="text-muted-foreground">
                                {service.name}
                              </span>
                            )}
                          </Badge>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Empty className="min-h-96">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Workflow aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{copy.emptyCanvas}</EmptyTitle>
          </EmptyHeader>
          <Button
            disabled={disabled}
            onClick={() => {
              setInsertAt(null);
              setPalette(true);
            }}
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            {copy.create}
          </Button>
        </Empty>
      )}
      <Sheet
        open={active && inspector && (!!selectedStep || !!agent)}
        modal={mobile}
        onOpenChange={(open) => {
          if (!saving) setInspector(open);
        }}
      >
        <SheetContent size="lg" className="flex flex-col">
          <SheetHeader>
            <SheetTitle>
              {selectedStep
                ? nodeTitle(selectedStep, capabilities, copy)
                : copy.agent}
            </SheetTitle>
            <SheetDescription>
              {selectedStep?.id ?? candidate?.name}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            <Tabs value={nodeTab} onValueChange={setNodeTab}>
              <TabsList variant="line" className="w-full">
                <TabsTrigger value="parameters">{copy.parameters}</TabsTrigger>
                <TabsTrigger value="settings">{copy.settings}</TabsTrigger>
              </TabsList>
              <TabsContent value="parameters">{parameters}</TabsContent>
              <TabsContent value="settings">{settingsFields}</TabsContent>
            </Tabs>
            {problem && (
              <Alert variant="destructive">
                <AlertDescription>
                  {problemText(problem, copy)}
                </AlertDescription>
              </Alert>
            )}
          </div>
          <SheetFooter>
            {selectedStep && (
              <span className="sm:mr-auto">
                <ConfirmAction
                  trigger={
                    <Button
                      variant="destructive"
                      disabled={disabled || unapplied}
                    >
                      <Trash2 aria-hidden="true" data-icon="inline-start" />
                      {copy.remove}
                    </Button>
                  }
                  title={`${copy.remove}: ${selectedStep.id}`}
                  confirmLabel={copy.remove}
                  cancelLabel={copy.cancel}
                  onConfirm={() =>
                    attempt(() => {
                      if (candidate?.kind !== "workflow") return;
                      const next = removeStep(candidate, selected);
                      graphEdit(next);
                      setSelected(next.entry);
                      setRename("");
                      setInspector(false);
                    })
                  }
                />
              </span>
            )}
            <Button disabled={saving} onClick={() => setInspector(false)}>
              {copy.done}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <Sheet
        open={active && settings}
        onOpenChange={(open) => {
          if (!saving) setSettings(open);
        }}
      >
        <SheetContent size="lg" className="flex flex-col">
          <SheetHeader>
            <SheetTitle>{copy.processSettings}</SheetTitle>
            <SheetDescription className="sr-only">
              {copy.draftHint}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            <FieldGroup>
              <FormField label={copy.purpose}>
                {(id) => (
                  <Textarea
                    id={id}
                    value={purpose}
                    maxLength={4000}
                    disabled={disabled}
                    onChange={(e) => setPurpose(e.target.value)}
                  />
                )}
              </FormField>
              {candidate && (
                <>
                  <FormField label={copy.name}>
                    {(id) => (
                      <Input
                        id={id}
                        value={candidate.name}
                        maxLength={100}
                        disabled={disabled}
                        onChange={(e) => patch("name", e.target.value)}
                      />
                    )}
                  </FormField>
                  <FormField label={copy.description}>
                    {(id) => (
                      <Textarea
                        id={id}
                        value={candidate.description}
                        maxLength={1000}
                        disabled={disabled}
                        onChange={(e) => patch("description", e.target.value)}
                      />
                    )}
                  </FormField>
                  {candidate.kind === "workflow" && (
                    <Choice
                      label={copy.entry}
                      value={candidate.entry}
                      values={options}
                      disabled={disabled}
                      onChange={(v) => patch("entry", v)}
                    />
                  )}
                  {schemaField(
                    "root",
                    "inputSchema",
                    candidate.inputSchema,
                    (v) => patch("inputSchema", v),
                  )}
                  {schemaField(
                    "root",
                    "outputSchema",
                    candidate.outputSchema,
                    (v) => patch("outputSchema", v),
                  )}
                  <Disclosure title={copy.advanced}>
                    <FieldGroup>
                      {jsonField(
                        "root",
                        "inputSchema",
                        candidate.inputSchema,
                        (v) => patch("inputSchema", v),
                      )}
                      {jsonField(
                        "root",
                        "outputSchema",
                        candidate.outputSchema,
                        (v) => patch("outputSchema", v),
                      )}
                      {jsonField("root", "limits", candidate.limits, (v) =>
                        patch("limits", v, true),
                      )}
                    </FieldGroup>
                  </Disclosure>
                </>
              )}
            </FieldGroup>
          </div>
          <SheetFooter>
            <Button disabled={saving} onClick={() => setSettings(false)}>
              {copy.done}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <Sheet
        open={active && palette}
        onOpenChange={(open) => {
          setPalette(open);
          if (!open) setInsertAt(null);
        }}
      >
        <SheetContent className="flex flex-col">
          <SheetHeader>
            <SheetTitle>
              {!candidate
                ? copy.create
                : insertAt?.from === null
                  ? copy.pickerStart
                  : copy.pickerNext}
            </SheetTitle>
            <SheetDescription>{pickerContext}</SheetDescription>
          </SheetHeader>
          <ProcessStepPicker
            capabilities={capabilities}
            copy={copy}
            disabled={disabled}
            allowAgent={capabilities.models.length > 0}
            onPick={add}
          />
          {problem && (
            <Alert variant="destructive">
              <AlertDescription>{problemText(problem, copy)}</AlertDescription>
            </Alert>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ScalarField({
  value,
  copy,
  disabled,
  draft,
  onDraft,
  onChange,
}: {
  value: string | number | boolean | null;
  copy: EditorCopy;
  disabled: boolean;
  draft?: string;
  onDraft(text: string | null): void;
  onChange(value: string | number | boolean | null): void;
}) {
  const type = value === null ? "null" : typeof value;
  return (
    <FieldGroup>
      <Choice
        label={copy.literalType}
        value={type}
        values={["string", "number", "boolean", "null"].map((id) => ({
          id,
          name: copy[id as keyof EditorCopy],
        }))}
        disabled={disabled}
        onChange={(next) => {
          onDraft(null);
          onChange(
            next === "number"
              ? 0
              : next === "boolean"
                ? false
                : next === "null"
                  ? null
                  : "",
          );
        }}
      />
      {typeof value === "boolean" ? (
        <Choice
          label={copy.comparison}
          value={String(value)}
          values={[
            { id: "true", name: copy.true },
            { id: "false", name: copy.false },
          ]}
          disabled={disabled}
          onChange={(next) => onChange(next === "true")}
        />
      ) : (
        value !== null && (
          <FormField label={copy.comparison}>
            {(id) => (
              <Input
                id={id}
                value={draft ?? String(value)}
                disabled={disabled}
                maxLength={4000}
                aria-invalid={draft !== undefined}
                inputMode={type === "number" ? "decimal" : "text"}
                onChange={(event) => {
                  const text = event.target.value;
                  if (type === "number") {
                    if (
                      !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
                        text.trim(),
                      ) ||
                      !Number.isFinite(Number(text))
                    ) {
                      onDraft(text);
                      return;
                    }
                    onChange(Number(text));
                  } else onChange(text);
                  onDraft(null);
                }}
              />
            )}
          </FormField>
        )
      )}
      {draft !== undefined && (
        <span role="alert" className="text-sm text-destructive">
          {copy.invalid}
        </span>
      )}
    </FieldGroup>
  );
}
