import React, { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { DateTimeFields } from "./DateTimeFields";
import { localDateTime } from "./local-date-time";
import { Surface } from "./index";
import { translate } from "../i18n";
function Example({
  language = "en",
  disabled = false,
}: {
  language?: "en" | "cs";
  disabled?: boolean;
}) {
  const initialValue = "2026-09-27T12:00:00.000Z";
  const [draft, setDraft] = useState(() => localDateTime(initialValue));
  const tr = translate(language);
  return (
    <Surface>
      <DateTimeFields
        {...draft}
        initialValue={initialValue}
        dateLabel={tr("meetingDate")}
        timeLabel={`${tr("meetingTime")} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}
        language={language}
        disabled={disabled}
        onDateChange={(date) => setDraft((current) => ({ ...current, date }))}
        onTimeChange={(time) => setDraft((current) => ({ ...current, time }))}
      />
    </Surface>
  );
}
export default {
  title: "Foundation/Date and time",
  component: Example,
} satisfies Meta<typeof Example>;
export const English: StoryObj<typeof Example> = {};
export const Czech: StoryObj<typeof Example> = { args: { language: "cs" } };
export const Disabled: StoryObj<typeof Example> = { args: { disabled: true } };
