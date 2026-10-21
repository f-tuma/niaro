import React, { useEffect, useState } from "react";
import type { ClientSession } from "../../packages/client-core/session";
import type { Language } from "../../packages/protocol";
import type { VoiceCapabilities } from "../../packages/protocol/voice";
import { VoiceServiceCard } from "../../packages/ui-catalog/VoiceServiceCard";
import { SpokenRepliesCard } from "../../packages/ui-catalog/SpokenRepliesCard";
import type { SpeechCapabilities } from "../../packages/protocol/speech";
import { translate } from "../../packages/i18n";
import { Group, ListRow } from "../../packages/ui";

export function VoiceSettings({
  session,
  language,
  spokenReplies,
  onSpokenReplies,
}: {
  session: ClientSession;
  language: Language;
  spokenReplies: boolean;
  onSpokenReplies: (enabled: boolean) => void;
}) {
  const [result, setResult] = useState<{
    session: ClientSession;
    value: VoiceCapabilities | null;
  }>();
  const [speech, setSpeech] = useState<{
    session: ClientSession;
    value: SpeechCapabilities | null;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void session.voiceCapabilities(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setResult({ session, value });
      },
      () => {
        if (!controller.signal.aborted) setResult({ session, value: null });
      },
    );
    void session.speechCapabilities(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setSpeech({ session, value });
      },
      () => {
        if (!controller.signal.aborted) setSpeech({ session, value: null });
      },
    );
    return () => controller.abort();
  }, [session]);
  const tr = translate(language);
  const voice = result?.session === session ? result.value : undefined;
  const replies = speech?.session === session ? speech.value : undefined;
  // Neither input nor output: one row says so instead of two.
  if (
    (voice === null || voice?.enabled === false) &&
    (replies === null || replies?.enabled === false) &&
    voice?.processing !== "cloud"
  )
    return (
      <Group title={tr("voiceSettings")}>
        <ListRow
          icon="mic"
          label={tr("voiceInputAndReplies")}
          value={tr("voice_unavailable_short")}
        />
      </Group>
    );
  return (
    <Group title={tr("voiceSettings")}>
      <VoiceServiceCard
        language={language}
        capabilities={result?.session === session ? result.value : undefined}
      />
      <SpokenRepliesCard
        language={language}
        enabled={spokenReplies}
        onChange={onSpokenReplies}
        capabilities={speech?.session === session ? speech.value : undefined}
      />
    </Group>
  );
}
