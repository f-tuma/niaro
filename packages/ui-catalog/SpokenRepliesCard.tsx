import React from "react";
import type { Language } from "../protocol";
import type { SpeechCapabilities } from "../protocol/speech";
import { translate } from "../i18n";
import { modelName } from "../protocol/display-name";
import { ListRow, Text, Toggle } from "../ui";

export function SpokenRepliesCard({
  language,
  enabled,
  onChange,
  capabilities,
}: {
  language: Language;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  capabilities?: SpeechCapabilities | null;
}) {
  const tr = translate(language);
  const unavailable = capabilities === null || capabilities?.enabled === false;
  return (
    <ListRow
      icon="speaker"
      label={tr("spoken_replies")}
      description={tr(
        unavailable
          ? "spoken_replies_unavailable"
          : capabilities === undefined
            ? "spoken_replies_loading"
            : "spoken_replies_hint",
      )}
      trailing={
        // Without voice output there is nothing to switch.
        unavailable ? undefined : (
          <Toggle
            value={enabled}
            onChange={onChange}
            accessibilityLabel={tr("spoken_replies")}
          />
        )
      }
    >
      {capabilities?.enabled ? (
        <Text role="caption" tone="secondary">
          {[
            capabilities.model && modelName(capabilities.model),
            tr("spoken_replies_cloud"),
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ) : null}
    </ListRow>
  );
}
