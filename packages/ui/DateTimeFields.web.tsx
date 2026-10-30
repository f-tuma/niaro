import React, { useId, useState } from "react";
import { tokens as t } from "../design-tokens";
import type { DateTimeFieldsProps } from "./local-date-time";

function BrowserField({
  type,
  label,
  value,
  disabled,
  onChange,
}: {
  type: "date" | "time";
  label: string;
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  return (
    <label
      htmlFor={id}
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        gap: t.spacing.sm,
        color: t.color.text.primary,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        fontSize: t.typography.label.fontSize,
        fontWeight: t.typography.label.fontWeight,
        lineHeight: `${t.typography.label.lineHeight}px`,
      }}
    >
      {label}
      <input
        id={id}
        type={type}
        value={value}
        disabled={disabled}
        step={type === "time" ? 60 : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          boxSizing: "border-box",
          width: "100%",
          minWidth: 0,
          minHeight: t.control.minHeight,
          padding: `${t.spacing.md}px ${t.spacing.lg}px`,
          border: `1px solid ${focused ? t.color.action.primary : t.color.border}`,
          borderRadius: t.radius.control,
          color: t.color.text.primary,
          background: t.color.surfaceRaised,
          fontFamily: "inherit",
          fontSize: t.typography.body.fontSize,
          lineHeight: `${t.typography.body.lineHeight}px`,
          outline: "none",
          colorScheme: "dark",
          opacity: disabled ? 0.5 : 1,
        }}
      />
    </label>
  );
}

export function DateTimeFields(props: DateTimeFieldsProps) {
  return (
    <div
      lang={props.language}
      style={{ display: "flex", flexDirection: "column", gap: t.spacing.md }}
    >
      <BrowserField
        type="date"
        label={props.dateLabel}
        value={props.date}
        disabled={props.disabled}
        onChange={props.onDateChange}
      />
      <BrowserField
        type="time"
        label={props.timeLabel}
        value={props.time}
        disabled={props.disabled}
        onChange={props.onTimeChange}
      />
    </div>
  );
}
