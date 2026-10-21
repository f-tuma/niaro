import React from "react";
import { View } from "react-native";
import type { Language, MeetingParameters } from "../protocol";
import { tokens as t } from "../design-tokens";
import { Icon, Row, Text } from "../ui";

/** Display formatting only. The server supplies all meeting facts and the target. */
export function MeetingFacts({
  parameters,
  language,
  timeZone,
}: {
  parameters: MeetingParameters;
  language: Language;
  timeZone?: string;
}) {
  const start = new Date(parameters.startsAt);
  const date = new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(start);
  const time = new Intl.DateTimeFormat(language, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(start);
  const duration = new Intl.NumberFormat(language, {
    style: "unit",
    unit: "minute",
    unitDisplay: "short",
  }).format((Date.parse(parameters.endsAt) - start.valueOf()) / 60000);
  return (
    <View style={{ gap: 10 }}>
      <Row style={{ alignItems: "flex-start", gap: 10 }}>
        <Icon name="calendar" size={20} color={t.color.action.primary} />
        <Text role="label" style={{ flex: 1, minWidth: 0 }}>
          {parameters.title}
        </Text>
      </Row>
      <Row style={{ alignItems: "flex-start", gap: 10 }}>
        <Icon name="person" size={16} color={t.color.text.secondary} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text role="caption">{parameters.participant.label}</Text>
          <Text role="caption" tone="secondary" selectable>
            {parameters.participant.email}
          </Text>
        </View>
      </Row>
      <Row style={{ alignItems: "flex-start", gap: 10 }}>
        <Icon name="clock" size={16} color={t.color.text.secondary} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text role="caption">{date}</Text>
          <Text role="caption">
            {time} · {duration}
          </Text>
        </View>
      </Row>
      {parameters.calendar ? (
        <Row style={{ alignItems: "flex-start", gap: 10 }}>
          <Icon name="calendar" size={16} color={t.color.text.secondary} />
          <Text
            role="caption"
            tone="secondary"
            style={{ flex: 1, minWidth: 0 }}
          >
            {parameters.calendar.label}
          </Text>
        </Row>
      ) : null}
    </View>
  );
}
