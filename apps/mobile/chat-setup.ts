import { useEffect, useState } from "react";
import type { ClientSession } from "../../packages/client-core/session";
import type { WorkspaceChatSetup } from "../../packages/protocol/workspace-instructions";

/**
 * The workspace's starters (and instructions) for the empty chat. A server
 * without them, a failed read or a late answer for another identity leaves
 * null, and the app keeps its own home shortcuts.
 */
export function useMobileChatSetup(
  session: ClientSession | null,
  online: boolean,
) {
  const [setup, setSetup] = useState<{
    session: ClientSession;
    identity: string;
    value: WorkspaceChatSetup | null;
  }>();
  useEffect(() => {
    if (!session || !online || typeof session.readChatSetup !== "function")
      return;
    const identity = session.identityKey;
    const controller = new AbortController();
    let current = true;
    void session.readChatSetup(controller.signal).then(
      (value) => {
        if (current && identity === session.identityKey)
          setSetup({ session, identity, value });
      },
      () => {},
    );
    return () => {
      current = false;
      controller.abort();
    };
  }, [session, online]);
  return setup?.session === session && setup.identity === session?.identityKey
    ? setup.value
    : null;
}
