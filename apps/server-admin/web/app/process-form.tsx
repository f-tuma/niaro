import { useId, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Textarea } from "@admin/components/ui/textarea";
import { Checkbox } from "@admin/components/ui/checkbox";
import {
  NativeSelect,
  NativeSelectOption,
} from "@admin/components/ui/native-select";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@admin/components/ui/field";
import type { ProcessInputCard } from "../../../../packages/protocol/process-execution";
import type { ProcessData } from "../../../../packages/protocol/service-processes";
import {
  createProcessDraft,
  createProcessDraftFromInput,
  parseProcessInputCard,
  processPathKey,
  validateProcessDraft,
  type ProcessDraft,
  type ProcessFormInput,
  type ProcessFormIssue,
  type ProcessFormPath,
} from "../../../../packages/ui-catalog/process-input-form";
import {
  processInputCopy,
  type ProcessInputCopyKey,
} from "../../../../packages/ui-catalog/process-input-copy";
import { fieldLabel } from "../../../../packages/ui-catalog/field-format";
import type { MenuCopy } from "./menu-copy";

type Language = "en" | "cs";
/** Stable keys for list items; unique across forms. */
let items = 0;
const itemId = () => `item-${items++}`;

/**
 * A process's input form with web controls. Drafts, validation and limits are
 * the shared ones the mobile form uses; this file only renders them.
 */
export function ProcessInputForm({
  id,
  card,
  language,
  copy,
  initialInput,
  disabled,
  onSubmit,
}: {
  /** Submit buttons elsewhere (a sheet footer) point at the form by id. */
  id: string;
  card: ProcessInputCard;
  language: Language;
  copy: MenuCopy;
  /** Validated earlier input, used only when this form mounts. */
  initialInput?: ProcessFormInput | null;
  disabled: boolean;
  onSubmit(input: ProcessFormInput): void;
}) {
  const t = (
    key: ProcessInputCopyKey,
    values?: Record<string, string | number>,
  ) => processInputCopy(language, key, values);
  const parsed = useMemo(() => parseProcessInputCard(card), [card]);
  const schema = parsed?.form.inputSchema;
  const [draft, setDraft] = useState<ProcessDraft | null>(() => {
    if (!schema) return null;
    return initialInput
      ? createProcessDraftFromInput(schema, initialInput, itemId, true)
      : createProcessDraft(schema);
  });
  const [issues, setIssues] = useState<ProcessFormIssue[]>([]);
  if (!schema || !draft || schema.type !== "object" || draft.kind !== "object")
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("unavailable")}</AlertDescription>
      </Alert>
    );
  const fields = Object.entries(schema.properties);
  const rootIssue = issues.find((issue) => issue.path.length === 0);
  return (
    <form
      id={id}
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const result = validateProcessDraft(schema, draft);
        setIssues(result.issues);
        if (result.success) onSubmit(result.input);
      }}
    >
      {fields.length ? (
        <FieldGroup>
          <DraftObjectFields
            schema={schema}
            draft={draft}
            path={[]}
            context={{
              language,
              copy,
              disabled,
              issues,
              itemId,
            }}
            onChange={(value) => {
              setDraft(value);
              setIssues([]);
            }}
          />
        </FieldGroup>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.processNoInputs}</p>
      )}
      {rootIssue && <FieldError>{t(rootIssue.message)}</FieldError>}
    </form>
  );
}

type Context = {
  language: Language;
  copy: MenuCopy;
  disabled: boolean;
  issues: ProcessFormIssue[];
  itemId(): string;
};

function label(path: ProcessFormPath, language: Language) {
  const last = path.at(-1);
  return typeof last === "number"
    ? processInputCopy(language, "item", { number: last + 1 })
    : last
      ? fieldLabel(last, language)
      : processInputCopy(language, "root");
}
function issueFor(path: ProcessFormPath, context: Context) {
  const key = processPathKey(path);
  const issue = context.issues.find(
    (value) => processPathKey(value.path) === key,
  );
  return issue ? processInputCopy(context.language, issue.message) : null;
}

function DraftObjectFields({
  schema,
  draft,
  path,
  context,
  onChange,
}: {
  schema: Extract<ProcessData, { type: "object" }>;
  draft: Extract<ProcessDraft, { kind: "object" }>;
  path: ProcessFormPath;
  context: Context;
  onChange(draft: ProcessDraft): void;
}) {
  return Object.entries(schema.properties).map(([key, child]) => {
    const required = schema.required.includes(key);
    return (
      <DraftField
        key={key}
        schema={child}
        draft={draft.children.get(key) ?? createProcessDraft(child, required)}
        path={[...path, key]}
        required={required}
        context={context}
        onChange={(value) => {
          const children = new Map(draft.children);
          children.set(key, value);
          onChange({ ...draft, children });
        }}
      />
    );
  });
}

/** One input; nested objects and lists become field sets. */
function DraftField({
  schema,
  draft,
  path,
  required,
  context,
  onChange,
}: {
  schema: ProcessData;
  draft: ProcessDraft;
  path: ProcessFormPath;
  required: boolean;
  context: Context;
  onChange(draft: ProcessDraft): void;
}) {
  const id = useId();
  const { language, copy, disabled } = context;
  const t = (
    key: ProcessInputCopyKey,
    values?: Record<string, string | number>,
  ) => processInputCopy(language, key, values);
  const name = label(path, language);
  const error = issueFor(path, context);
  const optional = required ? null : (
    <span className="font-normal text-muted-foreground">· {t("optional")}</span>
  );

  if (
    (schema.type === "object" && draft.kind === "object") ||
    (schema.type === "array" && draft.kind === "array")
  ) {
    const include = !required && (
      <Field orientation="horizontal">
        <Checkbox
          id={`${id}-include`}
          checked={draft.present}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange({ ...draft, present: checked === true })
          }
        />
        <FieldLabel htmlFor={`${id}-include`}>{copy.fieldInclude}</FieldLabel>
      </Field>
    );
    return (
      <FieldSet data-invalid={!!error}>
        <FieldLegend variant="label">
          {name} {optional}
        </FieldLegend>
        {include}
        {draft.present &&
          (schema.type === "object" && draft.kind === "object" ? (
            <div className="flex flex-col gap-4 border-l-2 pl-3">
              {Object.keys(schema.properties).length ? (
                <DraftObjectFields
                  schema={schema}
                  draft={draft}
                  path={path}
                  context={context}
                  onChange={onChange}
                />
              ) : (
                <FieldDescription>{t("emptyObject")}</FieldDescription>
              )}
            </div>
          ) : schema.type === "array" && draft.kind === "array" ? (
            <div className="flex flex-col gap-3 border-l-2 pl-3">
              {draft.items.map((item, index) => (
                <div key={item.id} className="flex items-start gap-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <DraftField
                      schema={schema.items}
                      draft={item.draft}
                      path={[...path, index]}
                      required
                      context={context}
                      onChange={(value) =>
                        onChange({
                          ...draft,
                          items: draft.items.map((current) =>
                            current.id === item.id
                              ? { ...current, draft: value }
                              : current,
                          ),
                        })
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled}
                    aria-label={t("remove", {
                      field: `${name} ${index + 1}`,
                    })}
                    onClick={() =>
                      onChange({
                        ...draft,
                        items: draft.items.filter(
                          (current) => current.id !== item.id,
                        ),
                      })
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    disabled || draft.items.length >= (schema.maxItems ?? 100)
                  }
                  onClick={() =>
                    onChange({
                      ...draft,
                      items: [
                        ...draft.items,
                        {
                          id: context.itemId(),
                          draft: createProcessDraft(schema.items),
                        },
                      ],
                    })
                  }
                >
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  {t("add", { field: name })}
                </Button>
              </div>
            </div>
          ) : null)}
        {error && <FieldError>{error}</FieldError>}
      </FieldSet>
    );
  }

  if (schema.type === "null")
    return (
      <Field>
        <FieldLabel>
          {name} {optional}
        </FieldLabel>
        <FieldDescription>{t("nullHint")}</FieldDescription>
      </Field>
    );

  // Choices: booleans and closed lists of text.
  const options: (string | boolean)[] | null =
    schema.type === "boolean" && draft.kind === "boolean"
      ? (schema.enum ?? [true, false])
      : schema.type === "string" && schema.enum && draft.kind === "string"
        ? schema.enum
        : null;
  if (options && (draft.kind === "boolean" || draft.kind === "string")) {
    const index = draft.present
      ? options.findIndex((value) => value === draft.value)
      : -1;
    return (
      <Field data-invalid={!!error}>
        <FieldLabel htmlFor={id}>
          {name} {optional}
        </FieldLabel>
        <NativeSelect
          id={id}
          value={index < 0 ? "" : String(index)}
          disabled={disabled}
          aria-invalid={!!error}
          required={required}
          onChange={(event) => {
            const chosen = event.target.value;
            if (!chosen) {
              onChange(
                required
                  ? { ...draft, value: undefined }
                  : { ...draft, present: false, value: undefined },
              );
              return;
            }
            const value = options[Number(chosen)];
            onChange(
              draft.kind === "boolean"
                ? { ...draft, present: true, value: value as boolean }
                : { ...draft, present: true, value: value as string },
            );
          }}
        >
          <NativeSelectOption value="">
            {required ? copy.fieldChoose : copy.fieldNone}
          </NativeSelectOption>
          {options.map((value, position) => (
            <NativeSelectOption key={position} value={String(position)}>
              {typeof value === "boolean"
                ? t(value ? "yes" : "no")
                : value === ""
                  ? t("emptyString")
                  : value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    );
  }

  if (draft.kind === "string" || draft.kind === "number") {
    const numeric = schema.type === "number" || schema.type === "integer";
    const hints = numeric
      ? [
          schema.minimum === undefined
            ? null
            : t("minimum", { value: schema.minimum }),
          schema.maximum === undefined
            ? null
            : t("maximum", { value: schema.maximum }),
        ]
      : schema.type === "string"
        ? [
            (schema.minLength ?? 0) <= 1
              ? null
              : t("minLength", { value: schema.minLength! }),
          ]
        : [];
    const maxLength =
      schema.type === "string" ? (schema.maxLength ?? 4000) : 4000;
    const value = draft.present ? (draft.value ?? "") : "";
    // An optional text left empty is simply not sent.
    const change = (text: string) =>
      onChange({ ...draft, present: required || text !== "", value: text });
    const props = {
      id,
      value,
      disabled,
      maxLength,
      required,
      "aria-invalid": !!error,
      "aria-describedby": hints.some(Boolean) ? `${id}-hint` : undefined,
    };
    return (
      <Field data-invalid={!!error}>
        <FieldLabel htmlFor={id}>
          {name} {optional}
        </FieldLabel>
        {schema.type === "string" && maxLength > 500 ? (
          <Textarea
            {...props}
            onChange={(event) => change(event.target.value)}
          />
        ) : (
          <Input
            {...props}
            inputMode={
              schema.type === "integer"
                ? "numeric"
                : numeric
                  ? "decimal"
                  : undefined
            }
            onChange={(event) => change(event.target.value)}
          />
        )}
        {hints.some(Boolean) && (
          <FieldDescription id={`${id}-hint`}>
            {hints.filter(Boolean).join(" · ")}
          </FieldDescription>
        )}
        {error && <FieldError>{error}</FieldError>}
      </Field>
    );
  }
  return null;
}
