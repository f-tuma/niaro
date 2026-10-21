import React from "react";
import { View, StyleSheet } from "react-native";
import type { ServiceResult } from "../protocol/service-result";
import type { ServicePresentation } from "../protocol/service-presentation";
import type { Language } from "../protocol";
import {
  Button,
  Disclosure,
  Icon,
  Row,
  StatusPill,
  Surface,
  Text,
  type StatusTone,
} from "../ui";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import { ServiceResultContent } from "./ServiceResultContent";
import { CrmContactCard } from "./CrmContactCard";
import { CardDocumentView } from "./CardDocumentView";
import { actionIcon, serviceActionDisplay } from "./service-action-display";
import {
  ServiceActionReview,
  completeServiceActionReview,
  type ServiceActionReviewFrame,
} from "./ServiceActionReview";
export type { ServiceActionReviewFrame } from "./ServiceActionReview";

/** One status line per card; awaiting approval shows its effect instead. */
const statusTone: Record<
  Exclude<ServiceResult["status"], "awaiting_approval">,
  StatusTone
> = {
  running: "running",
  succeeded: "success",
  failed: "error",
  unknown: "warning",
  rejected: "unknown",
};
export function ServiceActionCard({
  result,
  language,
  disabled,
  onDecide,
  reviewFrame,
  embedded = false,
}: {
  result: ServiceResult;
  language: Language;
  disabled: boolean;
  onDecide: (approved: boolean) => void;
  reviewFrame?: ServiceActionReviewFrame;
  /** Inside another card: no second frame, padding or border. */
  embedded?: boolean;
}) {
  const tr = translate(language);
  const incompleteReview =
    !!reviewFrame && !completeServiceActionReview(result, reviewFrame);
  const decisionDisabled = disabled || incompleteReview;
  const { presentation, card, title } = serviceActionDisplay(result);
  const status = {
    awaiting_approval: "serviceAwaiting",
    running: "serviceRunning",
    succeeded: "serviceSucceeded",
    failed: "serviceFailed",
    unknown: "serviceUnknown",
    rejected: "serviceRejected",
  } as const;
  if (!card && presentation?.kind === "contacts" && presentation.items.length)
    return (
      <ContactResults
        presentation={presentation}
        service={result.service}
        language={language}
      />
    );
  const waiting = result.status === "awaiting_approval";
  const Frame = embedded ? View : Surface;
  return (
    <Frame style={{ gap: t.spacing.md }}>
      <Row style={{ alignItems: "center", gap: t.spacing.md }}>
        <View style={styles.mark}>
          <Icon
            name={actionIcon(result.title, result.service)}
            size={20}
            color={t.color.text.primary}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text role="cardTitle" accessibilityRole="header">
            {title}
          </Text>
          <Text role="meta" tone="secondary" numberOfLines={1}>
            {result.service}
          </Text>
        </View>
      </Row>
      {result.status !== "awaiting_approval" ? (
        <View accessible accessibilityLabel={tr(status[result.status])}>
          <StatusPill
            label={tr(status[result.status])}
            tone={statusTone[result.status]}
            busy={result.status === "running"}
          />
        </View>
      ) : null}
      {waiting && (
        <>
          <ServiceActionReview
            result={result}
            frame={reviewFrame}
            language={language}
          />
          {card ? (
            <Disclosure label={tr("cardAdditionalContext")}>
              <CardDocumentView document={card} language={language} embedded />
            </Disclosure>
          ) : null}
          <Row style={{ gap: t.spacing.xs }}>
            <Icon
              name={result.effect === "write" ? "edit" : "search"}
              size={14}
              color={t.color.text.secondary}
            />
            <Text role="meta" tone="secondary" style={{ flex: 1 }}>
              {tr(
                result.effect === "write"
                  ? "serviceWriteEffect"
                  : "serviceReadEffect",
              )}
            </Text>
          </Row>
          <Row style={{ gap: t.spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                label={tr("serviceReject")}
                variant="secondary"
                disabled={decisionDisabled}
                onPress={() => {
                  if (!decisionDisabled) onDecide(false);
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label={tr("serviceApprove")}
                disabled={decisionDisabled}
                onPress={() => {
                  if (!decisionDisabled) onDecide(true);
                }}
              />
            </View>
          </Row>
        </>
      )}
      {card && result.status !== "awaiting_approval" ? (
        <CardDocumentView document={card} language={language} embedded />
      ) : presentation ? (
        <ServiceResultContent
          key={`${result.operationId}:${presentation.kind}`}
          presentation={presentation}
          language={language}
        />
      ) : null}
    </Frame>
  );
}

type Contacts = Extract<ServicePresentation, { kind: "contacts" }>;

/** Found people are shown as person cards; the tool name and raw payload are not user information. */
function ContactResults({
  presentation,
  service,
  language,
}: {
  presentation: Contacts;
  service: string;
  language: Language;
}) {
  const tr = translate(language);
  const cards = presentation.items.length <= 3;
  return (
    <View style={{ gap: t.spacing.md, minWidth: 0 }}>
      <Row style={{ flexWrap: "wrap", rowGap: t.spacing.xs }}>
        <Text role="label" accessibilityRole="header" style={{ flex: 1 }}>
          {tr(
            presentation.items.length === 1
              ? "serviceContact"
              : "serviceContacts",
          )}
        </Text>
        <Text role="caption" tone="secondary">
          {service}
        </Text>
      </Row>
      {cards ? (
        presentation.items.map((contact, index) => (
          <CrmContactCard
            key={index}
            contact={{
              name: contact.name,
              ...(contact.subtitle ? { jobTitle: contact.subtitle } : {}),
              ...(contact.email ? { email: contact.email } : {}),
              ...(contact.phone ? { phone: contact.phone } : {}),
            }}
            language={language}
          />
        ))
      ) : (
        <Surface>
          <ServiceResultContent
            presentation={presentation}
            language={language}
          />
        </Surface>
      )}
      {cards && presentation.hasMore ? (
        <Text role="caption" tone="secondary">
          {tr("serviceResultsTruncated")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  mark: {
    width: 40,
    height: 40,
    borderRadius: t.radius.control,
    backgroundColor: t.color.fill,
    alignItems: "center",
    justifyContent: "center",
  },
});
