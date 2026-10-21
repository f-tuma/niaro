import React from "react";
import { View } from "react-native";
import type { Language } from "../protocol";
import type { ProcessOfferResult } from "../protocol/process-offer";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import { Button, IconTile, Row, Surface, Text } from "../ui";
import { FieldRows } from "./FieldRows";
import { displayFields } from "./field-format";

const preview = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? text.slice(0, 119) + "…" : text;
};

/** A saved process the assistant suggests. Choosing it only opens the
 * reviewed start flow; declining asks the assistant to do the work itself. */
export function ProcessOfferCard({
  offer,
  language,
  disabled = false,
  onReview,
  onDecline,
}: {
  offer: ProcessOfferResult;
  language: Language;
  disabled?: boolean;
  onReview: () => void;
  onDecline: () => void;
}) {
  const tr = translate(language);
  const fields = displayFields(
    Object.entries(offer.input)
      .slice(0, 6)
      .map(([label, value]) => ({ label, value: preview(value) })),
    language,
  );
  const reason = offer.reason || offer.description;
  return (
    <Surface style={{ gap: t.spacing.md }} testID="process-offer">
      <Row style={{ alignItems: "center", gap: t.spacing.md }}>
        <IconTile
          icon={offer.kind === "agent" ? "sparkle" : "bolt"}
          tone={offer.kind === "agent" ? "violet" : "blue"}
        />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text role="cardTitle" accessibilityRole="header">
            {offer.name}
          </Text>
          <Text role="meta" tone="secondary" numberOfLines={1}>
            {tr("processOfferTitle")}
          </Text>
        </View>
      </Row>
      {reason ? (
        <Text role="body" tone="secondary">
          {reason}
        </Text>
      ) : null}
      <FieldRows fields={fields} testID="process-offer-input" />
      <Row style={{ gap: t.spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Button
            label={tr("processOfferDecline")}
            variant="secondary"
            disabled={disabled}
            onPress={onDecline}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label={tr("processOfferReview")}
            disabled={disabled}
            onPress={onReview}
          />
        </View>
      </Row>
    </Surface>
  );
}
