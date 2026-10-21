import React from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import type { Language } from "../protocol";
import type { ServiceResult } from "../protocol/service-result";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import { Notice, Text } from "../ui";
import { FieldRows } from "./FieldRows";
import { displayFields } from "./field-format";
import {
  completeServiceActionReview,
  type ServiceActionReviewFrame,
} from "./service-action-display";

export {
  completeServiceActionReview,
  type ServiceActionReviewFrame,
} from "./service-action-display";
/** Read-only review content. It owns neither action status nor decision controls. */
export function ServiceActionReview({
  result,
  frame,
  language,
}: {
  result?: ServiceResult;
  frame?: ServiceActionReviewFrame;
  language: Language;
}) {
  const tr = translate(language);
  const context = frame
    ? [
        [tr("processApprovalServer"), frame.source],
        [tr("scope"), frame.workspace ?? ""],
        [tr("processApprovalNativeRevision"), String(frame.nativeRevision)],
        ...(frame.conversationId
          ? [[tr("processesConversation"), frame.conversationId]]
          : []),
        ...(frame.language
          ? [
              [
                tr("language"),
                tr(frame.language === "cs" ? "czech" : "english"),
              ],
            ]
          : []),
        ...(frame.serviceId
          ? [[tr("processApprovalServiceIdentity"), frame.serviceId]]
          : []),
        ...(frame.serviceRevision !== undefined
          ? [
              [
                tr("processApprovalServiceRevision"),
                String(frame.serviceRevision),
              ],
            ]
          : []),
        ...(frame.actionId
          ? [[tr("processApprovalActionIdentity"), frame.actionId]]
          : []),
        ...(frame.actionRevision !== undefined
          ? [
              [
                tr("processApprovalActionRevision"),
                String(frame.actionRevision),
              ],
            ]
          : []),
      ]
    : [];
  return (
    <View style={{ gap: t.spacing.sm, minWidth: 0 }}>
      {frame ? (
        <View testID="service-action-review" style={{ gap: t.spacing.sm }}>
          <FieldRows
            fields={context.map(([label, value]) => ({
              label: label!,
              value: value!,
            }))}
          />
          {result && !completeServiceActionReview(result, frame) ? (
            <Notice>{tr("processApprovalUnavailable")}</Notice>
          ) : null}
        </View>
      ) : null}
      {result ? (
        <FieldRows fields={displayFields(result.fields, language)} />
      ) : null}
      {!result ? (
        <Notice>{tr("savedProcessApprovalParametersUnavailable")}</Notice>
      ) : frame || result.reviewTruncated ? (
        <View style={styles.code}>
          <Text role="meta" tone="secondary">
            {tr("serviceFullParameters")}
          </Text>
          <ScrollView style={{ maxHeight: 240 }}>
            <Text
              testID="service-action-parameters"
              role="caption"
              selectable
              style={styles.mono}
            >
              {result.inputJson}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  code: {
    gap: t.spacing.xs,
    minWidth: 0,
    padding: t.spacing.md,
    borderRadius: t.radius.control,
    backgroundColor: t.color.fill,
  },
  mono: {
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "ui-monospace, SFMono-Regular, Menlo, monospace",
    }),
    fontSize: 12,
  },
});
