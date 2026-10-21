import React from "react";
import { StyleSheet, View } from "react-native";
import type { CrmContact, CrmContactResult, Language } from "../protocol";
import { translate } from "../i18n";
import { tokens as t } from "../design-tokens";
import { Avatar, Icon, Row, Surface, Text, type IconName } from "../ui";
import { MotionPressable } from "../ui/motion";
import { openContact } from "./contact-link";

/** A data-only result. Rendering never fetches or changes a record; a tap only opens the dialer or mail app. */
export function CrmContactCard({
  contact,
  language,
}: {
  contact: Omit<CrmContact, "id"> & { id?: string };
  language: Language;
}) {
  const tr = translate(language);
  return (
    <Surface
      testID={contact.id ? `crm-contact-${contact.id}` : undefined}
      style={styles.card}
    >
      <Row style={styles.heading}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Avatar name={contact.name.replace(/^TEST\s+/i, "")} size={40} />
        </View>
        <View style={styles.identity}>
          <Text role="rowTitle" accessibilityRole="header" selectable>
            {contact.name}
          </Text>
          {contact.jobTitle ? (
            <Text role="meta" tone="secondary" selectable>
              {contact.jobTitle}
            </Text>
          ) : null}
        </View>
      </Row>
      {contact.phone || contact.email ? (
        <View style={styles.fields}>
          {contact.phone ? (
            <ContactField
              icon="phone"
              label={tr("crmPhone")}
              value={contact.phone}
              action={tr("contactCall").replace("{value}", contact.phone)}
              onPress={() => openContact("phone", contact.phone!)}
            />
          ) : null}
          {contact.email ? (
            <ContactField
              icon="mail"
              label={tr("crmEmail")}
              value={contact.email}
              action={tr("contactWrite").replace("{value}", contact.email)}
              onPress={() => openContact("email", contact.email!)}
            />
          ) : null}
        </View>
      ) : null}
    </Surface>
  );
}

function ContactField({
  icon,
  label,
  value,
  action,
  onPress,
}: {
  icon: IconName;
  label: string;
  value: string;
  action: string;
  onPress: () => void;
}) {
  return (
    <MotionPressable
      accessibilityRole="link"
      accessibilityLabel={action}
      onPress={onPress}
      style={styles.field}
    >
      <View style={styles.fieldIcon}>
        <Icon name={icon} size={18} color={t.color.action.primary} />
      </View>
      <View style={styles.fieldText}>
        <Text role="meta" tone="secondary">
          {label}
        </Text>
        <Text style={[styles.value, { color: t.color.action.primary }]}>
          {value}
        </Text>
      </View>
    </MotionPressable>
  );
}

export function CrmContactResults({
  result,
  language,
}: {
  result: CrmContactResult;
  language: Language;
}) {
  const tr = translate(language);
  return (
    <View testID="crm-contact-results" style={styles.results}>
      <Row style={styles.resultHeading}>
        <Text role="label" accessibilityRole="header" style={{ flex: 1 }}>
          {tr("crmContacts")}
        </Text>
        <Text role="meta" tone="secondary">
          Twenty · TEST
        </Text>
      </Row>
      {result.contacts.map((contact) => (
        <CrmContactCard
          key={contact.id}
          contact={contact}
          language={language}
        />
      ))}
      {!result.contacts.length ? (
        <Surface style={styles.card}>
          <Text tone="secondary">{tr("crmEmpty")}</Text>
        </Surface>
      ) : null}
      {result.hasMore ? (
        <Text role="caption" tone="secondary">
          {tr("crmMore")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  results: { gap: t.spacing.md, minWidth: 0 },
  resultHeading: { flexWrap: "wrap", rowGap: t.spacing.xs, minHeight: 24 },
  card: { gap: t.spacing.sm },
  heading: { alignItems: "center", gap: t.spacing.md },
  identity: { flex: 1, minWidth: 0, gap: 2 },
  fields: { gap: 0 },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.md,
    minHeight: 48,
  },
  fieldIcon: { width: 40, alignItems: "center", justifyContent: "center" },
  fieldText: { flex: 1, minWidth: 0, gap: 1 },
  value: { flexShrink: 1, fontWeight: "500" },
});
