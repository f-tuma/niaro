import { useEffect, useId, useState } from "react";
import type {
  ProcessBinding,
  ProcessData,
  ProcessStep,
} from "../../../packages/protocol/service-processes";
import { Input } from "@admin/components/ui/input";
import { Button } from "@admin/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@admin/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import type { EditorCopy } from "./process-editor-copy";

type Bindings = Record<string, ProcessBinding>;
export type ProcessBindingFieldsProps = {
  bindings: Bindings;
  fields: string[];
  inputSchema: ProcessData;
  steps: ProcessStep[];
  disabled: boolean;
  copy: EditorCopy;
  onChange(bindings: Bindings): void;
  /** Incomplete literal text, keyed by destination; control it to retain it across inspector closes. */
  drafts?: Record<string, string>;
  onDraft?(key: string, text: string | null): void;
  onInvalid?(invalid: boolean): void;
};
type Option = { value: string; label: string; disabled?: boolean };
type LiteralType = "string" | "number" | "boolean" | "null";
const pathValue = (path: string[]) => JSON.stringify(path);

function declaredPaths(schema: ProcessData, copy: EditorCopy): Option[] {
  const paths: Option[] = [{ value: pathValue([]), label: copy.wholeValue }];
  const visit = (value: ProcessData, parent: string[], depth: number) => {
    if (value.type !== "object" || depth >= 6) return;
    for (const [key, child] of Object.entries(value.properties)) {
      // Declared object paths only; array indexing is outside the process grammar.
      const path = [...parent, key];
      paths.push({ value: pathValue(path), label: path.join(".") });
      visit(child, path, depth + 1);
    }
  };
  visit(schema, [], 0);
  return paths;
}
function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  disabled: boolean;
  onChange(value: string): void;
}) {
  const id = useId();
  return (
    <Field data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}
function numberValue(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed))
    return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** Typed binding controls; selecting a source changes only its destination field. */
export function ProcessBindingFields({
  bindings,
  fields,
  inputSchema,
  steps,
  disabled,
  copy,
  onChange,
  drafts,
  onDraft,
  onInvalid,
}: ProcessBindingFieldsProps) {
  const [localDrafts, setLocalDrafts] = useState<Record<string, string>>({});
  const currentDrafts = drafts ?? localDrafts;
  const invalid = Object.keys(currentDrafts).length > 0;
  useEffect(() => {
    onInvalid?.(invalid);
  }, [invalid, onInvalid]);
  const setDraft = (key: string, text: string | null) => {
    if (drafts === undefined)
      setLocalDrafts((previous) => {
        const next = { ...previous };
        if (text === null) delete next[key];
        else next[key] = text;
        return next;
      });
    onDraft?.(key, text);
  };
  const changeBinding = (key: string, binding?: ProcessBinding) => {
    if (disabled) return;
    setDraft(key, null);
    const next = { ...bindings };
    if (binding) next[key] = binding;
    else delete next[key];
    onChange(next);
  };
  const sources: Option[] = [
    { value: "unset", label: copy.unsetSource },
    { value: "input", label: copy.inputSource },
    ...steps.flatMap((step) =>
      step.type === "action" || step.type === "agent"
        ? [{ value: `step:${step.id}`, label: `${step.id} · ${copy.output}` }]
        : [],
    ),
    { value: "literal", label: copy.literalSource },
  ];
  // Keep previously bound keys visible even when a changed destination schema omits them.
  const destinations = [
    ...new Set([
      ...fields,
      ...Object.keys(bindings),
      ...Object.keys(currentDrafts),
    ]),
  ];
  return (
    <FieldGroup>
      {destinations.map((key) => {
        const binding = bindings[key];
        const source =
          binding?.source === "step"
            ? `step:${binding.stepId}`
            : (binding?.source ?? "unset");
        const options = sources.some((option) => option.value === source)
          ? sources
          : [
              ...sources,
              {
                value: source,
                label: `${binding?.source === "step" ? binding.stepId : source} · ${copy.unavailable}`,
                disabled: true,
              },
            ];
        const step =
          binding?.source === "step"
            ? steps.find((candidate) => candidate.id === binding.stepId)
            : undefined;
        const schema =
          binding?.source === "input"
            ? inputSchema
            : step?.type === "action" || step?.type === "agent"
              ? step.outputSchema
              : undefined;
        const paths = schema ? declaredPaths(schema, copy) : [];
        if (
          binding &&
          binding.source !== "literal" &&
          !paths.some((option) => option.value === pathValue(binding.path))
        )
          paths.push({
            value: pathValue(binding.path),
            label: `${binding.path.length ? binding.path.join(".") : copy.wholeValue} · ${copy.unavailable}`,
            disabled: true,
          });
        const draft = Object.hasOwn(currentDrafts, key)
          ? currentDrafts[key]
          : undefined;
        return (
          <FieldSet key={key} data-binding-field={key} disabled={disabled}>
            <FieldLegend>
              {key}
              {!fields.includes(key) ? ` · ${copy.unavailable}` : ""}
            </FieldLegend>
            <FieldGroup>
              <Choice
                label={`${key} · ${copy.bindingSource}`}
                value={source}
                options={options}
                disabled={disabled}
                onChange={(selected) => {
                  if (selected === source && draft === undefined) return;
                  if (selected === "unset") changeBinding(key);
                  else if (selected === "input")
                    changeBinding(key, { source: "input", path: [] });
                  else if (selected === "literal")
                    changeBinding(key, { source: "literal", value: "" });
                  else if (
                    selected.startsWith("step:") &&
                    sources.some((option) => option.value === selected)
                  )
                    changeBinding(key, {
                      source: "step",
                      stepId: selected.slice(5),
                      path: [],
                    });
                }}
              />
              {!binding && draft !== undefined ? (
                <Field data-invalid>
                  <FieldLabel>{copy.value}</FieldLabel>
                  <Input
                    value={draft}
                    readOnly
                    disabled={disabled}
                    aria-label={`${key} · ${copy.value}`}
                    aria-invalid
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    aria-label={`${key} · ${copy.unsetSource}`}
                    onClick={() => {
                      if (!disabled) setDraft(key, null);
                    }}
                  >
                    {copy.unsetSource}
                  </Button>
                </Field>
              ) : null}
              {binding && binding.source !== "literal" ? (
                <Choice
                  label={`${key} · ${copy.path}`}
                  value={pathValue(binding.path)}
                  options={paths}
                  disabled={disabled || !schema}
                  onChange={(selected) => {
                    if (
                      !paths.some(
                        (option) =>
                          option.value === selected && !option.disabled,
                      )
                    )
                      return;
                    // Values come only from declared paths built above, never expressions.
                    changeBinding(key, {
                      ...binding,
                      path: JSON.parse(selected) as string[],
                    });
                  }}
                />
              ) : null}
              {binding?.source === "literal" ? (
                <>
                  <Choice
                    label={`${key} · ${copy.literalType}`}
                    value={
                      binding.value === null ? "null" : typeof binding.value
                    }
                    options={(
                      ["string", "number", "boolean", "null"] as LiteralType[]
                    ).map((type) => ({ value: type, label: copy[type] }))}
                    disabled={disabled}
                    onChange={(type) => {
                      if (
                        !["string", "number", "boolean", "null"].includes(type)
                      )
                        return;
                      if (
                        type ===
                        (binding.value === null ? "null" : typeof binding.value)
                      )
                        return;
                      changeBinding(key, {
                        source: "literal",
                        value:
                          type === "string"
                            ? ""
                            : type === "number"
                              ? 0
                              : type === "boolean"
                                ? false
                                : null,
                      });
                    }}
                  />
                  {typeof binding.value === "boolean" ? (
                    <Choice
                      label={`${key} · ${copy.value}`}
                      value={String(binding.value)}
                      options={[
                        { value: "true", label: copy.true },
                        { value: "false", label: copy.false },
                      ]}
                      disabled={disabled}
                      onChange={(value) => {
                        if (value === "true" || value === "false")
                          changeBinding(key, {
                            source: "literal",
                            value: value === "true",
                          });
                      }}
                    />
                  ) : binding.value !== null ? (
                    <LiteralField
                      label={`${key} · ${copy.value}`}
                      value={draft ?? String(binding.value)}
                      disabled={disabled}
                      invalid={draft !== undefined}
                      message={copy.invalid}
                      numeric={typeof binding.value === "number"}
                      onChange={(text) => {
                        if (disabled) return;
                        const value =
                          typeof binding.value === "number"
                            ? numberValue(text)
                            : text;
                        if (
                          value === undefined ||
                          (typeof value === "string" && value.length > 4000)
                        ) {
                          setDraft(key, text);
                          return;
                        }
                        changeBinding(key, { source: "literal", value });
                      }}
                    />
                  ) : null}
                </>
              ) : null}
            </FieldGroup>
          </FieldSet>
        );
      })}
    </FieldGroup>
  );
}
function LiteralField({
  label,
  value,
  disabled,
  invalid,
  message,
  numeric,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  invalid: boolean;
  message: string;
  numeric: boolean;
  onChange(text: string): void;
}) {
  const id = useId();
  return (
    <Field data-invalid={invalid} data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-label={label}
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        inputMode={numeric ? "decimal" : "text"}
        maxLength={4000}
        onChange={(event) => onChange(event.target.value)}
      />
      {invalid ? (
        <FieldDescription id={`${id}-error`}>{message}</FieldDescription>
      ) : null}
    </Field>
  );
}
