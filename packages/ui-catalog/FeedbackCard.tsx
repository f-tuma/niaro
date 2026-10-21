import React from "react";
import type { Language } from "../protocol";
import { translate } from "../i18n";
import { ListRow, Toggle } from "../ui";

/** Interface sounds and haptics; a preference of this device only. */
export function FeedbackCard({
  language,
  enabled,
  onChange,
}: {
  language: Language;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const tr = translate(language);
  return (
    <ListRow
      icon="bell"
      label={tr("feedback_sounds")}
      trailing={
        <Toggle
          value={enabled}
          onChange={onChange}
          accessibilityLabel={tr("feedback_sounds")}
        />
      }
    />
  );
}
