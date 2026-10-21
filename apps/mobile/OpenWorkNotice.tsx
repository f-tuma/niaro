import React from "react";
import { View } from "react-native";
import { openWorkKindKey } from "../../packages/client-core/conversation-directory";
import type { Language, OpenWork } from "../../packages/protocol";
import { translate } from "../../packages/i18n";
import { Button, Notice, Row, Text } from "../../packages/ui";

/** A delete or archive the server refused because work waits in the chat. */
export type OpenWorkRefusal = {
  conversationId: string;
  action: "delete" | "archive";
  openWork: readonly OpenWork[];
};

/**
 * Names what still waits in the chat and offers to cancel it and go on.
 * An older server lists nothing: the general sentence stands in.
 */
export function OpenWorkNotice({
  language,
  refusal,
  disabled,
  onKeep,
  onCancelAndContinue,
}: {
  language: Language;
  refusal: OpenWorkRefusal;
  disabled?: boolean;
  onKeep: () => void;
  onCancelAndContinue: () => void;
}) {
  const tr = translate(language);
  return (
    <View testID="open-work-notice" style={{ gap: 8 }}>
      <Notice error>
        {refusal.openWork.length
          ? `${tr("chatWaiting")}: ${refusal.openWork
              .map(
                (work) => `${work.title} (${tr(openWorkKindKey(work.kind))})`,
              )
              .join(", ")}`
          : tr("chatOpenWork")}
      </Notice>
      <Text role="caption" tone="secondary">
        {tr("chatWaitingHint")}
      </Text>
      <Row style={{ justifyContent: "flex-end", gap: 8 }}>
        <Button
          variant="quiet"
          size="small"
          label={tr("keepWaiting")}
          onPress={onKeep}
        />
        <Button
          variant="danger"
          size="small"
          label={tr(
            refusal.action === "delete"
              ? "cancelAndDelete"
              : "cancelAndArchive",
          )}
          disabled={disabled}
          onPress={onCancelAndContinue}
        />
      </Row>
    </View>
  );
}
