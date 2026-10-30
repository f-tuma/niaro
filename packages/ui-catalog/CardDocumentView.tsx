import React, { useMemo, useState } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import {
  CardDocumentSchema,
  type CardDocument,
} from "../protocol/card-document";
import type { Language } from "../protocol";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import {
  Avatar,
  Disclosure,
  Icon,
  Row,
  StatusPill,
  Surface,
  Text,
  type StatusTone,
} from "../ui";
import { CardDataField } from "./CardDataField";

export type CardDocumentViewProps = {
  document: CardDocument;
  language: Language;
  /** Embedded cards reuse their surrounding card's surface and title. */
  embedded?: boolean;
};

/**
 * A system card's validated display data (service results, work items).
 * Passive: it reads, links and expands, and never answers or sends.
 */
export function CardDocumentView(props: CardDocumentViewProps) {
  const parsed = useMemo(
    () => CardDocumentSchema.safeParse(props.document),
    [props.document],
  );
  if (!parsed.success)
    return (
      <Text role="caption" tone="secondary" accessibilityRole="alert">
        {translate(props.language)("cardUnavailable")}
      </Text>
    );
  return <CardBody {...props} document={parsed.data} />;
}

function CardBody({
  document,
  language,
  embedded = false,
}: CardDocumentViewProps) {
  const { width } = useWindowDimensions();
  const [cardWidth, setCardWidth] = useState(0);
  const nodes = useMemo(
    () => new Map(document.nodes.map((node) => [node.id, node])),
    [document.nodes],
  );
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
                    color={t.color.action.link}
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
      // Inputs and buttons belonged to answer cards; system cards show data.
      case "button":
      case "input":
        return null;
    }
  };
  const body = (
    <>
      {!embedded ? (
        <Row style={styles.header}>
          {document.icon ? (
            <View style={styles.headerIcon}>
              <Icon name={document.icon} color={t.color.action.link} />
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
});
