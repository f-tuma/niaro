import React, { useEffect, useRef } from "react";
import { Platform, View } from "react-native";
import DateTimePicker, {
  DateTimePickerAndroid,
} from "@react-native-community/datetimepicker";
import { tokens as t } from "../design-tokens";
import { Icon, Row, Stack, Text, ui } from "./index";
import { MotionPressable } from "./motion";
import {
  localDateTime,
  localDateTimeToIso,
  type DateTimeFieldsProps,
} from "./local-date-time";

function NativeField({
  mode,
  value,
  label,
  language,
  disabled,
  onSelect,
}: {
  mode: "date" | "time";
  value: Date;
  label: string;
  language: "en" | "cs";
  disabled?: boolean;
  onSelect(value: Date): void;
}) {
  const active = useRef<symbol | undefined>(undefined);
  useEffect(
    () => () => {
      if (active.current) {
        active.current = undefined;
        void DateTimePickerAndroid.dismiss(mode);
      }
    },
    [disabled, mode],
  );
  const formatted = new Intl.DateTimeFormat(
    language,
    mode === "date"
      ? { dateStyle: "medium" }
      : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  ).format(value);
  return (
    <Stack style={{ gap: t.spacing.sm }}>
      <Text role="label">{label}</Text>
      {Platform.OS === "ios" ? (
        <Row style={[ui.input, { justifyContent: "space-between" }]}>
          <Icon
            name={mode === "date" ? "calendar" : "clock"}
            color={t.color.text.secondary}
          />
          <DateTimePicker
            accessibilityLabel={label}
            value={value}
            mode={mode}
            display="compact"
            disabled={disabled}
            themeVariant="light"
            accentColor={t.color.action.primary}
            onValueChange={(_event, selected) => onSelect(selected)}
            style={{ flexShrink: 1 }}
          />
        </Row>
      ) : (
        <MotionPressable
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${formatted}`}
          accessibilityState={{ disabled: !!disabled }}
          disabled={disabled}
          style={[ui.input, { opacity: disabled ? 0.5 : 1 }]}
          onPress={() => {
            const token = Symbol(mode);
            active.current = token;
            DateTimePickerAndroid.open({
              value,
              mode,
              is24Hour: true,
              onValueChange: (_event, selected) => {
                if (active.current !== token) return;
                active.current = undefined;
                onSelect(selected);
              },
              onDismiss: () => {
                if (active.current === token) active.current = undefined;
              },
            });
          }}
        >
          <Row>
            <Icon
              name={mode === "date" ? "calendar" : "clock"}
              color={t.color.text.secondary}
            />
            <Text style={{ flex: 1 }}>{formatted}</Text>
            <Icon name="chevron" size={16} color={t.color.text.secondary} />
          </Row>
        </MotionPressable>
      )}
    </Stack>
  );
}

export function DateTimeFields(props: DateTimeFieldsProps) {
  const value = new Date(
    localDateTimeToIso(props.date, props.time, props.initialValue) ??
      props.initialValue,
  );
  return (
    <View style={{ gap: t.spacing.md }}>
      <NativeField
        mode="date"
        value={value}
        label={props.dateLabel}
        language={props.language}
        disabled={props.disabled}
        onSelect={(selected) =>
          props.onDateChange(localDateTime(selected.toISOString()).date)
        }
      />
      <NativeField
        mode="time"
        value={value}
        label={props.timeLabel}
        language={props.language}
        disabled={props.disabled}
        onSelect={(selected) =>
          props.onTimeChange(localDateTime(selected.toISOString()).time)
        }
      />
    </View>
  );
}
