import React, { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import type { ClientSession } from "../../packages/client-core/session";
import type { Language } from "../../packages/protocol";
import type { ServiceConnectionCard as ConnectionResult } from "../../packages/protocol/service-oauth";
import { ServiceConnectionCard } from "../../packages/ui-catalog/ServiceConnectionCard";
import {
  ConnectionFlow,
  type ConnectionPlatform,
  type ConnectionState,
} from "../../packages/client-core/service-connection-flow";

/** The provider page opens in the browser and returns through the app link. */
const platform: ConnectionPlatform = {
  open: (url) => Linking.openURL(url),
  onReturn: (listener) =>
    Linking.addEventListener("url", ({ url }) => {
      if (url.startsWith("agentclient://service-connected")) listener();
    }),
};

export function ServiceConnection({
  session,
  result,
  language,
  disabled,
  online = true,
  onContinue,
}: {
  session: ClientSession;
  result: ConnectionResult;
  language: Language;
  disabled: boolean;
  online?: boolean;
  onContinue: (text: string) => void;
}) {
  const flow = useRef<ConnectionFlow | null>(null);
  const [view, setView] = useState<{
    owner: ConnectionFlow;
    state: ConnectionState;
  }>();
  const serviceId = result.serviceId;
  const [continued, setContinued] = useState(false);
  const resume = useRef(result.resumeText);
  const continueRequest = useRef(onContinue);
  useEffect(() => {
    resume.current = result.resumeText;
    continueRequest.current = onContinue;
  });
  useEffect(() => {
    if (!online) return;
    const owner = new ConnectionFlow(
      session,
      serviceId,
      (state) => setView({ owner, state }),
      () => {
        if (!resume.current) return;
        setContinued(true);
        continueRequest.current(resume.current);
      },
      platform,
    );
    flow.current = owner;
    void owner.load();
    return () => {
      owner.dispose();
      flow.current = null;
    };
  }, [session, serviceId, online]);
  const current =
    view?.owner.session === session && view?.owner.serviceId === serviceId;
  const state = current && online ? view.state : { phase: "loading" as const };
  const act = (action: "start" | "open" | "cancel") => {
    const owner = flow.current;
    if (
      !disabled &&
      online &&
      owner?.session === session &&
      owner.serviceId === serviceId
    )
      void owner[action]();
  };
  return (
    <ServiceConnectionCard
      result={result}
      language={language}
      {...state}
      disabled={disabled || !online}
      onConnect={() => act("start")}
      onOpen={() => act("open")}
      onCancel={() => act("cancel")}
      onContinue={
        continued
          ? undefined
          : () => {
              if (
                !disabled &&
                online &&
                flow.current?.session === session &&
                flow.current.serviceId === serviceId &&
                flow.current.state.phase === "connected" &&
                state.phase === "connected" &&
                result.resumeText
              )
                onContinue(result.resumeText);
            }
      }
    />
  );
}
