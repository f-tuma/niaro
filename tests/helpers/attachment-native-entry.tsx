import React, { useEffect, useState } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { randomUUID } from "expo-crypto";
import { Workspace } from "../../apps/mobile/App";
import type { Section } from "../../apps/mobile/ScreenChrome";
import { useCompanionFonts } from "../../apps/mobile/CompanionFonts";
import { CompanionFontContext } from "../../packages/ui/typography";
import { ClientSession } from "../../packages/client-core/session";
/** Opt-in QA entry: actual Workspace and native IO, synthetic loopback credential and in-memory session only. */
export default function AttachmentNativeEntry() {
  const fonts = useCompanionFonts();
  const [session, setSession] = useState<ClientSession | null>(null);
  const [section, setSection] = useState<Section>("chat");
  useEffect(() => {
    const address = process.env.EXPO_PUBLIC_ATTACHMENT_QA_BASE;
    if (!__DEV__ || !address || new URL(address).hostname !== "127.0.0.1")
      throw Error("TEST owned loopback required");
    let active = true;
    let session: ClientSession | undefined;
    const values = new Map<string, string>();
    void fetch(address + "/bootstrap")
      .then((response) => response.json())
      .then(async ({ actor }) => {
        session = new ClientSession(
          address,
          {
            getItem: async (key) => values.get(key) ?? null,
            setItem: async (key, value) => {
              values.set(key, value);
            },
          },
          actor,
          (url, init) => fetch(url, init),
          undefined,
          undefined,
          false,
          { attachments: true, attachmentId: randomUUID },
        );
        await session.start(false);
        if (active) setSession(session);
        else session.stop();
      });
    return () => {
      active = false;
      session?.stop();
    };
  }, []);
  if (!session || !fonts.ready)
    return <Text>Preparing synthetic attachment client…</Text>;
  return (
    <SafeAreaProvider>
      <CompanionFontContext.Provider value={fonts.loaded}>
        <Workspace
          session={session}
          language="en"
          section={section}
          setSection={setSection}
          settings={null}
          authError={null}
          spokenReplies={false}
        />
      </CompanionFontContext.Provider>
    </SafeAreaProvider>
  );
}
