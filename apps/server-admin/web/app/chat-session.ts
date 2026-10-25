import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ClientSession } from "../../../../packages/client-core/session";
import { AuthenticationError } from "../../../../packages/client-core/auth";
import type { KeyValueStorage } from "../../../../packages/client-core/preferences";
import { CredentialSchema } from "../../../../packages/protocol";
import { api, ApiError } from "../lib/api";
import { ensureSessionStarted } from "./menu-page";
import type { MessageResultToken } from "../../../../packages/protocol/message-delivery";

/** The chat results this page renders (chat-page.tsx); others arrive as text. */
const WEB_MESSAGE_RESULTS: readonly MessageResultToken[] = [
  "crm.contacts/1",
  "service.action/1",
  "service.connection/1",
  "card.document/1",
  "process.offer/1",
  "skill.proposal/1",
  "process.proposal/1",
];

const Issued = z.object({ address: z.string(), credential: CredentialSchema });

/** Chat caches live for this page only: nothing private stays in the browser. */
function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
  };
}

/**
 * The chat session for one workspace. The browser session that signed in to
 * this page issues a short credential bound to it; reloading replaces it.
 */
export function useChatSession(
  organizationId: string,
  workspaceId: string,
  onSignedOut: () => void,
) {
  const [attempt, setAttempt] = useState(0);
  const key = `${organizationId}:${workspaceId}:${attempt}`;
  // A result belongs to the workspace and attempt that asked for it.
  const [state, setState] = useState<{
    key: string;
    session: ClientSession | null;
    error: "sessionFailed" | "sessionEnded" | "deviceLimit" | null;
  }>({ key: "", session: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    let session: ClientSession | null = null;
    void (async () => {
      try {
        const issued = Issued.parse(
          await api(
            "identity/app/session",
            { organizationId, workspaceId },
            controller.signal,
          ),
        );
        if (controller.signal.aborted) return;
        session = new ClientSession(
          issued.address,
          memoryStorage(),
          issued.credential,
          (url, init) => fetch(url, init),
          () => {
            if (!controller.signal.aborted)
              setState({ key, session: null, error: "sessionEnded" });
          },
          // The chat credential is short; the signed-in browser session
          // quietly issues the next one, so chat never asks to sign in again
          // while the browser stays signed in.
          async () => {
            try {
              return Issued.parse(
                await api("identity/app/session", {
                  organizationId,
                  workspaceId,
                }),
              ).credential;
            } catch (error) {
              if (error instanceof ApiError && error.status === 401) {
                onSignedOut();
                throw new AuthenticationError("auth_expired");
              }
              throw new Error("connection_failed");
            }
          },
          false,
          {
            reissue: true,
            processOutputs: true,
            messageResults: WEB_MESSAGE_RESULTS,
            messageTimes: true,
            generativeUi: true,
            stream: true,
          },
        );
        // One sync loop per session, whichever page needs it first.
        ensureSessionStarted(session);
        setState({ key, session, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onSignedOut();
        else
          setState({
            key,
            session: null,
            error:
              error instanceof ApiError && error.code === "mobile_device_limit"
                ? "deviceLimit"
                : "sessionFailed",
          });
      }
    })();
    return () => {
      controller.abort();
      session?.stop();
    };
  }, [key, organizationId, workspaceId, onSignedOut]);
  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);
  return state.key === key
    ? { session: state.session, error: state.error, reconnect }
    : { session: null, error: null, reconnect };
}
