import React, { useMemo, useState } from "react";
import { StyleSheet, Switch, View, useWindowDimensions } from "react-native";
import {
  CardDocumentSchema,
  cardFieldValueValid,
  type CardAction,
  type CardDocument,
  type CardNode,
} from "../protocol/card-document";
import type { Language } from "../protocol";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import {
  Avatar,
  Button,
  Disclosure,
  Field,
  Icon,
  Notice,
  Row,
  StatusPill,
  Surface,
  Text,
  type StatusTone,
} from "../ui";
import { MotionPressable } from "../ui/motion";
import { CardDataField } from "./CardDataField";

export type CardValues = Record<string, string | number | boolean>;
export type CardDocumentViewProps = {
  document: CardDocument;
  language: Language;
  disabled?: boolean;
  /** Embedded cards reuse their surrounding card's surface and title. */
  embedded?: boolean;
  onAction?: (actionId: string, values: CardValues) => void;
};

/** Validated display data only. Reading, rendering, expansion and draft edits are passive. */
export function CardDocumentView(props: CardDocumentViewProps) {
  const parsed = useMemo(
    () => CardDocumentSchema.safeParse(props.document),
    [props.document],
  );
  const [seen, setSeen] = useState(() => ({
    id: parsed.success ? parsed.data.id : null,
    revision: parsed.success ? parsed.data.revision : 0,
    updated: false,
  }));
  if (
    parsed.success &&
    (seen.id !== parsed.data.id || seen.revision !== parsed.data.revision)
  ) {
    setSeen({
      id: parsed.data.id,
      revision: parsed.data.revision,
      updated: seen.id === parsed.data.id,
    });
  }
  if (!parsed.success)
    return (
      <Text role="caption" tone="secondary" accessibilityRole="alert">
        {translate(props.language)("cardUnavailable")}
      </Text>
    );
  return (
    <View style={styles.stack}>
      {seen.updated &&
      parsed.data.nodes.some((node) => node.type === "input") ? (
        <Notice>{translate(props.language)("cardUpdated")}</Notice>
      ) : null}
      <CardBody
        key={`${parsed.data.id}:${parsed.data.revision}`}
        {...props}
        document={parsed.data}
      />
    </View>
  );
}

function CardBody({
  document,
  language,
  disabled = false,
  embedded = false,
  onAction,
}: CardDocumentViewProps) {
  const tr = translate(language);
  const { width } = useWindowDimensions();
  const [cardWidth, setCardWidth] = useState(0);
  const nodes = useMemo(
    () => new Map(document.nodes.map((node) => [node.id, node])),
    [document.nodes],
  );
  const actions = useMemo(
    () => new Map(document.actions.map((action) => [action.id, action])),
    [document.actions],
  );
  const [draft, setDraft] = useState<CardValues>(() =>
    Object.fromEntries(
      document.nodes.flatMap((node) =>
        node.type === "input"
          ? [[node.id, node.value ?? (node.kind === "toggle" ? false : "")]]
          : [],
      ),
    ),
  );
  const [errors, setErrors] = useState<Record<string, "required" | "invalid">>(
    {},
  );
  const inactive = disabled || !onAction;
  const edit = (id: string, value: string | number | boolean) => {
    setDraft((current) => ({ ...current, [id]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };
  const activate = (action: CardAction) => {
    if (inactive) return;
    if (action.kind === "reply") {
      onAction?.(action.id, {});
      return;
    }
    const values: CardValues = {};
    const invalid: Record<string, "required" | "invalid"> = {};
    for (const id of action.fields ?? []) {
      const node = nodes.get(id);
      if (node?.type !== "input") return;
      const value = draft[id];
      if (
        value === undefined ||
        value === "" ||
        (typeof value === "string" && !value.trim())
      ) {
        if (node.required) invalid[id] = "required";
        continue;
      }
      const normalized = normalizeInput(node, value);
      if (normalized === undefined) invalid[id] = "invalid";
      else values[id] = normalized;
    }
    setErrors(invalid);
    if (!Object.keys(invalid).length) onAction?.(action.id, values);
  };
  const renderChildren = (ids: string[]) => ids.map(renderNode);
  const renderNode = (id: string): React.ReactNode => {
    const node = nodes.get(id);
    if (!node) return null;
    switch (node.type) {
      case "heading":
        return (
          <Text key={id} role="label" accessibilityRole="header" selectable>
            {node.text}
          </Text>
        );
      case "text":
        return (
          <Text
            key={id}
            tone={node.tone ?? "primary"}
            selectable
            style={styles.value}
          >
            {node.text}
          </Text>
        );
      case "field":
        return (
          <CardDataField
            key={id}
            label={node.label}
            value={node.value}
            icon={node.icon}
            language={language}
            disabled={disabled}
          />
        );
      case "badge":
        return (
          <View key={id} accessible accessibilityLabel={node.label}>
            <StatusPill label={node.label} tone={badgeTone[node.tone]} />
          </View>
        );
      case "notice":
        return (
          <View
            key={id}
            accessibilityRole={node.tone === "danger" ? "alert" : undefined}
            accessibilityLiveRegion="polite"
            style={[
              styles.notice,
              node.tone === "warning" && {
                backgroundColor: t.color.statusSoft.warning,
              },
              node.tone === "danger" && {
                backgroundColor: t.color.action.dangerSoft,
              },
            ]}
          >
            <Row style={styles.fieldRow}>
              <Icon
                name={
                  node.tone === "danger" || node.tone === "warning"
                    ? "alert"
                    : "info"
                }
                size={16}
                color={toneColor[node.tone]}
              />
              <Text
                role="caption"
                style={[
                  styles.value,
                  {
                    flex: 1,
                    color:
                      node.tone === "danger" || node.tone === "warning"
                        ? toneColor[node.tone]
                        : t.color.text.primary,
                  },
                ]}
              >
                {node.text}
              </Text>
            </Row>
          </View>
        );
      case "divider":
        return <View key={id} style={styles.divider} />;
      case "section":
        return (
          <View key={id} style={styles.section}>
            {node.title ? (
              <Row style={styles.sectionTitle}>
                {node.icon === "person" ? (
                  <Avatar name={node.title} size={32} />
                ) : node.icon ? (
                  <Icon
                    name={node.icon}
                    size={18}
                    color={t.color.text.secondary}
                  />
                ) : null}
                <Text
                  role="rowTitle"
                  accessibilityRole="header"
                  style={{ flex: 1 }}
                >
                  {node.title}
                </Text>
              </Row>
            ) : null}
            {renderChildren(node.children)}
          </View>
        );
      case "stack":
        return (
          <View key={id} style={styles.stack}>
            {renderChildren(node.children)}
          </View>
        );
      case "columns":
        return (
          <View
            key={id}
            style={[
              styles.columns,
              (cardWidth || width) < 480 && styles.narrowColumns,
            ]}
          >
            {node.children.map((child) => (
              <View key={child} style={styles.column}>
                {renderNode(child)}
              </View>
            ))}
          </View>
        );
      case "disclosure":
        return (
          <Disclosure key={id} label={node.label}>
            {renderChildren(node.children)}
          </Disclosure>
        );
      case "list":
        return (
          <View key={id} style={styles.stack}>
            {node.items.map((item, index) => (
              <Row key={index} style={styles.listItem}>
                {item.icon ? (
                  <Icon
                    name={item.icon}
                    size={18}
                    color={t.color.action.primary}
                  />
                ) : null}
                <View style={styles.content}>
                  <Text role="label" selectable>
                    {item.title}
                  </Text>
                  {item.detail ? (
                    <Text
                      role="caption"
                      tone="secondary"
                      selectable
                      style={styles.value}
                    >
                      {item.detail}
                    </Text>
                  ) : null}
                </View>
              </Row>
            ))}
          </View>
        );
      case "code":
        return (
          <View key={id} style={styles.code}>
            {node.label ? (
              <Text role="caption" tone="secondary">
                {node.label}
              </Text>
            ) : null}
            <Text role="caption" selectable style={styles.value}>
              {node.text}
            </Text>
          </View>
        );
      case "progress": {
        const percentage = node.value / node.total;
        return (
          <View
            key={id}
            style={styles.stack}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={node.label}
            accessibilityValue={{ min: 0, max: node.total, now: node.value }}
            aria-valuemin={0}
            aria-valuemax={node.total}
            aria-valuenow={node.value}
          >
            <Row style={{ justifyContent: "space-between" }}>
              <Text role="caption" style={{ flex: 1 }}>
                {node.label}
              </Text>
              <Text role="caption" tone="secondary">
                {new Intl.NumberFormat(language, {
                  style: "percent",
                  maximumFractionDigits: 0,
                }).format(percentage)}
              </Text>
            </Row>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${percentage * 100}%` }]} />
            </View>
          </View>
        );
      }
      case "button": {
        const action = actions.get(node.actionId);
        // An embedded data card has no authority to add buttons to its parent's approval.
        if (!action || !onAction) return null;
        return (
          <Button
            key={id}
            label={action.label}
            variant={action.variant}
            icon={action.icon}
            disabled={inactive}
            onPress={() => activate(action)}
          />
        );
      }
      case "input":
        return (
          <View key={id} style={styles.stack}>
            <CardInput
              node={node}
              value={draft[id] ?? ""}
              language={language}
              disabled={inactive}
              readOnly={!onAction}
              onChange={(value) => edit(id, value)}
            />
            {errors[id] ? (
              <Text
                role="caption"
                accessibilityRole="alert"
                style={{ color: t.color.status.error }}
              >
                {tr(
                  errors[id] === "required"
                    ? "cardRequired"
                    : "cardInvalidValue",
                )}
              </Text>
            ) : null}
          </View>
        );
    }
  };
  const body = (
    <>
      {!embedded ? (
        <Row style={styles.header}>
          {document.icon ? (
            <View style={styles.headerIcon}>
              <Icon name={document.icon} color={t.color.action.primary} />
            </View>
          ) : null}
          <View style={styles.content}>
            <Text role="cardTitle" accessibilityRole="header" selectable>
              {document.title}
            </Text>
            {document.subtitle ? (
              <Text role="caption" tone="secondary" selectable>
                {document.subtitle}
              </Text>
            ) : null}
          </View>
        </Row>
      ) : null}
      {renderChildren(document.root)}
    </>
  );
  const onLayout = (event: { nativeEvent: { layout: { width: number } } }) =>
    setCardWidth(event.nativeEvent.layout.width);
  return embedded ? (
    <View
      testID={`card-${document.id}`}
      style={styles.stack}
      onLayout={onLayout}
    >
      {body}
    </View>
  ) : (
    <Surface
      testID={`card-${document.id}`}
      style={styles.stack}
      onLayout={onLayout}
    >
      {body}
    </Surface>
  );
}

type InputNode = Extract<CardNode, { type: "input" }>;
function CardInput({
  node,
  value,
  language,
  disabled,
  readOnly,
  onChange,
}: {
  node: InputNode;
  value: string | number | boolean;
  language: Language;
  disabled: boolean;
  readOnly: boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  const tr = translate(language);
  if (readOnly)
    return (
      <View style={styles.content}>
        <Text role="caption" tone="secondary">
          {node.label}
        </Text>
        <Text selectable>
          {typeof value === "boolean"
            ? tr(value ? "cardOn" : "cardOff")
            : String(
                node.kind === "choice"
                  ? (node.options?.find((option) => option.id === value)
                      ?.label ?? value)
                  : value,
              )}
        </Text>
      </View>
    );
  if (node.kind === "toggle")
    return (
      <Row style={{ justifyContent: "space-between" }}>
        <Text role="label" style={{ flex: 1 }}>
          {node.label}
        </Text>
        <Switch
          accessibilityLabel={node.label}
          accessibilityState={{ disabled }}
          aria-disabled={disabled}
          aria-checked={value === true}
          disabled={disabled}
          value={value === true}
          onValueChange={onChange}
          trackColor={{ false: t.color.border, true: t.color.action.primary }}
          thumbColor={t.color.surfaceRaised}
        />
      </Row>
    );
  if (node.kind === "choice")
    return (
      <View style={styles.stack}>
        <Text role="label">
          {node.label}
          {node.required ? " *" : ""}
        </Text>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={node.label}
          style={styles.stack}
        >
          {node.options?.map((option) => (
            <MotionPressable
              key={option.id}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: value === option.id, disabled }}
              aria-checked={value === option.id}
              aria-disabled={disabled}
              disabled={disabled}
              onPress={() => onChange(option.id)}
              style={[
                styles.choice,
                value === option.id && styles.choiceSelected,
              ]}
            >
              <Row>
                <Icon
                  name={value === option.id ? "check" : "chevron"}
                  size={18}
                  color={t.color.action.primary}
                />
                <Text style={{ flex: 1 }}>{option.label}</Text>
              </Row>
            </MotionPressable>
          ))}
        </View>
      </View>
    );
  return (
    <Field
      label={node.label + (node.required ? " *" : "")}
      accessibilityLabel={node.label}
      placeholder={
        node.placeholder ??
        (node.kind === "date"
          ? "YYYY-MM-DD"
          : node.kind === "time"
            ? "HH:MM"
            : undefined)
      }
      value={String(value)}
      editable={!disabled}
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      aria-required={!!node.required}
      keyboardType={node.kind === "number" ? "decimal-pad" : "default"}
      maxLength={4000}
      onChangeText={onChange}
    />
  );
}

function normalizeInput(
  node: InputNode,
  value: string | number | boolean,
): string | number | boolean | undefined {
  const normalized =
    node.kind === "number" && typeof value !== "boolean"
      ? Number(value)
      : value;
  return cardFieldValueValid(node, normalized) ? normalized : undefined;
}

const badgeTone: Record<keyof typeof toneColor, StatusTone> = {
  neutral: "unknown",
  info: "needsInput",
  success: "success",
  warning: "warning",
  danger: "error",
};
const toneColor = {
  neutral: t.color.text.secondary,
  info: t.color.action.primary,
  success: t.color.status.success,
  warning: t.color.status.warning,
  danger: t.color.status.error,
};
const styles = StyleSheet.create({
  stack: { minWidth: 0, gap: t.spacing.md },
  content: { flex: 1, minWidth: 0, gap: t.spacing.xs },
  value: { minWidth: 0, flexShrink: 1 },
  header: { alignItems: "flex-start", gap: t.spacing.md },
  headerIcon: {
    backgroundColor: t.color.accent.softBlue,
    borderRadius: t.radius.control,
    padding: t.spacing.sm,
  },
  fieldRow: { alignItems: "flex-start" },
  notice: {
    paddingVertical: 10,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.control,
    backgroundColor: t.color.fill,
  },
  divider: { height: 1, backgroundColor: t.color.border },
  section: { minWidth: 0, gap: t.spacing.sm, paddingTop: t.spacing.sm },
  sectionTitle: { alignItems: "center", gap: t.spacing.md },
  columns: { minWidth: 0, flexDirection: "row", gap: t.spacing.md },
  narrowColumns: { flexDirection: "column" },
  column: { flex: 1, minWidth: 0, gap: t.spacing.md },
  listItem: {
    alignItems: "flex-start",
    paddingVertical: t.spacing.sm,
    borderTopWidth: 1,
    borderColor: t.color.border,
  },
  code: {
    gap: t.spacing.sm,
    minWidth: 0,
    padding: t.spacing.md,
    backgroundColor: t.color.background,
    borderRadius: t.radius.control,
  },
  track: {
    height: 6,
    backgroundColor: t.color.border,
    borderRadius: t.radius.pill,
    overflow: "hidden",
  },
  fill: { height: 6, backgroundColor: t.color.action.primary },
  choice: {
    minHeight: t.control.minHeight,
    padding: t.spacing.md,
    borderWidth: 1,
    borderColor: t.color.border,
    borderRadius: t.radius.control,
    backgroundColor: t.color.surfaceRaised,
  },
  choiceSelected: {
    borderColor: t.color.action.primary,
    backgroundColor: t.color.accent.softBlue,
  },
});
