import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { ClientSession } from "../../packages/client-core/session";
import { ReplySpeech } from "../../packages/client-core/speech";
import { createSpeechPlayback } from "./speech-playback";

export function useReplySpeech(
  session: ClientSession | null,
  online: boolean,
  automatic: boolean,
) {
  const player = useMemo(
    () =>
      new ReplySpeech((request, signal) => {
        if (!session) return Promise.reject(new Error("speech_unavailable"));
        return session.synthesize(request, signal);
      }, createSpeechPlayback()),
    [session],
  );
  const [capability, setCapability] = useState<{
    session: ClientSession;
    enabled: boolean;
  } | null>(null);
  const state = useSyncExternalStore(
    player.subscribe,
    player.getSnapshot,
    player.getSnapshot,
  );
  useEffect(() => {
    if (!automatic) player.stop();
  }, [automatic, player]);
  useEffect(() => {
    if (!session) return;
    let pending = session.getSnapshot().pending?.commandId;
    return session.subscribe(() => {
      const current = session.getSnapshot();
      const next = current.pending?.commandId;
      if (current.status !== "online" || (next && next !== pending))
        player.stop();
      pending = next;
      player.reconcile(current.store?.conversations);
    });
  }, [session, player]);
  useEffect(() => {
    if (!session || !online) {
      player.stop();
      return;
    }
    const controller = new AbortController();
    const refresh = () =>
      void session
        .speechCapabilities(controller.signal)
        .then((caps) => {
          if (!controller.signal.aborted)
            setCapability({ session, enabled: caps.enabled });
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setCapability({ session, enabled: false });
        });
    refresh();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") player.stop();
      else refresh();
    });
    return () => {
      controller.abort();
      subscription.remove();
      player.stop();
    };
  }, [session, online, player]);
  return {
    player,
    state,
    enabled:
      online && capability?.session === session && capability?.enabled === true,
  };
}
