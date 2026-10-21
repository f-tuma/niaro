import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { type InputRequest, type Language } from "../protocol";
import { translate } from "../i18n";
import { tokens as t } from "../design-tokens";
import { Text, Stack, Row, Icon, Button, Notice } from "../ui";
export type FormState =
  | "idle"
  | "sending"
  | "accepted"
  | "network_error"
  | "conflict"
  | "rejected";
export type InputRequestFormProps = {
  input: InputRequest;
  language: Language;
  state?: FormState;
  stale?: boolean;
  blocked?: boolean;
  compact?: boolean;
  onExpand?: () => void;
  onAnswer: (selectedContactId: string, revision: number) => void;
};
export function InputRequestForm({
  input,
  language,
  state = "idle",
  stale = false,
  blocked = false,
  compact = false,
  onExpand,
  onAnswer,
}: InputRequestFormProps) {
  const tr = translate(language);
  const [selected, setSelected] = useState<string>();
  const [draftRevision, setDraftRevision] = useState(input.revision);
  const [required, setRequired] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const changed = draftRevision !== input.revision;
  if (input.status !== "open")
    return (
      <Notice>
        {tr(
          input.status === "resolved" ? "questionResolved" : "questionClosed",
        )}
        {input.resolution
          ? ` · ${input.options.find((o) => o.id === input.resolution?.selectedContactId)?.label ?? ""}`
          : ""}
      </Notice>
    );
  const disabled =
    stale ||
    blocked ||
    state === "sending" ||
    state === "accepted" ||
    state === "network_error" ||
    changed;
  return (
    <Stack>
      <Text role={compact ? "label" : "body"}>{input.question}</Text>
      {changed ? (
        <>
          <Notice>{tr("questionUpdated")}</Notice>
          <Button
            variant="secondary"
            label={tr("refresh")}
            onPress={() => {
              setDraftRevision(input.revision);
              if (!input.options.some((o) => o.id === selected))
                setSelected(undefined);
            }}
          />
        </>
      ) : null}
      <View
        accessibilityRole={compact ? undefined : "radiogroup"}
        accessibilityLabel={tr("selectContact")}
        style={{ gap: t.spacing.sm }}
      >
        {(compact && !showAll ? input.options.slice(0, 3) : input.options).map(
          (option) => (
            <Pressable
              key={option.id}
              accessibilityRole={compact ? "button" : "radio"}
              accessibilityLabel={`${option.label}, ${option.detail}`}
              accessibilityState={
                compact
                  ? { disabled }
                  : { checked: selected === option.id, disabled }
              }
              disabled={disabled}
              onPress={() => {
                setSelected(option.id);
                setRequired(false);
                if (compact) onAnswer(option.id, draftRevision);
              }}
              style={({ pressed }) => ({
                borderWidth: 1,
                borderColor:
                  selected === option.id
                    ? t.color.action.primary
                    : t.color.border,
                backgroundColor:
                  selected === option.id || pressed
                    ? t.color.accent.softBlue
                    : t.color.surfaceRaised,
                borderRadius: t.radius.control,
                padding: compact ? 10 : t.spacing.md,
                minHeight: t.control.minHeight,
              })}
            >
              <Row style={{ gap: compact ? 8 : t.spacing.inlineGap }}>
                <View
                  style={{
                    width: compact ? 28 : 36,
                    height: compact ? 28 : 36,
                    borderRadius: 18,
                    backgroundColor: t.color.background,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon
                    name={selected === option.id ? "check" : "person"}
                    size={20}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text role="label">{option.label}</Text>
                  <Text role="caption" tone="secondary">
                    {option.detail}
                  </Text>
                </View>
                {compact ? (
                  <Icon
                    name="chevron"
                    size={14}
                    color={t.color.text.secondary}
                  />
                ) : null}
              </Row>
            </Pressable>
          ),
        )}
      </View>
      {compact && input.options.length > 3 ? (
        <Button
          variant="quiet"
          label={tr(showAll ? "showFewerContacts" : "showMoreContacts")}
          onPress={() => {
            onExpand?.();
            setShowAll(!showAll);
          }}
        />
      ) : null}
      {required ? <Notice error>{tr("required")}</Notice> : null}
      {state === "conflict" ||
      state === "rejected" ||
      state === "network_error" ? (
        <Notice error>{tr(state)}</Notice>
      ) : null}
      {stale ? <Notice>{tr("stale")}</Notice> : null}
      {!compact ? (
        <Button
          label={tr(
            state === "sending"
              ? "sending"
              : state === "accepted"
                ? "accepted"
                : "sendAnswer",
          )}
          loading={state === "sending"}
          disabled={disabled}
          onPress={() => {
            if (!selected) {
              setRequired(true);
              return;
            }
            onAnswer(selected, draftRevision);
          }}
        />
      ) : null}
    </Stack>
  );
}
