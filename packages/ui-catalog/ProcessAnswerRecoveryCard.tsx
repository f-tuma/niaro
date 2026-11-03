import React, { useState } from "react";
import { View } from "react-native";
import type { Language } from "../protocol";
import { translate } from "../i18n";
import { Surface, Text, Row, Button, Notice } from "../ui";

/**
 * Local delivery evidence; this card does not claim a canonical process
 * result. An answer still on its way, or one the session is checking by
 * itself, shows as the person's message instead (NIAR-284): "unknown" here
 * is an answer whose delivery failed, with Try again. A refused answer is
 * failed too: "Not sent", the reason and Try again, which sends its words to
 * the same question as a new answer; its words never go back to the composer
 * (NIAR-286).
 */
export function ProcessAnswerRecoveryCard({
  question,
  answer,
  outcome,
  explanation,
  language,
  canReview = false,
  canRetry = false,
  canDiscard = true,
  canTryAgain = false,
  onReview,
  onRetry,
  onTryAgain,
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
  /** Sends a refused answer's words again as a new answer. */
  canTryAgain?: boolean;
  onTryAgain?: () => void;
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
      <Notice
        error={outcome === "rejected" || outcome === "unknown" || !!explanation}
      >
        {outcome === "unknown"
          ? tr("progressFailedHint")
          : outcome === "rejected"
            ? `${tr("messageNotSent")}.`
            : tr("savedProcessAnswerAccepted")}
        {explanation ? ` ${explanation}` : ""}
      </Notice>
      <Row style={{ flexWrap: "wrap" }}>
        {outcome === "unknown" ? (
          <Button
            size="small"
            label={tr("progressRetry")}
            disabled={!canRetry}
            onPress={onRetry}
          />
        ) : outcome === "rejected" && !canRetry ? (
          <Button
            size="small"
            label={tr("progressRetry")}
            disabled={!canTryAgain || !onTryAgain}
            onPress={onTryAgain}
          />
        ) : (
          <>
            {outcome === "accepted" ? (
              <Button
                size="small"
                label={tr("savedProcessAnswerReview")}
                disabled={!canReview}
                onPress={onReview}
              />
            ) : null}
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
