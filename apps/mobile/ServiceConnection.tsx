import React, { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import type { ClientSession } from "../../packages/client-core/session";
import type { Language } from "../../packages/protocol";
import type { ServiceConnectionCard as ConnectionResult } from "../../packages/protocol/service-oauth";
import { ServiceConnectionCard } from "../../packages/ui-catalog/ServiceConnectionCard";
import type { MemberService } from "../../packages/protocol/member-services";
import { MemberServicesView } from "../../packages/ui-catalog/MemberServicesView";
import {
  ConnectionFlow,
  type ConnectionPlatform,
  type ConnectionState,
} from "../../packages/client-core/service-connection-flow";

/** The provider page opens in the browser and returns through the app link. */
export const connectionPlatform: ConnectionPlatform = {
  open: (url) => Linking.openURL(url),
  onReturn: (listener) =>
    Linking.addEventListener("url", ({ url }) => {
      if (url.startsWith("niaro://service-connected")) listener();
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
      connectionPlatform,
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
              ) {
                // One continuation per connection, pressed or automatic.
                setContinued(true);
                onContinue(result.resumeText);
              }
            }
      }
    />
  );
}

/**
 * Where Niaro reads for the person: the services they may use, under whose
 * account, and their own last read and failure, as the server projects it.
 * Read-only; nothing here signs in or changes a choice. A server without the
 * projection shows nothing.
 */
export function MemberServices({
  session,
  language,
}: {
  session: ClientSession;
  language: Language;
}) {
  const [result, setResult] = useState<{
    session: ClientSession;
    value: readonly MemberService[] | null | "failed";
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void session.readMemberServices(controller.signal).then(
      (list) => {
        if (!controller.signal.aborted)
          setResult({ session, value: list?.services ?? null });
      },
      () => {
        if (!controller.signal.aborted) setResult({ session, value: "failed" });
      },
    );
    return () => controller.abort();
  }, [session]);
  const value = result?.session === session ? result.value : undefined;
  if (value === null) return null;
  return (
    <MemberServicesView
      language={language}
      services={value === "failed" ? undefined : value}
      failed={value === "failed"}
    />
  );
}
