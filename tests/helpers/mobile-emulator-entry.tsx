import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import App from "../../apps/mobile/App";
import { credentialVault } from "../../apps/mobile/credential-vault";
import { Connections } from "../../packages/client-core/connections";

/** Opt-in native QA entry. Pairing comes only from the isolated loopback fixture. */
export default function MobileEmulatorEntry() {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    async function prepare() {
      const address = process.env.EXPO_PUBLIC_QA_BOOTSTRAP;
      if (!__DEV__ || !address || new URL(address).hostname !== "127.0.0.1")
        throw Error("TEST loopback bootstrap required");
      const setup = await fetch(address).then((response) => response.json());
      if (new URL(setup.pairing.address).hostname !== "127.0.0.1")
        throw Error("TEST loopback pairing required");
      // Check before restore: it may refresh a credential or contact its saved server.
      const stored = await credentialVault.getItem(
        "agent-client.active-credential.v1",
      );
      if (
        stored &&
        stored !== "null" &&
        JSON.parse(stored).address !== setup.pairing.address
      )
        throw Error(
          "TEST existing connection retained; sign out before running isolated QA",
        );
      const connections = new Connections(AsyncStorage, credentialVault, true);
      try {
        await connections.restore();
        if (
          connections.getSnapshot().status === "connected" &&
          connections.getSnapshot().address !== setup.pairing.address
        )
          throw Error(
            "TEST existing connection retained; sign out before running isolated QA",
          );
        if (
          connections.getSnapshot().status !== "connected" &&
          !(await connections.pair(setup.pairing.address, setup.pairing.code))
        )
          throw Error("TEST pairing failed");
      } finally {
        connections.dispose();
      }
      await AsyncStorage.multiSet([
        ["agent-client.ui-language.v1", "cs"],
        ["agent-client.spoken-replies.v1", "off"],
        ["agent-client.feedback.v1", "off"],
        ["agent-client.address.v1", setup.pairing.address],
      ]);
      if (active) setReady(true);
    }
    void prepare().catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, []);
  if (ready) return <App />;
  return (
    <View style={{ padding: 40 }}>
      <Text>
        {failed
          ? "Isolated native QA setup failed. Existing connection was retained."
          : "Preparing isolated native QA…"}
      </Text>
    </View>
  );
}
