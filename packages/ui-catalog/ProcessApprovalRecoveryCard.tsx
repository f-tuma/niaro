import React from "react";
import { View } from "react-native";
import type { Language } from "../protocol";
import type { ServiceResult } from "../protocol/service-result";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import { Button, Disclosure, Notice, Row, Surface, Text } from "../ui";
import {
  ServiceActionReview,
  type ServiceActionReviewFrame,
} from "./ServiceActionReview";

export type SavedProcessApprovalReview = {
  title: string;
  service: string;
  approved: boolean;
  effect: "read" | "write";
  frame: ServiceActionReviewFrame;
  result?: ServiceResult;
};

/** A local saved decision, without claiming a current approval or business result. */
export function ProcessApprovalRecoveryCard({
  review,
  outcome,
  explanation,
  language,
  canRetry = false,
  retrying = false,
  onRetry,
}: {
  review?: SavedProcessApprovalReview;
  outcome: "unknown" | "accepted" | "rejected";
  explanation?: string;
  language: Language;
  canRetry?: boolean;
  retrying?: boolean;
  onRetry: () => void;
}) {
  const tr = translate(language);
  return (
    <Surface testID="saved-process-approval" style={{ minWidth: 0 }}>
      <Text role="meta" tone="secondary" accessibilityRole="header">
        {tr("savedProcessApproval")}
      </Text>
      {review ? (
        <View style={{ gap: t.spacing.xs, minWidth: 0 }}>
          <Text selectable role="cardTitle">
            {review.title}
          </Text>
          <Row style={{ flexWrap: "wrap", gap: 6 }}>
            <Text selectable role="meta" tone="secondary">
              {review.service}
            </Text>
            <Text role="meta" tone="secondary">
              ·
            </Text>
            <Text role="meta" tone="secondary">
              {tr(
                review.effect === "write"
                  ? "savedProcessApprovalEffectWrite"
                  : "savedProcessApprovalEffectRead",
              )}
            </Text>
          </Row>
          <Text
            selectable
            accessibilityLabel={`${tr("savedProcessApprovalDecision")}: ${tr(
              review.approved
                ? "savedProcessApprovalApprove"
                : "savedProcessApprovalReject",
            )}`}
          >
            {tr("savedProcessApprovalDecision")}:{" "}
            {tr(
              review.approved
                ? "savedProcessApprovalApprove"
                : "savedProcessApprovalReject",
            )}
          </Text>
        </View>
      ) : null}
      <Notice error={!review || outcome === "rejected"}>
        {tr(
          !review
            ? "savedProcessApprovalProofUnavailable"
            : outcome === "unknown"
              ? "savedProcessApprovalUnknown"
              : outcome === "accepted"
                ? "savedProcessApprovalAccepted"
                : "savedProcessApprovalRejected",
        )}
      </Notice>
      {explanation ? <Notice error>{explanation}</Notice> : null}
      {review ? (
        <Disclosure label={tr("savedProcessApprovalReview")}>
          <ServiceActionReview
            result={review.result}
            frame={review.frame}
            language={language}
          />
        </Disclosure>
      ) : null}
      <Button
        label={tr(
          retrying
            ? "savedProcessApprovalRetrying"
            : outcome === "unknown"
              ? "savedProcessApprovalRetrySame"
              : "processesRetrySaving",
        )}
        loading={retrying}
        disabled={!review || !canRetry || retrying}
        onPress={() => {
          if (review && canRetry && !retrying) onRetry();
        }}
      />
    </Surface>
  );
}
