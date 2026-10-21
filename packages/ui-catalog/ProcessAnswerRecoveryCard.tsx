import React, { useState } from "react";
import { View } from "react-native";
import type { Language } from "../protocol";
import { translate } from "../i18n";
import { Surface, Text, Row, Button, Notice } from "../ui";

/** Local delivery evidence; this card does not claim a canonical process result. */
export function ProcessAnswerRecoveryCard({
  question,
  answer,
  outcome,
  explanation,
  language,
  canReview = false,
  canRetry = false,
  canDiscard = true,
  onReview,
  onRetry,
  onDiscard,
}: {
  question: string;
  answer: string;
  outcome: "unknown" | "accepted" | "rejected";
  explanation?: string;
  language: Language;
  canReview?: boolean;
  canRetry?: boolean;
  canDiscard?: boolean;
  onReview: () => void;
  onRetry?: () => void;
  onDiscard: () => void;
}) {
  const tr = translate(language);
  const [expanded, setExpanded] = useState(false);
  return (
    <Surface testID="saved-process-answer">
      <Text role="label">{tr("savedProcessAnswer")}</Text>
      <Text
        role="meta"
        tone="secondary"
        numberOfLines={expanded ? undefined : 2}
      >
        {question}
      </Text>
      <View testID="saved-process-answer-text">
        <Text selectable numberOfLines={expanded ? undefined : 4}>
          {answer}
        </Text>
      </View>
      <Button
        variant="quiet"
        size="small"
        style={{ alignSelf: "flex-start", paddingHorizontal: 0 }}
        label={tr(
          expanded ? "savedProcessAnswerLess" : "savedProcessAnswerMore",
        )}
        onPress={() => setExpanded((value) => !value)}
      />
      <Notice error={outcome === "rejected" || !!explanation}>
        {tr(
          outcome === "unknown"
            ? "savedProcessAnswerUnknown"
            : outcome === "rejected"
              ? "savedProcessAnswerRejected"
              : "savedProcessAnswerAccepted",
        )}
        {explanation ? ` ${explanation}` : ""}
      </Notice>
      <Row style={{ flexWrap: "wrap" }}>
        {outcome === "unknown" ? (
          <Button
            size="small"
            label={tr("retry")}
            disabled={!canRetry}
            onPress={onRetry}
          />
        ) : (
          <>
            <Button
              size="small"
              label={tr("savedProcessAnswerReview")}
              disabled={!canReview}
              onPress={onReview}
            />
            {canRetry ? (
              <Button
                size="small"
                variant="secondary"
                label={tr("savedProcessAnswerSave")}
                onPress={onRetry}
              />
            ) : null}
          </>
        )}
        <Button
          size="small"
          variant="quiet"
          label={tr("savedProcessAnswerDiscard")}
          disabled={outcome === "unknown" || !canDiscard}
          onPress={onDiscard}
        />
      </Row>
    </Surface>
  );
}
