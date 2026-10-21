import React, { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { Language } from "../protocol";
import type { ServicePresentation } from "../protocol/service-presentation";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import { Disclosure, Icon, Row, Text, type IconName } from "../ui";
import { MotionPressable } from "../ui/motion";
import { openContact } from "./contact-link";
import { CardDataField } from "./CardDataField";
import { formatInstant, formatRange } from "./field-format";
import { displayFieldIcon } from "../protocol/display-link";

type ResultFields = Extract<ServicePresentation, { kind: "detail" }>["fields"];

/** Presentation only: expanding rows never fetches or invokes a service. */
export function ServiceResultContent({
  presentation,
  language,
}: {
  presentation: ServicePresentation;
  language: Language;
}) {
  const tr = translate(language);
  switch (presentation.kind) {
    case "contacts":
      return (
        <ResultList
          language={language}
          hasMore={presentation.hasMore}
          emptyLabel={tr("serviceContactsEmpty")}
          items={presentation.items.map((contact, index) => (
            <ResultRow key={index} icon="person">
              <Text role="label" selectable>
                {contact.name}
              </Text>
              {contact.subtitle ? (
                <Text role="caption" tone="secondary" selectable>
                  {contact.subtitle}
                </Text>
              ) : null}
              {contact.email ? (
                <ContactValue
                  icon="mail"
                  label={tr("contactWrite").replace("{value}", contact.email)}
                  value={contact.email}
                  onPress={() => openContact("email", contact.email!)}
                />
              ) : null}
              {contact.phone ? (
                <ContactValue
                  icon="phone"
                  label={tr("contactCall").replace("{value}", contact.phone)}
                  value={contact.phone}
                  onPress={() => openContact("phone", contact.phone!)}
                />
              ) : null}
            </ResultRow>
          ))}
        />
      );
    case "events":
      return (
        <ResultList
          language={language}
          hasMore={presentation.hasMore}
          emptyLabel={tr("serviceEventsEmpty")}
          items={presentation.items.map((event, index) => (
            <ResultRow key={index} icon="calendar">
              <Text role="label" selectable>
                {event.title}
              </Text>
              <Text role="caption" selectable>
                {(event.end
                  ? formatRange(event.start, event.end, language)
                  : undefined) ??
                  formatInstant(event.start, language) ??
                  event.start}
              </Text>
              {event.location ? (
                <Text role="caption" tone="secondary" selectable>
                  {event.location}
                </Text>
              ) : null}
            </ResultRow>
          ))}
        />
      );
    case "records":
      return (
        <ResultList
          language={language}
          hasMore={presentation.hasMore}
          emptyLabel={tr("serviceRecordsEmpty")}
          items={presentation.items.map((record, index) => {
            const showDetails =
              record.fields.length > 2 ||
              record.fields.some((field) => field.value.length > 120);
            return (
              <ResultRow key={index} icon="tasks">
                <Text role="label" selectable>
                  {record.title}
                </Text>
                {record.subtitle ? (
                  <Text role="caption" tone="secondary" selectable>
                    {record.subtitle}
                  </Text>
                ) : null}
                {showDetails ? (
                  <Disclosure
                    label={tr("serviceItemDetails").replace(
                      "{title}",
                      record.title,
                    )}
                  >
                    <Fields fields={record.fields} language={language} />
                  </Disclosure>
                ) : (
                  <Fields fields={record.fields} language={language} />
                )}
              </ResultRow>
            );
          })}
        />
      );
    case "detail":
      return <Fields fields={presentation.fields} language={language} />;
    case "text":
      return (
        <Text selectable style={styles.value}>
          {presentation.text}
        </Text>
      );
  }
}

function ResultList({
  items,
  language,
  hasMore,
  emptyLabel,
}: {
  items: ReactNode[];
  language: Language;
  hasMore: boolean;
  emptyLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const tr = translate(language);
  return (
    <View style={styles.list}>
      {items.length ? (
        items.slice(0, expanded ? items.length : 3)
      ) : (
        <Text role="caption" tone="secondary">
          {hasMore ? tr("serviceResultsPageEmpty") : emptyLabel}
        </Text>
      )}
      {items.length > 3 ? (
        <MotionPressable
          accessibilityRole="button"
          accessibilityLabel={tr(
            expanded ? "serviceShowLess" : "serviceShowMore",
          )}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={styles.expand}
        >
          <Text role="label" style={styles.expandLabel}>
            {tr(expanded ? "serviceShowLess" : "serviceShowMore")}
          </Text>
          <View
            style={{ transform: [{ rotate: expanded ? "-90deg" : "90deg" }] }}
          >
            <Icon name="chevron" size={15} color={t.color.action.primary} />
          </View>
        </MotionPressable>
      ) : null}
      {hasMore ? (
        <Text role="caption" tone="secondary">
          {tr("serviceResultsTruncated")}
        </Text>
      ) : null}
    </View>
  );
}

function ResultRow({
  icon,
  children,
}: {
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <Row style={styles.row}>
      <View style={styles.leadingIcon}>
        <Icon name={icon} size={18} color={t.color.action.primary} />
      </View>
      <View style={styles.content}>{children}</View>
    </Row>
  );
}

function ContactValue({
  icon,
  label,
  value,
  onPress,
}: {
  icon: IconName;
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <MotionPressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={styles.contactValue}
    >
      <Icon name={icon} size={14} color={t.color.action.primary} />
      <Text
        role="caption"
        style={[styles.value, { color: t.color.action.primary }]}
      >
        {value}
      </Text>
    </MotionPressable>
  );
}

function Fields({
  fields,
  language,
}: {
  fields: ResultFields;
  language: Language;
}) {
  return (
    <View style={styles.fields}>
      {fields.map((field, index) => (
        <CardDataField
          key={index}
          label={field.label}
          value={field.value}
          icon={displayFieldIcon(field.label, field.value)}
          language={language}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { minWidth: 0, gap: t.spacing.sm },
  row: {
    alignItems: "flex-start",
    paddingVertical: t.spacing.sm,
    borderTopWidth: 1,
    borderColor: t.color.border,
    minWidth: 0,
  },
  leadingIcon: { paddingTop: 2, width: 22 },
  content: { flex: 1, minWidth: 0, gap: t.spacing.xs },
  contactValue: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: t.spacing.xs,
  },
  value: { flexShrink: 1, minWidth: 0 },
  fields: { minWidth: 0, gap: t.spacing.sm },
  expand: {
    minHeight: t.control.minHeight,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: t.spacing.sm,
    borderRadius: t.radius.control,
  },
  expandLabel: { color: t.color.action.primary },
});
