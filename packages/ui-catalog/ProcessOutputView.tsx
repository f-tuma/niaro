import React from "react";
import { View } from "react-native";
import { Text, Button, Group, ListRow, Row } from "../ui";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import type { Language } from "../protocol";
import type {
  ProcessOutputNode,
  ProcessOutputPage,
} from "../protocol/process-output";

export function processOutputText(
  node: ProcessOutputNode,
  language: Language,
): string {
  const tr = translate(language);
  switch (node.kind) {
    case "object":
      return tr("processOutputObject").replace(
        "{count}",
        String(node.childCount),
      );
    case "array":
      return tr("processOutputArray").replace(
        "{count}",
        String(node.childCount),
      );
    case "string":
      return node.value === "" ? tr("processOutputEmptyString") : node.value;
    case "number":
      return String(node.value);
    case "boolean":
      return String(node.value);
    case "null":
      return "null";
    case "redacted":
      return tr("processOutputHidden");
  }
}

/** A typed, selectable view; output text never becomes markup, URLs, or commands. */
export function ProcessOutputView({
  page,
  language,
  onOpen,
  onNext,
  onPrevious,
}: {
  page: ProcessOutputPage;
  language: Language;
  onOpen: (index: number, label: string) => void;
  onNext?: () => void;
  onPrevious?: () => void;
}) {
  const tr = translate(language);
  const container = page.node.kind === "object" || page.node.kind === "array";
  return (
    <View style={{ gap: t.spacing.md }} testID="process-output-page">
      {!container ? (
        <View style={{ gap: t.spacing.xs }}>
          <Text role="meta" tone="secondary">
            {tr(
              page.node.kind === "redacted"
                ? "processOutputHidden"
                : page.node.kind === "string"
                  ? "processOutputString"
                  : page.node.kind === "number"
                    ? "processOutputNumber"
                    : page.node.kind === "boolean"
                      ? "processOutputBoolean"
                      : "processOutputNull",
            )}
          </Text>
          <Text selectable testID="process-output-value">
            {processOutputText(page.node, language)}
          </Text>
        </View>
      ) : null}
      {page.children.length ? (
        // Every field is a row: its name, a short preview, and a way in.
        <Group>
          {page.children.map((child) => {
            const label =
              child.node.kind === "redacted" &&
              child.label === "[redacted field]"
                ? tr("processOutputHidden")
                : (child.label ?? `${child.index + 1}`);
            const value = processOutputText(child.node, language);
            return (
              <ListRow
                key={child.index}
                label={label}
                description={
                  value.length > 120 ? value.slice(0, 120) + "…" : value
                }
                accessibilityLabel={tr("processOutputOpenField").replace(
                  "{label}",
                  label,
                )}
                onPress={() => onOpen(child.index, label)}
              />
            );
          })}
        </Group>
      ) : null}
      {container && page.total === 0 ? (
        <Text tone="secondary">{tr("processOutputEmpty")}</Text>
      ) : null}
      {container && page.total > page.children.length ? (
        <Text role="meta" tone="secondary" style={{ textAlign: "center" }}>
          {tr("processOutputRange")
            .replace("{from}", String(page.offset + 1))
            .replace("{to}", String(page.offset + page.children.length))
            .replace("{total}", String(page.total))}
        </Text>
      ) : null}
      {onPrevious || onNext ? (
        <Row style={{ justifyContent: "space-between" }}>
          {onPrevious ? (
            <Button
              variant="secondary"
              size="small"
              icon="back"
              label={tr("processOutputPrevious")}
              onPress={onPrevious}
            />
          ) : (
            <View />
          )}
          {onNext ? (
            <Button
              variant="secondary"
              size="small"
              label={tr("processOutputNext")}
              onPress={onNext}
            />
          ) : null}
        </Row>
      ) : null}
    </View>
  );
}
