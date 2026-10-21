import React from "react";
import { View } from "react-native";
import type { Language } from "../protocol";
import { translate, type TranslationKey } from "../i18n";
import { Notice } from "../ui";

/** Passive announcement; command and recovery controls stay with their owners. */
export function ProcessCommandNoticeView({
  language,
  notice,
}: {
  language: Language;
  notice: { key: TranslationKey; detailKey?: TranslationKey; error: boolean };
}) {
  const tr = translate(language);
  return (
    <View testID="process-command-notice">
      <Notice error={notice.error}>
        {tr(notice.key)}
        {notice.detailKey ? ` ${tr(notice.detailKey)}` : ""}
      </Notice>
    </View>
  );
}
