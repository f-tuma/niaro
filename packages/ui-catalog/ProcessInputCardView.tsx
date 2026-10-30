import React, { useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { Language } from "../protocol";
import type { ProcessInputCard } from "../protocol/process-execution";
import type { ProcessData } from "../protocol/service-processes";
import { tokens as t } from "../design-tokens";
import { Button, Field, Icon, Notice, Row, Text } from "../ui";
import { MotionPressable } from "../ui/motion";
import { processInputCopy as copy } from "./process-input-copy";
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
} from "./process-input-form";

export type ProcessInputCardViewProps = {
  card: ProcessInputCard;
  language: Language;
  disabled?: boolean;
  /** Validated original submitted input, used only when this immutable form mounts. */
  initialInput?: ProcessFormInput;
  /** Local typed handoff only. The renderer owns no transport or start command. */
  onSubmit?: (input: ProcessFormInput) => void;
};

/** Render, expansion and draft edits have no business side effects. */
export function ProcessInputCardView(props: ProcessInputCardViewProps) {
  const card = useMemo(() => parseProcessInputCard(props.card), [props.card]);
  const binding = card ? JSON.stringify(card) : null;
  const [seen, setSeen] = useState(() => ({ binding, updated: false }));
  if (seen.binding !== binding) {
    setSeen({ binding, updated: seen.binding !== null && binding !== null });
  }
  if (!card)
    return <Notice error>{copy(props.language, "unavailable")}</Notice>;
  return (
    <View style={styles.stack}>
      {seen.updated ? <Notice>{copy(props.language, "updated")}</Notice> : null}
      <ProcessFormBody key={binding} {...props} card={card} />
    </View>
  );
}

function ProcessFormBody({
  card,
  language,
  disabled,
  initialInput,
  onSubmit,
}: ProcessInputCardViewProps) {
  const [initial] = useState(() => {
    let nextItem = 0;
    const draft =
      initialInput === undefined
        ? createProcessDraft(card.form.inputSchema)
        : createProcessDraftFromInput(
            card.form.inputSchema,
            initialInput,
            () => `item-${nextItem++}`,
            true,
          );
    return { draft, nextItem };
  });
  const nextItemId = useRef(initial.nextItem);
  const [draft, setDraft] = useState(initial.draft);
  const [issues, setIssues] = useState<ProcessFormIssue[]>([]);
  const inactive = !!disabled || !onSubmit || draft === null;
  const edit = (next: ProcessDraft) => {
    if (inactive) return;
    setDraft(next);
    setIssues([]);
  };
  const prepare = () => {
    if (inactive || !draft) return;
    const result = validateProcessDraft(card.form.inputSchema, draft);
    setIssues(result.issues);
    if (result.success) onSubmit?.(result.input);
  };
  if (!draft) return <Notice error>{copy(language, "unavailable")}</Notice>;
  return (
    <View style={styles.form} testID="process-input-card">
      <View style={styles.heading}>
        <Text role="sheetTitle" accessibilityRole="header" selectable>
          {card.form.name}
        </Text>
        {card.form.description ? (
          <Text tone="secondary" selectable>
            {card.form.description}
          </Text>
        ) : null}
      </View>
      {inactive ? <Notice>{copy(language, "disabled")}</Notice> : null}
      {issues.length ? (
        <View
          style={styles.stack}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          <Text role="label" style={styles.error}>
            {copy(language, "errors")}
          </Text>
          {issues.map((issue) => (
            <Text
              key={processPathKey(issue.path)}
              role="caption"
              style={styles.error}
            >
              {fieldLabel(issue.path, language)}:{" "}
              {copy(language, issue.message)}
            </Text>
          ))}
        </View>
      ) : null}
      <InputEditor
        schema={card.form.inputSchema}
        draft={draft}
        path={[]}
        root
        required
        language={language}
        disabled={inactive}
        issues={issues}
        onChange={edit}
        itemId={() => `item-${nextItemId.current++}`}
      />
      <Button
        label={copy(language, "prepare")}
        disabled={inactive}
        onPress={prepare}
      />
    </View>
  );
}

export function fieldLabel(path: ProcessFormPath, language: Language): string {
  return path.length
    ? path
        .map((part) =>
          typeof part === "number"
            ? copy(language, "item", { number: part + 1 })
            : part,
        )
        .join(" › ")
    : copy(language, "root");
}

type EditorProps = {
  schema: ProcessData;
  draft: ProcessDraft;
  path: ProcessFormPath;
  required: boolean;
  root?: boolean;
  language: Language;
  disabled: boolean;
  issues: ProcessFormIssue[];
  onChange: (draft: ProcessDraft) => void;
  itemId: () => string;
};

function InputEditor(props: EditorProps) {
  const {
    schema,
    draft,
    path,
    required,
    root,
    language,
    disabled,
    issues,
    onChange,
  } = props;
  const [expanded, setExpanded] = useState(!!root);
  const label = fieldLabel(path, language);
  const issue = issues.find(
    (value) => processPathKey(value.path) === processPathKey(path),
  );
  const change = (value: ProcessDraft) => {
    if (!disabled) onChange(value);
  };
  const content = () => {
    if (schema.type === "object" && draft.kind === "object") {
      const fields = Object.entries(schema.properties);
      return fields.length ? (
        fields.map(([key, child]) => (
          <InputEditor
            key={key}
            {...props}
            root={false}
            schema={child}
            path={[...path, key]}
            required={schema.required.includes(key)}
            draft={
              draft.children.get(key) ??
              createProcessDraft(child, schema.required.includes(key))
            }
            onChange={(value) => {
              const children = new Map(draft.children);
              children.set(key, value);
              change({ ...draft, children });
            }}
          />
        ))
      ) : (
        <Text role="caption" tone="secondary">
          {copy(language, "emptyObject")}
        </Text>
      );
    }
    if (schema.type === "array" && draft.kind === "array") {
      return (
        <View style={styles.stack}>
          <Text role="caption" tone="secondary">
            {[
              copy(language, "items", { number: draft.items.length }),
              schema.minItems === undefined
                ? null
                : copy(language, "minimum", { value: schema.minItems }),
              copy(language, "maximum", { value: schema.maxItems ?? 100 }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {!draft.items.length ? (
            <Text role="caption" tone="secondary">
              {copy(language, "emptyArray")}
            </Text>
          ) : null}
          {draft.items.map((item, index) => (
            <View
              key={item.id}
              style={styles.item}
              testID={`process-${item.id}`}
            >
              <InputEditor
                {...props}
                root={false}
                schema={schema.items}
                required
                path={[...path, index]}
                draft={item.draft}
                onChange={(value) =>
                  change({
                    ...draft,
                    items: draft.items.map((current) =>
                      current.id === item.id
                        ? { ...current, draft: value }
                        : current,
                    ),
                  })
                }
              />
              <Button
                variant="quiet"
                label={copy(language, "remove", {
                  field: fieldLabel([...path, index], language),
                })}
                disabled={disabled}
                onPress={() =>
                  change({
                    ...draft,
                    items: draft.items.filter(
                      (current) => current.id !== item.id,
                    ),
                  })
                }
              />
            </View>
          ))}
          <Button
            variant="secondary"
            icon="plus"
            label={copy(language, "add", { field: label })}
            disabled={
              disabled || draft.items.length >= (schema.maxItems ?? 100)
            }
            onPress={() => {
              if (disabled || draft.items.length >= (schema.maxItems ?? 100))
                return;
              change({
                ...draft,
                items: [
                  ...draft.items,
                  {
                    id: props.itemId(),
                    draft: createProcessDraft(schema.items),
                  },
                ],
              });
            }}
          />
        </View>
      );
    }
    if (schema.type === "null")
      return (
        <View style={styles.stack}>
          <Text>{copy(language, "nullValue")}</Text>
          <Text role="caption" tone="secondary">
            {copy(language, "nullHint")}
          </Text>
        </View>
      );
    if (schema.type === "boolean" && draft.kind === "boolean")
      return (
        <Choices
          label={label}
          disabled={disabled}
          options={schema.enum ?? [true, false]}
          selected={draft.value}
          language={language}
          onSelect={(value) => change({ ...draft, value: value as boolean })}
        />
      );
    if (schema.type === "string" && draft.kind === "string" && schema.enum)
      return (
        <Choices
          label={label}
          disabled={disabled}
          options={schema.enum}
          selected={draft.value}
          language={language}
          onSelect={(value) => change({ ...draft, value: value as string })}
        />
      );
    if (draft.kind === "string" || draft.kind === "number") {
      const numeric = schema.type === "number" || schema.type === "integer";
      const hints = numeric
        ? [
            copy(language, schema.type === "integer" ? "integer" : "number"),
            schema.minimum === undefined
              ? null
              : copy(language, "minimum", { value: schema.minimum }),
            schema.maximum === undefined
              ? null
              : copy(language, "maximum", { value: schema.maximum }),
          ]
        : schema.type === "string"
          ? [
              schema.minLength === undefined
                ? null
                : copy(language, "minLength", { value: schema.minLength }),
              schema.maxLength === undefined
                ? null
                : copy(language, "maxLength", { value: schema.maxLength }),
            ]
          : [];
      return (
        <View style={styles.stack}>
          <Field
            label={`${label} · ${copy(language, required ? "required" : "optional")}`}
            accessibilityLabel={label}
            value={draft.value ?? ""}
            multiline={
              schema.type === "string" && (schema.maxLength ?? 4000) > 4000
            }
            textAlignVertical={
              schema.type === "string" && (schema.maxLength ?? 4000) > 4000
                ? "top"
                : undefined
            }
            editable={!disabled}
            accessibilityState={{ disabled }}
            aria-disabled={disabled}
            aria-required={required}
            aria-invalid={!!issue}
            keyboardType={numeric ? "numbers-and-punctuation" : "default"}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={
              numeric
                ? 4000
                : schema.type === "string"
                  ? (schema.maxLength ?? 4000)
                  : 4000
            }
            onChangeText={(value) => change({ ...draft, value })}
          />
          {hints.some(Boolean) ? (
            <Text role="caption" tone="secondary">
              {hints.filter(Boolean).join(" · ")}
            </Text>
          ) : null}
        </View>
      );
    }
    return null;
  };
  const group =
    schema.type === "object" && Object.keys(schema.properties).length > 0;
  const presentField =
    draft.present &&
    ((schema.type === "string" && !schema.enum && draft.kind === "string") ||
      ((schema.type === "number" || schema.type === "integer") &&
        draft.kind === "number"));
  return (
    <View style={root ? styles.stack : styles.field}>
      {!root && !presentField ? (
        <Text role="caption" tone="secondary">
          {label} · {copy(language, required ? "required" : "optional")}
        </Text>
      ) : null}
      {!required ? (
        <MotionPressable
          accessibilityRole="checkbox"
          accessibilityLabel={copy(language, "include", { field: label })}
          accessibilityState={{ checked: draft.present, disabled }}
          aria-checked={draft.present}
          aria-disabled={disabled}
          disabled={disabled}
          style={styles.choice}
          onPress={() => change({ ...draft, present: !draft.present })}
        >
          <Row>
            <Icon
              name={draft.present ? "check" : "plus"}
              size={18}
              color={t.color.action.link}
            />
            <Text style={styles.flex}>
              {copy(language, "include", { field: label })}
            </Text>
          </Row>
        </MotionPressable>
      ) : null}
      {!draft.present ? (
        <Text role="caption" tone="secondary">
          {copy(language, "omitted")}
        </Text>
      ) : (
        <>
          {group && !root ? (
            <MotionPressable
              accessibilityRole="button"
              accessibilityLabel={copy(language, expanded ? "hide" : "edit", {
                field: label,
              })}
              accessibilityState={{ expanded }}
              aria-expanded={expanded}
              style={styles.choice}
              onPress={() => setExpanded((current) => !current)}
            >
              <Row>
                <Icon name="chevron" size={18} color={t.color.action.link} />
                <Text style={styles.flex}>
                  {copy(language, expanded ? "hide" : "edit", { field: label })}
                </Text>
              </Row>
            </MotionPressable>
          ) : null}
          {!group || expanded ? content() : null}
        </>
      )}
      {issue ? (
        <Text accessibilityRole="alert" role="caption" style={styles.error}>
          {copy(language, issue.message)}
        </Text>
      ) : null}
    </View>
  );
}

function Choices({
  label,
  options,
  selected,
  language,
  disabled,
  onSelect,
}: {
  label: string;
  options: (string | boolean)[];
  selected: string | boolean | undefined;
  language: Language;
  disabled: boolean;
  onSelect: (value: string | boolean) => void;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={styles.stack}
    >
      {options.map((value, index) => {
        const text =
          typeof value === "boolean"
            ? copy(language, value ? "yes" : "no")
            : value === ""
              ? copy(language, "emptyString")
              : !value.trim()
                ? copy(language, "whitespace", { value: JSON.stringify(value) })
                : value;
        const checked = value === selected;
        return (
          <MotionPressable
            key={index}
            accessibilityRole="radio"
            accessibilityLabel={`${label}: ${text}`}
            accessibilityState={{ checked, disabled }}
            aria-checked={checked}
            aria-disabled={disabled}
            disabled={disabled}
            style={[styles.choice, checked && styles.selected]}
            onPress={() => {
              if (!disabled) onSelect(value);
            }}
          >
            <Row>
              <Text selectable style={styles.flex}>
                {text}
              </Text>
              {checked ? (
                <Icon name="check" size={18} color={t.color.action.link} />
              ) : null}
            </Row>
          </MotionPressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { minWidth: 0, gap: t.spacing.md },
  form: { minWidth: 0, gap: t.spacing.lg },
  heading: { minWidth: 0, gap: t.spacing.xs },
  field: { minWidth: 0, gap: t.spacing.sm, paddingVertical: t.spacing.sm },
  item: {
    minWidth: 0,
    gap: t.spacing.xs,
    paddingLeft: t.spacing.md,
    borderLeftWidth: 2,
    borderColor: t.color.border,
  },
  flex: { flex: 1, minWidth: 0, flexShrink: 1 },
  error: { color: t.color.status.error, flexShrink: 1 },
  choice: {
    minWidth: 0,
    minHeight: t.control.minHeight,
    paddingHorizontal: t.spacing.md,
    paddingVertical: 10,
    borderRadius: t.radius.control,
    backgroundColor: t.color.fill,
    justifyContent: "center",
  },
  selected: {
    borderColor: t.color.action.primary,
    backgroundColor: t.color.accent.softBlue,
  },
});
