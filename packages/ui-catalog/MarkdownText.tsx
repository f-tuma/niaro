import React, { memo, useMemo } from "react";
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text as InlineText,
  View,
} from "react-native";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Definition, Nodes, PhrasingContent } from "mdast";
import { Text } from "../ui";
import { tokens as t } from "../design-tokens";
import { displayLink } from "../protocol/display-link";

/** Display-only Markdown. HTML stays text and remote images are never fetched. */
export const MarkdownText = memo(function MarkdownText({
  text,
}: {
  text: string;
}) {
  const tree = useMemo(
    () =>
      fromMarkdown(text, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
      }),
    [text],
  );
  const definitions = new Map<string, Definition>();
  for (const node of tree.children)
    if (node.type === "definition") definitions.set(node.identifier, node);

  function inlines(nodes: PhrasingContent[], depth = 0): React.ReactNode {
    if (depth > 24) return nodes.map(plain).join("");
    return nodes.map((node, index) => {
      if (node.type === "text" || node.type === "html") return node.value;
      if (node.type === "break") return "\n";
      if (node.type === "image" || node.type === "imageReference")
        return node.alt ?? "";
      if (node.type === "inlineCode")
        return (
          <InlineText key={index} style={styles.inlineCode}>
            {node.value}
          </InlineText>
        );
      if (node.type === "link" || node.type === "linkReference") {
        const url =
          node.type === "link"
            ? node.url
            : definitions.get(node.identifier)?.url;
        const href = url ? markdownLink(url) : undefined;
        return (
          <InlineText
            key={index}
            accessibilityRole={href ? "link" : undefined}
            style={href ? styles.link : undefined}
            onPress={
              href
                ? () => {
                    void Linking.openURL(href).catch(() => {});
                  }
                : undefined
            }
          >
            {inlines(node.children, depth + 1)}
          </InlineText>
        );
      }
      if (
        node.type === "strong" ||
        node.type === "emphasis" ||
        node.type === "delete"
      )
        return (
          <InlineText
            key={index}
            style={
              node.type === "strong"
                ? styles.strong
                : node.type === "emphasis"
                  ? styles.emphasis
                  : styles.deleted
            }
          >
            {inlines(node.children, depth + 1)}
          </InlineText>
        );
      return plain(node);
    });
  }

  function blocks(nodes: Nodes[], depth = 0): React.ReactNode {
    if (depth > 24)
      return <Text selectable>{nodes.map(plain).join("\n")}</Text>;
    return nodes.map((node, index) => {
      if (node.type === "definition" || node.type === "footnoteDefinition")
        return null;
      if (node.type === "paragraph" || node.type === "heading")
        return (
          <Text
            key={index}
            selectable
            accessibilityRole={node.type === "heading" ? "header" : undefined}
            style={node.type === "heading" ? styles.heading : undefined}
          >
            {inlines(node.children)}
          </Text>
        );
      if (node.type === "code")
        return (
          <ScrollView key={index} horizontal style={styles.code}>
            <Text selectable style={styles.monospace}>
              {node.value}
            </Text>
          </ScrollView>
        );
      if (node.type === "blockquote")
        return (
          <View key={index} style={styles.quote}>
            {blocks(node.children, depth + 1)}
          </View>
        );
      if (node.type === "list")
        return (
          <View key={index} style={styles.blocks}>
            {node.children.map((item, itemIndex) => (
              <View key={itemIndex} style={styles.listRow}>
                <Text style={styles.marker}>
                  {item.checked === true
                    ? "☑"
                    : item.checked === false
                      ? "☐"
                      : node.ordered
                        ? `${(node.start ?? 1) + itemIndex}.`
                        : "•"}
                </Text>
                <View style={styles.listContent}>
                  {blocks(item.children, depth + 1)}
                </View>
              </View>
            ))}
          </View>
        );
      if (node.type === "table")
        return (
          <ScrollView key={index} horizontal style={styles.table}>
            <View>
              {node.children.map((row, rowIndex) => (
                <View key={rowIndex} style={styles.tableRow}>
                  {row.children.map((cell, cellIndex) => (
                    <Text
                      key={cellIndex}
                      selectable
                      style={[
                        styles.cell,
                        rowIndex === 0 ? styles.strong : undefined,
                      ]}
                    >
                      {inlines(cell.children)}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        );
      if (node.type === "thematicBreak")
        return <View key={index} style={styles.rule} />;
      return (
        <Text key={index} selectable>
          {plain(node)}
        </Text>
      );
    });
  }
  return <View style={styles.blocks}>{blocks(tree.children)}</View>;
});

function plain(node: Nodes): string {
  if ("value" in node) return node.value;
  if ("alt" in node) return node.alt ?? "";
  if ("children" in node) return node.children.map(plain).join("");
  return "";
}

function markdownLink(url: string): string | undefined {
  const web = displayLink(url, "url");
  if (web) return web.href;
  try {
    if (url.startsWith("mailto:"))
      return displayLink(decodeURIComponent(url.slice(7)), "email")?.href;
    if (url.startsWith("tel:"))
      return displayLink(decodeURIComponent(url.slice(4)), "phone")?.href;
  } catch {
    /* An invalid escape remains readable text. */
  }
}

const styles = StyleSheet.create({
  blocks: { gap: t.spacing.sm, minWidth: 0 },
  heading: { ...t.typography.cardTitle },
  strong: { fontWeight: "600" },
  emphasis: { fontStyle: "italic" },
  deleted: { textDecorationLine: "line-through" },
  link: { color: t.color.action.primary, textDecorationLine: "underline" },
  monospace: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  inlineCode: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    backgroundColor: t.color.accent.softBlue,
  },
  code: {
    maxWidth: "100%",
    backgroundColor: t.color.background,
    padding: t.spacing.sm,
    borderRadius: t.radius.control,
  },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: t.color.border,
    paddingLeft: t.spacing.md,
    gap: t.spacing.sm,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: t.spacing.sm,
  },
  marker: { minWidth: 20 },
  listContent: { flex: 1, minWidth: 0, gap: t.spacing.sm },
  table: { maxWidth: "100%" },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: t.color.border,
  },
  cell: { width: 160, padding: t.spacing.sm },
  rule: { height: 1, backgroundColor: t.color.border },
});
