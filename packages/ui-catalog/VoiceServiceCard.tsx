import React from "react";
import type { Language } from "../protocol";
import type { VoiceCapabilities } from "../protocol/voice";
import { translate } from "../i18n";
import { modelName } from "../protocol/display-name";
import { ListRow, Text } from "../ui";

export function VoiceServiceCard({
  language,
  capabilities,
}: {
  language: Language;
  /** undefined = checking; null = unavailable */
  capabilities?: VoiceCapabilities | null;
}) {
  const tr = translate(language);
  // Cloud processing stays disclosed even while the service is switched off.
  const processing =
    capabilities &&
    (capabilities.enabled || capabilities.processing === "cloud")
      ? tr(
          capabilities.processing === "cloud"
            ? "voice_service_cloud"
            : "voice_service_local",
        )
      : null;
  return (
    <ListRow icon="mic" label={tr("voice_service")}>
      {/* One line: which model, or why there is none, then where audio goes. */}
      <Text role="caption" tone="secondary">
        {[
          capabilities?.enabled
            ? capabilities.engine === "openrouter"
              ? modelName(capabilities.model)
              : "Whisper small"
            : tr(
                capabilities === undefined
                  ? "voice_service_loading"
                  : "voice_unavailable_short",
              ),
          processing,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
    </ListRow>
  );
}
