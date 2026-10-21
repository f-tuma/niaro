import { useState } from "react";
import { AdminLink } from "./process-host";
import type {
  ProcessData,
  ProcessDefinition,
  ProcessStep,
} from "../../../packages/protocol/service-processes";
import type {
  DesignCapabilities,
  OwnedDesignReview as DesignReview,
} from "../../../packages/protocol/process-design";
import { Button } from "@admin/components/ui/button";
import { Badge } from "@admin/components/ui/badge";
import { Checkbox } from "@admin/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@admin/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@admin/components/ui/select";
import {
  CodeBlock as JsonDetail,
  Disclosure,
} from "@admin/components/console/disclosure";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@admin/components/ui/alert";
import { Section } from "@admin/components/console/page";
import { DetailList } from "@admin/components/console/forms";
import { StatusBadge } from "@admin/components/console/status";
import type { DesignCopy } from "./process-design-copy";
import { processReviewOrder } from "./lib/process-review-order";

// Shared with the other process pages; the console owns the treatment.
export { Disclosure, JsonDetail };
function NoteList({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4">
      {items.map((text, i) => (
        <li key={i} className="whitespace-pre-wrap break-words">
          {text}
        </li>
      ))}
    </ul>
  );
}
/** Field name, type and — only when it differs from the norm — optionality. */
function FieldList({
  schema,
  copy,
}: {
  schema: ProcessData;
  copy: DesignCopy;
}) {
  if (schema.type !== "object")
    return <Badge variant="outline">{schema.type}</Badge>;
  const fields = Object.entries(schema.properties);
  if (!fields.length)
    return <span className="text-muted-foreground">{copy.empty}</span>;
  return (
    <ul className="flex flex-col gap-1.5">
      {fields.map(([name, definition]) => (
        <li key={name} className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-all">{name}</span>
          <Badge variant="outline">{definition.type}</Badge>
          {!schema.required.includes(name) && (
            <span className="text-xs text-muted-foreground">
              {copy.optional}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
function ModelReference({
  id,
  capabilities,
  copy,
}: {
  id: string;
  capabilities: DesignCapabilities;
  copy: DesignCopy;
}) {
  const model = capabilities.models.find((model) => model.id === id);
  return model ? (
    <AdminLink
      to="/providers/$providerId"
      params={{ providerId: model.providerId }}
      className="underline-offset-4 hover:underline"
    >
      {model.name}
    </AdminLink>
  ) : (
    <span className="flex flex-wrap items-center gap-2">
      {id}
      <StatusBadge tone="warning">{copy.unavailable}</StatusBadge>
    </span>
  );
}
export function ActionReference({
  serviceId,
  actionId,
  capabilities,
  copy,
}: {
  serviceId: string;
  actionId: string;
  capabilities: DesignCapabilities;
  copy: DesignCopy;
}) {
  const service = capabilities.services.find((s) => s.id === serviceId);
  const action = service?.actions.find((a) => a.id === actionId);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium break-words">
        {action?.name ?? actionId}
      </span>
      <AdminLink
        to="/services/$serviceId"
        params={{ serviceId }}
        className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        plainClassName="text-muted-foreground"
      >
        {service?.name ?? serviceId}
      </AdminLink>
      {action ? (
        <>
          <Badge variant="outline">{copy[action.effect]}</Badge>
          {action.effect === "write" && (
            <Badge variant="outline">{copy[action.approval]}</Badge>
          )}
          {!(action.enabled && service?.enabled) && (
            <StatusBadge tone="warning">{copy.unavailable}</StatusBadge>
          )}
          {action.schemaUnavailable && (
            <StatusBadge tone="warning">{copy.schemaUnavailable}</StatusBadge>
          )}
        </>
      ) : (
        <StatusBadge tone="warning">{copy.unavailable}</StatusBadge>
      )}
    </div>
  );
}
type AgentPart = Pick<
  Extract<ProcessDefinition, { kind: "agent" }>,
  "modelId" | "instructions" | "memory" | "capabilities"
>;
type DetailItem = { label: string; value: React.ReactNode };
/** Agent settings as rows of the surrounding label/value grid. */
function agentItems(
  agent: AgentPart,
  capabilities: DesignCapabilities,
  copy: DesignCopy,
): DetailItem[] {
  return [
    {
      label: copy.executionModel,
      value: (
        <ModelReference
          id={agent.modelId}
          capabilities={capabilities}
          copy={copy}
        />
      ),
    },
    {
      label: copy.memory,
      value:
        agent.memory === "conversation"
          ? copy.conversationMemory
          : agent.memory === "saved"
            ? copy.savedMemory
            : copy.none,
    },
    {
      label: copy.instructions,
      value: <p className="whitespace-pre-wrap">{agent.instructions}</p>,
    },
    {
      label: copy.allowedActions,
      value: agent.capabilities.length ? (
        <div className="flex flex-col gap-1.5">
          {agent.capabilities.map((a) => (
            <ActionReference
              key={`${a.serviceId}/${a.actionId}`}
              {...a}
              capabilities={capabilities}
              copy={copy}
            />
          ))}
        </div>
      ) : (
        copy.none
      ),
    },
  ];
}
/** A step named the way the canvas names it, never by its internal ID. */
function stepTitle(
  step: ProcessStep,
  capabilities: DesignCapabilities,
  copy: DesignCopy,
) {
  return step.type === "action"
    ? (capabilities.services
        .find((s) => s.id === step.serviceId)
        ?.actions.find((a) => a.id === step.actionId)?.name ?? step.actionId)
    : copy[step.type];
}
const pathLabels: Partial<Record<string, keyof DesignCopy>> = {
  modelId: "executionModel",
  memory: "memory",
  instructions: "instructions",
  inputSchema: "inputSchema",
  outputSchema: "outputSchema",
  serviceId: "service",
  condition: "condition",
  next: "next",
  whenTrue: "whenTrue",
  whenFalse: "whenFalse",
  entry: "entry",
  limits: "limits",
  maxSteps: "maxSteps",
  maxModelCalls: "maxModelCalls",
  maxTokens: "maxTokens",
  maxCostMicros: "maxCostMicros",
  maxDurationMs: "maxDurationMs",
};
/** "/steps/2/input/email" reads as "Search people › email". */
export function issueTarget(
  path: string,
  definition: ProcessDefinition | null,
  capabilities: DesignCapabilities,
  copy: DesignCopy,
): string | null {
  const parts = path.split("/").filter(Boolean);
  const labels: string[] = [];
  let scope: unknown = definition;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "steps" && definition?.kind === "workflow") {
      const key = parts[i + 1];
      if (key === undefined) {
        labels.push(copy.steps);
        break;
      }
      const step =
        (/^\d+$/.test(key) ? definition.steps[Number(key)] : undefined) ??
        definition.steps.find((s) => s.id === key);
      labels.push(step ? stepTitle(step, capabilities, copy) : key);
      scope = step;
      i++;
      continue;
    }
    if (part === "capabilities") {
      const ref = (
        scope as { capabilities?: { serviceId: string; actionId: string }[] }
      )?.capabilities?.[Number(parts[i + 1])];
      const action = ref
        ? capabilities.services
            .find((s) => s.id === ref.serviceId)
            ?.actions.find((a) => a.id === ref.actionId)
        : undefined;
      labels.push(action?.name ?? ref?.actionId ?? copy.allowedActions);
      break;
    }
    // Containers and indexes add nothing a person needs.
    if (
      ["input", "output", "properties", "items", "required"].includes(part) ||
      /^\d+$/.test(part)
    )
      continue;
    const known = pathLabels[part];
    labels.push(known ? copy[known] : part);
  }
  return labels.length ? labels.join(" › ") : null;
}
function StepSummary({
  step,
  steps,
  capabilities,
  copy,
}: {
  step: ProcessStep;
  steps: ProcessStep[];
  capabilities: DesignCapabilities;
  copy: DesignCopy;
}) {
  const target = (id: string) => {
    const next = steps.find((s) => s.id === id);
    return next ? stepTitle(next, capabilities, copy) : id;
  };
  const items: DetailItem[] =
    step.type === "agent"
      ? agentItems(step, capabilities, copy)
      : step.type === "action"
        ? [
            {
              label: copy.action,
              value: (
                <ActionReference
                  {...step}
                  capabilities={capabilities}
                  copy={copy}
                />
              ),
            },
          ]
        : step.type === "branch"
          ? [
              {
                label: copy.condition,
                value: (
                  <code className="font-mono text-xs break-all">
                    {JSON.stringify(step.condition)}
                  </code>
                ),
              },
              { label: copy.whenTrue, value: target(step.whenTrue) },
              { label: copy.whenFalse, value: target(step.whenFalse) },
            ]
          : [];
  if ("next" in step)
    items.push({ label: copy.next, value: target(step.next) });
  return (
    <li className="flex flex-col gap-3 border-b pb-4 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-medium break-words">
          {stepTitle(step, capabilities, copy)}
        </h4>
        <span className="font-mono text-xs text-muted-foreground">
          {step.id}
        </span>
      </div>
      {items.length > 0 && <DetailList items={items} />}
      <Disclosure title={copy.technical}>
        <JsonDetail value={step} />
      </Disclosure>
    </li>
  );
}
export function ProcessDefinitionSummary({
  definition: candidate,
  capabilities,
  copy,
  hideName = false,
  hideKind = false,
  hideTechnical = false,
}: {
  definition: ProcessDefinition;
  capabilities: DesignCapabilities;
  copy: DesignCopy;
  /** The page title already names the process. */
  hideName?: boolean;
  /** The page header already shows the kind. */
  hideKind?: boolean;
  /** The caller shows its own technical details. */
  hideTechnical?: boolean;
}) {
  const items: DetailItem[] = [
    ...(hideName ? [] : [{ label: copy.name, value: candidate.name }]),
    ...(hideKind ? [] : [{ label: copy.kind, value: copy[candidate.kind] }]),
    { label: copy.trigger, value: copy.manualValue },
    {
      label: copy.inputSchema,
      value: <FieldList schema={candidate.inputSchema} copy={copy} />,
    },
    {
      label: copy.outputSchema,
      value: <FieldList schema={candidate.outputSchema} copy={copy} />,
    },
    ...(candidate.kind === "agent"
      ? agentItems(candidate, capabilities, copy)
      : []),
  ];
  return (
    <div className="flex flex-col gap-5">
      {candidate.description && (
        <p className="text-sm whitespace-pre-wrap break-words">
          {candidate.description}
        </p>
      )}
      <DetailList items={items} />
      {candidate.kind === "workflow" && (
        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-medium">
            {copy.steps}{" "}
            <span className="font-normal text-muted-foreground">
              {candidate.steps.length}
            </span>
          </h4>
          <ol className="flex flex-col gap-4 rounded-lg border p-4">
            {processReviewOrder(candidate).map((step) => (
              <StepSummary
                key={step.id}
                step={step}
                steps={candidate.steps}
                capabilities={capabilities}
                copy={copy}
              />
            ))}
          </ol>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Disclosure title={copy.limits}>
          <DetailList
            items={Object.entries(candidate.limits).map(([key, value]) => ({
              label: copy[key as keyof typeof candidate.limits],
              value: value.toLocaleString(),
            }))}
          />
        </Disclosure>
        {!hideTechnical && (
          <Disclosure title={copy.technical}>
            <DetailList
              items={[
                {
                  label: copy.entry,
                  value: "entry" in candidate ? candidate.entry : copy.none,
                },
              ]}
            />
            <JsonDetail value={candidate} />
          </Disclosure>
        )}
      </div>
    </div>
  );
}
export function ProcessDesignReview({
  review,
  capabilities,
  copy,
  blocked,
  onAcknowledge,
}: {
  review: DesignReview;
  capabilities: DesignCapabilities;
  copy: DesignCopy;
  blocked: boolean;
  onAcknowledge: (
    ids: string[],
    confirmation?: "catalog" | "every_write",
  ) => Promise<unknown>;
}) {
  // Parent keys this component by revision/digest: changed content invalidates local ACK selection.
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState(review.confirmation);
  const disabled = blocked || !!review.acceptedProcessId;
  const valid = review.validation.valid && !review.blockers.length;
  // One line per problem kind, naming what it refers to instead of repeating it.
  const issueGroups = new Map<string, Set<string>>();
  for (const issue of review.validation.issues) {
    const targets = issueGroups.get(issue.code) ?? new Set<string>();
    const target = issueTarget(
      issue.path,
      review.candidate,
      capabilities,
      copy,
    );
    if (target) targets.add(target);
    issueGroups.set(issue.code, targets);
  }
  const brief: { label: string; value: React.ReactNode }[] = [
    {
      label: copy.purpose,
      value: (
        <p className="whitespace-pre-wrap">
          {review.brief.purpose || copy.empty}
        </p>
      ),
    },
    {
      label: copy.baseline,
      value: review.baseline
        ? `${review.baseline.definition.name}, ${review.baseline.version ? `v${review.baseline.version}` : copy.draft}`
        : copy.newProcess,
    },
    ...(
      [
        [copy.inputs, review.brief.inputs],
        [copy.outputs, review.brief.outputs],
        [copy.rules, review.brief.rules],
        [copy.questions, review.brief.questions.map((q) => q.text)],
      ] as const
    )
      .filter(([, items]) => items.length > 0)
      .map(([label, items]) => ({
        label,
        value: <NoteList items={[...items]} />,
      })),
  ];
  return (
    <div
      className="flex min-w-0 flex-col rounded-lg border bg-background"
      data-design-review
    >
      {!valid && (
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <StatusBadge tone="warning">{copy.blocked}</StatusBadge>
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-8 p-4">
        <div className="flex flex-col gap-4">
          {!valid && (review.blockers.length > 0 || issueGroups.size > 0) && (
            <Alert>
              <AlertTitle>{copy.blockers}</AlertTitle>
              <AlertDescription>
                <ul className="flex list-disc flex-col gap-1.5 pl-4">
                  {review.blockers.map((code) => (
                    <li key={code}>{copy[code]}</li>
                  ))}
                  {[...issueGroups].map(([code, targets]) => (
                    <li key={code}>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {copy[code as keyof DesignCopy]}
                        {[...targets].map((target) => (
                          <Badge key={target} variant="outline">
                            {target}
                          </Badge>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <DetailList items={brief} />
          {review.validation.issues.length > 0 && (
            <Disclosure title={copy.technical}>
              <JsonDetail
                value={{
                  revision: review.baseline?.registryRevision,
                  issues: review.validation.issues,
                }}
              />
            </Disclosure>
          )}
        </div>
        <Section title={copy.candidate}>
          {review.candidate ? (
            <ProcessDefinitionSummary
              definition={review.candidate}
              capabilities={capabilities}
              copy={copy}
              hideName
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {copy.missingCandidate}
            </p>
          )}
        </Section>
        {/* A new process has no baseline: every path would read as "added". */}
        {review.baseline && (
          <Section
            title={copy.changes}
            count={review.changes.length || undefined}
          >
            <div className="flex flex-col gap-4">
              {review.changesTruncated && (
                <Alert>
                  <AlertDescription>{copy.truncated}</AlertDescription>
                </Alert>
              )}
              {review.changes.length ? (
                <Disclosure title={copy.technical}>
                  {review.changes.map((change, i) => (
                    <div
                      key={i}
                      className="flex flex-col gap-2 border-b pb-4 last:border-0 last:pb-0"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{copy[change.kind]}</Badge>
                        <code className="font-mono text-xs break-all">
                          {change.path}
                        </code>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {(["before", "after"] as const).map((side) => (
                          <div
                            key={side}
                            className="flex min-w-0 flex-col gap-1"
                          >
                            <h4 className="text-xs text-muted-foreground">
                              {copy[side]}
                            </h4>
                            <JsonDetail value={change[side] ?? copy.empty} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </Disclosure>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {copy.noChanges}
                </p>
              )}
              {review.dependencyComparison === "unavailable" && (
                <p className="text-sm text-muted-foreground">
                  {copy.dependencyUnavailable}
                </p>
              )}
              {review.dependencyChanges.length > 0 && (
                <Disclosure title={copy.dependencies}>
                  <DetailList
                    items={review.dependencyChanges.map((d) => ({
                      label: `${copy[d.kind === "model" ? "executionModel" : d.kind]} ${d.id}`,
                      value: `${d.beforeRevision ?? copy.empty} / ${d.afterRevision ?? copy.unavailable}`,
                    }))}
                  />
                </Disclosure>
              )}
            </div>
          </Section>
        )}
        <Section
          title={copy.assumptions}
          count={review.assumptions.length || undefined}
          actions={
            review.assumptions.some((a) => !a.acknowledged) && (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !selected.length}
                onClick={() => void onAcknowledge(selected)}
              >
                {copy.acknowledge}
              </Button>
            )
          }
        >
          {review.assumptions.length ? (
            <FieldSet>
              <FieldLegend className="sr-only">{copy.assumptions}</FieldLegend>
              <FieldGroup>
                {review.assumptions.map((a) => (
                  <Field key={a.id} orientation="horizontal">
                    <Checkbox
                      id={`assumption-${a.id}`}
                      checked={a.acknowledged || selected.includes(a.id)}
                      disabled={disabled || a.acknowledged}
                      onCheckedChange={(value) =>
                        setSelected((ids) =>
                          value === true
                            ? [...ids, a.id]
                            : ids.filter((id) => id !== a.id),
                        )
                      }
                    />
                    <FieldLabel htmlFor={`assumption-${a.id}`}>
                      {review.brief.assumptions.find((note) => note.id === a.id)
                        ?.text ?? a.id}
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            </FieldSet>
          ) : (
            <p className="text-sm text-muted-foreground">{copy.empty}</p>
          )}
        </Section>
        <Section title={copy.confirmation}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 basis-56">
              <Select
                value={confirmation}
                onValueChange={(value) =>
                  setConfirmation(value as typeof confirmation)
                }
                disabled={disabled}
              >
                <SelectTrigger
                  id="design-confirmation"
                  aria-label={copy.confirmation}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="catalog">{copy.catalog}</SelectItem>
                    <SelectItem value="every_write">
                      {copy.everyWrite}
                    </SelectItem>
                    {review.confirmation === "grouped" && (
                      <SelectItem value="grouped" disabled>
                        {copy.grouped}
                      </SelectItem>
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              disabled={
                disabled ||
                confirmation === review.confirmation ||
                confirmation === "grouped"
              }
              onClick={() => {
                if (confirmation !== "grouped")
                  void onAcknowledge([], confirmation);
              }}
            >
              {copy.applyConfirmation}
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}
