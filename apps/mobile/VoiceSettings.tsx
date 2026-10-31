import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import { DetailSheet } from "./ScreenChrome";
import { OutputVoiceCard } from "../../packages/ui-catalog/OutputVoiceCard";
import {
  OUTPUT_VOICE_PROFILE,
  type OutputVoiceSnapshot,
  type OutputVoiceUpdate,
  type OutputVoiceChoice,
} from "../../packages/protocol/output-voice";
import type { TranslationKey } from "../../packages/i18n";
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
  const unavailable =
    (voice === null || voice?.enabled === false) &&
    (replies === null || replies?.enabled === false) &&
    voice?.processing !== "cloud";
  return (
    <Group title={tr("voiceSettings")}>
      {unavailable ? (
        <ListRow
          icon="mic"
          label={tr("voiceInputAndReplies")}
          value={tr("voice_unavailable_short")}
        />
      ) : (
        <>
          <VoiceServiceCard
            language={language}
            capabilities={
              result?.session === session ? result.value : undefined
            }
          />
          <SpokenRepliesCard
            language={language}
            enabled={spokenReplies}
            onChange={onSpokenReplies}
            capabilities={
              speech?.session === session ? speech.value : undefined
            }
          />
        </>
      )}
      <MobileOutputVoiceSettings session={session} language={language} />
    </Group>
  );
}

/** Requests and dismissal belong to this settings surface; the card only renders. */
function MobileOutputVoiceSettings({
  session,
  language,
}: {
  session: ClientSession;
  language: Language;
}) {
  const owner = useMemo(() => new MobileOutputVoiceEditor(session), [session]);
  useSyncExternalStore(owner.subscribe, owner.getVersion, owner.getVersion);
  useEffect(() => owner.mount(), [owner]);
  const tr = translate(language);
  const card = {
    language,
    snapshot: owner.snapshot,
    pending: owner.busy && !!owner.pending && !owner.reading,
    loading: owner.reading,
    disabled: owner.busy || owner.closing,
    issue: owner.issue,
    onReset: () => {
      void owner.save({ kind: "server-default" });
    },
    onRetry:
      owner.pending && !owner.reading && !owner.busy
        ? () => {
            void owner.save(owner.pending!.choice, owner.pending);
          }
        : undefined,
    onRefresh:
      owner.issue && !owner.pending
        ? () => {
            void owner.refresh();
          }
        : undefined,
  };
  return (
    <>
      <OutputVoiceCard {...card} onOpen={() => owner.open()} />
      {owner.sheet ? (
        <DetailSheet
          title={tr("outputVoice")}
          language={language}
          onDismissRequested={owner.dismissRequested}
          onClose={owner.closed}
        >
          <OutputVoiceCard
            {...card}
            options
            onChoose={(choice) => {
              void owner.save(choice);
            }}
          />
        </DetailSheet>
      ) : null}
    </>
  );
}

class MobileOutputVoiceEditor {
  constructor(readonly session: ClientSession) {}
  alive = false;
  foreground = true;
  generation = 0;
  write = 0;
  reading = false;
  snapshot: OutputVoiceSnapshot | null | undefined;
  issue: TranslationKey | undefined;
  busy = false;
  sheet = false;
  closing = false;
  pending: OutputVoiceUpdate | undefined;
  read: AbortController | undefined;
  saveRequest: AbortController | undefined;
  private version = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getVersion = () => this.version;
  notify = () => {
    this.version++;
    for (const listener of this.listeners) listener();
  };
  owns = (generation: number) =>
    this.alive && this.foreground && this.generation === generation;
  refresh = async () => {
    if (!this.alive || !this.foreground || this.closing) return;
    this.read?.abort();
    const controller = new AbortController();
    this.read = controller;
    const generation = this.generation,
      write = this.write;
    this.reading = true;
    this.notify();
    try {
      const value = await this.session.outputVoiceSettings(controller.signal);
      if (
        !this.owns(generation) ||
        controller.signal.aborted ||
        write !== this.write
      )
        return;
      if (value && this.snapshot && value.revision < this.snapshot.revision)
        return;
      this.snapshot = value;
      if (!this.pending && this.issue === "outputVoiceLoadFailed")
        this.issue = undefined;
      if (this.pending && value) {
        if (
          sameIntent(value, this.pending.choice) ||
          value.revision > this.pending.expectedRevision ||
          value.catalogueRevision !== this.pending.catalogueRevision
        ) {
          this.pending = undefined;
          this.issue = undefined;
        }
      }
    } catch (error) {
      if (this.owns(generation) && !controller.signal.aborted) {
        if (
          error instanceof Error &&
          [
            "session_stopped",
            "auth_expired",
            "output_voice_context_changed",
          ].includes(error.message)
        ) {
          this.snapshot = undefined;
          this.pending = undefined;
          this.sheet = false;
        }
        this.issue = this.pending
          ? "outputVoiceSaveFailed"
          : "outputVoiceLoadFailed";
      }
    } finally {
      if (this.owns(generation) && this.read === controller) {
        this.reading = false;
        this.notify();
      }
    }
  };
  abandon = () => {
    this.generation++;
    this.read?.abort();
    this.saveRequest?.abort();
    this.pending = undefined;
  };
  mount = () => {
    this.alive = true;
    this.foreground =
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive";
    void this.refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        this.foreground = false;
        this.abandon();
        this.snapshot = undefined;
        this.sheet = false;
        this.busy = false;
        this.closing = false;
        this.notify();
      } else {
        this.foreground = true;
        void this.refresh();
      }
    });
    const unsubscribe = this.session.subscribe?.(() => {
      if (this.session?.getSnapshot().status === "unauthorized") {
        this.abandon();
        this.snapshot = undefined;
        this.sheet = false;
        this.busy = false;
        this.issue = "outputVoiceLoadFailed";
        this.notify();
      }
    });
    return () => {
      this.alive = false;
      this.abandon();
      subscription.remove();
      unsubscribe?.();
    };
  };
  async save(choice: OutputVoiceChoice, retry?: OutputVoiceUpdate) {
    const snapshot = this.snapshot;
    if (
      !snapshot ||
      this.busy ||
      this.reading ||
      this.closing ||
      !this.alive ||
      !this.foreground ||
      (this.pending && !retry)
    )
      return;
    if (!retry && sameIntent(snapshot, choice)) return;
    const update = retry ?? {
      profile: OUTPUT_VOICE_PROFILE,
      requestId: randomUUID(),
      expectedRevision: snapshot.revision,
      catalogueRevision: snapshot.catalogueRevision,
      choice,
    };
    const generation = ++this.generation;
    this.write++;
    this.read?.abort();
    const controller = new AbortController();
    this.saveRequest = controller;
    this.busy = true;
    this.issue = undefined;
    this.pending = update;
    this.notify();
    try {
      const value = await this.session.saveOutputVoiceSettings(
        update,
        controller.signal,
      );
      if (!this.owns(generation) || controller.signal.aborted) return;
      if (value.revision < (this.snapshot?.revision ?? 0)) return;
      this.snapshot = value;
      this.pending = undefined;
      this.sheet = false;
    } catch (error) {
      if (!this.owns(generation) || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "";
      if (
        [
          "session_stopped",
          "auth_expired",
          "output_voice_context_changed",
        ].includes(message)
      ) {
        this.snapshot = undefined;
        this.pending = undefined;
        this.sheet = false;
        this.issue = "outputVoiceLoadFailed";
      } else if (
        [
          "output_voice_conflict",
          "output_voice_catalogue_changed",
          "output_voice_choice_unavailable",
        ].includes(message)
      ) {
        this.pending = undefined;
        this.issue = "outputVoiceConflict";
        await this.refresh();
      } else if (
        [
          "invalid_payload",
          "output_voice_profile_unsupported",
          "auth_expired",
        ].includes(message)
      ) {
        this.pending = undefined;
        this.issue = "outputVoiceSaveFailed";
      } else {
        this.issue = "outputVoiceUnknown";
        await this.refresh();
      }
    } finally {
      if (this.owns(generation)) {
        this.busy = false;
        this.notify();
      }
    }
  }
  open = () => {
    if (this.closing || this.busy) return;
    this.sheet = true;
    this.issue = undefined;
    this.notify();
    void this.refresh();
  };
  dismissRequested = () => {
    this.closing = true;
    this.abandon();
    this.notify();
  };
  closed = () => {
    this.sheet = false;
    this.closing = false;
    this.busy = false;
    this.reading = false;
    this.notify();
  };
}

function sameIntent(snapshot: OutputVoiceSnapshot, choice: OutputVoiceChoice) {
  // A corrupt existing row is intentionally not comparable with absent intent.
  if (
    !snapshot.saved &&
    snapshot.revision > 0 &&
    ["saved-choice-unavailable", "speech-unavailable"].includes(
      snapshot.effective.reason,
    )
  )
    return false;
  const saved = snapshot.saved?.choice ?? { kind: "server-default" };
  return (
    saved.kind === choice.kind &&
    (saved.kind === "server-default" ||
      (choice.kind === "catalogue" && saved.optionId === choice.optionId))
  );
}
