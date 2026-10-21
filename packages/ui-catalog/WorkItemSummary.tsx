import React from "react";
import { View } from "react-native";
import type {
  WorkItem,
  InputRequest,
  ActionProposal,
  Language,
} from "../protocol";
import { translate } from "../i18n";
import { tokens as t } from "../design-tokens";
import { Text, Row, Icon, Badge, ui } from "../ui";
import { MotionPressable } from "../ui/motion";

/** Opening a summary only reveals details. Consent lives in ActionApprovalCard. */
export function WorkItemSummary({
  work,
  input,
  proposal,
  language,
  onOpen,
  timeZone,
  openLabel,
}: {
  work: WorkItem;
  input?: InputRequest;
  proposal?: ActionProposal;
  language: Language;
  onOpen: (workId: string) => void;
  timeZone?: string;
  openLabel?: string;
}) {
  const tr = translate(language);
  const parameters = proposal?.parameters;
  const start = parameters ? new Date(parameters.startsAt) : null;
  const minutes = parameters
    ? (Date.parse(parameters.endsAt) - Date.parse(parameters.startsAt)) / 60000
    : 0;
  const details =
    start && Number.isFinite(start.valueOf()) && minutes > 0
      ? {
          participant: parameters!.participant.label,
          date: new Intl.DateTimeFormat(language, {
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone,
          }).format(start),
          time: new Intl.DateTimeFormat(language, {
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
            timeZone,
          }).format(start),
          duration: new Intl.NumberFormat(language, {
            style: "unit",
            unit: "minute",
            unitDisplay: "short",
          }).format(minutes),
        }
      : null;
  const status = tr(
    parameters?.calendar && work.status === "succeeded"
      ? "calendarSucceeded"
      : work.native && work.status === "succeeded"
        ? "nativeSucceeded"
        : work.native?.process?.status === "unknown"
          ? "processUnknown"
          : work.native?.process?.status === "interrupted"
            ? "processInterrupted"
            : work.status,
  );
  return (
    <MotionPressable
      testID={`summary-${work.id}`}
      accessibilityRole="button"
      accessibilityLabel={[
        work.title,
        ...(details
          ? [details.participant, details.date, details.time, details.duration]
          : []),
        status,
        openLabel ?? tr("viewDetails"),
      ].join(". ")}
      onPress={() => onOpen(work.id)}
      style={({ pressed }) => [
        ui.surface,
        {
          backgroundColor: pressed ? t.color.surfaceRaised : t.color.glass,
          padding: 16,
          gap: 10,
        },
      ]}
    >
      <Row style={{ alignItems: "flex-start", gap: 12 }}>
        <View
          style={{
            padding: 10,
            borderRadius: 15,
            backgroundColor: t.color.accent.softBlue,
          }}
        >
          <Icon
            name={
              work.status === "succeeded"
                ? "check"
                : work.native
                  ? "chat"
                  : "calendar"
            }
            color={t.color.action.primary}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
          <Text role="cardTitle">{work.title}</Text>
          <Text role="caption" tone="secondary" numberOfLines={2}>
            {input?.status === "open"
              ? input.question
              : (details?.participant ?? work.context)}
          </Text>
        </View>
        <View style={{ alignSelf: "center" }}>
          <Icon name="chevron" size={16} color={t.color.text.secondary} />
        </View>
      </Row>
      {details ? (
        <View testID={`meeting-details-${work.id}`} style={{ gap: 6 }}>
          <Row style={{ alignItems: "flex-start" }}>
            <Icon name="calendar" size={15} color={t.color.text.secondary} />
            <Text role="caption" tone="secondary" style={{ flex: 1 }}>
              {details.date}
            </Text>
          </Row>
          <Row style={{ alignItems: "flex-start" }}>
            <Icon name="clock" size={15} color={t.color.text.secondary} />
            <Text role="caption" tone="secondary" style={{ flex: 1 }}>
              {details.time} · {details.duration}
            </Text>
          </Row>
        </View>
      ) : null}
      <View style={{ paddingLeft: details ? 0 : 54 }}>
        <Badge label={status} success={work.status === "succeeded"} />
      </View>
    </MotionPressable>
  );
}
